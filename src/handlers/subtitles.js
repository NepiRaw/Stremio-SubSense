'use strict';

const { log, parseStremioId } = require('../../src/utils');
const { providerManager } = require('../providers');
const l1 = require('../cache/response-cache');
const l2 = require('../cache/subtitle-store');
const inflight = require('../cache/inflight');
const metrics = require('../infra/metrics');
const { prioritizeByLanguage, buildEntries } = require('../utils/format');
const { validateWyzieUrls } = require('../utils/validateWyzie');
const { statsService, track } = require('../stats');

let encryptConfig = null;
try {
    encryptConfig = require('../../src/utils/crypto').encryptConfig;
} catch (_) {
    log('warn', '[handlers/subtitles] crypto unavailable; SubSource downloads will be limited');
}

const STREMIO_UA_RE = /stremio|com\.stremio|libmpv/i;
const OS_DIRECT_URL_RE = /^https?:\/\/dl\.opensubtitles\.org\//;
const OS_PROXIED_URL_RE = /\/api\/subtitle\/(?:vtt|srt|ass)\/(https?:\/\/dl\.opensubtitles\.org\/[^\s]+)/;

function isStremioClient(userAgent) {
    return STREMIO_UA_RE.test(userAgent || '');
}

function extractOsUrl(url) {
    if (!url) return null;
    if (OS_DIRECT_URL_RE.test(url)) return url;
    const match = url.match(OS_PROXIED_URL_RE);
    return match ? match[1] : null;
}

function getSubtitleFormat(url) {
    const ext = url.match(/\.(\w+)$/)?.[1]?.toLowerCase();
    if (ext === 'ass' || ext === 'ssa') return 'ass';
    if (ext === 'vtt') return 'vtt';
    return 'srt';
}

/**
 * Wrap OpenSubtitles URLs with the Stremio local streaming server,
 * or unwrap proxy-wrapped OS URLs for non-Stremio clients.
 */
function applyStreamingServerWrap(subtitles, userAgent) {
    const isStremio = isStremioClient(userAgent);
    return subtitles.map(sub => {
        const osUrl = extractOsUrl(sub.url);
        if (!osUrl) return sub;
        if (isStremio) {
            const fmt = getSubtitleFormat(osUrl);
            return { ...sub, url: `http://127.0.0.1:11470/subtitles.${fmt}?from=${encodeURIComponent(osUrl)}` };
        }
        if (sub.url !== osUrl) return { ...sub, url: osUrl };
        return sub;
    });
}

/**
 * Resolve a subtitle request.
 *
 * L1 (Redis) -> L2 (cache.db) -> providers. A hit reads no SQLite and calls no upstream:
 * dead-URL filtering happens when an entry is written, not when it is served. Persistence
 * and stats are never awaited before responding.
 */
async function handleSubtitlesRequest(args, parsedConfig) {
    const startedAt = Date.now();
    metrics.recordRequest();

    const parsed = parseStremioId(args.id);
    const languages = parsedConfig.languages || [];
    const userAgent = parsedConfig._userAgent || '';
    const filename = (args.extra && args.extra.filename) || null;
    const apiKey = parsedConfig.subsourceApiKey || null;
    const subdlApiKey = parsedConfig.subdlApiKey || null;
    const wyzieApiKey = parsedConfig.wyzieApiKey || null;
    const encryptedApiKey = apiKey && encryptConfig ? safeEncrypt({ apiKey }) : null;

    const sessionInfo = parsedConfig.userId ? `session=${parsedConfig.userId}` : 'no-session';
    const idTag = `${parsed.imdbId}${parsed.season != null ? `:${parsed.season}:${parsed.episode}` : ''}`;
    log('info', `[Request] ${sessionInfo} ${parsed.type} ${idTag} langs=[${languages.join(',')}]${filename ? ` file="${filename}"` : ''}`);
    if (userAgent) log('debug', `[Request] UA: ${userAgent.substring(0, 120)} stremio=${isStremioClient(userAgent)}`);

    const cacheKey = l1.buildKey(parsed.imdbId, parsed.season, parsed.episode, languages,
        { keepAss: parsedConfig.keepAss });

    const requestContext = {
        videoFilename: filename,
        contentType: parsed.type,
        encryptedSubsourceKey: encryptedApiKey,
        maxPerLang: parsedConfig.maxSubtitles || 0
    };

    const cached = await l1.get(cacheKey, requestContext);
    if (cached) {
        metrics.recordCache('l1');
        log('info', `[handler] cache-${cached.status} ${reqTag(parsed, languages)} -> ${cached.subtitles.length} subs in ${Date.now() - startedAt}ms`);
        if (cached.status === 'stale') {
            scheduleRefresh(parsed, languages, parsedConfig, filename, apiKey, encryptedApiKey, cacheKey);
        }
        fireTrack(parsedConfig, parsed, languages, cached.subtitles, Date.now() - startedAt, true);
        return { subtitles: applyStreamingServerWrap(cached.subtitles, userAgent) };
    }

    const l2Hit = await l2.getByContent(parsed.imdbId, parsed.season, parsed.episode, languages);
    if (l2Hit && l2Hit.subtitles.length > 0) {
        metrics.recordCache('l2');
        l1.set(cacheKey, l2Hit.subtitles).catch(() => {});
        const returned = l1.materialize(l2Hit.subtitles, requestContext);
        log('info', `[handler] l2-hit ${reqTag(parsed, languages)} -> ${l2Hit.subtitles.length} subs (returning ${returned.length}) in ${Date.now() - startedAt}ms`);
        fireTrack(parsedConfig, parsed, languages, returned, Date.now() - startedAt, true);
        return { subtitles: applyStreamingServerWrap(returned, userAgent) };
    }

    // Another worker may already be fetching this key; wait for its result rather than duplicating.
    const owned = await inflight.acquire(cacheKey);
    if (!owned) {
        const waited = await inflight.pollFor(() => l1.get(cacheKey, requestContext));
        if (waited) {
            metrics.recordCache('l1');
            log('info', `[handler] dedup-wait ${reqTag(parsed, languages)} -> ${waited.subtitles.length} subs in ${Date.now() - startedAt}ms`);
            fireTrack(parsedConfig, parsed, languages, waited.subtitles, Date.now() - startedAt, true);
            return { subtitles: applyStreamingServerWrap(waited.subtitles, userAgent) };
        }
    }

    metrics.recordCache('miss');
    try {
        const result = await providerManager.searchAll({
            imdbId: parsed.imdbId,
            season: parsed.season,
            episode: parsed.episode,
            languages,
            filename,
            apiKeys: { subsource: apiKey, subdl: subdlApiKey, wyzie: wyzieApiKey },
            encryptedApiKeys: { subsource: encryptedApiKey }
        }, { dedupeKey: cacheKey });

        const { formatted, languageMatch } = buildFormatted(result.subtitles, languages, 0, { keepAss: parsedConfig.keepAss });
        const validated = await validateWyzieUrls(formatted);

        l1.set(cacheKey, validated).catch(() => {});
        l2.set(parsed.imdbId, parsed.season, parsed.episode, uniqueLangs(validated), validated)
            .then((delta) => { if (delta) track.dist(delta); })
            .catch((err) => log('debug', `[handler] L2 write failed: ${err.message}`));

        if (Array.isArray(result.backgroundPromises) && result.backgroundPromises.length > 0) {
            wireBackgroundPromises(result.backgroundPromises, parsed, languages, parsedConfig, cacheKey, validated);
        }

        const returned = l1.materialize(validated, requestContext);
        log('info', `[handler] miss ${reqTag(parsed, languages)} -> ${validated.length} subs (returning ${returned.length}) in ${Date.now() - startedAt}ms`);
        fireTrack(parsedConfig, parsed, languages, returned, Date.now() - startedAt, false, languageMatch);
        return { subtitles: applyStreamingServerWrap(returned, userAgent) };
    } finally {
        if (owned) inflight.release(cacheKey).catch(() => {});
    }
}

function fireTrack(parsedConfig, parsed, languages, subtitles, fetchTimeMs, cacheHit, languageMatch) {
    try {
        statsService.trackRequest({
            type: parsed.type,
            userId: parsedConfig.userId,
            imdbId: parsed.imdbId,
            languages,
            season: parsed.season,
            episode: parsed.episode,
            fetchTimeMs,
            subtitleCount: subtitles ? subtitles.length : 0,
            subtitles: subtitles || [],
            cacheHit,
            languageMatch: languageMatch || null
        });
    } catch (_) { /* never fail the response path */ }
}

function buildFormatted(rawSubtitles, languages, maxPerLang, opts = {}) {
    const { subtitles, languageMatch } = prioritizeByLanguage(rawSubtitles, languages, maxPerLang);
    languageMatch.languages = languages;
    languageMatch.found = languages.filter(l => languageMatch.byLanguage[l]?.found);
    languageMatch.anyPreferredFound = languageMatch.found.length > 0;
    languageMatch.allPreferredFound = languageMatch.found.length === languages.length;
    return { formatted: buildEntries(subtitles, opts), languageMatch };
}

function wireBackgroundPromises(promises, parsed, languages, parsedConfig, cacheKey, foregroundFormatted) {
    Promise.allSettled(promises).then(async (results) => {
        const extra = [];
        for (const r of results) {
            if (r.status !== 'fulfilled' || !r.value) continue;
            const subs = r.value.subtitles || (Array.isArray(r.value) ? r.value : []);
            if (subs.length > 0) extra.push(...subs);
        }
        if (extra.length === 0) return;

        const { formatted: extraFormatted } = buildFormatted(extra, languages, 0, { keepAss: parsedConfig.keepAss });
        const merged = mergeFormatted(foregroundFormatted, extraFormatted);
        const added = merged.length - foregroundFormatted.length;
        if (added <= 0) return;

        const validated = await validateWyzieUrls(merged);
        await l1.set(cacheKey, validated);
        l2.set(parsed.imdbId, parsed.season, parsed.episode, uniqueLangs(validated), validated)
            .then((delta) => { if (delta) track.dist(delta); }).catch(() => {});
        log('info', `[handler] bg-warm ${reqTag(parsed, uniqueLangs(validated))} -> ${validated.length} subs (+${added})`);
    }).catch((err) => log('debug', `[handler] bg error: ${err.message}`));
}

function mergeFormatted(existing, extra) {
    const seen = new Set();
    const out = [];
    for (const s of existing) {
        if (!s || !s.url || seen.has(s.url)) continue;
        seen.add(s.url);
        out.push(s);
    }
    for (const s of extra) {
        if (!s || !s.url || seen.has(s.url)) continue;
        seen.add(s.url);
        out.push(s);
    }
    return out;
}

function scheduleRefresh(parsed, languages, parsedConfig, filename, apiKey, encryptedApiKey, cacheKey) {
    const subdlApiKey = parsedConfig.subdlApiKey || null;
    const wyzieApiKey = parsedConfig.wyzieApiKey || null;
    setImmediate(async () => {
        // One refresh per key across all workers; the rest keep serving the stale entry.
        if (!await inflight.acquire(`${cacheKey}:refresh`, 30)) return;
        try {
            const res = await providerManager.searchAll({
                imdbId: parsed.imdbId,
                season: parsed.season,
                episode: parsed.episode,
                languages,
                filename,
                apiKeys: { subsource: apiKey, subdl: subdlApiKey, wyzie: wyzieApiKey },
                encryptedApiKeys: { subsource: encryptedApiKey }
            }, { dedupeKey: `${cacheKey}:refresh` });

            const { formatted } = buildFormatted(res.subtitles, languages, 0, { keepAss: parsedConfig.keepAss });
            if (formatted.length === 0) return;

            const validated = await validateWyzieUrls(formatted);
            await l1.set(cacheKey, validated);
            l2.set(parsed.imdbId, parsed.season, parsed.episode, uniqueLangs(validated), validated)
                .then((delta) => { if (delta) track.dist(delta); }).catch(() => {});
            log('info', `[handler] stale-refresh ${reqTag(parsed, languages)} -> ${validated.length} subs`);
        } catch (err) {
            log('debug', `[handler] stale-refresh failed: ${err.message}`);
        } finally {
            inflight.release(`${cacheKey}:refresh`).catch(() => {});
        }
    });
}

function uniqueLangs(formatted) {
    const set = new Set();
    for (const s of formatted) if (s.lang) set.add(s.lang);
    return Array.from(set);
}

function reqTag(parsed, languages) {
    const parts = [];
    if (parsed && parsed.type) parts.push(`type=${parsed.type}`);
    if (parsed && parsed.imdbId) parts.push(`imdb=${parsed.imdbId}`);
    if (parsed && parsed.season != null) parts.push(`s=${parsed.season}`);
    if (parsed && parsed.episode != null) parts.push(`e=${parsed.episode}`);
    if (Array.isArray(languages) && languages.length > 0) parts.push(`langs=${languages.join(',')}`);
    return parts.join(' ');
}

function safeEncrypt(payload) {
    try { return encryptConfig(payload); } catch (_) { return null; }
}

async function getCacheStats() {
    return l1.stats();
}

module.exports = { handleSubtitlesRequest, getCacheStats };

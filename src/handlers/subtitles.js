'use strict';

const { log, parseStremioId } = require('../../src/utils');
const { mapStremioToWyzie } = require('../../src/languages');
const { providerManager } = require('../providers');
const { ResponseCache, SubtitleCache } = require('../cache');
const { prioritizeByLanguage, formatForStremio } = require('../utils/format');
const { statsService } = require('../stats');

let encryptConfig = null;
try {
    encryptConfig = require('../../src/utils/crypto').encryptConfig;
} catch (_) {
    log('warn', '[handlers/subtitles] crypto unavailable; SubSource downloads will be limited');
}

const responseCache = new ResponseCache();
const subtitleCache = new SubtitleCache();

/**
 * Resolve a subtitle request end-to-end.
 *
 * Hot path:
 *   1. L1 ResponseCache.get -> fresh hit returns immediately
 *   2. (stale hit) returns stale + schedules background refresh
 *   3. miss -> providerManager.searchAll, format, populate L1, persist L2
 *      (writes are fire-and-forget; never awaited on the response path)
 *
 * No DB read or write is ever awaited before responding to the client.
 */
async function handleSubtitlesRequest(args, parsedConfig) {
    const startedAt = Date.now();
    const parsed = parseStremioId(args.id);
    const languages = parsedConfig.languages || [];
    const wyzieLanguages = languages.map(mapStremioToWyzie).filter(Boolean);
    const filename = (args.extra && args.extra.filename) || null;
    const apiKey = parsedConfig.subsourceApiKey || null;
    const subdlApiKey = parsedConfig.subdlApiKey || null;
    const encryptedApiKey = apiKey && encryptConfig
        ? safeEncrypt({ apiKey })
        : null;

    const sessionInfo = parsedConfig.userId ? `session=${parsedConfig.userId}` : 'no-session';
    const idTag = `${parsed.imdbId}${parsed.season != null ? `:${parsed.season}:${parsed.episode}` : ''}`;
    log('info', `[Request] ${sessionInfo} ${parsed.type} ${idTag} langs=[${languages.join(',')}]${filename ? ` file="${filename}"` : ''}`);

    const cacheKey = ResponseCache.buildKey(
        parsed.imdbId,
        parsed.season,
        parsed.episode,
        wyzieLanguages,
        { keepAss: parsedConfig.keepAss }
    );

    if (parsedConfig.keepAss) {
        log('debug', `[handler] keepAss=true ${reqTag(parsed, wyzieLanguages)}`);
    }

    const requestContext = {
        videoFilename: filename,
        contentType: parsed.type,
        encryptedSubsourceKey: encryptedApiKey,
        maxPerLang: parsedConfig.maxSubtitles || 0
    };

    const cached = responseCache.get(cacheKey, requestContext);
    if (cached) {
        log('info',
            `[handler] cache-${cached.status} ${reqTag(parsed, wyzieLanguages)} -> ${cached.subtitles.length} subs in ${Date.now() - startedAt}ms`);
        if (cached.status === 'stale') {
            scheduleRefresh(parsed, wyzieLanguages, languages, parsedConfig, filename, apiKey, encryptedApiKey, cacheKey, requestContext);
        }
        fireTrack(parsedConfig, parsed, languages, cached.subtitles, Date.now() - startedAt, true);
        return { subtitles: cached.subtitles };
    }

    const result = await providerManager.searchAll(
        {
            imdbId: parsed.imdbId,
            season: parsed.season,
            episode: parsed.episode,
            languages: wyzieLanguages,
            filename,
            apiKeys: { subsource: apiKey, subdl: subdlApiKey },
            encryptedApiKeys: { subsource: encryptedApiKey }
        },
        { dedupeKey: cacheKey }
    );

    const { formatted, languageMatch } = buildFormatted(result.subtitles, languages, 0, { keepAss: parsedConfig.keepAss });

    responseCache.set(cacheKey, formatted);
    persistL2(parsed, formatted).catch((err) =>
        log('debug', `[handler] L2 write failed: ${err.message}`));

    if (Array.isArray(result.backgroundPromises) && result.backgroundPromises.length > 0) {
        wireBackgroundPromises(result.backgroundPromises, parsed, languages, parsedConfig, cacheKey, formatted);
    }

    const finalSubs = responseCache.get(cacheKey, requestContext);
    log('info',
        `[handler] miss ${reqTag(parsed, wyzieLanguages)} -> ${formatted.length} subs (returning ${finalSubs ? finalSubs.subtitles.length : 0}) in ${Date.now() - startedAt}ms`);

    const returnedSubs = finalSubs ? finalSubs.subtitles : formatted;
    fireTrack(parsedConfig, parsed, languages, returnedSubs, Date.now() - startedAt, false, languageMatch);
    return { subtitles: returnedSubs };
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
    return { formatted: formatForStremio(subtitles, opts), languageMatch };
}

function persistL2(parsed, formatted) {
    if (!formatted || formatted.length === 0) return Promise.resolve();
    return subtitleCache.set(
        parsed.imdbId,
        parsed.season,
        parsed.episode,
        uniqueLangs(formatted),
        formatted
    );
}

function wireBackgroundPromises(promises, parsed, languages, parsedConfig, cacheKey, foregroundFormatted) {
    Promise.allSettled(promises).then((results) => {
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

        responseCache.set(cacheKey, merged);
        persistL2(parsed, merged).catch(() => {});
        log('info', `[handler] bg-warm ${reqTag(parsed, uniqueLangs(merged))} -> ${merged.length} subs (+${added})`);
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

function scheduleRefresh(parsed, wyzieLanguages, languages, parsedConfig, filename, apiKey, encryptedApiKey, cacheKey, requestContext) {
    setImmediate(() => {
        providerManager.searchAll({
            imdbId: parsed.imdbId,
            season: parsed.season,
            episode: parsed.episode,
            languages: wyzieLanguages,
            filename,
            apiKeys: { subsource: apiKey, subdl: subdlApiKey },
            encryptedApiKeys: { subsource: encryptedApiKey }
        }, { dedupeKey: `${cacheKey}:refresh` })
            .then((res) => {
                const { formatted } = buildFormatted(res.subtitles, languages, 0, { keepAss: parsedConfig.keepAss });
                if (formatted.length > 0) {
                    responseCache.set(cacheKey, formatted);
                    persistL2(parsed, formatted).catch(() => {});
                    log('info', `[handler] stale-refresh ${reqTag(parsed, wyzieLanguages)} -> ${formatted.length} subs`);
                }
            })
            .catch((err) => log('debug', `[handler] stale-refresh failed: ${err.message}`));
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

async function warmupResponseCache() {
    try {
        const memBefore = process.memoryUsage();
        const t0 = Date.now();

        const entries = await subtitleCache.loadAllForWarmup();
        if (entries.length > 0) {
            responseCache.warmup(entries);
            const memAfter = process.memoryUsage();
            const elapsed = Date.now() - t0;
            const heapDeltaMB = ((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(1);
            const rssDeltaMB = ((memAfter.rss - memBefore.rss) / 1024 / 1024).toFixed(1);
            log('info', `[handler] warmed ResponseCache with ${entries.length} entries in ${elapsed}ms (heap +${heapDeltaMB}MB, rss +${rssDeltaMB}MB)`);
        } else {
            log('info', '[handler] warmup skipped: no L2 entries');
        }
    } catch (err) {
        log('warn', `[handler] warmup failed: ${err.message}`);
    }
}

function getCacheStats() {
    return responseCache.stats();
}

module.exports = {
    handleSubtitlesRequest,
    warmupResponseCache,
    getCacheStats,
    responseCache,
    subtitleCache
};

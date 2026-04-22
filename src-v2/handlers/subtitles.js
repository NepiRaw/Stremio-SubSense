'use strict';

const { log, parseStremioId } = require('../../src/utils');
const { mapStremioToWyzie } = require('../../src/languages');
const { providerManager } = require('../providers');
const { ResponseCache, SubtitleCache } = require('../cache');
const { prioritizeByLanguage, formatForStremio } = require('../utils/format');

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
    const encryptedApiKey = apiKey && encryptConfig
        ? safeEncrypt({ apiKey })
        : null;

    const cacheKey = ResponseCache.buildKey(
        parsed.imdbId,
        parsed.season,
        parsed.episode,
        wyzieLanguages
    );

    const requestContext = {
        videoFilename: filename,
        contentType: parsed.type,
        userApiKeys: { subsource: encryptedApiKey }
    };

    const cached = responseCache.get(cacheKey, requestContext);
    if (cached) {
        log('info',
            `[handler] cache ${cached.status} key=${cacheKey} -> ${cached.subtitles.length} subs in ${Date.now() - startedAt}ms`);
        if (cached.status === 'stale') {
            scheduleRefresh(parsed, wyzieLanguages, languages, parsedConfig, filename, apiKey, encryptedApiKey, cacheKey, requestContext);
        }
        return { subtitles: cached.subtitles };
    }

    const result = await providerManager.searchAll(
        {
            imdbId: parsed.imdbId,
            season: parsed.season,
            episode: parsed.episode,
            languages: wyzieLanguages,
            filename,
            apiKeys: { subsource: apiKey },
            encryptedApiKeys: { subsource: encryptedApiKey }
        },
        { dedupeKey: cacheKey }
    );

    const formatted = buildFormatted(result.subtitles, languages, parsedConfig.maxSubtitles || 0);

    responseCache.set(cacheKey, formatted);
    persistL2(parsed, formatted).catch((err) =>
        log('debug', `[handler] L2 write failed: ${err.message}`));

    if (Array.isArray(result.backgroundPromises) && result.backgroundPromises.length > 0) {
        wireBackgroundPromises(result.backgroundPromises, parsed, languages, parsedConfig, cacheKey, formatted);
    }

    const finalSubs = responseCache.get(cacheKey, requestContext);
    log('info',
        `[handler] miss -> fetched ${formatted.length} (returning ${finalSubs ? finalSubs.subtitles.length : 0}) in ${Date.now() - startedAt}ms`);

    return { subtitles: finalSubs ? finalSubs.subtitles : formatted };
}

function buildFormatted(rawSubtitles, languages, maxPerLang) {
    const { subtitles } = prioritizeByLanguage(rawSubtitles, languages, maxPerLang);
    return formatForStremio(subtitles);
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

        const extraFormatted = buildFormatted(extra, languages, parsedConfig.maxSubtitles || 0);
        const merged = mergeFormatted(foregroundFormatted, extraFormatted);
        const added = merged.length - foregroundFormatted.length;
        if (added <= 0) return;

        responseCache.set(cacheKey, merged);
        persistL2(parsed, merged).catch(() => {});
        log('info', `[handler] background warm: ${cacheKey} -> ${merged.length} subs (+${added})`);
    }).catch((err) => log('debug', `[handler] background error: ${err.message}`));
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
            apiKeys: { subsource: apiKey },
            encryptedApiKeys: { subsource: encryptedApiKey }
        }, { dedupeKey: `${cacheKey}:refresh` })
            .then((res) => {
                const formatted = buildFormatted(res.subtitles, languages, parsedConfig.maxSubtitles || 0);
                if (formatted.length > 0) {
                    responseCache.set(cacheKey, formatted);
                    persistL2(parsed, formatted).catch(() => {});
                    log('info', `[handler] stale refresh: ${formatted.length} subs for ${cacheKey}`);
                }
            })
            .catch((err) => log('debug', `[handler] stale refresh failed: ${err.message}`));
    });
}

function uniqueLangs(formatted) {
    const set = new Set();
    for (const s of formatted) if (s.lang) set.add(s.lang);
    return Array.from(set);
}

function safeEncrypt(payload) {
    try { return encryptConfig(payload); } catch (_) { return null; }
}

async function warmupResponseCache() {
    try {
        const entries = await subtitleCache.loadAllForWarmup();
        if (entries.length > 0) {
            responseCache.warmup(entries);
            log('info', `[handler] warmed ResponseCache with ${entries.length} entries`);
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

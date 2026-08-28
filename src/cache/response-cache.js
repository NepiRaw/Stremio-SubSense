'use strict';

/**
 * L1 response cache on Redis, shared by every API worker.
 *
 * Entries are stored unmaterialized: quality-sorted, with `__SUBSRC_KEY__` placeholders in
 * SubSource URLs. Materialization is per-request because it depends on the caller's key,
 * filename and language cap.
 */

const { redis, isHealthy, safe } = require('../infra/redis');
const { log } = require('../utils');

const SUBSRC_KEY_PLACEHOLDER = '__SUBSRC_KEY__';
const SUBSRC_HOST_MARKER = '/subsource/';

const HOUR_MS = 60 * 60 * 1000;
const PREFIX = 'ss:r:';

function intEnv(name, fallback) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

const TTL_MS = intEnv('L1_TTL_HOURS', 6) * HOUR_MS;
const STALE_AFTER_MS = intEnv('L1_STALE_AFTER_HOURS', 2) * HOUR_MS;
const TTL_SECONDS = Math.floor(TTL_MS / 1000);

function buildKey(imdbId, season, episode, languages, opts = {}) {
    const langs = (languages || []).slice().sort().join(',');
    const flags = opts.keepAss ? ':ass' : '';
    return `${imdbId}:${season || 0}:${episode || 0}:${langs}${flags}`;
}

function redisKey(cacheKey) {
    return PREFIX + cacheKey;
}

/**
 * Rewrite or strip SubSource placeholders for this caller, re-sort by filename similarity,
 * then cap per language.
 */
function materialize(cachedSubtitles, ctx = {}) {
    const {
        encryptedSubsourceKey = null,
        videoFilename = null,
        contentType = 'series',
        maxPerLang = 0
    } = ctx;

    let result;
    if (encryptedSubsourceKey) {
        result = cachedSubtitles.map(sub => {
            if (sub.url && sub.url.includes(SUBSRC_KEY_PLACEHOLDER)) {
                return { ...sub, url: sub.url.replace(SUBSRC_KEY_PLACEHOLDER, encryptedSubsourceKey) };
            }
            return sub;
        });
    } else {
        result = cachedSubtitles.filter(sub =>
            !(sub.url && sub.url.includes(SUBSRC_HOST_MARKER) && sub.url.includes(SUBSRC_KEY_PLACEHOLDER))
        );
    }

    if (videoFilename) {
        try {
            const matcher = require('../utils/filenameMatcher');
            if (typeof matcher.sortByFilenameSimilarity === 'function') {
                result = matcher.sortByFilenameSimilarity(result, videoFilename, contentType);
            }
        } catch (err) {
            log('debug', `[L1] filename re-sort skipped: ${err.message}`);
        }
    }

    if (maxPerLang > 0) {
        const byLang = new Map();
        for (const s of result) {
            const lang = s.lang || 'und';
            if (!byLang.has(lang)) byLang.set(lang, []);
            byLang.get(lang).push(s);
        }
        const capped = [];
        for (const [, subs] of byLang) capped.push(...subs.slice(0, maxPerLang));
        result = capped;
    }

    return result;
}

/**
 * @returns {Promise<{subtitles: any[], status: 'fresh'|'stale', ageMs: number} | null>}
 */
async function get(cacheKey, ctx = {}) {
    const raw = await safe(r => r.get(redisKey(cacheKey)), null);
    if (!raw) return null;

    let entry;
    try {
        entry = JSON.parse(raw);
    } catch (err) {
        log('warn', `[L1] corrupt entry for ${cacheKey}: ${err.message}`);
        await safe(r => r.del(redisKey(cacheKey)), null);
        return null;
    }
    if (!entry || !Array.isArray(entry.subs)) return null;

    const ageMs = Date.now() - (entry.t || 0);
    return {
        subtitles: materialize(entry.subs, ctx),
        status: ageMs > STALE_AFTER_MS ? 'stale' : 'fresh',
        ageMs
    };
}

/** Store an already quality-sorted, placeholder-bearing list. */
async function set(cacheKey, subtitles) {
    if (!Array.isArray(subtitles) || subtitles.length === 0) return false;
    const payload = JSON.stringify({ t: Date.now(), subs: subtitles });
    const res = await safe(r => r.set(redisKey(cacheKey), payload, 'EX', TTL_SECONDS), null);
    return res === 'OK';
}

async function del(cacheKey) {
    return safe(r => r.del(redisKey(cacheKey)), 0);
}

/** Entry count and memory, for /metrics. Uses SCAN so it never blocks Redis. */
async function stats() {
    if (!isHealthy()) return { available: false, entries: 0 };
    try {
        let cursor = '0';
        let entries = 0;
        do {
            const [next, keys] = await redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 1000);
            cursor = next;
            entries += keys.length;
        } while (cursor !== '0');
        return { available: true, entries, ttlHours: TTL_MS / HOUR_MS, staleAfterHours: STALE_AFTER_MS / HOUR_MS };
    } catch (err) {
        return { available: false, entries: 0, error: err.message };
    }
}

module.exports = {
    buildKey, materialize, get, set, del, stats,
    SUBSRC_KEY_PLACEHOLDER, SUBSRC_HOST_MARKER,
    TTL_MS, STALE_AFTER_MS
};

/**
 * In-memory LRU cache for fully-built Stremio subtitle responses.
 *
 * Entries are stored quality-sorted with `__SUBSRC_KEY__` placeholders in
 * SubSource URLs. On read, entries are materialized for the requesting user:
 *   - if the user has a SubSource key configured, placeholders are rewritten;
 *   - otherwise SubSource entries are stripped from the response.
 *   - if a video filename is provided, results are re-sorted by filename
 *     similarity before being returned.
 *
 * Cache key shape:
 *   `${imdbId}:${season|0}:${episode|0}:${langA},${langB},...sorted`
 *
 * All operations are synchronous and never touch I/O. The cache is a pure
 * in-process LRU keyed on Map insertion order.
 */

const { log } = require('../../src/utils');

const SUBSRC_KEY_PLACEHOLDER = '__SUBSRC_KEY__';
const SUBSRC_HOST_MARKER = '/subsource/';

const HOUR_MS = 60 * 60 * 1000;

function intEnv(name, fallback) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

class ResponseCache {
    constructor(options = {}) {
        this.maxEntries = options.maxEntries ?? intEnv('L1_MAX_ENTRIES', 5000);
        this.ttlMs      = (options.ttlHours      ?? intEnv('L1_TTL_HOURS',       6)) * HOUR_MS;
        this.staleMs    = (options.staleTtlHours ?? intEnv('L1_STALE_TTL_HOURS', 4)) * HOUR_MS;

        /** @type {Map<string, {subtitles: any[], storedAt: number}>} */
        this._map = new Map();

        log('info', `[ResponseCache] initialized: max=${this.maxEntries} ttl=${this.ttlMs / HOUR_MS}h stale=${this.staleMs / HOUR_MS}h`);
    }

    static buildKey(imdbId, season, episode, languages, opts = {}) {
        const langs = (languages || []).slice().sort().join(',');
        const flags = opts.keepAss ? ':ass' : '';
        return `${imdbId}:${season || 0}:${episode || 0}:${langs}${flags}`;
    }

    /**
     * @param {string} key
     * @param {object} requestContext
     * @param {string|null} requestContext.encryptedSubsourceKey
     * @param {string|null} requestContext.videoFilename
     * @param {'series'|'movie'} [requestContext.contentType='series']
     * @returns {{subtitles: any[], status: 'fresh'|'stale'} | null}
     */
    get(key, requestContext = {}) {
        const entry = this._map.get(key);
        if (!entry) return null;

        const ageMs = Date.now() - entry.storedAt;

        if (ageMs > this.ttlMs) {
            this._map.delete(key);
            return null;
        }

        // LRU bump
        this._map.delete(key);
        this._map.set(key, entry);

        const subtitles = this._materializeForRequest(entry.subtitles, requestContext);
        const status = ageMs > (this.ttlMs - this.staleMs) ? 'stale' : 'fresh';

        return { subtitles, status };
    }

    /**
     * Store a response. Subtitles must already be quality-sorted and any
     * SubSource URLs must contain `SUBSRC_KEY_PLACEHOLDER` instead of the
     * encrypted user key.
     */
    set(key, subtitles) {
        if (!Array.isArray(subtitles)) return;

        while (this._map.size >= this.maxEntries) {
            const oldestKey = this._map.keys().next().value;
            if (oldestKey === undefined) break;
            this._map.delete(oldestKey);
        }

        this._map.set(key, {
            subtitles: subtitles.slice(),
            storedAt: Date.now()
        });
    }

    _materializeForRequest(cachedSubtitles, ctx) {
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
                const matcher = require('../../src/utils/filenameMatcher');
                if (typeof matcher.sortByFilenameSimilarity === 'function') {
                    result = matcher.sortByFilenameSimilarity(result, videoFilename, contentType);
                }
            } catch (err) {
                log('debug', `[ResponseCache] filename re-sort skipped: ${err.message}`);
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
            for (const [, subs] of byLang) {
                capped.push(...subs.slice(0, maxPerLang));
            }
            result = capped;
        }

        return result;
    }

    /**
     * Bulk-load entries for cold-start warmup. Each entry must be
     * `{ key, subtitles }`. Insertion sets `storedAt` to now.
     */
    warmup(entries) {
        if (!Array.isArray(entries)) return 0;
        let n = 0;
        for (const e of entries) {
            if (e && typeof e.key === 'string' && Array.isArray(e.subtitles)) {
                this.set(e.key, e.subtitles);
                n++;
            }
        }
        log('info', `[ResponseCache] warmup loaded ${n} entries`);
        return n;
    }

    delete(key) {
        return this._map.delete(key);
    }

    clear() {
        this._map.clear();
    }

    stats() {
        return {
            size: this._map.size,
            maxEntries: this.maxEntries,
            ttlMs: this.ttlMs,
            staleMs: this.staleMs
        };
    }
}

module.exports = ResponseCache;
module.exports.SUBSRC_KEY_PLACEHOLDER = SUBSRC_KEY_PLACEHOLDER;
module.exports.SUBSRC_HOST_MARKER = SUBSRC_HOST_MARKER;

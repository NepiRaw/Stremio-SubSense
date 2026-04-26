/**
 * Persistent subtitle cache backed by SQLite (JSON-blob storage).
 *
 * One row per (imdb_id, season, episode, lang_key). Stored entries are
 * already quality-sorted and contain `__SUBSRC_KEY__` placeholders in any
 * SubSource URLs (see ResponseCache for the in-memory contract).
 *
 * On the request path, writes are typically fire-and-forget: the route
 * handler should not await `set()` since persistence must never delay the
 * subtitle response. Reads are normally only used at startup warmup and on
 * L1 misses.
 */

const db = require('./database-libsql');
const { log } = require('../../src/utils');

const DAY_S = 24 * 60 * 60;

function intEnv(name, fallback) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

class SubtitleCache {
    constructor(options = {}) {
        this.ttlSeconds = (options.ttlDays ?? intEnv('L2_TTL_DAYS', 7)) * DAY_S;
    }

    /**
     * Build a stable lang_key matching the L1 cache key suffix.
     */
    static buildLangKey(languages) {
        return (languages || []).slice().sort().join(',');
    }

    /**
     * @returns {Promise<{subtitles: any[], ageSeconds: number} | null>}
     */
    async get(imdbId, season, episode, languages) {
        const langKey = SubtitleCache.buildLangKey(languages);
        try {
            const result = await db.execute(`
                SELECT subtitles, updated_at,
                       (strftime('%s','now') - updated_at) AS age_seconds
                FROM subtitle_cache
                WHERE imdb_id = ? AND season = ? AND episode = ? AND lang_key = ?
            `, [imdbId, season || 0, episode || 0, langKey]);

            if (result.rows.length === 0) return null;

            const row = result.rows[0];
            const ageSeconds = Number(row.age_seconds) || 0;

            if (ageSeconds > this.ttlSeconds) {
                return null;
            }

            let subtitles;
            try {
                subtitles = JSON.parse(row.subtitles);
            } catch (err) {
                log('warn', `[L2] corrupt JSON for ${imdbId}/${langKey}: ${err.message}`);
                return null;
            }

            if (!Array.isArray(subtitles)) return null;
            return { subtitles, ageSeconds };
        } catch (err) {
            log('error', `[L2] get failed: ${err.message}`);
            return null;
        }
    }

    /**
     * Upsert a JSON blob. `subtitles` must be quality-sorted with
     * `__SUBSRC_KEY__` placeholders already applied.
     */
    async set(imdbId, season, episode, languages, subtitles) {
        if (!Array.isArray(subtitles) || subtitles.length === 0) return;

        const langKey = SubtitleCache.buildLangKey(languages);
        const payload = JSON.stringify(subtitles);

        try {
            await db.execute(`
                INSERT INTO subtitle_cache (imdb_id, season, episode, lang_key, subtitles, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))
                ON CONFLICT (imdb_id, season, episode, lang_key) DO UPDATE SET
                    subtitles  = excluded.subtitles,
                    updated_at = strftime('%s','now')
            `, [imdbId, season || 0, episode || 0, langKey, payload]);
        } catch (err) {
            log('error', `[L2] set failed: ${err.message}`);
        }
    }

    /**
     * Stream non-expired rows for cold-start warmup (capped at 2000 most recent).
     * @returns {Promise<Array<{key: string, subtitles: any[]}>>}
     */
    async loadAllForWarmup() {
        try {
            const result = await db.execute(`
                SELECT imdb_id, season, episode, lang_key, subtitles
                FROM subtitle_cache
                WHERE updated_at > (strftime('%s','now') - ?)
                ORDER BY updated_at DESC
                LIMIT 2000
            `, [this.ttlSeconds]);

            const out = [];
            for (const row of result.rows) {
                let subs;
                try {
                    subs = JSON.parse(row.subtitles);
                } catch {
                    continue;
                }
                if (!Array.isArray(subs)) continue;

                const key = `${row.imdb_id}:${row.season || 0}:${row.episode || 0}:${row.lang_key}`;
                out.push({ key, subtitles: subs });
            }
            return out;
        } catch (err) {
            log('error', `[L2] warmup load failed: ${err.message}`);
            return [];
        }
    }

    /**
     * Count rows past the retention TTL. Worker-side helper.
     */
    async countExpired() {
        const result = await db.execute(`
            SELECT COUNT(*) AS n FROM subtitle_cache
            WHERE updated_at < (strftime('%s','now') - ?)
        `, [this.ttlSeconds]);
        return Number(result.rows[0]?.n) || 0;
    }
}

module.exports = SubtitleCache;

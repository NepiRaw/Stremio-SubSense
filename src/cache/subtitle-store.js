'use strict';

/**
 * L2 subtitle cache on cache.db. Durability and cold-start source behind the Redis L1.
 * Writes on the request path are fire-and-forget; reads are only reached on an L1 miss.
 */

const { cacheDb } = require('../infra/db');
const { log } = require('../utils');
const { sameLanguage } = require('../languages');

const DAY_S = 24 * 60 * 60;

function intEnv(name, fallback) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

const TTL_SECONDS = intEnv('L2_TTL_DAYS', 7) * DAY_S;

function buildLangKey(languages) {
    return (languages || []).slice().sort().join(',');
}

async function get(imdbId, season, episode, languages) {
    const langKey = buildLangKey(languages);
    try {
        const result = await cacheDb.execute({
            sql: `SELECT subtitles, (strftime('%s','now') - updated_at) AS age_seconds
                  FROM subtitle_cache
                  WHERE imdb_id = ? AND season = ? AND episode = ? AND lang_key = ?`,
            args: [imdbId, season || 0, episode || 0, langKey]
        });
        if (result.rows.length === 0) return null;

        const row = result.rows[0];
        const ageSeconds = Number(row.age_seconds) || 0;
        if (ageSeconds > TTL_SECONDS) return null;

        const subtitles = JSON.parse(row.subtitles);
        if (!Array.isArray(subtitles)) return null;
        return { subtitles, ageSeconds };
    } catch (err) {
        log('error', `[L2] get failed: ${err.message}`);
        return null;
    }
}

/**
 * Language-agnostic lookup: merge every non-expired row for this content, dedupe by id,
 * then keep only the requested languages.
 */
async function getByContent(imdbId, season, episode, languages) {
    try {
        const result = await cacheDb.execute({
            sql: `SELECT subtitles, (strftime('%s','now') - updated_at) AS age_seconds
                  FROM subtitle_cache
                  WHERE imdb_id = ? AND season = ? AND episode = ?
                    AND updated_at > (strftime('%s','now') - ?)
                  ORDER BY updated_at DESC`,
            args: [imdbId, season || 0, episode || 0, TTL_SECONDS]
        });
        if (result.rows.length === 0) return null;

        const wanted = (languages || []).filter(Boolean);
        const seenIds = new Set();
        const merged = [];
        let minAge = Infinity;

        for (const row of result.rows) {
            const age = Number(row.age_seconds) || 0;
            if (age < minAge) minAge = age;

            let subs;
            try { subs = JSON.parse(row.subtitles); } catch { continue; }
            if (!Array.isArray(subs)) continue;

            for (const sub of subs) {
                if (!sub.id || seenIds.has(sub.id)) continue;
                if (sub.lang && wanted.some(l => sameLanguage(l, sub.lang))) {
                    seenIds.add(sub.id);
                    merged.push(sub);
                }
            }
        }

        if (merged.length === 0) return null;
        return { subtitles: merged, ageSeconds: minAge };
    } catch (err) {
        log('error', `[L2] getByContent failed: ${err.message}`);
        return null;
    }
}

function countsOf(subtitles, sign) {
    const out = Object.create(null);
    for (const s of subtitles || []) {
        if (s.source) out[`source:${s.source}`] = (out[`source:${s.source}`] || 0) + sign;
        if (s.lang) out[`lang:${s.lang}`] = (out[`lang:${s.lang}`] || 0) + sign;
    }
    return out;
}

/**
 * Upsert an entry and return the net change in cache composition, so counters stay exact
 * when a row replaces an older one.
 */
async function set(imdbId, season, episode, languages, subtitles) {
    if (!Array.isArray(subtitles) || subtitles.length === 0) return null;
    const langKey = buildLangKey(languages);
    let delta = countsOf(subtitles, 1);
    try {
        const prev = await cacheDb.execute({
            sql: 'SELECT subtitles FROM subtitle_cache WHERE imdb_id = ? AND season = ? AND episode = ? AND lang_key = ?',
            args: [imdbId, season || 0, episode || 0, langKey]
        });
        if (prev.rows.length > 0) {
            try {
                const old = JSON.parse(prev.rows[0].subtitles);
                if (Array.isArray(old)) {
                    for (const [k, v] of Object.entries(countsOf(old, -1))) {
                        delta[k] = (delta[k] || 0) + v;
                        if (delta[k] === 0) delete delta[k];
                    }
                }
            } catch (_) { /* an unreadable old blob just leaves the delta positive */ }
        }

        await cacheDb.execute({
            sql: `INSERT INTO subtitle_cache (imdb_id, season, episode, lang_key, subtitles, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))
                  ON CONFLICT (imdb_id, season, episode, lang_key) DO UPDATE SET
                      subtitles  = excluded.subtitles,
                      updated_at = strftime('%s','now')`,
            args: [imdbId, season || 0, episode || 0, langKey, JSON.stringify(subtitles)]
        });
        return delta;
    } catch (err) {
        log('error', `[L2] set failed: ${err.message}`);
        return null;
    }
}

/** Delete one expired batch. Returns rows removed, so the caller can loop within a budget. */
async function deleteExpiredBatch(limit = 500) {
    const result = await cacheDb.execute({
        sql: `DELETE FROM subtitle_cache
              WHERE rowid IN (
                  SELECT rowid FROM subtitle_cache
                  WHERE updated_at < (strftime('%s','now') - ?)
                  LIMIT ?
              )`,
        args: [TTL_SECONDS, limit]
    });
    return Number(result.rowsAffected) || 0;
}

/** Expired rows with their blobs, so a caller can decrement source counters before deleting. */
async function selectExpiredBatch(limit = 500) {
    const result = await cacheDb.execute({
        sql: `SELECT rowid AS rid, subtitles FROM subtitle_cache
              WHERE updated_at < (strftime('%s','now') - ?) LIMIT ?`,
        args: [TTL_SECONDS, limit]
    });
    return result.rows.map(r => ({ rid: Number(r.rid), subtitles: r.subtitles }));
}

async function deleteByRowIds(rowIds) {
    if (!rowIds || rowIds.length === 0) return 0;
    const placeholders = rowIds.map(() => '?').join(',');
    const result = await cacheDb.execute({
        sql: `DELETE FROM subtitle_cache WHERE rowid IN (${placeholders})`,
        args: rowIds
    });
    return Number(result.rowsAffected) || 0;
}

async function countExpired() {
    const result = await cacheDb.execute({
        sql: `SELECT COUNT(*) AS n FROM subtitle_cache WHERE updated_at < (strftime('%s','now') - ?)`,
        args: [TTL_SECONDS]
    });
    return Number(result.rows[0]?.n) || 0;
}

async function count() {
    const result = await cacheDb.execute('SELECT COUNT(*) AS n FROM subtitle_cache');
    return Number(result.rows[0]?.n) || 0;
}

module.exports = {
    buildLangKey, get, getByContent, set, countsOf,
    deleteExpiredBatch, selectExpiredBatch, deleteByRowIds,
    countExpired, count, TTL_SECONDS
};

'use strict';

/**
 * Persistent statistics
 */

const { statsDb, cacheDb } = require('../infra/db');
const contentLog = require('./content-log');
const { log } = require('../../src/utils');

const db = { execute: (sql, args = []) => statsDb.execute({ sql, args }) };
const cache = { execute: (sql, args = []) => cacheDb.execute({ sql, args }) };

let _toAlpha3B = null;
function toAlpha3B(code) {
    if (!_toAlpha3B) {
        try { _toAlpha3B = require('../../src/languages').toAlpha3B; }
        catch (_) { _toAlpha3B = (c) => c; }
    }
    return _toAlpha3B(code);
}

function intEnv(name, fallback) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

const SOURCE_SCAN_BATCH        = intEnv('STATS_SOURCE_SCAN_BATCH', 2000);
const SOURCE_SCAN_INTERVAL_MS  = intEnv('STATS_SOURCE_SCAN_INTERVAL_MS', 6 * 60 * 60 * 1000);
const LOG_RETENTION_DAYS       = intEnv('STATS_LOG_RETENTION_DAYS', 30);
const LOG_PRUNE_BATCH          = intEnv('STATS_LOG_PRUNE_BATCH', 5000);

function getLocalDateString() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

class StatsDBAsync {
    constructor() {
        this._lastSourceScanAt = 0;
    }

    /* ------------------------------------------------------------------ */
    /*  Counter helpers (full mode only)                                   */
    /* ------------------------------------------------------------------ */


    async get(key) {
        try {
            const r = await db.execute('SELECT stat_value FROM stats WHERE stat_key = ?', [key]);
            return r.rows[0]?.stat_value || 0;
        } catch (err) {
            log('error', `[StatsDB] get error: ${err.message}`);
            return 0;
        }
    }

    async getAll() {
        try {
            const r = await db.execute('SELECT stat_key, stat_value FROM stats');
            const out = {};
            for (const row of r.rows) out[row.stat_key] = row.stat_value;
            return out;
        } catch (err) {
            log('error', `[StatsDB] getAll error: ${err.message}`);
            return {};
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Daily aggregates                                                   */
    /* ------------------------------------------------------------------ */


    async getDailyStats(days = 7) {
        try {
            const r = await db.execute(`
                SELECT * FROM stats_daily
                WHERE date >= date('now', '-' || ? || ' days')
                ORDER BY date DESC
            `, [days]);
            return r.rows;
        } catch (err) {
            log('error', `[StatsDB] getDailyStats error: ${err.message}`);
            return [];
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Request log                                                        */
    /* ------------------------------------------------------------------ */



    async getCacheHitRate() {
        const hits = await this.get('cache_hits');
        const misses = await this.get('cache_misses');
        const total = hits + misses;
        return { hits, misses, rate: total > 0 ? (hits / total * 100).toFixed(1) : 0 };
    }

    /* ------------------------------------------------------------------ */
    /*  Provider stats                                                     */
    /* ------------------------------------------------------------------ */


    async getProviderStats(days = 7) {
        try {
            const r = await db.execute(`
                SELECT provider_name,
                       SUM(total_requests) as total_requests,
                       SUM(successful_requests) as successful_requests,
                       SUM(failed_requests) as failed_requests,
                       ROUND(AVG(avg_response_ms)) as avg_response_ms,
                       SUM(subtitles_returned) as subtitles_returned,
                       SUM(requests_with_results) as requests_with_results,
                       SUM(CASE WHEN requests_with_results IS NOT NULL THEN successful_requests ELSE 0 END) as tracked_requests,
                       MAX(last_success_at) as last_success_at,
                       ROUND(SUM(successful_requests) * 100.0 / NULLIF(SUM(total_requests), 0), 1) as success_rate,
                       ROUND(
                           SUM(requests_with_results) * 100.0 /
                           NULLIF(SUM(CASE WHEN requests_with_results IS NOT NULL THEN successful_requests ELSE 0 END), 0)
                       , 1) as matching_rate
                FROM provider_stats
                WHERE date >= date('now', '-' || ? || ' days')
                GROUP BY provider_name
                ORDER BY total_requests DESC
            `, [days]);
            return r.rows;
        } catch (err) {
            log('error', `[StatsDB] getProviderStats error: ${err.message}`);
            return [];
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Language stats                                                      */
    /* ------------------------------------------------------------------ */


    async getLanguageStats(days = 7) {
        try {
            const r = await db.execute(`
                SELECT language_code,
                       SUM(requests_for) as total_requests,
                       SUM(found_count) as found_count,
                       SUM(not_found_count) as not_found_count,
                       ROUND(SUM(found_count) * 100.0 / NULLIF(SUM(requests_for), 0), 1) as availability_rate
                FROM language_stats
                WHERE date >= date('now', '-' || ? || ' days')
                GROUP BY language_code
                ORDER BY total_requests DESC
            `, [days]);
            return r.rows;
        } catch (err) {
            log('error', `[StatsDB] getLanguageStats error: ${err.message}`);
            return [];
        }
    }

    async getLanguageMatchSummary(days = 30) {
        try {
            const [aggResult, perLangResult] = await Promise.all([
                db.execute(`
                    SELECT SUM(found_count) as found, SUM(not_found_count) as not_found,
                           SUM(requests_for) as total_requests
                    FROM language_stats WHERE date >= date('now', '-' || ? || ' days')
                `, [days]),
                db.execute(`
                    SELECT language_code,
                           SUM(found_count) as found, SUM(not_found_count) as not_found,
                           SUM(requests_for) as total_requests,
                           ROUND(SUM(found_count) * 100.0 / NULLIF(SUM(requests_for), 0), 1) as success_rate
                    FROM language_stats WHERE date >= date('now', '-' || ? || ' days')
                    GROUP BY language_code ORDER BY total_requests DESC
                `, [days])
            ]);
            const agg = aggResult.rows[0];
            const total = agg?.total_requests || 0;
            const found = agg?.found || 0;
            const notFound = agg?.not_found || 0;
            return {
                totalRequests: total, found, notFound,
                successRate: total > 0 ? Math.round((found / total) * 100) : 0,
                perLanguage: perLangResult.rows
            };
        } catch (err) {
            log('error', `[StatsDB] getLanguageMatchSummary error: ${err.message}`);
            return { totalRequests: 0, found: 0, notFound: 0, successRate: 0, perLanguage: [] };
        }
    }

    async getTopSuccessfulLanguages(days = 30, limit = 10) {
        try {
            const r = await db.execute(`
                SELECT language_code, SUM(found_count) as found_count
                FROM language_stats
                WHERE date >= date('now', '-' || ? || ' days') AND found_count > 0
                GROUP BY language_code ORDER BY found_count DESC LIMIT ?
            `, [days, limit]);
            const out = {};
            r.rows.forEach(row => { out[row.language_code.toUpperCase()] = row.found_count; });
            return out;
        } catch (err) {
            log('error', `[StatsDB] getTopSuccessfulLanguages error: ${err.message}`);
            return {};
        }
    }



    /* ------------------------------------------------------------------ */
    /*  Cache stats summary                                                */
    /* ------------------------------------------------------------------ */



    _defaultCacheStats() {
        return {
            entries: 0, uniqueContent: 0, uniqueLanguages: 0, uniqueSources: 0,
            sizeMB: '0', oldestAge: 0, newestAge: 0, avgAgeHours: 0,
            hitRate: 0, hits: 0, misses: 0, fromSummary: false
        };
    }




    /* ------------------------------------------------------------------ */
    /*  Content cache browser                                              */
    /* ------------------------------------------------------------------ */

    async getContentCacheSummary(options = {}) {
        const page  = Math.max(1, parseInt(options.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 20));
        const offset = (page - 1) * limit;
        try {
            const totalR = await cache.execute('SELECT COUNT(DISTINCT imdb_id) AS n FROM subtitle_cache');
            const total = totalR.rows[0]?.n || 0;

            // Get grouped content keys first
            const keysR = await cache.execute(`
                SELECT imdb_id, season, episode, MAX(updated_at) as last_updated
                FROM subtitle_cache
                GROUP BY imdb_id, season, episode
                ORDER BY MAX(updated_at) DESC
                LIMIT ? OFFSET ?
            `, [limit, offset]);

            // For each content key, get all lang rows to compute real counts
            const items = [];
            for (const key of keysR.rows) {
                const rowsR = await cache.execute(`
                    SELECT lang_key, subtitles FROM subtitle_cache
                    WHERE imdb_id = ? AND season = ? AND episode = ?
                `, [key.imdb_id, key.season, key.episode]);

                let totalSubs = 0;
                const sources = new Set();
                const langKeys = new Set();

                for (const row of rowsR.rows) {
                    if (row.lang_key) {
                        for (const l of row.lang_key.split(',')) {
                            const t = l.trim();
                            if (t) langKeys.add(t);
                        }
                    }
                    try {
                        const subs = JSON.parse(row.subtitles || '[]');
                        totalSubs += subs.length;
                        for (const s of subs) {
                            if (s.source) sources.add(s.source);
                        }
                    } catch (_) {}
                }

                items.push({
                    imdb_id: key.imdb_id,
                    season: key.season === 0 ? null : key.season,
                    episode: key.episode === 0 ? null : key.episode,
                    languages_cached: [...langKeys].join(', '),
                    total_subtitles: totalSubs,
                    sources: sources.size > 0 ? [...sources].join(', ') : null,
                    last_updated: key.last_updated
                });
            }
            return { items, total, page, limit };
        } catch (err) {
            log('error', `[StatsDB] getContentCacheSummary error: ${err.message}`);
            return { items: [], total: 0, page, limit };
        }
    }

    async searchCacheByImdb(imdbId) {
        try {
            const r = await cache.execute(`
                SELECT imdb_id, season, episode, lang_key, subtitles, updated_at
                FROM subtitle_cache WHERE imdb_id = ?
                ORDER BY season, episode, lang_key
            `, [imdbId]);
            if (r.rows.length === 0) return null;

            let totalSubtitles = 0;
            const allSources = new Set();
            const allLangs = new Set();
            const breakdown = [];

            for (const row of r.rows) {
                try {
                    const subs = JSON.parse(row.subtitles || '[]');
                    const langBuckets = {};
                    for (const s of subs) {
                        const lang = s.lang || 'unknown';
                        if (!langBuckets[lang]) langBuckets[lang] = { count: 0, sources: new Set() };
                        langBuckets[lang].count++;
                        if (s.source) { langBuckets[lang].sources.add(s.source); allSources.add(s.source); }
                    }
                    totalSubtitles += subs.length;
                    for (const [lang, info] of Object.entries(langBuckets)) {
                        allLangs.add(lang);
                        breakdown.push({
                            imdb_id: row.imdb_id,
                            season: row.season === 0 ? null : row.season,
                            episode: row.episode === 0 ? null : row.episode,
                            language: lang,
                            subtitle_count: info.count,
                            sources: info.sources.size > 0 ? [...info.sources].join(',') : null,
                            last_updated: row.updated_at
                        });
                    }
                } catch (_) {}
            }

            return {
                imdbId,
                totalSubtitles,
                uniqueLanguages: allLangs.size,
                sources: [...allSources],
                breakdown,
                lastUpdated: Math.max(...r.rows.map(row => row.updated_at))
            };
        } catch (err) {
            log('error', `[StatsDB] searchCacheByImdb error: ${err.message}`);
            return null;
        }
    }

    /* ------------------------------------------------------------------ */
    /*  User / session tracking (works in both full AND minimal modes)    */
    /* ------------------------------------------------------------------ */



    /* ------------------------------------------------------------------ */
    /*  Cache composition                                                  */
    /* ------------------------------------------------------------------ */

    /** Source and language distribution come from counters maintained at write time. */
    async getDistribution() {
        try {
            const r = await db.execute('SELECT kind, key, count FROM dist WHERE count > 0');
            const source = {};
            const language = {};
            for (const row of r.rows) {
                const target = row.kind === 'source' ? source : row.kind === 'lang' ? language : null;
                if (target) target[row.key] = row.count;
            }
            return { source, language };
        } catch (err) {
            log('error', `[StatsDB] getDistribution error: ${err.message}`);
            return { source: {}, language: {} };
        }
    }

    async getCacheStats() {
        try {
            const [counts, size, age, dist, hr] = await Promise.all([
                cache.execute('SELECT COUNT(*) AS total_entries, COUNT(DISTINCT imdb_id) AS unique_content FROM subtitle_cache'),
                cache.execute('SELECT page_count * page_size AS size_bytes FROM pragma_page_count(), pragma_page_size()'),
                cache.execute(`SELECT MIN(updated_at) AS oldest_timestamp, MAX(updated_at) AS newest_timestamp,
                                      AVG(strftime('%s','now') - updated_at) AS avg_age_seconds FROM subtitle_cache`),
                this.getDistribution(),
                this.getCacheHitRate()
            ]);
            const c = counts.rows[0] || {};
            const s = size.rows[0] || {};
            const a = age.rows[0] || {};
            const nowSec = Math.floor(Date.now() / 1000);
            return {
                entries: c.total_entries || 0,
                uniqueContent: c.unique_content || 0,
                uniqueLanguages: Object.keys(dist.language).length,
                uniqueSources: Object.keys(dist.source).length,
                sizeMB: s.size_bytes ? (s.size_bytes / 1024 / 1024).toFixed(2) : '0',
                oldestAge: a.oldest_timestamp ? nowSec - a.oldest_timestamp : 0,
                newestAge: a.newest_timestamp ? nowSec - a.newest_timestamp : 0,
                avgAgeHours: a.avg_age_seconds ? Math.round(a.avg_age_seconds / 3600) : 0,
                hitRate: hr.rate,
                hits: hr.hits,
                misses: hr.misses,
                sourceDistribution: dist.source,
                languageDistribution: dist.language,
                lastUpdated: new Date().toISOString(),
                fromSummary: false
            };
        } catch (err) {
            log('error', `[StatsDB] getCacheStats error: ${err.message}`);
            return this._defaultCacheStats();
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Readers backed by rollups and the rotating content log             */
    /* ------------------------------------------------------------------ */

    async getLanguageSuccessRates(days = 30) {
        try {
            const r = await db.execute(`
                SELECT SUM(pref_tracked) AS tracked,
                       SUM(any_pref_found) AS any_found,
                       SUM(all_pref_found) AS all_found
                FROM stats_daily
                WHERE date >= date('now', '-' || ? || ' days') AND pref_tracked > 0
            `, [days]);
            const row = r.rows[0] || {};
            const tracked = row.tracked || 0;
            return {
                totalRequests: tracked,
                anyPreferredRate: tracked > 0 ? Math.round((row.any_found || 0) / tracked * 100) : 0,
                allPreferredRate: tracked > 0 ? Math.round((row.all_found || 0) / tracked * 100) : 0
            };
        } catch (err) {
            log('error', `[StatsDB] getLanguageSuccessRates error: ${err.message}`);
            return { totalRequests: 0, anyPreferredRate: 0, allPreferredRate: 0 };
        }
    }

    async getPopularLanguageCombinations(days = 30, limit = 10) {
        try {
            const r = await db.execute(`
                SELECT combo, SUM(count) AS count FROM lang_combos
                WHERE date >= date('now', '-' || ? || ' days')
                GROUP BY combo ORDER BY count DESC LIMIT ?
            `, [days, limit]);
            return r.rows.map(row => ({
                languages: row.combo.split(',').map(l => (toAlpha3B(l) || l).toUpperCase()).sort().join(', '),
                count: row.count
            }));
        } catch (err) {
            log('error', `[StatsDB] getPopularLanguageCombinations error: ${err.message}`);
            return [];
        }
    }

    async getRecentRequests(limit = 100) {
        return contentLog.recent(limit);
    }

    async getUserContent(userId, limit = 10) {
        return contentLog.forUser(userId, limit);
    }

    async getUserStats(userId) {
        try {
            const r = await db.execute('SELECT * FROM user_tracking WHERE user_id = ?', [userId]);
            const u = r.rows[0];
            if (!u) return null;
            return {
                sessionId: u.user_id,
                languages: JSON.parse(u.languages || '[]'),
                totalRequests: u.total_requests,
                movieRequests: u.movie_requests,
                seriesRequests: u.series_requests,
                firstSeen: new Date(u.first_seen * 1000),
                lastActive: new Date(u.last_active * 1000)
            };
        } catch (err) {
            log('error', `[StatsDB] getUserStats error: ${err.message}`);
            return null;
        }
    }


    async getActiveUsersCount(days = 30) {
        try {
            const secs = days * 86400;
            const r = await db.execute(
                "SELECT COUNT(*) as count FROM user_tracking WHERE last_active > strftime('%s','now') - ?",
                [secs]
            );
            return r.rows[0]?.count || 0;
        } catch (err) {
            log('error', `[StatsDB] getActiveUsersCount error: ${err.message}`);
            return 0;
        }
    }

    async getActiveUsersInWindow(startDaysAgo, endDaysAgo) {
        try {
            const now = Math.floor(Date.now() / 1000);
            const wStart = now - startDaysAgo * 86400;
            const wEnd   = now - endDaysAgo * 86400;
            const r = await db.execute(
                'SELECT COUNT(*) as count FROM user_tracking WHERE last_active <= ? AND last_active > ?',
                [wEnd, wStart]
            );
            return r.rows[0]?.count || 0;
        } catch (err) {
            log('error', `[StatsDB] getActiveUsersInWindow error: ${err.message}`);
            return 0;
        }
    }

    async getActiveUsersOnDay(startTs, endTs) {
        try {
            const r = await db.execute(
                'SELECT COUNT(*) as count FROM user_tracking WHERE last_active >= ? AND last_active < ?',
                [startTs, endTs]
            );
            return r.rows[0]?.count || 0;
        } catch (err) {
            log('error', `[StatsDB] getActiveUsersOnDay error: ${err.message}`);
            return 0;
        }
    }

    async getAggregateUserStats() {
        try {
            const r = await db.execute(`
                SELECT COUNT(*) as total_users, SUM(total_requests) as total_requests,
                       SUM(movie_requests) as movie_requests, SUM(series_requests) as series_requests,
                       AVG(total_requests) as avg_requests_per_user
                FROM user_tracking
            `);
            const s = r.rows[0];
            const [d7, d30, d60] = await Promise.all([
                this.getActiveUsersCount(7),
                this.getActiveUsersCount(30),
                this.getActiveUsersCount(60)
            ]);
            return {
                totalSessions: s?.total_users || 0,
                totalRequests: s?.total_requests || 0,
                movieRequests: s?.movie_requests || 0,
                seriesRequests: s?.series_requests || 0,
                avgRequestsPerSession: Math.round(s?.avg_requests_per_user || 0),
                activeSessions: { last7Days: d7, last30Days: d30, last60Days: d60 }
            };
        } catch (err) {
            log('error', `[StatsDB] getAggregateUserStats error: ${err.message}`);
            return {
                totalSessions: 0, totalRequests: 0, movieRequests: 0, seriesRequests: 0,
                avgRequestsPerSession: 0, activeSessions: { last7Days: 0, last30Days: 0, last60Days: 0 }
            };
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Minimal-mode helpers (lightweight user counts for /configure)      */
    /* ------------------------------------------------------------------ */

    /**
     * Returns { totalUsers, activeUsers } where activeUsers = sessions
     * active in the last `windowMinutes` (default 15).
     */
    async getUserCounts(windowMinutes = 15) {
        const THIRTY_DAYS_SECS = 30 * 24 * 60 * 60;
        try {
            const windowSecs = windowMinutes * 60;
            const r = await db.execute(`
                SELECT COUNT(*) as total,
                       SUM(CASE WHEN last_active > strftime('%s','now') - ? THEN 1 ELSE 0 END) as active
                FROM user_tracking
                WHERE last_active > strftime('%s','now') - ?
            `, [windowSecs, THIRTY_DAYS_SECS]);
            const row = r.rows[0];
            return {
                totalUsers: row?.total || 0,
                activeUsers: row?.active || 0
            };
        } catch (err) {
            log('error', `[StatsDB] getUserCounts error: ${err.message}`);
            return { totalUsers: 0, activeUsers: 0 };
        }
    }

    /**
     * Remove users who haven't been active in the last 30 days.
     */
    async cleanupInactiveUsers() {
        const THIRTY_DAYS_SECS = 30 * 24 * 60 * 60;
        try {
            const r = await db.execute(`
                DELETE FROM user_tracking WHERE last_active <= strftime('%s','now') - ?
            `, [THIRTY_DAYS_SECS]);
            const deleted = r.rowsAffected || 0;
            if (deleted > 0) {
                log('info', `[StatsDB] Cleaned up ${deleted} inactive users (>30 days)`);
            }
            return deleted;
        } catch (err) {
            log('error', `[StatsDB] cleanupInactiveUsers error: ${err.message}`);
            return 0;
        }
    }

}

module.exports = StatsDBAsync;

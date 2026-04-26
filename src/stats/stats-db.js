'use strict';

/**
 * Persistent statistics
 */

const db = require('../cache/database-libsql');
const { log } = require('../../src/utils');

let _toAlpha3B = null;
function toAlpha3B(code) {
    if (!_toAlpha3B) {
        try { _toAlpha3B = require('../../src/languages').toAlpha3B; }
        catch (_) { _toAlpha3B = (c) => c; }
    }
    return _toAlpha3B(code);
}

function getLocalDateString() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

class StatsDBAsync {
    /**
     * @param {() => boolean} writesEnabled  - returns true when full writes are permitted
     * @param {() => boolean} minimalEnabled - returns true when at least minimal tracking is on
     */
    constructor(writesEnabled, minimalEnabled) {
        this._writesEnabled  = writesEnabled  || (() => true);
        this._minimalEnabled = minimalEnabled || (() => true);
    }

    /* ------------------------------------------------------------------ */
    /*  Counter helpers (full mode only)                                   */
    /* ------------------------------------------------------------------ */

    async increment(key, amount = 1) {
        if (!this._writesEnabled()) return;
        try {
            await db.execute(`
                INSERT INTO stats (stat_key, stat_value, updated_at)
                VALUES (?, ?, strftime('%s','now'))
                ON CONFLICT(stat_key) DO UPDATE SET
                    stat_value = stat_value + ?,
                    updated_at = strftime('%s','now')
            `, [key, amount, amount]);
        } catch (err) {
            log('error', `[StatsDB] increment error: ${err.message}`);
        }
    }

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

    async recordDaily(data) {
        if (!this._writesEnabled()) return;
        const today = getLocalDateString();
        try {
            await db.execute(`
                INSERT INTO stats_daily (date, requests, cache_hits, cache_misses, conversions, movies, series)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(date) DO UPDATE SET
                    requests = requests + ?,
                    cache_hits = cache_hits + ?,
                    cache_misses = cache_misses + ?,
                    conversions = conversions + ?,
                    movies = movies + ?,
                    series = series + ?
            `, [
                today,
                data.requests || 0, data.cacheHits || 0, data.cacheMisses || 0,
                data.conversions || 0, data.movies || 0, data.series || 0,
                data.requests || 0, data.cacheHits || 0, data.cacheMisses || 0,
                data.conversions || 0, data.movies || 0, data.series || 0
            ]);
        } catch (err) {
            log('error', `[StatsDB] recordDaily error: ${err.message}`);
        }
    }

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

    async logRequest(data) {
        if (!this._writesEnabled()) return;
        try {
            const normalizedLanguages = (data.languages || [])
                .map(lang => toAlpha3B(lang) || lang.toLowerCase())
                .sort();
            await db.execute(`
                INSERT INTO request_log
                    (imdb_id, content_type, languages, result_count, cache_hit, response_time_ms, any_preferred_found, all_preferred_found)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                data.imdbId, data.contentType, JSON.stringify(normalizedLanguages),
                data.resultCount || 0, data.cacheHit ? 1 : 0, data.responseTimeMs || 0,
                data.anyPreferredFound ? 1 : 0, data.allPreferredFound ? 1 : 0
            ]);
        } catch (err) {
            log('error', `[StatsDB] logRequest error: ${err.message}`);
        }
    }

    async getRecentRequests(limit = 100) {
        try {
            const r = await db.execute('SELECT * FROM request_log ORDER BY created_at DESC LIMIT ?', [limit]);
            return r.rows;
        } catch (err) {
            log('error', `[StatsDB] getRecentRequests error: ${err.message}`);
            return [];
        }
    }

    async getCacheHitRate() {
        const hits = await this.get('cache_hits');
        const misses = await this.get('cache_misses');
        const total = hits + misses;
        return { hits, misses, rate: total > 0 ? (hits / total * 100).toFixed(1) : 0 };
    }

    /* ------------------------------------------------------------------ */
    /*  Provider stats                                                     */
    /* ------------------------------------------------------------------ */

    async recordProviderStats(data) {
        if (!this._writesEnabled()) return;
        const today = getLocalDateString();
        const success = data.success ? 1 : 0;
        const failure = data.success ? 0 : 1;
        const responseMs = data.responseMs || 0;
        const subsCount = data.subtitlesCount || 0;
        try {
            await db.execute(`
                INSERT INTO provider_stats
                    (provider_name, date, total_requests, successful_requests, failed_requests, avg_response_ms, subtitles_returned)
                VALUES (?, ?, 1, ?, ?, ?, ?)
                ON CONFLICT(provider_name, date) DO UPDATE SET
                    total_requests = total_requests + 1,
                    successful_requests = successful_requests + ?,
                    failed_requests = failed_requests + ?,
                    avg_response_ms = (avg_response_ms * total_requests + ?) / (total_requests + 1),
                    subtitles_returned = subtitles_returned + ?
            `, [
                data.providerName, today, success, failure, responseMs, subsCount,
                success, failure, responseMs, subsCount
            ]);
        } catch (err) {
            log('error', `[StatsDB] recordProviderStats error: ${err.message}`);
        }
    }

    async getProviderStats(days = 7) {
        try {
            const r = await db.execute(`
                SELECT provider_name,
                       SUM(total_requests) as total_requests,
                       SUM(successful_requests) as successful_requests,
                       SUM(failed_requests) as failed_requests,
                       ROUND(AVG(avg_response_ms)) as avg_response_ms,
                       SUM(subtitles_returned) as subtitles_returned,
                       ROUND(SUM(successful_requests) * 100.0 / NULLIF(SUM(total_requests), 0), 1) as success_rate
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

    async recordLanguageStats(data) {
        if (!this._writesEnabled()) return;
        const today = getLocalDateString();
        try {
            await db.execute(`
                INSERT INTO language_stats (language_code, date, priority, requests_for, found_count, not_found_count)
                VALUES (?, ?, 'preferred', 1, ?, ?)
                ON CONFLICT(language_code, date, priority) DO UPDATE SET
                    requests_for = requests_for + 1,
                    found_count = found_count + ?,
                    not_found_count = not_found_count + ?
            `, [
                data.languageCode, today,
                data.found ? 1 : 0, data.found ? 0 : 1,
                data.found ? 1 : 0, data.found ? 0 : 1
            ]);
        } catch (err) {
            log('error', `[StatsDB] recordLanguageStats error: ${err.message}`);
        }
    }

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

    async getLanguageSuccessRates(days = 30) {
        try {
            const r = await db.execute(`
                SELECT COUNT(*) as total_requests,
                       SUM(CASE WHEN any_preferred_found = 1 THEN 1 ELSE 0 END) as any_found,
                       SUM(CASE WHEN all_preferred_found = 1 THEN 1 ELSE 0 END) as all_found
                FROM request_log WHERE created_at >= strftime('%s','now', '-' || ? || ' days')
            `, [days]);
            const row = r.rows[0];
            const total = row?.total_requests || 0;
            return {
                totalRequests: total,
                anyPreferredRate: total > 0 ? Math.round((row.any_found || 0) / total * 100) : 0,
                allPreferredRate: total > 0 ? Math.round((row.all_found || 0) / total * 100) : 0
            };
        } catch (err) {
            log('error', `[StatsDB] getLanguageSuccessRates error: ${err.message}`);
            return { totalRequests: 0, anyPreferredRate: 0, allPreferredRate: 0 };
        }
    }

    async getPopularLanguageCombinations(days = 30, limit = 10) {
        try {
            const r = await db.execute(`
                SELECT languages, COUNT(*) as count
                FROM request_log WHERE created_at >= strftime('%s','now', '-' || ? || ' days')
                GROUP BY languages ORDER BY count DESC
            `, [days]);
            const map = new Map();
            for (const row of r.rows) {
                let list;
                try { list = JSON.parse(row.languages); } catch { list = [row.languages]; }
                const key = list.map(l => (toAlpha3B(l) || l).toUpperCase()).sort().join(', ');
                map.set(key, (map.get(key) || 0) + row.count);
            }
            return Array.from(map.entries())
                .map(([languages, count]) => ({ languages, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, limit);
        } catch (err) {
            log('error', `[StatsDB] getPopularLanguageCombinations error: ${err.message}`);
            return [];
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Cache stats summary                                                */
    /* ------------------------------------------------------------------ */

    async getCacheStats() {
        try {
            const r = await db.execute('SELECT * FROM cache_stats_summary WHERE id = 1');
            const s = r.rows[0];
            if (s && s.total_entries > 0) {
                const nowSec = Math.floor(Date.now() / 1000);
                return {
                    entries: s.total_entries,
                    uniqueContent: s.unique_content,
                    uniqueLanguages: s.unique_languages,
                    uniqueSources: s.unique_sources,
                    sizeMB: s.size_bytes ? (s.size_bytes / 1024 / 1024).toFixed(2) : '0',
                    oldestAge: s.oldest_timestamp ? Math.floor(nowSec - s.oldest_timestamp) : 0,
                    newestAge: s.newest_timestamp ? Math.floor(nowSec - s.newest_timestamp) : 0,
                    avgAgeHours: s.avg_age_seconds ? Math.round(s.avg_age_seconds / 3600) : 0,
                    hitRate: (s.cache_hits + s.cache_misses) > 0
                        ? ((s.cache_hits / (s.cache_hits + s.cache_misses)) * 100).toFixed(1) : 0,
                    hits: s.cache_hits,
                    misses: s.cache_misses,
                    sourceDistribution: JSON.parse(s.source_distribution || '{}'),
                    languageDistribution: JSON.parse(s.language_distribution || '{}'),
                    lastUpdated: new Date(s.computed_at * 1000).toISOString(),
                    lastComputationTimeMs: s.computation_time_ms,
                    fromSummary: true
                };
            }
            return await this._getCacheStatsDirectQuery();
        } catch (err) {
            log('error', `[StatsDB] getCacheStats error: ${err.message}`);
            return this._defaultCacheStats();
        }
    }

    async _getCacheStatsDirectQuery() {
        try {
            const [counts, size, age] = await Promise.all([
                db.execute(`
                    SELECT COUNT(*) as total_entries, COUNT(DISTINCT imdb_id) as unique_content,
                           COUNT(DISTINCT lang_key) as unique_languages
                    FROM subtitle_cache
                `),
                db.execute('SELECT page_count * page_size as size_bytes FROM pragma_page_count(), pragma_page_size()'),
                db.execute(`
                    SELECT MIN(updated_at) as oldest_timestamp, MAX(updated_at) as newest_timestamp,
                           AVG(strftime('%s','now') - updated_at) as avg_age_seconds
                    FROM subtitle_cache
                `)
            ]);
            const c = counts.rows[0];
            const s = size.rows[0];
            const a = age.rows[0];
            const hr = await this.getCacheHitRate();
            return {
                entries: c.total_entries, uniqueContent: c.unique_content,
                uniqueLanguages: c.unique_languages, uniqueSources: 0,
                sizeMB: s ? (s.size_bytes / 1024 / 1024).toFixed(2) : '0',
                oldestAge: a.oldest_timestamp ? Math.floor(Date.now() / 1000 - a.oldest_timestamp) : 0,
                newestAge: a.newest_timestamp ? Math.floor(Date.now() / 1000 - a.newest_timestamp) : 0,
                avgAgeHours: a.avg_age_seconds ? Math.round(a.avg_age_seconds / 3600) : 0,
                hitRate: hr.rate, hits: hr.hits, misses: hr.misses, fromSummary: false
            };
        } catch (err) {
            log('error', `[StatsDB] _getCacheStatsDirectQuery error: ${err.message}`);
            return this._defaultCacheStats();
        }
    }

    _defaultCacheStats() {
        return {
            entries: 0, uniqueContent: 0, uniqueLanguages: 0, uniqueSources: 0,
            sizeMB: '0', oldestAge: 0, newestAge: 0, avgAgeHours: 0,
            hitRate: 0, hits: 0, misses: 0, fromSummary: false
        };
    }

    async recomputeSummary() {
        const start = Date.now();
        try {
            const [lastSummary, currentMax] = await Promise.all([
                db.execute('SELECT newest_timestamp, total_entries FROM cache_stats_summary WHERE id = 1'),
                db.execute('SELECT MAX(updated_at) as max_ts, COUNT(*) as cnt FROM subtitle_cache')
            ]);
            const lastNewest = lastSummary.rows[0]?.newest_timestamp || 0;
            const lastCount  = lastSummary.rows[0]?.total_entries || 0;
            const curNewest  = currentMax.rows[0]?.max_ts || 0;
            const curCount   = currentMax.rows[0]?.cnt || 0;

            if (lastNewest === curNewest && lastCount === curCount && lastCount > 0) {
                log('debug', '[StatsDB] summary unchanged, skipping');
                return { success: true, skipped: true, computationTime: Date.now() - start, entries: curCount };
            }

            const combined = await db.execute(`
                SELECT COUNT(*) as total_entries,
                       COUNT(DISTINCT imdb_id) as unique_content,
                       COUNT(DISTINCT lang_key) as unique_languages,
                       MIN(updated_at) as oldest_timestamp,
                       MAX(updated_at) as newest_timestamp,
                       AVG(strftime('%s','now') - updated_at) as avg_age_seconds
                FROM subtitle_cache
            `);
            const [langResult, sizeResult] = await Promise.all([
                db.execute(`SELECT lang_key, COUNT(*) as count FROM subtitle_cache WHERE lang_key IS NOT NULL GROUP BY lang_key ORDER BY count DESC`),
                db.execute('SELECT page_count * page_size as size_bytes FROM pragma_page_count(), pragma_page_size()')
            ]);
            const c = combined.rows[0];
            const langDist = {};
            langResult.rows.forEach(r => { if (r.lang_key) langDist[r.lang_key] = r.count; });
            const sizeBytes = sizeResult.rows[0]?.size_bytes || 0;
            const hr = await this.getCacheHitRate();
            const elapsed = Date.now() - start;

            await db.execute(`
                UPDATE cache_stats_summary SET
                    total_entries = ?, unique_content = ?, unique_languages = ?, unique_sources = 0,
                    size_bytes = ?, source_distribution = '{}', language_distribution = ?,
                    oldest_timestamp = ?, newest_timestamp = ?, avg_age_seconds = ?,
                    cache_hits = ?, cache_misses = ?, computed_at = strftime('%s','now'), computation_time_ms = ?
                WHERE id = 1
            `, [
                c.total_entries, c.unique_content, c.unique_languages,
                sizeBytes, JSON.stringify(langDist),
                c.oldest_timestamp || 0, c.newest_timestamp || 0, c.avg_age_seconds || 0,
                hr.hits, hr.misses, elapsed
            ]);
            log('info', `[StatsDB] summary updated in ${elapsed}ms (${c.total_entries} entries)`);
            return { success: true, computationTime: elapsed, entries: c.total_entries };
        } catch (err) {
            log('error', `[StatsDB] recomputeSummary failed: ${err.message}`);
            return { success: false, computationTime: Date.now() - start, error: err.message };
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Content cache browser                                              */
    /* ------------------------------------------------------------------ */

    async getContentCacheSummary(options = {}) {
        const page  = Math.max(1, parseInt(options.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 20));
        const offset = (page - 1) * limit;
        try {
            const summaryR = await db.execute('SELECT unique_content FROM cache_stats_summary WHERE id = 1');
            const total = summaryR.rows[0]?.unique_content || 0;

            // Get grouped content keys first
            const keysR = await db.execute(`
                SELECT imdb_id, season, episode, MAX(updated_at) as last_updated
                FROM subtitle_cache
                GROUP BY imdb_id, season, episode
                ORDER BY MAX(updated_at) DESC
                LIMIT ? OFFSET ?
            `, [limit, offset]);

            // For each content key, get all lang rows to compute real counts
            const items = [];
            for (const key of keysR.rows) {
                const rowsR = await db.execute(`
                    SELECT lang_key, subtitles FROM subtitle_cache
                    WHERE imdb_id = ? AND season = ? AND episode = ?
                `, [key.imdb_id, key.season, key.episode]);

                let totalSubs = 0;
                const sources = new Set();
                const langKeys = new Set();

                for (const row of rowsR.rows) {
                    langKeys.add(row.lang_key);
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
            const r = await db.execute(`
                SELECT imdb_id, season, episode, lang_key, subtitles, updated_at
                FROM subtitle_cache WHERE imdb_id = ?
                ORDER BY season, episode, lang_key
            `, [imdbId]);
            if (r.rows.length === 0) return null;

            let totalSubtitles = 0;
            const allSources = new Set();
            const breakdown = [];

            for (const row of r.rows) {
                let subtitleCount = 0;
                const rowSources = new Set();
                try {
                    const subs = JSON.parse(row.subtitles || '[]');
                    subtitleCount = subs.length;
                    for (const s of subs) {
                        if (s.source) { rowSources.add(s.source); allSources.add(s.source); }
                    }
                } catch (_) {}
                totalSubtitles += subtitleCount;
                breakdown.push({
                    imdb_id: row.imdb_id,
                    season: row.season === 0 ? null : row.season,
                    episode: row.episode === 0 ? null : row.episode,
                    language: row.lang_key,
                    subtitle_count: subtitleCount,
                    sources: rowSources.size > 0 ? [...rowSources].join(',') : null,
                    last_updated: row.updated_at
                });
            }

            return {
                imdbId,
                totalSubtitles,
                uniqueLanguages: new Set(r.rows.map(row => row.lang_key)).size,
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

    async trackUserRequest(userId, requestData) {
        if (!this._minimalEnabled() || !userId) return;
        const { imdbId, contentType, languages, season, episode } = requestData;
        try {
            const isMovie  = contentType === 'movie' ? 1 : 0;
            const isSeries = contentType === 'series' ? 1 : 0;
            const langsJson = JSON.stringify(languages || []);

            await db.execute(`
                INSERT INTO user_tracking (user_id, languages, total_requests, movie_requests, series_requests, first_seen, last_active)
                VALUES (?, ?, 1, ?, ?, strftime('%s','now'), strftime('%s','now'))
                ON CONFLICT(user_id) DO UPDATE SET
                    total_requests  = total_requests + 1,
                    movie_requests  = movie_requests + excluded.movie_requests,
                    series_requests = series_requests + excluded.series_requests,
                    last_active     = strftime('%s','now')
            `, [userId, langsJson, isMovie, isSeries]);

            // Full mode also logs the content (skip if no imdbId, e.g. manifest requests)
            if (this._writesEnabled() && imdbId) {
                await db.execute(`
                    INSERT INTO user_content_log (user_id, imdb_id, content_type, season, episode, requested_at)
                    VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
                `, [userId, imdbId, contentType, season || null, episode || null]);
            }

            log('debug', `[StatsDB] session ${userId}: ${contentType} ${imdbId}`);
        } catch (err) {
            log('error', `[StatsDB] trackUserRequest error: ${err.message}`);
        }
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

    async getUserContent(userId, limit = 10) {
        try {
            const r = await db.execute(
                'SELECT * FROM user_content_log WHERE user_id = ? ORDER BY requested_at DESC LIMIT ?',
                [userId, limit]
            );
            return r.rows.map(row => ({
                imdbId: row.imdb_id, contentType: row.content_type,
                season: row.season, episode: row.episode,
                requestedAt: new Date(row.requested_at * 1000)
            }));
        } catch (err) {
            log('error', `[StatsDB] getUserContent error: ${err.message}`);
            return [];
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

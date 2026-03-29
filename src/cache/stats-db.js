/**
 * Async Persistent Statistics - LibSQL-backed stats storage
 */
const db = require('./database-libsql');
const { log } = require('../utils');
const { toAlpha3B } = require('../languages');

function areStatsWritesEnabled() {
    const rawInterval = process.env.STATS_REFRESH_INTERVAL;
    if (rawInterval === undefined) {
        return true;
    }

    const parsedInterval = parseInt(rawInterval, 10);
    if (Number.isNaN(parsedInterval)) {
        return true;
    }

    return parsedInterval > 0;
}

function getLocalDateString() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

class StatsDBAsync {
    async increment(key, amount = 1) {
        if (!areStatsWritesEnabled()) {
            return;
        }

        try {
            await db.execute(`
                INSERT INTO stats (stat_key, stat_value, updated_at)
                VALUES (?, ?, strftime('%s', 'now'))
                ON CONFLICT(stat_key) DO UPDATE SET
                    stat_value = stat_value + ?,
                    updated_at = strftime('%s', 'now')
            `, [key, amount, amount]);
        } catch (error) {
            log('error', '[StatsDB] Increment error:', error.message);
        }
    }
    
    async get(key) {
        try {
            const result = await db.execute('SELECT stat_value FROM stats WHERE stat_key = ?', [key]);
            return result.rows[0]?.stat_value || 0;
        } catch (error) {
            log('error', '[StatsDB] Get error:', error.message);
            return 0;
        }
    }
    
    async getAll() {
        try {
            const result = await db.execute('SELECT stat_key, stat_value FROM stats');
            const out = {};
            for (const row of result.rows) {
                out[row.stat_key] = row.stat_value;
            }
            return out;
        } catch (error) {
            log('error', '[StatsDB] GetAll error:', error.message);
            return {};
        }
    }
    
    async recordDaily(data) {
        if (!areStatsWritesEnabled()) {
            return;
        }

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
        } catch (error) {
            log('error', '[StatsDB] RecordDaily error:', error.message);
        }
    }
    
    async getDailyStats(days = 7) {
        try {
            const result = await db.execute(`
                SELECT * FROM stats_daily 
                WHERE date >= date('now', '-' || ? || ' days')
                ORDER BY date DESC
            `, [days]);
            return result.rows;
        } catch (error) {
            log('error', '[StatsDB] GetDailyStats error:', error.message);
            return [];
        }
    }
    
    async logRequest(data) {
        if (!areStatsWritesEnabled()) {
            return;
        }

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
        } catch (error) {
            log('error', '[StatsDB] LogRequest error:', error.message);
        }
    }
    
    async getRecentRequests(limit = 100) {
        try {
            const result = await db.execute(`
                SELECT * FROM request_log ORDER BY created_at DESC LIMIT ?
            `, [limit]);
            return result.rows;
        } catch (error) {
            log('error', '[StatsDB] GetRecentRequests error:', error.message);
            return [];
        }
    }
    
    async getCacheHitRate() {
        const hits = await this.get('cache_hits');
        const misses = await this.get('cache_misses');
        const total = hits + misses;
        return {
            hits,
            misses,
            rate: total > 0 ? (hits / total * 100).toFixed(1) : 0
        };
    }
    
    async recordProviderStats(data) {
        if (!areStatsWritesEnabled()) {
            return;
        }

        const today = getLocalDateString();
        try {
            const updateResult = await db.execute(`
                UPDATE provider_stats SET
                    total_requests = total_requests + 1,
                    successful_requests = successful_requests + ?,
                    failed_requests = failed_requests + ?,
                    avg_response_ms = (avg_response_ms * total_requests + ?) / (total_requests + 1),
                    subtitles_returned = subtitles_returned + ?
                WHERE provider_name = ? AND date = ?
            `, [
                data.success ? 1 : 0, data.success ? 0 : 1,
                data.responseMs || 0, data.subtitlesCount || 0,
                data.providerName, today
            ]);
            
            if (updateResult.rowsAffected === 0) {
                await db.execute(`
                    INSERT INTO provider_stats 
                        (provider_name, date, total_requests, successful_requests, failed_requests, avg_response_ms, subtitles_returned)
                    VALUES (?, ?, 1, ?, ?, ?, ?)
                `, [
                    data.providerName, today,
                    data.success ? 1 : 0, data.success ? 0 : 1,
                    data.responseMs || 0, data.subtitlesCount || 0
                ]);
            }
        } catch (error) {
            log('error', '[StatsDB] RecordProviderStats error:', error.message);
        }
    }
    
    async getProviderStats(days = 7) {
        try {
            const result = await db.execute(`
                SELECT 
                    provider_name,
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
            return result.rows;
        } catch (error) {
            log('error', '[StatsDB] GetProviderStats error:', error.message);
            return [];
        }
    }
    
    async recordLanguageStats(data) {
        if (!areStatsWritesEnabled()) {
            return;
        }

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
        } catch (error) {
            log('error', '[StatsDB] RecordLanguageStats error:', error.message);
        }
    }
    
    async getLanguageStats(days = 7) {
        try {
            const result = await db.execute(`
                SELECT 
                    language_code,
                    SUM(requests_for) as total_requests,
                    SUM(found_count) as found_count,
                    SUM(not_found_count) as not_found_count,
                    ROUND(SUM(found_count) * 100.0 / NULLIF(SUM(requests_for), 0), 1) as availability_rate
                FROM language_stats 
                WHERE date >= date('now', '-' || ? || ' days')
                GROUP BY language_code
                ORDER BY total_requests DESC
            `, [days]);
            return result.rows;
        } catch (error) {
            log('error', '[StatsDB] GetLanguageStats error:', error.message);
            return [];
        }
    }
    
    async getLanguageMatchSummary(days = 30) {
        try {
            const [aggregateResult, perLangResult] = await Promise.all([
                db.execute(`
                    SELECT 
                        SUM(found_count) as found,
                        SUM(not_found_count) as not_found,
                        SUM(requests_for) as total_requests
                    FROM language_stats 
                    WHERE date >= date('now', '-' || ? || ' days')
                `, [days]),
                db.execute(`
                    SELECT 
                        language_code,
                        SUM(found_count) as found,
                        SUM(not_found_count) as not_found,
                        SUM(requests_for) as total_requests,
                        ROUND(SUM(found_count) * 100.0 / NULLIF(SUM(requests_for), 0), 1) as success_rate
                    FROM language_stats 
                    WHERE date >= date('now', '-' || ? || ' days')
                    GROUP BY language_code
                    ORDER BY total_requests DESC
                `, [days])
            ]);
            
            const aggregate = aggregateResult.rows[0];
            const totalRequests = aggregate?.total_requests || 0;
            const found = aggregate?.found || 0;
            const notFound = aggregate?.not_found || 0;
            
            return { 
                totalRequests, found, notFound,
                successRate: totalRequests > 0 ? Math.round((found / totalRequests) * 100) : 0,
                perLanguage: perLangResult.rows
            };
        } catch (error) {
            log('error', '[StatsDB] GetLanguageMatchSummary error:', error.message);
            return { totalRequests: 0, found: 0, notFound: 0, successRate: 0, perLanguage: [] };
        }
    }
    
    async getTopSuccessfulLanguages(days = 30, limit = 10) {
        try {
            const result = await db.execute(`
                SELECT language_code, SUM(found_count) as found_count
                FROM language_stats 
                WHERE date >= date('now', '-' || ? || ' days') AND found_count > 0
                GROUP BY language_code
                ORDER BY found_count DESC LIMIT ?
            `, [days, limit]);
            
            const out = {};
            result.rows.forEach(r => { out[r.language_code.toUpperCase()] = r.found_count; });
            return out;
        } catch (error) {
            log('error', '[StatsDB] GetTopSuccessfulLanguages error:', error.message);
            return {};
        }
    }
    
    async getLanguageSuccessRates(days = 30) {
        try {
            const result = await db.execute(`
                SELECT 
                    COUNT(*) as total_requests,
                    SUM(CASE WHEN any_preferred_found = 1 THEN 1 ELSE 0 END) as any_found,
                    SUM(CASE WHEN all_preferred_found = 1 THEN 1 ELSE 0 END) as all_found
                FROM request_log 
                WHERE created_at >= strftime('%s', 'now', '-' || ? || ' days')
            `, [days]);
            
            const row = result.rows[0];
            const totalRequests = row?.total_requests || 0;
            return {
                totalRequests,
                anyPreferredRate: totalRequests > 0 ? Math.round((row.any_found || 0) / totalRequests * 100) : 0,
                allPreferredRate: totalRequests > 0 ? Math.round((row.all_found || 0) / totalRequests * 100) : 0
            };
        } catch (error) {
            log('error', '[StatsDB] GetLanguageSuccessRates error:', error.message);
            return { totalRequests: 0, anyPreferredRate: 0, allPreferredRate: 0 };
        }
    }
    
    async getPopularLanguageCombinations(days = 30, limit = 10) {
        try {
            const result = await db.execute(`
                SELECT languages, COUNT(*) as count
                FROM request_log 
                WHERE created_at >= strftime('%s', 'now', '-' || ? || ' days')
                GROUP BY languages ORDER BY count DESC
            `, [days]);
            
            const combinationMap = new Map();
            for (const row of result.rows) {
                let langList;
                try { langList = JSON.parse(row.languages); } catch { langList = [row.languages]; }
                const normalizedLangs = langList
                    .map(l => (toAlpha3B(l) || l).toUpperCase())
                    .sort();
                const key = normalizedLangs.join(', ');
                combinationMap.set(key, (combinationMap.get(key) || 0) + row.count);
            }
            
            return Array.from(combinationMap.entries())
                .map(([languages, count]) => ({ languages, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, limit);
        } catch (error) {
            log('error', '[StatsDB] GetPopularLanguageCombinations error:', error.message);
            return [];
        }
    }
    
    async getCacheStats() {
        try {
            const result = await db.execute('SELECT * FROM cache_stats_summary WHERE id = 1');
            const summary = result.rows[0];
            
            if (summary && summary.total_entries > 0) {
                const nowSeconds = Math.floor(Date.now() / 1000);
                return {
                    entries: summary.total_entries,
                    uniqueContent: summary.unique_content,
                    uniqueLanguages: summary.unique_languages,
                    uniqueSources: summary.unique_sources,
                    sizeMB: summary.size_bytes ? (summary.size_bytes / 1024 / 1024).toFixed(2) : '0',
                    oldestAge: summary.oldest_timestamp ? Math.floor(nowSeconds - summary.oldest_timestamp) : 0,
                    newestAge: summary.newest_timestamp ? Math.floor(nowSeconds - summary.newest_timestamp) : 0,
                    avgAgeHours: summary.avg_age_seconds ? Math.round(summary.avg_age_seconds / 3600) : 0,
                    hitRate: (summary.cache_hits + summary.cache_misses) > 0 
                        ? ((summary.cache_hits / (summary.cache_hits + summary.cache_misses)) * 100).toFixed(1) : 0,
                    hits: summary.cache_hits,
                    misses: summary.cache_misses,
                    sourceDistribution: JSON.parse(summary.source_distribution || '{}'),
                    languageDistribution: JSON.parse(summary.language_distribution || '{}'),
                    lastUpdated: new Date(summary.computed_at * 1000).toISOString(),
                    lastComputationTimeMs: summary.computation_time_ms,
                    fromSummary: true
                };
            }
            
            log('warn', '[StatsDB] Summary empty, falling back to direct query');
            return await this._getCacheStatsDirectQuery();
        } catch (error) {
            log('error', '[StatsDB] GetCacheStats error:', error.message);
            return this._getDefaultCacheStats();
        }
    }
    
    async _getCacheStatsDirectQuery() {
        try {
            const [countsResult, sizeResult, ageResult] = await Promise.all([
                db.execute(`
                    SELECT COUNT(*) as total_entries, COUNT(DISTINCT imdb_id) as unique_content,
                           COUNT(DISTINCT language) as unique_languages, COUNT(DISTINCT source) as unique_sources
                    FROM subtitle_cache
                `),
                db.execute('SELECT page_count * page_size as size_bytes FROM pragma_page_count(), pragma_page_size()'),
                db.execute(`
                    SELECT MIN(updated_at) as oldest_timestamp, MAX(updated_at) as newest_timestamp,
                           AVG(strftime('%s', 'now') - updated_at) as avg_age_seconds
                    FROM subtitle_cache
                `)
            ]);
            
            const counts = countsResult.rows[0];
            const sizeInfo = sizeResult.rows[0];
            const ageStats = ageResult.rows[0];
            const hitRate = await this.getCacheHitRate();
            
            return {
                entries: counts.total_entries,
                uniqueContent: counts.unique_content,
                uniqueLanguages: counts.unique_languages,
                uniqueSources: counts.unique_sources,
                sizeMB: sizeInfo ? (sizeInfo.size_bytes / 1024 / 1024).toFixed(2) : '0',
                oldestAge: ageStats.oldest_timestamp ? Math.floor((Date.now() / 1000) - ageStats.oldest_timestamp) : 0,
                newestAge: ageStats.newest_timestamp ? Math.floor((Date.now() / 1000) - ageStats.newest_timestamp) : 0,
                avgAgeHours: ageStats.avg_age_seconds ? Math.round(ageStats.avg_age_seconds / 3600) : 0,
                hitRate: hitRate.rate,
                hits: hitRate.hits,
                misses: hitRate.misses,
                fromSummary: false
            };
        } catch (error) {
            log('error', '[StatsDB] _getCacheStatsDirectQuery error:', error.message);
            return this._getDefaultCacheStats();
        }
    }
    
    _getDefaultCacheStats() {
        return {
            entries: 0, uniqueContent: 0, uniqueLanguages: 0, uniqueSources: 0,
            sizeMB: '0', oldestAge: 0, newestAge: 0, avgAgeHours: 0,
            hitRate: 0, hits: 0, misses: 0, fromSummary: false
        };
    }
    
    async recomputeSummary() {
        const startTime = Date.now();
        try {
            const [lastSummary, currentMax] = await Promise.all([
                db.execute('SELECT newest_timestamp, total_entries FROM cache_stats_summary WHERE id = 1'),
                db.execute('SELECT MAX(updated_at) as max_ts, COUNT(*) as cnt FROM subtitle_cache')
            ]);
            
            const lastNewest = lastSummary.rows[0]?.newest_timestamp || 0;
            const lastCount = lastSummary.rows[0]?.total_entries || 0;
            const currentNewest = currentMax.rows[0]?.max_ts || 0;
            const currentCount = currentMax.rows[0]?.cnt || 0;
            
            if (lastNewest === currentNewest && lastCount === currentCount && lastCount > 0) {
                log('debug', '[StatsDB] Summary unchanged, skipping recomputation');
                return { success: true, skipped: true, computationTime: Date.now() - startTime, entries: currentCount };
            }
            
            const combinedResult = await db.execute(`
                SELECT 
                    COUNT(*) as total_entries,
                    COUNT(DISTINCT imdb_id) as unique_content,
                    COUNT(DISTINCT language) as unique_languages,
                    COUNT(DISTINCT source) as unique_sources,
                    MIN(updated_at) as oldest_timestamp,
                    MAX(updated_at) as newest_timestamp,
                    AVG(strftime('%s', 'now') - updated_at) as avg_age_seconds
                FROM subtitle_cache
            `);
            
            const [sourceResult, langResult, sizeResult] = await Promise.all([
                db.execute('SELECT source, COUNT(*) as count FROM subtitle_cache WHERE source IS NOT NULL GROUP BY source'),
                db.execute('SELECT language, COUNT(*) as count FROM subtitle_cache WHERE language IS NOT NULL GROUP BY language ORDER BY count DESC'),
                db.execute('SELECT page_count * page_size as size_bytes FROM pragma_page_count(), pragma_page_size()')
            ]);
            
            const counts = combinedResult.rows[0];
            const sourceDistribution = {};
            sourceResult.rows.forEach(r => { if (r.source) sourceDistribution[r.source] = r.count; });
            const languageDistribution = {};
            langResult.rows.forEach(r => { if (r.language) languageDistribution[r.language] = r.count; });
            const sizeInfo = sizeResult.rows[0];
            const hitRate = await this.getCacheHitRate();
            const computationTime = Date.now() - startTime;
            
            await db.execute(`
                UPDATE cache_stats_summary SET
                    total_entries = ?, unique_content = ?, unique_languages = ?, unique_sources = ?,
                    size_bytes = ?, source_distribution = ?, language_distribution = ?,
                    oldest_timestamp = ?, newest_timestamp = ?, avg_age_seconds = ?,
                    cache_hits = ?, cache_misses = ?, computed_at = strftime('%s', 'now'), computation_time_ms = ?
                WHERE id = 1
            `, [
                counts.total_entries, counts.unique_content, counts.unique_languages, counts.unique_sources,
                sizeInfo?.size_bytes || 0, JSON.stringify(sourceDistribution), JSON.stringify(languageDistribution),
                counts.oldest_timestamp || 0, counts.newest_timestamp || 0, counts.avg_age_seconds || 0,
                hitRate.hits, hitRate.misses, computationTime
            ]);
            
            log('info', `[StatsDB] Summary updated in ${computationTime}ms (${counts.total_entries.toLocaleString()} entries)`);
            return { success: true, computationTime, entries: counts.total_entries };
        } catch (error) {
            log('error', `[StatsDB] Summary recomputation failed: ${error.message}`);
            return { success: false, computationTime: Date.now() - startTime, error: error.message };
        }
    }
    
    async getContentCacheSummary(options = {}) {
        const page = Math.max(1, parseInt(options.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 20));
        const offset = (page - 1) * limit;
        
        try {
            const summaryResult = await db.execute('SELECT unique_content FROM cache_stats_summary WHERE id = 1');
            const totalCount = summaryResult.rows[0]?.unique_content || 0;
            
            const dataResult = await db.execute(`
                SELECT imdb_id, season, episode, 
                       COUNT(*) as total_subtitles,
                       COUNT(DISTINCT language) as languages_cached,
                       MAX(updated_at) as last_updated,
                       GROUP_CONCAT(DISTINCT language) as language_list,
                       GROUP_CONCAT(DISTINCT source) as sources
                FROM (
                    SELECT * FROM subtitle_cache 
                    ORDER BY updated_at DESC 
                    LIMIT 10000
                )
                GROUP BY imdb_id, COALESCE(season, ''), COALESCE(episode, '')
                ORDER BY MAX(updated_at) DESC
                LIMIT ? OFFSET ?
            `, [limit, offset]);
            
            return { items: dataResult.rows, total: totalCount, page, limit };
        } catch (error) {
            log('error', '[StatsDB] GetContentCacheSummary error:', error.message);
            return { items: [], total: 0, page, limit };
        }
    }
    
    async searchCacheByImdb(imdbId) {
        try {
            const result = await db.execute(`
                SELECT imdb_id, season, episode, language, COUNT(*) as subtitle_count,
                       GROUP_CONCAT(DISTINCT source) as sources, MAX(updated_at) as last_updated
                FROM subtitle_cache WHERE imdb_id = ?
                GROUP BY imdb_id, season, episode, language
                ORDER BY season, episode, language
            `, [imdbId]);
            
            if (result.rows.length === 0) return null;
            
            const totalSubtitles = result.rows.reduce((sum, r) => sum + r.subtitle_count, 0);
            const uniqueLanguages = new Set(result.rows.map(r => r.language)).size;
            const allSources = new Set();
            result.rows.forEach(r => { if (r.sources) r.sources.split(',').forEach(s => allSources.add(s)); });
            
            return {
                imdbId, totalSubtitles, uniqueLanguages, sources: [...allSources],
                breakdown: result.rows,
                lastUpdated: Math.max(...result.rows.map(r => r.last_updated))
            };
        } catch (error) {
            log('error', `[StatsDB] SearchCacheByImdb error: ${error.message}`);
            return null;
        }
    }
    
    async trackUserRequest(userId, requestData) {
        if (!areStatsWritesEnabled() || !userId) return;
        const { imdbId, contentType, languages, season, episode } = requestData;
        
        try {
            const isMovie = contentType === 'movie' ? 1 : 0;
            const isSeries = contentType === 'series' ? 1 : 0;
            const languagesJson = JSON.stringify(languages || []);
            
            await db.execute(`
                INSERT INTO user_tracking (user_id, languages, total_requests, movie_requests, series_requests, first_seen, last_active)
                VALUES (?, ?, 1, ?, ?, strftime('%s', 'now'), strftime('%s', 'now'))
                ON CONFLICT(user_id) DO UPDATE SET
                    total_requests = total_requests + 1,
                    movie_requests = movie_requests + excluded.movie_requests,
                    series_requests = series_requests + excluded.series_requests,
                    last_active = strftime('%s', 'now')
            `, [userId, languagesJson, isMovie, isSeries]);
            
            await db.execute(`
                INSERT INTO user_content_log (user_id, imdb_id, content_type, season, episode, requested_at)
                VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
            `, [userId, imdbId, contentType, season || null, episode || null]);
            
            log('debug', `Session ${userId}: ${contentType} ${imdbId}`);
        } catch (error) {
            log('error', `Failed to record session ${userId}: ${error.message}`);
        }
    }
    
    async getUserStats(userId) {
        try {
            const result = await db.execute('SELECT * FROM user_tracking WHERE user_id = ?', [userId]);
            const user = result.rows[0];
            if (!user) return null;
            
            return {
                sessionId: user.user_id,
                languages: JSON.parse(user.languages || '[]'),
                totalRequests: user.total_requests,
                movieRequests: user.movie_requests,
                seriesRequests: user.series_requests,
                firstSeen: new Date(user.first_seen * 1000),
                lastActive: new Date(user.last_active * 1000)
            };
        } catch (error) {
            log('error', `Failed to get session stats for ${userId}: ${error.message}`);
            return null;
        }
    }
    
    async getUserContent(userId, limit = 10) {
        try {
            const result = await db.execute(`
                SELECT * FROM user_content_log WHERE user_id = ? ORDER BY requested_at DESC LIMIT ?
            `, [userId, limit]);
            return result.rows.map(row => ({
                imdbId: row.imdb_id, contentType: row.content_type,
                season: row.season, episode: row.episode,
                requestedAt: new Date(row.requested_at * 1000)
            }));
        } catch (error) {
            log('error', `Failed to get session content for ${userId}: ${error.message}`);
            return [];
        }
    }
    
    async getActiveUsersCount(days = 30) {
        try {
            const seconds = days * 24 * 60 * 60;
            const result = await db.execute(
                'SELECT COUNT(*) as count FROM user_tracking WHERE last_active > strftime(\'%s\', \'now\') - ?',
                [seconds]
            );
            return result.rows[0]?.count || 0;
        } catch (error) {
            log('error', `Failed to get active sessions count: ${error.message}`);
            return 0;
        }
    }
    
    async getActiveUsersInWindow(startDaysAgo, endDaysAgo) {
        try {
            const nowSeconds = Math.floor(Date.now() / 1000);
            const windowStart = nowSeconds - (startDaysAgo * 24 * 60 * 60);
            const windowEnd = nowSeconds - (endDaysAgo * 24 * 60 * 60);
            const result = await db.execute(
                'SELECT COUNT(*) as count FROM user_tracking WHERE last_active <= ? AND last_active > ?',
                [windowEnd, windowStart]
            );
            return result.rows[0]?.count || 0;
        } catch (error) {
            log('error', `Failed to get active users in window: ${error.message}`);
            return 0;
        }
    }
    
    async getActiveUsersOnDay(startTimestamp, endTimestamp) {
        try {
            const result = await db.execute(
                'SELECT COUNT(*) as count FROM user_tracking WHERE last_active >= ? AND last_active < ?',
                [startTimestamp, endTimestamp]
            );
            return result.rows[0]?.count || 0;
        } catch (error) {
            log('error', `Failed to get active users on day: ${error.message}`);
            return 0;
        }
    }
    
    async getAggregateUserStats() {
        try {
            const result = await db.execute(`
                SELECT COUNT(*) as total_users, SUM(total_requests) as total_requests,
                       SUM(movie_requests) as movie_requests, SUM(series_requests) as series_requests,
                       AVG(total_requests) as avg_requests_per_user
                FROM user_tracking
            `);
            const stats = result.rows[0];
            
            const [d7, d30, d60] = await Promise.all([
                this.getActiveUsersCount(7),
                this.getActiveUsersCount(30),
                this.getActiveUsersCount(60)
            ]);
            
            return {
                totalSessions: stats?.total_users || 0,
                totalRequests: stats?.total_requests || 0,
                movieRequests: stats?.movie_requests || 0,
                seriesRequests: stats?.series_requests || 0,
                avgRequestsPerSession: Math.round(stats?.avg_requests_per_user || 0),
                activeSessions: { last7Days: d7, last30Days: d30, last60Days: d60 }
            };
        } catch (error) {
            log('error', `Failed to get aggregate session stats: ${error.message}`);
            return {
                totalSessions: 0, totalRequests: 0, movieRequests: 0, seriesRequests: 0,
                avgRequestsPerSession: 0, activeSessions: { last7Days: 0, last30Days: 0, last60Days: 0 }
            };
        }
    }
}

module.exports = new StatsDBAsync();

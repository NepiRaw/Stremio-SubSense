/**
 * Persistent Statistics - SQLite-backed stats storage
 * Replaces in-memory stats for persistence across restarts
 */
const db = require('./database');

/**
 * Get local date string in YYYY-MM-DD format
 * Uses local timezone instead of UTC to match user expectations
 */
function getLocalDateString() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

class StatsDB {
    /**
     * Increment a statistic counter
     * @param {string} key - Stat key name
     * @param {number} amount - Amount to increment (default: 1)
     */
    increment(key, amount = 1) {
        try {
            const stmt = db.prepare(`
                INSERT INTO stats (stat_key, stat_value, updated_at)
                VALUES (?, ?, strftime('%s', 'now'))
                ON CONFLICT(stat_key) DO UPDATE SET
                    stat_value = stat_value + ?,
                    updated_at = strftime('%s', 'now')
            `);
            stmt.run(key, amount, amount);
        } catch (error) {
            console.error('[StatsDB] Increment error:', error.message);
        }
    }
    
    /**
     * Get a statistic value
     * @param {string} key - Stat key name
     * @returns {number} Value (0 if not found)
     */
    get(key) {
        try {
            const stmt = db.prepare('SELECT stat_value FROM stats WHERE stat_key = ?');
            const row = stmt.get(key);
            return row ? row.stat_value : 0;
        } catch (error) {
            console.error('[StatsDB] Get error:', error.message);
            return 0;
        }
    }
    
    /**
     * Get all statistics
     * @returns {Object} All stats as key-value pairs
     */
    getAll() {
        try {
            const stmt = db.prepare('SELECT stat_key, stat_value FROM stats');
            const rows = stmt.all();
            const result = {};
            for (const row of rows) {
                result[row.stat_key] = row.stat_value;
            }
            return result;
        } catch (error) {
            console.error('[StatsDB] GetAll error:', error.message);
            return {};
        }
    }
    
    /**
     * Record daily stats
     * @param {Object} data - { requests, cacheHits, cacheMisses, conversions, movies, series }
     */
    recordDaily(data) {
        const today = getLocalDateString();
        try {
            const stmt = db.prepare(`
                INSERT INTO stats_daily (date, requests, cache_hits, cache_misses, conversions, movies, series)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(date) DO UPDATE SET
                    requests = requests + ?,
                    cache_hits = cache_hits + ?,
                    cache_misses = cache_misses + ?,
                    conversions = conversions + ?,
                    movies = movies + ?,
                    series = series + ?
            `);
            stmt.run(
                today,
                data.requests || 0,
                data.cacheHits || 0,
                data.cacheMisses || 0,
                data.conversions || 0,
                data.movies || 0,
                data.series || 0,
                data.requests || 0,
                data.cacheHits || 0,
                data.cacheMisses || 0,
                data.conversions || 0,
                data.movies || 0,
                data.series || 0
            );
        } catch (error) {
            console.error('[StatsDB] RecordDaily error:', error.message);
        }
    }
    
    /**
     * Get daily stats for a date range
     * @param {number} days - Number of days to retrieve (default: 7)
     * @returns {Array} Daily stats array
     */
    getDailyStats(days = 7) {
        try {
            const stmt = db.prepare(`
                SELECT * FROM stats_daily 
                WHERE date >= date('now', '-' || ? || ' days')
                ORDER BY date DESC
            `);
            return stmt.all(days);
        } catch (error) {
            console.error('[StatsDB] GetDailyStats error:', error.message);
            return [];
        }
    }
    
    /**
     * Log a request for analytics
     * @param {Object} data - Request data
     */
    logRequest(data) {
        try {
            const stmt = db.prepare(`
                INSERT INTO request_log 
                    (imdb_id, content_type, languages, result_count, cache_hit, response_time_ms)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            stmt.run(
                data.imdbId,
                data.contentType,
                JSON.stringify(data.languages || []),
                data.resultCount || 0,
                data.cacheHit ? 1 : 0,
                data.responseTimeMs || 0
            );
        } catch (error) {
            console.error('[StatsDB] LogRequest error:', error.message);
        }
    }
    
    /**
     * Get recent request logs
     * @param {number} limit - Max number of logs to return
     * @returns {Array} Recent request logs
     */
    getRecentRequests(limit = 100) {
        try {
            const stmt = db.prepare(`
                SELECT * FROM request_log 
                ORDER BY created_at DESC 
                LIMIT ?
            `);
            return stmt.all(limit);
        } catch (error) {
            console.error('[StatsDB] GetRecentRequests error:', error.message);
            return [];
        }
    }
    
    /**
     * Get cache hit rate
     * @returns {Object} { hits, misses, rate }
     */
    getCacheHitRate() {
        const hits = this.get('cache_hits');
        const misses = this.get('cache_misses');
        const total = hits + misses;
        return {
            hits,
            misses,
            rate: total > 0 ? (hits / total * 100).toFixed(1) : 0
        };
    }
    
    // =====================================================
    // Provider Stats Methods (Phase 2.5)
    // =====================================================
    
    /**
     * Record provider performance for today
     * @param {Object} data - { providerName, success, responseMs, subtitlesCount }
     */
    recordProviderStats(data) {
        const today = getLocalDateString();
        try {
            // First, try to update existing row
            const updateStmt = db.prepare(`
                UPDATE provider_stats SET
                    total_requests = total_requests + 1,
                    successful_requests = successful_requests + ?,
                    failed_requests = failed_requests + ?,
                    avg_response_ms = (avg_response_ms * total_requests + ?) / (total_requests + 1),
                    subtitles_returned = subtitles_returned + ?
                WHERE provider_name = ? AND date = ?
            `);
            
            const result = updateStmt.run(
                data.success ? 1 : 0,
                data.success ? 0 : 1,
                data.responseMs || 0,
                data.subtitlesCount || 0,
                data.providerName,
                today
            );
            
            // If no row was updated, insert a new one
            if (result.changes === 0) {
                const insertStmt = db.prepare(`
                    INSERT INTO provider_stats 
                        (provider_name, date, total_requests, successful_requests, failed_requests, avg_response_ms, subtitles_returned)
                    VALUES (?, ?, 1, ?, ?, ?, ?)
                `);
                insertStmt.run(
                    data.providerName,
                    today,
                    data.success ? 1 : 0,
                    data.success ? 0 : 1,
                    data.responseMs || 0,
                    data.subtitlesCount || 0
                );
            }
        } catch (error) {
            console.error('[StatsDB] RecordProviderStats error:', error.message);
        }
    }
    
    /**
     * Get provider stats summary
     * @param {number} days - Number of days to aggregate (default: 7)
     * @returns {Array} Provider stats
     */
    getProviderStats(days = 7) {
        try {
            const stmt = db.prepare(`
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
            `);
            return stmt.all(days);
        } catch (error) {
            console.error('[StatsDB] GetProviderStats error:', error.message);
            return [];
        }
    }
    
    // =====================================================
    // Language Stats Methods (Phase 2.5)
    // =====================================================
    
    /**
     * Record language request/availability
     * @param {Object} data - { languageCode, found, priority }
     */
    recordLanguageStats(data) {
        const today = getLocalDateString();
        const priority = data.priority || 'primary';
        try {
            const stmt = db.prepare(`
                INSERT INTO language_stats (language_code, date, priority, requests_for, found_count, not_found_count)
                VALUES (?, ?, ?, 1, ?, ?)
                ON CONFLICT(language_code, date, priority) DO UPDATE SET
                    requests_for = requests_for + 1,
                    found_count = found_count + ?,
                    not_found_count = not_found_count + ?
            `);
            stmt.run(
                data.languageCode,
                today,
                priority,
                data.found ? 1 : 0,
                data.found ? 0 : 1,
                data.found ? 1 : 0,
                data.found ? 0 : 1
            );
        } catch (error) {
            console.error('[StatsDB] RecordLanguageStats error:', error.message);
        }
    }
    
    /**
     * Get language stats summary
     * @param {number} days - Number of days to aggregate (default: 7)
     * @returns {Array} Language stats
     */
    getLanguageStats(days = 7) {
        try {
            const stmt = db.prepare(`
                SELECT 
                    language_code,
                    priority,
                    SUM(requests_for) as total_requests,
                    SUM(found_count) as found_count,
                    SUM(not_found_count) as not_found_count,
                    ROUND(SUM(found_count) * 100.0 / NULLIF(SUM(requests_for), 0), 1) as availability_rate
                FROM language_stats 
                WHERE date >= date('now', '-' || ? || ' days')
                GROUP BY language_code, priority
                ORDER BY priority, total_requests DESC
            `);
            return stmt.all(days);
        } catch (error) {
            console.error('[StatsDB] GetLanguageStats error:', error.message);
            return [];
        }
    }
    
    /**
     * Get aggregated language match stats (primary vs secondary)
     * @param {number} days - Number of days to aggregate
     * @returns {Object} { primary: { found, notFound, rate }, secondary: { found, notFound, rate }, combined: { rate } }
     */
    getLanguageMatchSummary(days = 30) {
        try {
            const stmt = db.prepare(`
                SELECT 
                    priority,
                    SUM(found_count) as found,
                    SUM(not_found_count) as not_found
                FROM language_stats 
                WHERE date >= date('now', '-' || ? || ' days')
                GROUP BY priority
            `);
            const rows = stmt.all(days);
            
            const primary = { found: 0, notFound: 0, rate: 0 };
            const secondary = { found: 0, notFound: 0, rate: 0 };
            
            rows.forEach(row => {
                if (row.priority === 'primary') {
                    primary.found = row.found || 0;
                    primary.notFound = row.not_found || 0;
                } else if (row.priority === 'secondary') {
                    secondary.found = row.found || 0;
                    secondary.notFound = row.not_found || 0;
                }
            });
            
            const primaryTotal = primary.found + primary.notFound;
            const secondaryTotal = secondary.found + secondary.notFound;
            const combinedFound = primary.found + secondary.found;
            const combinedTotal = primaryTotal + secondaryTotal;
            
            primary.rate = primaryTotal > 0 ? Math.round((primary.found / primaryTotal) * 100) : 0;
            secondary.rate = secondaryTotal > 0 ? Math.round((secondary.found / secondaryTotal) * 100) : 0;
            const combinedRate = combinedTotal > 0 ? Math.round((combinedFound / combinedTotal) * 100) : 0;
            
            return { primary, secondary, combined: { rate: combinedRate, found: combinedFound, total: combinedTotal } };
        } catch (error) {
            console.error('[StatsDB] GetLanguageMatchSummary error:', error.message);
            return { 
                primary: { found: 0, notFound: 0, rate: 0 }, 
                secondary: { found: 0, notFound: 0, rate: 0 }, 
                combined: { rate: 0, found: 0, total: 0 } 
            };
        }
    }
    
    /**
     * Get top successful languages
     * @param {number} days - Number of days
     * @param {number} limit - Number of languages to return
     * @returns {Object} Map of language code to count
     */
    getTopSuccessfulLanguages(days = 30, limit = 10) {
        try {
            const stmt = db.prepare(`
                SELECT 
                    language_code,
                    SUM(found_count) as found_count
                FROM language_stats 
                WHERE date >= date('now', '-' || ? || ' days')
                  AND found_count > 0
                GROUP BY language_code
                ORDER BY found_count DESC
                LIMIT ?
            `);
            const rows = stmt.all(days, limit);
            const result = {};
            rows.forEach(row => {
                result[row.language_code.toUpperCase()] = row.found_count;
            });
            return result;
        } catch (error) {
            console.error('[StatsDB] GetTopSuccessfulLanguages error:', error.message);
            return {};
        }
    }
    
    // =====================================================
    // Cache Analytics Methods (Phase 2.5)
    // =====================================================
    
    /**
     * Get comprehensive cache statistics
     * @returns {Object} Cache stats
     */
    getCacheStats() {
        try {
            // Basic counts
            const counts = db.prepare(`
                SELECT 
                    COUNT(*) as total_entries,
                    COUNT(DISTINCT imdb_id) as unique_content,
                    COUNT(DISTINCT language) as unique_languages,
                    COUNT(DISTINCT source) as unique_sources
                FROM subtitle_cache
            `).get();
            
            // Database size
            const sizeInfo = db.prepare(`
                SELECT page_count * page_size as size_bytes 
                FROM pragma_page_count(), pragma_page_size()
            `).get();
            
            // Age stats
            const ageStats = db.prepare(`
                SELECT 
                    MIN(updated_at) as oldest_timestamp,
                    MAX(updated_at) as newest_timestamp,
                    AVG(strftime('%s', 'now') - updated_at) as avg_age_seconds
                FROM subtitle_cache
            `).get();
            
            // Cache hit rate
            const hitRate = this.getCacheHitRate();
            
            return {
                entries: counts.total_entries,
                uniqueContent: counts.unique_content,
                uniqueLanguages: counts.unique_languages,
                uniqueSources: counts.unique_sources,
                sizeMB: sizeInfo ? (sizeInfo.size_bytes / 1024 / 1024).toFixed(2) : '0',
                oldestAge: ageStats.oldest_timestamp 
                    ? Math.floor((Date.now() / 1000) - ageStats.oldest_timestamp)
                    : 0,
                newestAge: ageStats.newest_timestamp
                    ? Math.floor((Date.now() / 1000) - ageStats.newest_timestamp)
                    : 0,
                avgAgeHours: ageStats.avg_age_seconds
                    ? Math.round(ageStats.avg_age_seconds / 3600)
                    : 0,
                hitRate: hitRate.rate,
                hits: hitRate.hits,
                misses: hitRate.misses
            };
        } catch (error) {
            console.error('[StatsDB] GetCacheStats error:', error.message);
            return {
                entries: 0,
                uniqueContent: 0,
                uniqueLanguages: 0,
                uniqueSources: 0,
                sizeMB: '0',
                oldestAge: 0,
                newestAge: 0,
                avgAgeHours: 0,
                hitRate: 0,
                hits: 0,
                misses: 0
            };
        }
    }
    
    /**
     * Get content cache summary (for browsing)
     * @param {Object} options - { page, limit }
     * @returns {Object} { items, total, page, limit }
     */
    getContentCacheSummary(options = {}) {
        const page = Math.max(1, parseInt(options.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 20));
        const offset = (page - 1) * limit;
        
        try {
            const countStmt = db.prepare(`
                SELECT COUNT(DISTINCT imdb_id || '-' || COALESCE(season, '') || '-' || COALESCE(episode, '')) as total
                FROM subtitle_cache
            `);
            const total = countStmt.get().total;
            
            const dataStmt = db.prepare(`
                SELECT * FROM content_cache_summary
                LIMIT ? OFFSET ?
            `);
            const items = dataStmt.all(limit, offset);
            
            return { items, total, page, limit };
        } catch (error) {
            console.error('[StatsDB] GetContentCacheSummary error:', error.message);
            return { items: [], total: 0, page, limit };
        }
    }
    
    /**
     * Search cache by IMDB ID
     * @param {string} imdbId - IMDB ID (validated)
     * @returns {Object} Detailed cache info for this content
     */
    searchCacheByImdb(imdbId) {
        try {
            // Get summary for this IMDB ID
            const summaryStmt = db.prepare(`
                SELECT 
                    imdb_id,
                    season,
                    episode,
                    language,
                    COUNT(*) as subtitle_count,
                    GROUP_CONCAT(DISTINCT source) as sources,
                    MAX(updated_at) as last_updated
                FROM subtitle_cache
                WHERE imdb_id = ?
                GROUP BY imdb_id, season, episode, language
                ORDER BY season, episode, language
            `);
            const results = summaryStmt.all(imdbId);
            
            if (results.length === 0) {
                return null;
            }
            
            // Aggregate totals
            const totalSubtitles = results.reduce((sum, r) => sum + r.subtitle_count, 0);
            const uniqueLanguages = new Set(results.map(r => r.language)).size;
            const allSources = new Set();
            results.forEach(r => {
                if (r.sources) r.sources.split(',').forEach(s => allSources.add(s));
            });
            
            return {
                imdbId,
                totalSubtitles,
                uniqueLanguages,
                sources: [...allSources],
                breakdown: results,
                lastUpdated: Math.max(...results.map(r => r.last_updated))
            };
        } catch (error) {
            console.error('[StatsDB] SearchCacheByImdb error:', error.message);
            return null;
        }
    }
}

module.exports = new StatsDB();

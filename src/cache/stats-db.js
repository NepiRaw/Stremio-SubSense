/**
 * Persistent Statistics - SQLite-backed stats storage
 * Replaces in-memory stats for persistence across restarts
 */
const db = require('./database');

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
     * @param {Object} data - { requests, cacheHits, cacheMisses, conversions }
     */
    recordDaily(data) {
        const today = new Date().toISOString().split('T')[0];
        try {
            const stmt = db.prepare(`
                INSERT INTO stats_daily (date, requests, cache_hits, cache_misses, conversions)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(date) DO UPDATE SET
                    requests = requests + ?,
                    cache_hits = cache_hits + ?,
                    cache_misses = cache_misses + ?,
                    conversions = conversions + ?
            `);
            stmt.run(
                today,
                data.requests || 0,
                data.cacheHits || 0,
                data.cacheMisses || 0,
                data.conversions || 0,
                data.requests || 0,
                data.cacheHits || 0,
                data.cacheMisses || 0,
                data.conversions || 0
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
}

module.exports = new StatsDB();

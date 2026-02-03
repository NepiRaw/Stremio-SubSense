/**
 * Async Subtitle Cache - Non-blocking Get, Set, and Background Refresh
 * Uses LibSQL for async database operations
 */
const db = require('./database-libsql');
const { log } = require('../utils');

const REFRESH_INTERVAL = parseInt(process.env.CACHE_REFRESH_INTERVAL || '604800');

class SubtitleCacheAsync {
    /**
     * Get cached subtitles for a content/language combination
     * @returns {Promise<Object|null>} { subtitles, needsRefresh }
     */
    async get(imdbId, season, episode, language) {
        try {
            const result = await db.execute(`
                SELECT *, 
                       (strftime('%s', 'now') - updated_at) as age_seconds
                FROM subtitle_cache 
                WHERE imdb_id = ? 
                  AND (season IS ? OR (season IS NULL AND ? IS NULL))
                  AND (episode IS ? OR (episode IS NULL AND ? IS NULL))
                  AND language = ?
                ORDER BY rating DESC, id ASC
            `, [imdbId, season, season, episode, episode, language]);
            
            if (result.rows.length === 0) {
                return null;
            }
            
            const needsRefresh = result.rows.some(row => row.age_seconds > REFRESH_INTERVAL);
            
            const subtitles = result.rows.map(row => ({
                id: row.subtitle_id,
                url: row.url,
                lang: row.language,
                format: row.format,
                needsConversion: row.needs_conversion === 1 ? true : 
                                 row.needs_conversion === 0 ? false : null,
                rating: row.rating,
                source: row.source,
                title: row.title
            }));
            
            return { subtitles, needsRefresh };
        } catch (error) {
            log('error', '[Cache] Get error:', error.message);
            return null;
        }
    }
    
    /**
     * Store subtitles in cache
     */
    async set(imdbId, season, episode, language, subtitles) {
        if (!subtitles || subtitles.length === 0) {
            return;
        }
        
        try {
            const statements = subtitles.map(sub => {
                const needsConv = sub.needsConversion === true ? 1 : 
                                 sub.needsConversion === false ? 0 : null;
                return {
                    sql: `
                        INSERT INTO subtitle_cache 
                            (imdb_id, season, episode, language, subtitle_id, title, url, format, needs_conversion, rating, source, updated_at)
                        VALUES 
                            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
                        ON CONFLICT(imdb_id, season, episode, language, subtitle_id) 
                        DO UPDATE SET 
                            url = excluded.url,
                            format = excluded.format,
                            needs_conversion = excluded.needs_conversion,
                            rating = excluded.rating,
                            source = excluded.source,
                            updated_at = strftime('%s', 'now')
                    `,
                    args: [
                        imdbId,
                        season,
                        episode,
                        language,
                        sub.id || sub.subtitle_id || `${Date.now()}-${Math.random()}`,
                        sub.title || sub.releaseName || null,
                        sub.url,
                        sub.format || null,
                        needsConv,
                        sub.rating || null,
                        Array.isArray(sub.source) ? sub.source[0] : (sub.source || null)
                    ]
                };
            });
            
            await db.batch(statements, 'write');
        } catch (error) {
            log('error', '[Cache] Set error:', error.message);
        }
    }
    
    /**
     * Update the timestamp for a cache entry
     */
    async touch(imdbId, season, episode, language) {
        try {
            await db.execute(`
                UPDATE subtitle_cache 
                SET updated_at = strftime('%s', 'now')
                WHERE imdb_id = ? 
                  AND (season IS ? OR (season IS NULL AND ? IS NULL))
                  AND (episode IS ? OR (episode IS NULL AND ? IS NULL))
                  AND language = ?
            `, [imdbId, season, season, episode, episode, language]);
        } catch (error) {
            log('error', '[Cache] Touch error:', error.message);
        }
    }
    
    /**
     * Clear all cached subtitles
     */
    async clear() {
        try {
            await db.execute('DELETE FROM subtitle_cache');
            log('info', '[Cache] Cache cleared');
        } catch (error) {
            log('error', '[Cache] Clear error:', error.message);
        }
    }
    
    /**
     * Get cache statistics
     */
    async getStats() {
        try {
            const [countResult, oldestResult] = await Promise.all([
                db.execute('SELECT COUNT(*) as count FROM subtitle_cache'),
                db.execute('SELECT MIN(updated_at) as oldest FROM subtitle_cache')
            ]);
            
            const count = countResult.rows[0]?.count || 0;
            const oldest = oldestResult.rows[0]?.oldest;
            
            return {
                entries: count,
                oldestAge: oldest ? Math.floor((Date.now() / 1000) - oldest) : 0
            };
        } catch (error) {
            log('error', '[Cache] GetStats error:', error.message);
            return { entries: 0, oldestAge: 0 };
        }
    }
}

module.exports = new SubtitleCacheAsync();

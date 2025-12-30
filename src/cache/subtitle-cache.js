/**
 * Subtitle Cache - Get, Set, and Background Refresh
 * Simple caching layer for subtitle results
 */
const db = require('./database');

// Default: 24 hours before triggering background refresh
const REFRESH_INTERVAL = parseInt(process.env.CACHE_REFRESH_INTERVAL || '86400');

class SubtitleCache {
    /**
     * Get cached subtitles for a content/language combination
     * @param {string} imdbId - IMDB ID
     * @param {number|null} season - Season number (null for movies)
     * @param {number|null} episode - Episode number (null for movies)
     * @param {string} language - Language code (2-letter)
     * @returns {Object|null} { subtitles, needsRefresh }
     */
    get(imdbId, season, episode, language) {
        try {
            const stmt = db.prepare(`
                SELECT *, 
                       (strftime('%s', 'now') - updated_at) as age_seconds
                FROM subtitle_cache 
                WHERE imdb_id = ? 
                  AND (season IS ? OR (season IS NULL AND ? IS NULL))
                  AND (episode IS ? OR (episode IS NULL AND ? IS NULL))
                  AND language = ?
                ORDER BY rating DESC, id ASC
            `);
            
            const rows = stmt.all(imdbId, season, season, episode, episode, language);
            
            if (rows.length === 0) {
                return null;
            }
            
            // Check if any entry needs refresh (older than REFRESH_INTERVAL)
            const needsRefresh = rows.some(row => row.age_seconds > REFRESH_INTERVAL);
            
            // Convert DB rows to subtitle objects
            const subtitles = rows.map(row => ({
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
            console.error('[Cache] Get error:', error.message);
            return null;
        }
    }
    
    /**
     * Store subtitles in cache
     * @param {string} imdbId - IMDB ID
     * @param {number|null} season - Season number
     * @param {number|null} episode - Episode number
     * @param {string} language - Language code
     * @param {Array} subtitles - Array of subtitle objects
     */
    set(imdbId, season, episode, language, subtitles) {
        if (!subtitles || subtitles.length === 0) {
            return;
        }
        
        try {
            const stmt = db.prepare(`
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
            `);
            
            const insertMany = db.transaction((subs) => {
                for (const sub of subs) {
                    const needsConv = sub.needsConversion === true ? 1 : 
                                     sub.needsConversion === false ? 0 : null;
                    stmt.run(
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
                    );
                }
            });
            
            insertMany(subtitles);
            console.log(`[Cache] Stored ${subtitles.length} subtitles for ${imdbId} (${language})`);
        } catch (error) {
            console.error('[Cache] Set error:', error.message);
        }
    }
    
    /**
     * Update the timestamp for a cache entry (mark as refreshed)
     * @param {string} imdbId - IMDB ID
     * @param {number|null} season - Season number
     * @param {number|null} episode - Episode number
     * @param {string} language - Language code
     */
    touch(imdbId, season, episode, language) {
        try {
            const stmt = db.prepare(`
                UPDATE subtitle_cache 
                SET updated_at = strftime('%s', 'now')
                WHERE imdb_id = ? 
                  AND (season IS ? OR (season IS NULL AND ? IS NULL))
                  AND (episode IS ? OR (episode IS NULL AND ? IS NULL))
                  AND language = ?
            `);
            stmt.run(imdbId, season, season, episode, episode, language);
        } catch (error) {
            console.error('[Cache] Touch error:', error.message);
        }
    }
    
    /**
     * Clear all cached subtitles (for debugging)
     */
    clear() {
        try {
            db.prepare('DELETE FROM subtitle_cache').run();
            console.log('[Cache] Cache cleared');
        } catch (error) {
            console.error('[Cache] Clear error:', error.message);
        }
    }
    
    /**
     * Get cache statistics
     * @returns {Object} Cache stats
     */
    getStats() {
        try {
            const countStmt = db.prepare('SELECT COUNT(*) as count FROM subtitle_cache');
            const oldestStmt = db.prepare(`
                SELECT MIN(updated_at) as oldest FROM subtitle_cache
            `);
            
            const count = countStmt.get();
            const oldest = oldestStmt.get();
            
            return {
                entries: count.count,
                oldestAge: oldest.oldest ? Math.floor((Date.now() / 1000) - oldest.oldest) : 0
            };
        } catch (error) {
            console.error('[Cache] GetStats error:', error.message);
            return { entries: 0, oldestAge: 0 };
        }
    }
}

module.exports = new SubtitleCache();

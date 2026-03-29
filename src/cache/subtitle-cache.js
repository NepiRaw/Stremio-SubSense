/**
 * Async Subtitle Cache - Non-blocking Get, Set, and Background Refresh
 * Uses LibSQL for async database operations
 */
const crypto = require('crypto');
const db = require('./database-libsql');
const { log } = require('../utils');

const REFRESH_INTERVAL = parseInt(process.env.CACHE_REFRESH_INTERVAL || '604800');
const MAX_CACHE_RESULTS_PER_LANGUAGE = 200;

function normalizeCacheDimension(value) {
    return value == null ? 0 : value;
}

function buildStableSubtitleId(subtitle) {
    const explicitId = subtitle.id ?? subtitle.subtitle_id;
    if (explicitId !== undefined && explicitId !== null && String(explicitId).trim() !== '') {
        return String(explicitId).trim();
    }

    const source = Array.isArray(subtitle.source)
        ? subtitle.source[0]
        : (subtitle.source || subtitle.provider || 'unknown');

    const fingerprint = [
        subtitle.url || '',
        subtitle.title || subtitle.releaseName || subtitle.release || '',
        source,
        subtitle.lang || subtitle.language || '',
        subtitle.format || '',
        subtitle.needsConversion == null ? '' : String(subtitle.needsConversion)
    ].join('|');

    return crypto.createHash('sha1').update(fingerprint).digest('hex');
}

class SubtitleCacheAsync {
    /**
     * Get cached subtitles for a content/language combination
     * @returns {Promise<Object|null>} { subtitles, needsRefresh }
     */
    async get(imdbId, season, episode, language) {
        try {
            const normalizedSeason = normalizeCacheDimension(season);
            const normalizedEpisode = normalizeCacheDimension(episode);
            const result = await db.execute(`
                SELECT 
                    MAX(id) as id,
                    MAX(subtitle_id) as subtitle_id,
                    MAX(url) as url,
                    language,
                    MAX(format) as format,
                    MAX(needs_conversion) as needs_conversion,
                    MAX(rating) as rating,
                    MAX(source) as source,
                    MAX(title) as title,
                    MAX(updated_at) as updated_at,
                    (strftime('%s', 'now') - MAX(updated_at)) as age_seconds
                FROM subtitle_cache
                WHERE imdb_id = ? 
                  AND (season = ? OR (season IS NULL AND ? = 0))
                  AND (episode = ? OR (episode IS NULL AND ? = 0))
                  AND language = ?
                GROUP BY COALESCE(NULLIF(url, ''), NULLIF(TRIM(subtitle_id), ''), COALESCE(title, ''), CAST(id AS TEXT)), language
                ORDER BY rating DESC, id ASC
                LIMIT ?
            `, [imdbId, normalizedSeason, normalizedSeason, normalizedEpisode, normalizedEpisode, language, MAX_CACHE_RESULTS_PER_LANGUAGE]);
            
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
            const normalizedSeason = normalizeCacheDimension(season);
            const normalizedEpisode = normalizeCacheDimension(episode);
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
                        normalizedSeason,
                        normalizedEpisode,
                        language,
                        buildStableSubtitleId(sub),
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
            const normalizedSeason = normalizeCacheDimension(season);
            const normalizedEpisode = normalizeCacheDimension(episode);
            await db.execute(`
                UPDATE subtitle_cache 
                SET updated_at = strftime('%s', 'now')
                WHERE imdb_id = ? 
                  AND (season = ? OR (season IS NULL AND ? = 0))
                  AND (episode = ? OR (episode IS NULL AND ? = 0))
                  AND language = ?
            `, [imdbId, normalizedSeason, normalizedSeason, normalizedEpisode, normalizedEpisode, language]);
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

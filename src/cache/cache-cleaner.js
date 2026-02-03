/**
 * Background Cache Cleaner (Async)
 * Cleans up old request logs, stale subtitle cache entries, and inactive sessions
 */
const db = require('./database-libsql');
const { log } = require('../utils');

const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const LOG_RETENTION_DAYS = 30;
const CACHE_RETENTION_DAYS = parseInt(process.env.CACHE_RETENTION_DAYS, 10) || 14;
const SESSION_RETENTION_DAYS = 60;

/**
 * Clean old request logs (keeps last 30 days)
 */
async function cleanOldRequestLogs() {
    try {
        const result = await db.execute(`
            DELETE FROM request_log 
            WHERE created_at < strftime('%s', 'now', '-' || ? || ' days')
        `, [LOG_RETENTION_DAYS]);
        if (result.rowsAffected > 0) {
            log('info', `Cleanup: removed ${result.rowsAffected} old request logs`);
        }
    } catch (error) {
        log('error', `Cleanup error (logs): ${error.message}`);
    }
}

/**
 * Clean old subtitle cache entries
 */
async function cleanOldCacheEntries() {
    try {
        const result = await db.execute(`
            DELETE FROM subtitle_cache 
            WHERE updated_at < strftime('%s', 'now', '-' || ? || ' days')
        `, [CACHE_RETENTION_DAYS]);
        if (result.rowsAffected > 0) {
            log('info', `Cleanup: removed ${result.rowsAffected} old cache entries (>${CACHE_RETENTION_DAYS} days)`);
        }
    } catch (error) {
        log('error', `Cleanup error (cache): ${error.message}`);
    }
}

/**
 * Clean inactive sessions
 */
async function cleanInactiveSessions() {
    try {
        const contentResult = await db.execute(`
            DELETE FROM user_content_log 
            WHERE user_id IN (
                SELECT user_id FROM user_tracking 
                WHERE last_active < strftime('%s', 'now', '-' || ? || ' days')
            )
        `, [SESSION_RETENTION_DAYS]);
        
        const sessionResult = await db.execute(`
            DELETE FROM user_tracking 
            WHERE last_active < strftime('%s', 'now', '-' || ? || ' days')
        `, [SESSION_RETENTION_DAYS]);
        
        if (sessionResult.rowsAffected > 0) {
            log('info', `Cleanup: removed ${sessionResult.rowsAffected} inactive sessions (${contentResult.rowsAffected} content logs)`);
        }
    } catch (error) {
        log('error', `Cleanup error (sessions): ${error.message}`);
    }
}

/**
 * Get cache statistics for monitoring
 */
async function getCacheStats() {
    try {
        const result = await db.execute(`
            SELECT 
                COUNT(*) as total_entries,
                COUNT(DISTINCT imdb_id) as unique_content,
                COUNT(DISTINCT language) as unique_languages
            FROM subtitle_cache
        `);
        const stats = result.rows?.[0] || {};
        
        const sizeResult = await db.execute(`
            SELECT page_count * page_size as size_bytes 
            FROM pragma_page_count(), pragma_page_size()
        `);
        const sizeInfo = sizeResult.rows?.[0];
        
        return {
            ...stats,
            sizeMB: sizeInfo ? (sizeInfo.size_bytes / 1024 / 1024).toFixed(2) : 'unknown'
        };
    } catch (error) {
        log('error', '[Cache] Stats error:', error.message);
        return null;
    }
}

/**
 * Run all cleanup tasks
 */
async function runCleanup() {
    await cleanOldRequestLogs();
    await cleanOldCacheEntries();
    await cleanInactiveSessions();
}

/**
 * Start the background cleaner
 */
function startCleaner() {
    log('info', `[Cache] Starting background cleaner (cache: ${CACHE_RETENTION_DAYS} days, sessions: ${SESSION_RETENTION_DAYS} days)`);
    runCleanup().catch(err => log('error', `Initial cleanup error: ${err.message}`));
    setInterval(() => runCleanup().catch(err => log('error', `Cleanup error: ${err.message}`)), CLEANUP_INTERVAL);
}

module.exports = { startCleaner, cleanOldRequestLogs, cleanOldCacheEntries, cleanInactiveSessions, getCacheStats };

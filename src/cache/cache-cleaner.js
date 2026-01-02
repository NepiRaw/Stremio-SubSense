/**
 * Background Cache Cleaner
 * Cleans up old request logs, stale subtitle cache entries, and inactive sessions
 */
const db = require('./database');
const { log } = require('../utils');

const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const LOG_RETENTION_DAYS = 30;
const CACHE_RETENTION_DAYS = parseInt(process.env.CACHE_RETENTION_DAYS, 10) || 90; // 3 months default
const SESSION_RETENTION_DAYS = 60; // Remove sessions inactive for 60 days

/**
 * Clean old request logs (keeps last 30 days)
 */
function cleanOldRequestLogs() {
    try {
        const stmt = db.prepare(`
            DELETE FROM request_log 
            WHERE created_at < strftime('%s', 'now', '-' || ? || ' days')
        `);
        const result = stmt.run(LOG_RETENTION_DAYS);
        if (result.changes > 0) {
            log('info', `Cleanup: removed ${result.changes} old request logs`);
        }
    } catch (error) {
        log('error', `Cleanup error (logs): ${error.message}`);
    }
}

/**
 * Clean old subtitle cache entries (keeps last X days based on updated_at)
 */
function cleanOldCacheEntries() {
    try {
        const stmt = db.prepare(`
            DELETE FROM subtitle_cache 
            WHERE updated_at < strftime('%s', 'now', '-' || ? || ' days')
        `);
        const result = stmt.run(CACHE_RETENTION_DAYS);
        if (result.changes > 0) {
            log('info', `Cleanup: removed ${result.changes} old cache entries (>${CACHE_RETENTION_DAYS} days)`);
        }
    } catch (error) {
        log('error', `Cleanup error (cache): ${error.message}`);
    }
}

/**
 * Clean inactive sessions (no requests in 60 days)
 */
function cleanInactiveSessions() {
    try {
        // First, clean up content logs for sessions that will be deleted
        const contentLogStmt = db.prepare(`
            DELETE FROM user_content_log 
            WHERE user_id IN (
                SELECT user_id FROM user_tracking 
                WHERE last_active < strftime('%s', 'now', '-' || ? || ' days')
            )
        `);
        const contentResult = contentLogStmt.run(SESSION_RETENTION_DAYS);
        
        // Then delete the inactive sessions
        const sessionStmt = db.prepare(`
            DELETE FROM user_tracking 
            WHERE last_active < strftime('%s', 'now', '-' || ? || ' days')
        `);
        const sessionResult = sessionStmt.run(SESSION_RETENTION_DAYS);
        
        if (sessionResult.changes > 0) {
            log('info', `Cleanup: removed ${sessionResult.changes} inactive sessions (>${SESSION_RETENTION_DAYS} days, ${contentResult.changes} content logs)`);
        }
    } catch (error) {
        log('error', `Cleanup error (sessions): ${error.message}`);
    }
}

/**
 * Get cache statistics for monitoring
 */
function getCacheStats() {
    try {
        const stats = db.prepare(`
            SELECT 
                COUNT(*) as total_entries,
                COUNT(DISTINCT imdb_id) as unique_content,
                COUNT(DISTINCT language) as unique_languages
            FROM subtitle_cache
        `).get();
        
        const sizeInfo = db.prepare(`
            SELECT page_count * page_size as size_bytes 
            FROM pragma_page_count(), pragma_page_size()
        `).get();
        
        return {
            ...stats,
            sizeMB: sizeInfo ? (sizeInfo.size_bytes / 1024 / 1024).toFixed(2) : 'unknown'
        };
    } catch (error) {
        console.error('[Cache] Stats error:', error.message);
        return null;
    }
}

/**
 * Run all cleanup tasks
 */
function runCleanup() {
    cleanOldRequestLogs();
    cleanOldCacheEntries();
    cleanInactiveSessions();
}

/**
 * Start the background cleaner
 */
function startCleaner() {
    log('info', `Starting background cleaner (cache: ${CACHE_RETENTION_DAYS} days, sessions: ${SESSION_RETENTION_DAYS} days)`);
    runCleanup(); // Initial cleanup
    setInterval(runCleanup, CLEANUP_INTERVAL);
}

module.exports = { startCleaner, cleanOldRequestLogs, cleanOldCacheEntries, cleanInactiveSessions, getCacheStats };

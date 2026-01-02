/**
 * Statistics tracking service
 */

// Database stats module (lazy-loaded)
let statsDB = null;
function getStatsDB() {
    if (!statsDB) {
        try {
            const cache = require('./cache');
            statsDB = cache.statsDB;
        } catch (e) {
            // Cache not available
        }
    }
    return statsDB;
}

// In-memory stats for real-time updates (volatile)
const stats = {
    startedAt: new Date(),
    requests: {
        total: 0,
        movie: 0,
        series: 0,
        byDate: {}
    },
    subtitles: {
        total: 0,
        bySource: {},
        byLanguage: {}
    },
    languageMatching: {
        primaryFound: 0,
        primaryNotFound: 0,
        secondaryFound: 0,
        secondaryNotFound: 0,
        byLanguageSuccess: {} // Track which languages are frequently found
    },
    timing: {
        totalMs: 0,
        count: 0,
        minMs: Infinity,
        maxMs: 0,
        history: [] // Keep last 100 fetch times
    },
    errors: {
        total: 0,
        recent: [] // Keep last 10 errors
    }
};

const HISTORY_LIMIT = 100;
const ERROR_LIMIT = 10;

/**
 * Get today's date key for daily stats (uses local timezone)
 */
function getDateKey() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`; // YYYY-MM-DD in local time
}

/**
 * Track a subtitle request
 * @param {Object} data - Request data
 * @param {string} data.type - Content type (movie/series)
 * @param {number} data.fetchTimeMs - Time taken to fetch subtitles
 * @param {number} data.subtitleCount - Number of subtitles returned
 * @param {Array} data.subtitles - Subtitle objects with source info
 * @param {Object} data.languageMatch - Language matching results
 */
function trackRequest({ type, fetchTimeMs, subtitleCount, subtitles = [], languageMatch = null }) {
    const dateKey = getDateKey();

    // Track request counts
    stats.requests.total++;
    if (type === 'movie') stats.requests.movie++;
    if (type === 'series') stats.requests.series++;

    // Track by date
    if (!stats.requests.byDate[dateKey]) {
        stats.requests.byDate[dateKey] = { total: 0, movie: 0, series: 0 };
    }
    stats.requests.byDate[dateKey].total++;
    stats.requests.byDate[dateKey][type]++;

    // Track subtitle counts
    stats.subtitles.total += subtitleCount;

    // Track by source
    subtitles.forEach(sub => {
        const source = sub.source || 'unknown';
        stats.subtitles.bySource[source] = (stats.subtitles.bySource[source] || 0) + 1;
        
        const lang = sub.lang || 'unknown';
        stats.subtitles.byLanguage[lang] = (stats.subtitles.byLanguage[lang] || 0) + 1;
    });

    // Track language matching results
    if (languageMatch) {
        if (languageMatch.primaryLang) {
            if (languageMatch.primaryFound) {
                stats.languageMatching.primaryFound++;
                stats.languageMatching.byLanguageSuccess[languageMatch.primaryLang] = 
                    (stats.languageMatching.byLanguageSuccess[languageMatch.primaryLang] || 0) + 1;
            } else {
                stats.languageMatching.primaryNotFound++;
            }
        }
        if (languageMatch.secondaryLang && languageMatch.secondaryLang !== 'none') {
            if (languageMatch.secondaryFound) {
                stats.languageMatching.secondaryFound++;
                stats.languageMatching.byLanguageSuccess[languageMatch.secondaryLang] = 
                    (stats.languageMatching.byLanguageSuccess[languageMatch.secondaryLang] || 0) + 1;
            } else {
                stats.languageMatching.secondaryNotFound++;
            }
        }
    }

    // Track timing
    if (fetchTimeMs !== undefined) {
        stats.timing.totalMs += fetchTimeMs;
        stats.timing.count++;
        stats.timing.minMs = Math.min(stats.timing.minMs, fetchTimeMs);
        stats.timing.maxMs = Math.max(stats.timing.maxMs, fetchTimeMs);
        
        stats.timing.history.push(fetchTimeMs);
        if (stats.timing.history.length > HISTORY_LIMIT) {
            stats.timing.history.shift();
        }
    }
    
    // Persist key counters to database
    const db = getStatsDB();
    if (db) {
        db.increment('total_requests');
        if (type === 'movie') db.increment('total_movies');
        if (type === 'series') db.increment('total_series');
        db.increment('total_subtitles', subtitleCount);
    }
}

/**
 * Track an error
 * @param {Error} error - The error object
 * @param {Object} context - Additional context
 */
function trackError(error, context = {}) {
    stats.errors.total++;
    stats.errors.recent.push({
        message: error.message,
        timestamp: new Date().toISOString(),
        context
    });
    
    if (stats.errors.recent.length > ERROR_LIMIT) {
        stats.errors.recent.shift();
    }
}

/**
 * Get current statistics
 * Merges in-memory (session) stats with persistent (database) stats
 * @returns {Object} Statistics object
 */
function getStats() {
    const uptime = Date.now() - stats.startedAt.getTime();
    const avgMs = stats.timing.count > 0 
        ? Math.round(stats.timing.totalMs / stats.timing.count) 
        : 0;

    // Get persistent counters from database
    let persistentStats = {};
    let dailyStats = [];
    let languageMatchSummary = null;
    let topLanguages = {};
    let sourceStats = {};
    let langDistribution = {};
    
    const db = getStatsDB();
    if (db) {
        persistentStats = db.getAll();
        dailyStats = db.getDailyStats(30); // Last 30 days
        languageMatchSummary = db.getLanguageMatchSummary(30);
        topLanguages = db.getTopSuccessfulLanguages(30, 10);
        
        // Get source and language distribution from subtitle cache
        try {
            const dbConn = require('./cache/database');
            
            // Get subtitles by source
            const sourceRows = dbConn.prepare(`
                SELECT source, COUNT(*) as count 
                FROM subtitle_cache 
                WHERE source IS NOT NULL 
                GROUP BY source
            `).all();
            sourceRows.forEach(row => {
                sourceStats[row.source] = row.count;
            });
            
            // Get subtitles by language
            const langRows = dbConn.prepare(`
                SELECT language, COUNT(*) as count 
                FROM subtitle_cache 
                WHERE language IS NOT NULL 
                GROUP BY language
                ORDER BY count DESC
            `).all();
            langRows.forEach(row => {
                langDistribution[row.language] = row.count;
            });
        } catch (e) {
            // Fallback to in-memory
        }
    }
    
    // Use persistent stats for totals, fallback to in-memory
    const totalRequests = persistentStats.total_requests || stats.requests.total;
    const totalMovies = persistentStats.total_movies || stats.requests.movie;
    const totalSeries = persistentStats.total_series || stats.requests.series;
    const totalSubtitles = persistentStats.total_subtitles || stats.subtitles.total;
    
    // Preferred languages rate - success if primary OR secondary found
    const preferredRequests = persistentStats.preferred_requests || 0;
    const preferredFound = persistentStats.preferred_found || 0;
    const preferredSuccessRate = preferredRequests > 0 
        ? Math.round((preferredFound / preferredRequests) * 100) 
        : 0;

    // Use DB-backed language match stats if available
    let primaryFoundCount, primaryNotFound, secondaryFound, secondaryNotFound, primarySuccessRate, secondarySuccessRate;
    let byLanguageSuccess = {};
    
    if (languageMatchSummary) {
        primaryFoundCount = languageMatchSummary.primary.found;
        primaryNotFound = languageMatchSummary.primary.notFound;
        secondaryFound = languageMatchSummary.secondary.found;
        secondaryNotFound = languageMatchSummary.secondary.notFound;
        primarySuccessRate = languageMatchSummary.primary.rate;
        secondarySuccessRate = languageMatchSummary.secondary.rate;
        byLanguageSuccess = topLanguages;
    } else {
        // Fallback to in-memory
        primaryFoundCount = stats.languageMatching.primaryFound;
        primaryNotFound = stats.languageMatching.primaryNotFound;
        secondaryFound = stats.languageMatching.secondaryFound;
        secondaryNotFound = stats.languageMatching.secondaryNotFound;
        byLanguageSuccess = stats.languageMatching.byLanguageSuccess;
        
        const totalPrimaryRequests = primaryFoundCount + primaryNotFound;
        const totalSecondaryRequests = secondaryFound + secondaryNotFound;
        primarySuccessRate = totalPrimaryRequests > 0 
            ? Math.round((primaryFoundCount / totalPrimaryRequests) * 100) 
            : 0;
        secondarySuccessRate = totalSecondaryRequests > 0 
            ? Math.round((secondaryFound / totalSecondaryRequests) * 100) 
            : 0;
    }

    // Build daily activity from DB or in-memory
    let byDate = {};
    if (dailyStats.length > 0) {
        dailyStats.forEach(d => {
            byDate[d.date] = {
                total: d.requests,
                movie: d.movies || 0,
                series: d.series || 0,
                cacheHits: d.cache_hits,
                cacheMisses: d.cache_misses
            };
        });
    } else {
        byDate = getLast30Days(stats.requests.byDate);
    }

    // Use DB-backed source/language stats if available
    const subtitlesBySource = Object.keys(sourceStats).length > 0 ? sourceStats : stats.subtitles.bySource;
    const subtitlesByLanguage = Object.keys(langDistribution).length > 0 ? langDistribution : stats.subtitles.byLanguage;

    return {
        uptime: {
            ms: uptime,
            formatted: formatUptime(uptime)
        },
        startedAt: stats.startedAt.toISOString(),
        requests: {
            total: totalRequests,
            movie: totalMovies,
            series: totalSeries,
            // Use DB-backed byDate if available
            byDate: byDate
        },
        subtitles: {
            total: totalSubtitles,
            bySource: subtitlesBySource,
            byLanguage: subtitlesByLanguage
        },
        languageMatching: {
            primaryFound: primaryFoundCount,
            primaryNotFound,
            secondaryFound,
            secondaryNotFound,
            byLanguageSuccess,
            primarySuccessRate,
            secondarySuccessRate,
            preferredSuccessRate  // Success if primary OR secondary was found
        },
        timing: {
            avgMs,
            minMs: stats.timing.minMs === Infinity ? 0 : stats.timing.minMs,
            maxMs: stats.timing.maxMs,
            recentHistory: stats.timing.history.slice(-20) // Last 20 for charts
        },
        errors: stats.errors
    };
}

/**
 * Format uptime in human-readable format
 */
function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

/**
 * Get last 30 days of data
 */
function getLast30Days(byDate) {
    const result = {};
    const now = new Date();
    
    for (let i = 0; i < 30; i++) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);
        const key = date.toISOString().split('T')[0];
        if (byDate[key]) {
            result[key] = byDate[key];
        }
    }
    
    return result;
}

/**
 * Reset statistics (useful for testing)
 */
function resetStats() {
    stats.startedAt = new Date();
    stats.requests = { total: 0, movie: 0, series: 0, byDate: {} };
    stats.subtitles = { total: 0, bySource: {}, byLanguage: {} };
    stats.languageMatching = { primaryFound: 0, primaryNotFound: 0, secondaryFound: 0, secondaryNotFound: 0, byLanguageSuccess: {} };
    stats.timing = { totalMs: 0, count: 0, minMs: Infinity, maxMs: 0, history: [] };
    stats.errors = { total: 0, recent: [] };
}

module.exports = {
    trackRequest,
    trackError,
    getStats
};

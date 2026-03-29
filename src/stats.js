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
        totalRequests: 0,
        found: 0,
        notFound: 0,
        byLanguageSuccess: {}
    },
    timing: {
        totalMs: 0,
        count: 0,
        minMs: Infinity,
        maxMs: 0,
        history: []
    }
};

const HISTORY_LIMIT = 100;

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
    if (!areStatsWritesEnabled()) {
        return;
    }

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

    // Track language matching results (new model - all languages equal priority)
    if (languageMatch) {
        // Track each language requested
        if (languageMatch.languages && Array.isArray(languageMatch.languages)) {
            languageMatch.languages.forEach(lang => {
                stats.languageMatching.totalRequests++;
                if (languageMatch.found && languageMatch.found.includes(lang)) {
                    stats.languageMatching.found++;
                    stats.languageMatching.byLanguageSuccess[lang] = 
                        (stats.languageMatching.byLanguageSuccess[lang] || 0) + 1;
                } else {
                    stats.languageMatching.notFound++;
                }
            });
        } else {
            // Legacy fallback - single language check
            const lang = languageMatch.primaryLang || languageMatch.language;
            if (lang) {
                stats.languageMatching.totalRequests++;
                if (languageMatch.primaryFound || languageMatch.found) {
                    stats.languageMatching.found++;
                    stats.languageMatching.byLanguageSuccess[lang] = 
                        (stats.languageMatching.byLanguageSuccess[lang] || 0) + 1;
                } else {
                    stats.languageMatching.notFound++;
                }
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
    
    // Persist key counters to database (fire-and-forget - async)
    const db = getStatsDB();
    if (db) {
        Promise.all([
            db.increment('total_requests'),
            type === 'movie' ? db.increment('total_movies') : Promise.resolve(),
            type === 'series' ? db.increment('total_series') : Promise.resolve(),
            db.increment('total_subtitles', subtitleCount)
        ]).catch(err => console.error('Stats DB error:', err.message));
    }
}

/**
 * Get current statistics
 * Merges in-memory (session) stats with persistent (database) stats
 * @returns {Object} Statistics object
 */
async function getStats() {
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
        // Use Promise.all for parallel async calls
        const [persStats, dStats, langSummary, topLangs] = await Promise.all([
            db.getAll(),
            db.getDailyStats(30),
            db.getLanguageMatchSummary(30),
            db.getTopSuccessfulLanguages(30, 10)
        ]);
        
        persistentStats = persStats || {};
        dailyStats = dStats || [];
        languageMatchSummary = langSummary;
        topLanguages = topLangs || {};
        
        // Get source and language distribution from cache summary (O(1) read)
        try {
            const cacheStats = await db.getCacheStats();
            if (cacheStats.sourceDistribution) {
                sourceStats = cacheStats.sourceDistribution;
            }
            if (cacheStats.languageDistribution) {
                langDistribution = cacheStats.languageDistribution;
            }
        } catch (e) {
            // Fallback to in-memory
        }
    }
    
    // Use persistent stats for totals, fallback to in-memory
    const totalRequests = persistentStats.total_requests || stats.requests.total;
    const totalMovies = persistentStats.total_movies || stats.requests.movie;
    const totalSeries = persistentStats.total_series || stats.requests.series;
    const totalSubtitles = persistentStats.total_subtitles || stats.subtitles.total;

    // New model: get language match stats and active sessions from DB
    let langTotalRequests = 0;
    let langFound = 0;
    let langNotFound = 0;
    let successRate = 0;
    let byLanguageSuccess = {};
    let activeSessionCount = 0;
    let perLanguage = [];
    let anyPreferredRate = 0;
    let allPreferredRate = 0;
    let popularCombinations = [];
    
    if (languageMatchSummary) {
        langTotalRequests = languageMatchSummary.totalRequests || 0;
        langFound = languageMatchSummary.found || 0;
        langNotFound = languageMatchSummary.notFound || 0;
        successRate = languageMatchSummary.successRate || 0;
        byLanguageSuccess = topLanguages;
        perLanguage = languageMatchSummary.perLanguage || [];
    } else {
        // Fallback to in-memory
        langTotalRequests = stats.languageMatching.totalRequests || 0;
        langFound = stats.languageMatching.found || 0;
        langNotFound = stats.languageMatching.notFound || 0;
        successRate = langTotalRequests > 0 
            ? Math.round((langFound / langTotalRequests) * 100) 
            : 0;
        byLanguageSuccess = stats.languageMatching.byLanguageSuccess;
    }
    
    // Get active sessions count and language success rates (async)
    if (db) {
        try {
            const [userStats, successRates, popCombos] = await Promise.all([
                db.getAggregateUserStats(),
                db.getLanguageSuccessRates(30),
                db.getPopularLanguageCombinations(30, 10)
            ]);
            activeSessionCount = userStats?.activeSessions?.last30Days || 0;
            anyPreferredRate = successRates?.anyPreferredRate || 0;
            allPreferredRate = successRates?.allPreferredRate || 0;
            popularCombinations = popCombos || [];
        } catch (e) {
            // Fallback to 0
        }
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
            totalRequests: langTotalRequests,
            found: langFound,
            notFound: langNotFound,
            successRate,
            byLanguageSuccess,
            activeSessionCount,
            perLanguage,
            anyPreferredRate,
            allPreferredRate,
            popularCombinations
        },
        timing: {
            avgMs,
            minMs: stats.timing.minMs === Infinity ? 0 : stats.timing.minMs,
            maxMs: stats.timing.maxMs,
            recentHistory: stats.timing.history.slice(-20)
        }
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
    stats.languageMatching = { totalRequests: 0, found: 0, notFound: 0, byLanguageSuccess: {} };
    stats.timing = { totalMs: 0, count: 0, minMs: Infinity, maxMs: 0, history: [] };
}

module.exports = {
    trackRequest,
    getStats
};

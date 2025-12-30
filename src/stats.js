/**
 * Statistics tracking service (in-memory for Phase 1)
 */

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
 * Get today's date key for daily stats
 */
function getDateKey() {
    return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
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
 * @returns {Object} Statistics object
 */
function getStats() {
    const uptime = Date.now() - stats.startedAt.getTime();
    const avgMs = stats.timing.count > 0 
        ? Math.round(stats.timing.totalMs / stats.timing.count) 
        : 0;

    // Calculate language match success rates
    const totalPrimaryRequests = stats.languageMatching.primaryFound + stats.languageMatching.primaryNotFound;
    const totalSecondaryRequests = stats.languageMatching.secondaryFound + stats.languageMatching.secondaryNotFound;
    const primarySuccessRate = totalPrimaryRequests > 0 
        ? Math.round((stats.languageMatching.primaryFound / totalPrimaryRequests) * 100) 
        : 0;
    const secondarySuccessRate = totalSecondaryRequests > 0 
        ? Math.round((stats.languageMatching.secondaryFound / totalSecondaryRequests) * 100) 
        : 0;

    return {
        uptime: {
            ms: uptime,
            formatted: formatUptime(uptime)
        },
        startedAt: stats.startedAt.toISOString(),
        requests: {
            ...stats.requests,
            // Clean up byDate to only return last 30 days
            byDate: getLast30Days(stats.requests.byDate)
        },
        subtitles: stats.subtitles,
        languageMatching: {
            ...stats.languageMatching,
            primarySuccessRate,
            secondarySuccessRate
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

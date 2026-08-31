'use strict';

/**
 * In-memory statistics tracking service.
 *
 * The service respects the stats mode:
 *   full    - tracks everything, persists to DB
 *   minimal - only persists user tracking (for /configure user counts)
 *   disabled - no-op
 */

const { log } = require('../../src/utils');
const track = require('./track');

let _toAlpha3B = null;
function toAlpha3B(code) {
    if (!_toAlpha3B) {
        try { _toAlpha3B = require('../../src/languages').toAlpha3B; }
        catch (_) { _toAlpha3B = (c) => c; }
    }
    return _toAlpha3B(code);
}

const HISTORY_LIMIT = 100;

const stats = {
    startedAt: new Date(),
    requests: { total: 0, movie: 0, series: 0, byDate: {} },
    subtitles: { total: 0, bySource: {}, byLanguage: {} },
    languageMatching: { totalRequests: 0, found: 0, notFound: 0, byLanguageSuccess: {} },
    timing: { totalMs: 0, count: 0, minMs: Infinity, maxMs: 0, history: [] }
};

let _statsDB = null;
let _getMode = () => 'disabled';

function init(statsDB, getMode) {
    _statsDB = statsDB;
    _getMode = getMode || (() => 'full');
}

function getDateKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Track a subtitle request.
 * Called from the subtitle handler on every request.
 *
 * @param {Object} data
 * @param {string}  data.type          - 'movie' | 'series'
 * @param {number}  data.fetchTimeMs   - elapsed ms
 * @param {number}  data.subtitleCount - count of returned subs
 * @param {Array}   data.subtitles     - subtitle objects
 * @param {Object}  data.languageMatch - language matching results
 * @param {string}  data.userId        - anonymous session id
 * @param {string}  data.imdbId        - IMDB identifier
 * @param {Array}   data.languages     - languages requested
 * @param {number}  data.season        - season number (series only)
 * @param {number}  data.episode       - episode number (series only)
 * @param {boolean} data.cacheHit      - whether this was a cache hit
 */
function trackRequest(data) {
    if (_getMode() === 'disabled') return;

    const {
        type, fetchTimeMs, subtitleCount = 0, subtitles = [],
        languageMatch = null, userId, imdbId, languages = [],
        season, episode, cacheHit
    } = data;

    // In-memory figures back the per-process timing sparkline.
    stats.requests.total++;
    if (type === 'movie') stats.requests.movie++;
    if (type === 'series') stats.requests.series++;
    stats.subtitles.total += subtitleCount;

    for (const sub of subtitles) {
        const source = sub.source || 'unknown';
        stats.subtitles.bySource[source] = (stats.subtitles.bySource[source] || 0) + 1;
        const lang = sub.lang || 'unknown';
        stats.subtitles.byLanguage[lang] = (stats.subtitles.byLanguage[lang] || 0) + 1;
    }

    if (fetchTimeMs !== undefined) {
        stats.timing.totalMs += fetchTimeMs;
        stats.timing.count++;
        stats.timing.minMs = Math.min(stats.timing.minMs, fetchTimeMs);
        stats.timing.maxMs = Math.max(stats.timing.maxMs, fetchTimeMs);
        stats.timing.history.push(fetchTimeMs);
        if (stats.timing.history.length > HISTORY_LIMIT) stats.timing.history.shift();
        track.responseTime(fetchTimeMs);
    }

    const isMovie = type === 'movie' ? 1 : 0;
    const isSeries = type === 'series' ? 1 : 0;

    if (_getMode() === 'minimal') {
        if (userId) track.user(userId, { movie: isMovie, series: isSeries, languages });
        return;
    }

    track.counter('total_requests');
    if (isMovie) track.counter('total_movies');
    if (isSeries) track.counter('total_series');
    track.counter('total_subtitles', subtitleCount);
    track.counter(cacheHit ? 'cache_hits' : 'cache_misses');

    track.daily({
        requests: 1,
        cache_hits: cacheHit ? 1 : 0,
        cache_misses: cacheHit ? 0 : 1,
        movies: isMovie,
        series: isSeries,
        subtitles: subtitleCount,
        any_pref_found: languageMatch && languageMatch.anyPreferredFound ? 1 : 0,
        all_pref_found: languageMatch && languageMatch.allPreferredFound ? 1 : 0,
        pref_tracked: languageMatch ? 1 : 0
    });

    if (languages.length > 0) {
        track.combo(languages.map(l => (toAlpha3B(l) || l).toLowerCase()));
    }

    if (languageMatch && Array.isArray(languageMatch.languages)) {
        for (const lang of languageMatch.languages) {
            const found = Array.isArray(languageMatch.found) && languageMatch.found.includes(lang);
            track.language(lang, { found });
            stats.languageMatching.totalRequests++;
            if (found) {
                stats.languageMatching.found++;
                stats.languageMatching.byLanguageSuccess[lang] =
                    (stats.languageMatching.byLanguageSuccess[lang] || 0) + 1;
            } else {
                stats.languageMatching.notFound++;
            }
        }
    }

    if (userId) {
        track.user(userId, { movie: isMovie, series: isSeries, languages });
        if (imdbId) track.content({ userId, imdbId, contentType: type, season, episode });
    }
}

/**
 * Format uptime in human-readable format.
 */
function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
    if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

function getLast30Days(byDate) {
    const result = {};
    const now = new Date();
    for (let i = 0; i < 30; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const key = d.toISOString().split('T')[0];
        if (byDate[key]) result[key] = byDate[key];
    }
    return result;
}

/**
 * Get current statistics (merges in-memory + persistent).
 */
async function getStats() {
    const uptime = Date.now() - stats.startedAt.getTime();
    const avgMs = stats.timing.count > 0
        ? Math.round(stats.timing.totalMs / stats.timing.count)
        : 0;

    let persistentStats = {};
    let dailyStats = [];
    let languageMatchSummary = null;
    let topLanguages = {};
    let sourceStats = {};
    let langDistribution = {};

    if (_statsDB) {
        const [persStats, dStats, langSummary, topLangs] = await Promise.all([
            _statsDB.getAll(),
            _statsDB.getDailyStats(30),
            _statsDB.getLanguageMatchSummary(30),
            _statsDB.getTopSuccessfulLanguages(30, 10)
        ]);
        persistentStats = persStats || {};
        dailyStats = dStats || [];
        languageMatchSummary = langSummary;
        topLanguages = topLangs || {};

        try {
            const cs = await _statsDB.getCacheStats();
            if (cs.sourceDistribution) sourceStats = cs.sourceDistribution;
            if (cs.languageDistribution) langDistribution = cs.languageDistribution;
        } catch (_) { /* fallback */ }
    }

    const totalRequests  = persistentStats.total_requests  || stats.requests.total;
    const totalMovies    = persistentStats.total_movies    || stats.requests.movie;
    const totalSeries    = persistentStats.total_series    || stats.requests.series;
    const totalSubtitles = persistentStats.total_subtitles || stats.subtitles.total;

    let langTotalReq = 0, langFound = 0, langNotFound = 0, successRate = 0;
    let byLanguageSuccess = {}, perLanguage = [];
    let activeSessionCount = 0, anyPreferredRate = 0, allPreferredRate = 0, popularCombinations = [];

    if (languageMatchSummary) {
        langTotalReq = languageMatchSummary.totalRequests || 0;
        langFound    = languageMatchSummary.found || 0;
        langNotFound = languageMatchSummary.notFound || 0;
        successRate  = languageMatchSummary.successRate || 0;
        byLanguageSuccess = topLanguages;
        perLanguage = languageMatchSummary.perLanguage || [];
    } else {
        langTotalReq = stats.languageMatching.totalRequests;
        langFound    = stats.languageMatching.found;
        langNotFound = stats.languageMatching.notFound;
        successRate  = langTotalReq > 0 ? Math.round((langFound / langTotalReq) * 100) : 0;
        byLanguageSuccess = stats.languageMatching.byLanguageSuccess;
    }

    if (_statsDB) {
        try {
            const [userStats, succRates, popCombos] = await Promise.all([
                _statsDB.getAggregateUserStats(),
                _statsDB.getLanguageSuccessRates(30),
                _statsDB.getPopularLanguageCombinations(30, 10)
            ]);
            activeSessionCount = userStats?.activeSessions?.last30Days || 0;
            anyPreferredRate   = succRates?.anyPreferredRate || 0;
            allPreferredRate   = succRates?.allPreferredRate || 0;
            popularCombinations = popCombos || [];
        } catch (_) { /* fallback */ }
    }

    let byDate = {};
    if (dailyStats.length > 0) {
        dailyStats.forEach(d => {
            byDate[d.date] = {
                total: d.requests, movie: d.movies || 0, series: d.series || 0,
                cacheHits: d.cache_hits, cacheMisses: d.cache_misses
            };
        });
    } else {
        byDate = getLast30Days(stats.requests.byDate);
    }

    const subtitlesBySource   = Object.keys(sourceStats).length > 0  ? sourceStats  : stats.subtitles.bySource;
    const subtitlesByLanguage = Object.keys(langDistribution).length > 0 ? langDistribution : stats.subtitles.byLanguage;

    return {
        uptime: { ms: uptime, formatted: formatUptime(uptime) },
        startedAt: stats.startedAt.toISOString(),
        requests: { total: totalRequests, movie: totalMovies, series: totalSeries, byDate },
        subtitles: { total: totalSubtitles, bySource: subtitlesBySource, byLanguage: subtitlesByLanguage },
        languageMatching: {
            totalRequests: langTotalReq, found: langFound, notFound: langNotFound,
            successRate, byLanguageSuccess, activeSessionCount, perLanguage,
            anyPreferredRate, allPreferredRate, popularCombinations
        },
        timing: {
            avgMs,
            minMs: stats.timing.minMs === Infinity ? 0 : stats.timing.minMs,
            maxMs: stats.timing.maxMs,
            recentHistory: stats.timing.history.slice(-20)
        }
    };
}

function resetStats() {
    stats.startedAt = new Date();
    stats.requests = { total: 0, movie: 0, series: 0, byDate: {} };
    stats.subtitles = { total: 0, bySource: {}, byLanguage: {} };
    stats.languageMatching = { totalRequests: 0, found: 0, notFound: 0, byLanguageSuccess: {} };
    stats.timing = { totalMs: 0, count: 0, minMs: Infinity, maxMs: 0, history: [] };
}

module.exports = { init, trackRequest, getStats, resetStats };

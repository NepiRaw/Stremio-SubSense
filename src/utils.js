/**
 * Logging utility
 */
const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
};

const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];

/**
 * Log a message at specified level
 * @param {string} level - Log level (debug, info, warn, error)
 * @param  {...any} args - Arguments to log
 */
function log(level, ...args) {
    if (LOG_LEVELS[level] >= currentLevel) {
        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
        console.log(prefix, ...args);
    }
}

/**
 * Parse Stremio content ID
 * Movie: "tt1234567"
 * Series: "tt1234567:1:5" (imdb:season:episode)
 * 
 * @param {string} id - Stremio content ID
 * @returns {Object} Parsed ID with imdbId, season, episode, type
 */
function parseStremioId(id) {
    const parts = id.split(':');
    
    if (parts.length === 1) {
        return {
            imdbId: parts[0],
            season: null,
            episode: null,
            type: 'movie'
        };
    }
    
    if (parts.length >= 3) {
        return {
            imdbId: parts[0],
            season: parseInt(parts[1], 10),
            episode: parseInt(parts[2], 10),
            type: 'series'
        };
    }
    
    // Fallback for unexpected format
    return {
        imdbId: parts[0],
        season: null,
        episode: null,
        type: 'unknown'
    };
}

module.exports = {
    log,
    parseStremioId
};

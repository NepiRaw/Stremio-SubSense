/**
 * BaseProvider - Abstract base class for subtitle providers
 * 
 * All subtitle providers must extend this class and implement the required methods.
 * This enables:
 * - Adding more providers independently
 * - Replacing providers if needed
 * - Per-provider statistics
 * - Testing/mocking providers
 */

class BaseProvider {
    /**
     * @param {string} name - Unique provider identifier (e.g., 'wyzie', 'opensubtitles')
     * @param {Object} options - Provider-specific configuration
     */
    constructor(name, options = {}) {
        if (this.constructor === BaseProvider) {
            throw new Error('BaseProvider is abstract and cannot be instantiated directly');
        }
        
        this.name = name;
        this.options = options;
        this.enabled = options.enabled !== false;
        
        // Per-provider stats
        this.stats = {
            requests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            totalSubtitlesReturned: 0,
            totalFetchTimeMs: 0,
            avgFetchTimeMs: 0,
            lastError: null,
            lastRequestAt: null
        };
    }

    /**
     * Search for subtitles - MUST be implemented by subclasses
     * 
     * @param {Object} query - Search parameters
     * @param {string} query.imdbId - IMDB ID (e.g., 'tt1234567')
     * @param {number|null} query.season - Season number for series
     * @param {number|null} query.episode - Episode number for series
     * @param {string|null} query.language - Optional language filter (ISO 639-1 or 639-2)
     * @returns {Promise<Array<SubtitleResult>>} Array of normalized subtitle results
     */
    async search(query) {
        throw new Error('search() must be implemented by provider subclass');
    }

    /**
     * Check if provider is available/healthy
     * @returns {Promise<boolean>}
     */
    async isAvailable() {
        return this.enabled;
    }

    /**
     * Get provider sources (for providers that aggregate multiple sources)
     * @returns {Array<string>} List of source names
     */
    getSources() {
        return [this.name];
    }

    /**
     * Get provider statistics
     * @returns {Object} Provider stats
     */
    getStats() {
        return {
            name: this.name,
            enabled: this.enabled,
            ...this.stats
        };
    }

    /**
     * Update stats after a request
     * @param {boolean} success - Whether the request succeeded
     * @param {number} fetchTimeMs - Time taken in milliseconds
     * @param {number} subtitleCount - Number of subtitles returned
     * @param {Error|null} error - Error if request failed
     */
    updateStats(success, fetchTimeMs, subtitleCount, error = null) {
        this.stats.requests++;
        this.stats.lastRequestAt = new Date().toISOString();
        
        if (success) {
            this.stats.successfulRequests++;
            this.stats.totalSubtitlesReturned += subtitleCount;
            this.stats.totalFetchTimeMs += fetchTimeMs;
            this.stats.avgFetchTimeMs = Math.round(this.stats.totalFetchTimeMs / this.stats.successfulRequests);
        } else {
            this.stats.failedRequests++;
            this.stats.lastError = error ? error.message : 'Unknown error';
        }
    }

    /**
     * Reset provider stats
     */
    resetStats() {
        this.stats = {
            requests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            totalSubtitlesReturned: 0,
            totalFetchTimeMs: 0,
            avgFetchTimeMs: 0,
            lastError: null,
            lastRequestAt: null
        };
    }
}

/**
 * Normalized subtitle result interface
 * All providers should return subtitles in this format
 */
class SubtitleResult {
    constructor({
        id,
        url,
        language,        // ISO 639-1 (2-letter) or full language name
        languageCode,    // ISO 639-2 (3-letter) for Stremio
        source,          // Source name (e.g., 'opensubtitles', 'subdl')
        provider,        // Provider name (e.g., 'wyzie')
        releaseName = '',
        hearingImpaired = false,
        rating = null,
        downloadCount = null,
        display = '',    // Display name (e.g., 'English', 'French')
        
        // Format hints - provider indicates what format the subtitle is in
        format = null,          // Detected/assumed format: 'srt', 'ass', 'ssa', 'vtt', 'unknown'
        needsConversion = null  // true/false/null - null means "needs inspection"
    }) {
        this.id = id;
        this.url = url;
        this.language = language;
        this.languageCode = languageCode;
        this.source = source;
        this.provider = provider;
        this.releaseName = releaseName;
        this.hearingImpaired = hearingImpaired;
        this.rating = rating;
        this.downloadCount = downloadCount;
        this.display = display;
        
        // Format hints
        this.format = format;
        this.needsConversion = needsConversion;
    }
}

module.exports = {
    BaseProvider,
    SubtitleResult
};

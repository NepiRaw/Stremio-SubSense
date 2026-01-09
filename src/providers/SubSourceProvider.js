/**
 * SubSourceProvider - Subtitle provider using SubSource API
 * 
 * SubSource is a separate database from Wyzie's sources, providing significantly
 * more subtitles for many titles. It requires a user-provided API key.
 * 
 * API: https://api.subsource.net/api/v1
 * - Uses full language words (e.g., 'english'), NOT ISO codes
 * - Returns ZIP files for all downloads
 * - TV series returns per-season results, episode info in releaseInfo
 */

const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { log } = require('../utils');
const { toSubsourceCode, getBySubsourceCode, toAlpha3B, getDisplayName } = require('../languages');

const API_BASE = 'https://api.subsource.net/api/v1';

class SubSourceProvider extends BaseProvider {
    constructor(options = {}) {
        super('subsource', options);
        
        this.baseUrl = options.baseUrl || process.env.SUBSENSE_BASE_URL || 
                       `http://127.0.0.1:${process.env.PORT || 3100}`;
        
        this.enabled = options.enabled !== false;
        
        // Cache: IMDB ID → { movieId, type, season }
        this._movieCache = new Map();
    }

    /**
     * Make a request to SubSource API
     * @param {string} apiKey - User's SubSource API key
     * @param {string} endpoint - API endpoint (e.g., '/movies/search')
     * @param {Object} params - Query parameters
     */
    async _apiRequest(apiKey, endpoint, params = {}) {
        const url = new URL(`${API_BASE}${endpoint}`);
        
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) {
                url.searchParams.set(key, value);
            }
        }
        
        log('debug', `[SubSource] API: ${endpoint} params=${JSON.stringify(params)}`);
        
        try {
            const response = await fetch(url.toString(), {
                headers: {
                    'X-API-Key': apiKey,
                    'User-Agent': 'SubSense-Stremio/1.0',
                    'Accept': 'application/json'
                }
            });
            
            if (response.status === 401) {
                log('warn', '[SubSource] Invalid API key (401)');
                return { error: 'invalid_api_key', status: 401 };
            }
            
            if (response.status === 429) {
                const reset = response.headers.get('X-RateLimit-Reset');
                log('warn', `[SubSource] Rate limited, reset at ${reset}`);
                return { error: 'rate_limited', status: 429, reset };
            }
            
            if (!response.ok) {
                log('error', `[SubSource] API error: ${response.status}`);
                return { error: 'api_error', status: response.status };
            }
            
            return await response.json();
        } catch (error) {
            log('error', `[SubSource] Request failed: ${error.message}`);
            return { error: 'network_error', message: error.message };
        }
    }

    /**
     * Find SubSource movieId for an IMDB ID
     * For TV series, finds the specific season's movieId
     */
    async _findMovieId(apiKey, imdbId, season = null) {
        const cacheKey = `${imdbId}:${season || 'movie'}`;
        
        if (this._movieCache.has(cacheKey)) {
            return this._movieCache.get(cacheKey);
        }
        
        const result = await this._apiRequest(apiKey, '/movies/search', {
            searchType: 'imdb',
            imdb: imdbId
        });
        
        if (result.error) return null;
        if (!result.success || !result.data || result.data.length === 0) return null;
        
        // Movies: single result with movieId
        if (result.data[0].type === 'movie') {
            const info = { movieId: result.data[0].movieId, type: 'movie' };
            this._movieCache.set(cacheKey, info);
            return info;
        }
        
        // TV Series: multiple results, one per season
        for (const entry of result.data) {
            const key = `${imdbId}:${entry.season}`;
            this._movieCache.set(key, { movieId: entry.movieId, type: 'series', season: entry.season });
        }
        
        return this._movieCache.get(cacheKey) || null;
    }

    /**
     * Search for subtitles
     * @param {Object} query - Search query
     * @param {string} query.imdbId - IMDB ID
     * @param {number|null} query.season - Season number (for series)
     * @param {number|null} query.episode - Episode number (for series)
     * @param {string|null} query.language - Language code (2 or 3 letter)
     * @param {string} query.apiKey - User's SubSource API key (from decrypted config)
     * @param {string} query.encryptedApiKey - Encrypted API key for download URLs
     * @param {string|null} query.filename - User's video filename (for ranking)
     */
    async search(query) {
        const startTime = Date.now();
        
        if (!query.apiKey) {
            log('debug', '[SubSource] No API key provided, skipping');
            return [];
        }
        
        try {
            // Find the movieId for this content
            const movieInfo = await this._findMovieId(query.apiKey, query.imdbId, query.season);
            
            if (!movieInfo) {
                log('debug', `[SubSource] No results for ${query.imdbId}`);
                this.updateStats(true, Date.now() - startTime, 0);
                return [];
            }
            
            // Convert language to SubSource format using centralized languages.js
            const subSourceLang = query.language ? toSubsourceCode(query.language) : null;
            
            if (query.language && !subSourceLang) {
                log('debug', `[SubSource] Unsupported language: ${query.language}`);
                this.updateStats(true, Date.now() - startTime, 0);
                return [];
            }
            
            // Fetch subtitles
            const params = { movieId: movieInfo.movieId };
            if (subSourceLang) params.language = subSourceLang;
            
            const result = await this._apiRequest(query.apiKey, '/subtitles', params);
            
            if (result.error) {
                this.updateStats(false, Date.now() - startTime, 0, new Error(result.error));
                return [];
            }
            
            if (!result.success || !result.data) {
                this.updateStats(true, Date.now() - startTime, 0);
                return [];
            }

            let subtitles = result.data;
            
            // Convert to SubtitleResult format
            const results = subtitles.map(sub => this._toSubtitleResult(sub, query));
            
            const fetchTime = Date.now() - startTime;
            log('info', `[SubSource] Found ${results.length} subtitles in ${fetchTime}ms`);
            this.updateStats(true, fetchTime, results.length);
            
            return results;
            
        } catch (error) {
            log('error', `[SubSource] Search error: ${error.message}`);
            this.updateStats(false, Date.now() - startTime, 0, error);
            return [];
        }
    }

    /**
     * Filter subtitles by episode number (for TV series)
     * Episode info is in releaseInfo field
     */
    _filterByEpisode(subtitles, targetEpisode) {
        const epNum = targetEpisode.toString().padStart(2, '0');
        
        const patterns = [
            new RegExp(`[sS]\\d+[eE]${epNum}\\b`, 'i'),  // S01E07
            new RegExp(`\\b${epNum}\\b`),                // bare episode number (less reliable)
            new RegExp(`[eE]${epNum}\\b`, 'i'),          // E07
            new RegExp(`x${epNum}\\b`, 'i'),             // 1x07
            new RegExp(`\\.${epNum}\\.`, 'i'),           // .07.
            new RegExp(`-${epNum}-`, 'i')                // -07-
        ];
        
        return subtitles.filter(sub => {
            const releaseInfo = Array.isArray(sub.releaseInfo) 
                ? sub.releaseInfo.join(' ') 
                : (sub.releaseInfo || '');
            
            // Check season-episode pattern first (most reliable)
            if (patterns[0].test(releaseInfo)) return true;
            
            // Check other patterns (less reliable, might get wrong episode)
            for (let i = 2; i < patterns.length; i++) {
                if (patterns[i].test(releaseInfo)) return true;
            }
            
            return false;
        });
    }

    /**
     * Convert SubSource subtitle to SubtitleResult
     */
    _toSubtitleResult(sub, query) {
        const releaseInfo = Array.isArray(sub.releaseInfo) 
            ? sub.releaseInfo.join(' | ') 
            : (sub.releaseInfo || '');
        
        // Build proxy URL for ZIP extraction
        // Include encrypted API key for proxy to authenticate with SubSource
        const params = new URLSearchParams();
        
        if (query.encryptedApiKey) {
            params.set('key', query.encryptedApiKey);
        }
        if (query.season) {
            params.set('season', query.season.toString());
        }
        if (query.episode) {
            params.set('episode', query.episode.toString());
        }
        if (query.filename) {
            params.set('filename', query.filename);
        }
        
        const queryStr = params.toString();
        const downloadUrl = `${this.baseUrl}/api/subsource/proxy/${sub.subtitleId}${queryStr ? '?' + queryStr : ''}`;
        
        // Use centralized language functions
        const lang = getBySubsourceCode(sub.language);
        const stremioCode = lang ? toAlpha3B(lang.alpha2) : 'und';
        const displayName = lang ? getDisplayName(lang.alpha2) : sub.language;
        
        return new SubtitleResult({
            id: `subsource-${sub.subtitleId}`,
            url: downloadUrl,
            language: sub.language,
            languageCode: stremioCode,
            source: 'subsource',
            provider: 'subsource',
            releaseName: releaseInfo,
            hearingImpaired: sub.hearingImpaired || false,
            rating: null,
            downloadCount: sub.downloads || null,
            display: displayName,
            format: 'srt',
            needsConversion: false
        });
    }

    /**
     * Validate an API key by making a test request
     * @param {string} apiKey - API key to validate
     * @returns {Object} { valid: boolean, remaining?: number, error?: string }
     */
    async validateApiKey(apiKey) {
        const result = await this._apiRequest(apiKey, '/movies/search', {
            searchType: 'imdb',
            imdb: 'tt1375666' // Inception - known to exist
        });
        
        if (result.error === 'invalid_api_key') {
            return { valid: false, error: 'Invalid API key' };
        }
        
        if (result.error === 'rate_limited') {
            return { valid: true, remaining: 0, error: 'Rate limited' };
        }
        
        if (result.error) {
            return { valid: false, error: result.message || result.error };
        }
        
        return { valid: true };
    }
}

module.exports = SubSourceProvider;

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

let filenameParseFn = null;
async function getFilenameParser() {
    if (!filenameParseFn) {
        const { filenameParse } = await import('@ctrl/video-filename-parser');
        filenameParseFn = filenameParse;
    }
    return filenameParseFn;
}

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
     * Fetch all subtitles with pagination
     * SubSource API returns max 100 per page, some titles have 200+
     * @param {string} apiKey - User's SubSource API key
     * @param {number} movieId - SubSource movieId
     * @param {string|null} language - Language filter
     * @returns {Array} All subtitle results
     */
    async _fetchAllSubtitles(apiKey, movieId, language = null) {
        const allSubtitles = [];
        let page = 1;
        const limit = 100; // Max allowed
        let totalPages = 1;
        
        do {
            const params = { movieId, limit, page };
            if (language) params.language = language;
            
            const result = await this._apiRequest(apiKey, '/subtitles', params);
            
            if (result.error) {
                log('warn', `[SubSource] Pagination error on page ${page}: ${result.error}`);
                break;
            }
            
            if (!result.success || !result.data) {
                break;
            }
            
            allSubtitles.push(...result.data);
            
            if (result.pagination) {
                totalPages = result.pagination.pages || 1;
                log('debug', `[SubSource] Fetched page ${page}/${totalPages} (${result.data.length} subs)`);
            }
            
            page++;
        } while (page <= totalPages);
        
        log('debug', `[SubSource] Total fetched: ${allSubtitles.length} subtitles`);
        return allSubtitles;
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
            
            // Fetch all subtitles with pagination (some titles have 200+ subs)
            let subtitles = await this._fetchAllSubtitles(
                query.apiKey, 
                movieInfo.movieId, 
                subSourceLang
            );
            
            if (subtitles.length === 0) {
                this.updateStats(true, Date.now() - startTime, 0);
                return [];
            }
            
            // Pre-filter to exclude clear episode mismatches
            const beforeCount = subtitles.length;
            const filterResults = await Promise.all(
                subtitles.map(sub => this._shouldIncludeSubtitle(sub, query))
            );
            subtitles = subtitles.filter((_, index) => filterResults[index]);
            if (subtitles.length < beforeCount) {
                log('debug', `[SubSource] Pre-filtered ${beforeCount - subtitles.length} episode mismatches (${subtitles.length} remaining)`);
            }
            
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
     * Check if subtitle should be excluded based on clear episode mismatch
     * Uses @ctrl/video-filename-parser as primary detection with regex fallbacks
     * @param {Object} sub - Subtitle object from API
     * @param {Object} query - Search query with episode/season
     * @returns {Promise<boolean>} true if subtitle should be INCLUDED
     */
    async _shouldIncludeSubtitle(sub, query) {
        if (!query.episode || !query.season) {
            return true; // Movies or no episode specified - include all
        }
        
        const releaseInfo = Array.isArray(sub.releaseInfo) 
            ? sub.releaseInfo.join(' ') 
            : (sub.releaseInfo || '');
        
        if (!releaseInfo) {
            return true; // No release info - can't filter, include it
        }
        
        const requestedEpisode = parseInt(query.episode, 10);
        const requestedSeason = parseInt(query.season, 10);
        
        // Parser first
        try {
            const parse = await getFilenameParser();
            const parsed = parse(releaseInfo, true); // isTv = true
            
            if (parsed.episodeNumbers && parsed.episodeNumbers.length > 0) {
                if (!parsed.episodeNumbers.includes(requestedEpisode)) {
                    log('debug', `[SubSource] Excluding (parser): "${releaseInfo.substring(0, 50)}..." - E${parsed.episodeNumbers.join(',')} != E${requestedEpisode}`);
                    return false;
                }
                
                if (parsed.seasons && parsed.seasons.length > 0) {
                    if (!parsed.seasons.includes(requestedSeason)) {
                        log('debug', `[SubSource] Excluding (parser): "${releaseInfo.substring(0, 50)}..." - S${parsed.seasons.join(',')} != S${requestedSeason}`);
                        return false;
                    }
                }
                
                return true;
            }
        } catch (err) {
            log('debug', `[SubSource] Parser error for "${releaseInfo.substring(0, 30)}": ${err.message}`);
        }
        
        // Fallback regex patterns for cases parser doesn't handle well
        // Pattern A: "Episode XXX" or "EP XXX" (handles Episode 1000 etc)
        // Careful with 4-digit numbers to not confuse with years (1900-2099)
        const episodeWordPattern = /\b(?:Episode|EP)[.\-_\s]*(\d{1,4})\b/i;
        const episodeWordMatch = releaseInfo.match(episodeWordPattern);
        if (episodeWordMatch) {
            const fileEpisode = parseInt(episodeWordMatch[1], 10);
            // Avoid year confusion: if 4 digits and looks like a year, skip
            if (fileEpisode >= 1900 && fileEpisode <= 2099) {
            } else if (fileEpisode !== requestedEpisode) {
                log('debug', `[SubSource] Excluding (Episode pattern): "${releaseInfo.substring(0, 50)}..." - E${fileEpisode} != E${requestedEpisode}`);
                return false;
            } else {
                return true;
            }
        }
        
        // Pattern B: "1x01" format (Season x Episode)
        const xPattern = /\b(\d{1,2})x(\d{1,4})\b/i;
        const xMatch = releaseInfo.match(xPattern);
        if (xMatch) {
            const fileSeason = parseInt(xMatch[1], 10);
            const fileEpisode = parseInt(xMatch[2], 10);
            if (fileSeason !== requestedSeason || fileEpisode !== requestedEpisode) {
                log('debug', `[SubSource] Excluding (NxNN pattern): "${releaseInfo.substring(0, 50)}..." - ${fileSeason}x${fileEpisode} != ${requestedSeason}x${requestedEpisode}`);
                return false;
            }
            return true;
        }
        
        // Pattern C: Anime-style " - XX " or "- XX[" (when no S/E pattern)
        // Only match if no S##E## pattern exists
        if (!/[sS]\d{1,2}[.\-_]?[eE]\d{1,4}/.test(releaseInfo)) {
            const animePattern = /[\s\-]\s*(\d{1,4})\s*(?:[\[\(]|$|\s*\-)/;
            const animeMatch = releaseInfo.match(animePattern);
            if (animeMatch) {
                const fileEpisode = parseInt(animeMatch[1], 10);
                if (fileEpisode > 0 && fileEpisode <= 2000 && fileEpisode !== requestedEpisode) {
                    if (![720, 1080, 480, 2160, 576, 360].includes(fileEpisode)) {
                        log('debug', `[SubSource] Excluding (anime pattern): "${releaseInfo.substring(0, 50)}..." - E${fileEpisode} != E${requestedEpisode}`);
                        return false;
                    }
                }
            }
        }
        
        // Original fallback patterns
        
        // Pattern D: Episode RANGE like S01E01-E12 (episode pack)
        const rangePattern = /[sS](\d{1,2})[.\-_]?[eE](\d{1,4})\-[eE]?(\d{1,4})/;
        const rangeMatch = releaseInfo.match(rangePattern);
        if (rangeMatch) {
            const fileSeason = parseInt(rangeMatch[1], 10);
            const startEp = parseInt(rangeMatch[2], 10);
            const endEp = parseInt(rangeMatch[3], 10);
            
            if (fileSeason !== requestedSeason) {
                log('debug', `[SubSource] Excluding "${releaseInfo.substring(0, 50)}..." - S${fileSeason} != S${requestedSeason}`);
                return false;
            }
            
            if (requestedEpisode < startEp || requestedEpisode > endEp) {
                log('debug', `[SubSource] Excluding "${releaseInfo.substring(0, 50)}..." - E${requestedEpisode} not in E${startEp}-E${endEp}`);
                return false;
            }
            return true;
        }
        
        // Pattern E: S01E13 (standard pattern - should have been caught by parser, but double-check)
        const fullPattern = /[sS](\d{1,2})[.\-_]?[eE](\d{1,4})(?!\d)/;
        const fullMatch = releaseInfo.match(fullPattern);
        if (fullMatch) {
            const fileSeason = parseInt(fullMatch[1], 10);
            const fileEpisode = parseInt(fullMatch[2], 10);
            
            if (fileSeason !== requestedSeason || fileEpisode !== requestedEpisode) {
                log('debug', `[SubSource] Excluding "${releaseInfo.substring(0, 50)}..." - S${fileSeason}E${fileEpisode} != S${requestedSeason}E${requestedEpisode}`);
                return false;
            }
            return true;
        }
        
        return true;
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
       
        const sanitizedRelease = releaseInfo
            ? releaseInfo
                .replace(/[^a-zA-Z0-9._-]/g, '_')  // Replace special chars with underscore
                .replace(/_+/g, '_')               // Collapse multiple underscores
                .replace(/^_|_$/g, '')             // Trim leading/trailing underscores
                .substring(0, 100)                 // Limit length
            : 'subtitle';
        
        const queryStr = params.toString();
        const downloadUrl = `${this.baseUrl}/api/subsource/proxy/${sub.subtitleId}/${encodeURIComponent(sanitizedRelease)}${queryStr ? '?' + queryStr : ''}`;
        
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

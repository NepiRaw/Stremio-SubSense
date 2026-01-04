/**
 * BetaSeriesProvider - Subtitle provider using BetaSeries API
 * 
 * BetaSeries is a French TV/Movie tracking service with subtitle support.
 * It aggregates subtitles from multiple sources and provides good French coverage.
 * 
 * API Documentation: https://developers.betaseries.com/
 * 
 * Endpoints used:
 * - /shows/display?thetvdb_id=X - Get show by TVDB ID
 * - /shows/display?imdb_id=X - Get show by IMDB ID
 * - /shows/episodes?id=X - Get all episodes for a show
 * - /subtitles/episode?id=X - Get subtitles for episode
 * 
 * Language Support:
 * - vo = Original Version (English)
 * - vf = French Version
 * 
 * Note: BetaSeries primarily supports French and English subtitles.
 */

const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { log } = require('../utils');
const { toBetaseriesCode, getByBetaseriesCode, toAlpha3B, getDisplayName } = require('../languages');

const API_BASE = 'https://api.betaseries.com';
const API_VERSION = '3.0';

class BetaSeriesProvider extends BaseProvider {
    /**
     * @param {Object} options
     * @param {string} options.apiKey - BetaSeries API key
     * @param {string} options.baseUrl - SubSense public URL for proxy
     */
    constructor(options = {}) {
        super('betaseries', options);
        
        this.apiKey = options.apiKey || process.env.BETASERIES_API_KEY;
        this.baseUrl = options.baseUrl || process.env.SUBSENSE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3100}`;
        
        if (!this.apiKey) {
            log('warn', '[BetaSeriesProvider] No API key configured, provider disabled');
            this.enabled = false;
        }
        
        // Cache for show/episode ID lookups (avoid repeated API calls)
        this._showCache = new Map();      // imdbId -> betaseriesShowId
        this._episodeCache = new Map();   // showId:season:episode -> betaseriesEpisodeId
        
        // Track unique sources we've seen (dynamically discovered)
        this._discoveredSources = new Set(['betaseries']);
    }

    /**
     * Get discovered sources (built dynamically from API responses)
     * @returns {Array<string>} List of source names seen in subtitle responses
     */
    getSources() {
        return Array.from(this._discoveredSources);
    }

    /**
     * Make a request to BetaSeries API
     * @private
     */
    async _apiRequest(endpoint, params = {}) {
        const url = new URL(`${API_BASE}${endpoint}`);
        url.searchParams.set('v', API_VERSION);
        url.searchParams.set('key', this.apiKey);
        
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) {
                url.searchParams.set(key, value);
            }
        }
        
        log('debug', `[BetaSeries] API request: ${endpoint} params=${JSON.stringify(params)}`);
        
        try {
            const response = await fetch(url.toString(), {
                headers: {
                    'User-Agent': 'SubSense-Stremio/1.0',
                    'Accept': 'application/json',
                }
            });
            
            const data = await response.json();
            
            if (data.errors && data.errors.length > 0) {
                log('debug', `[BetaSeries] API error: ${JSON.stringify(data.errors)}`);
                return null;
            }
            
            return data;
        } catch (error) {
            log('error', `[BetaSeries] API request failed: ${error.message}`);
            return null;
        }
    }

    /**
     * Get BetaSeries show ID from IMDB ID
     * @private
     */
    async _getShowId(imdbId) {
        // Check cache
        if (this._showCache.has(imdbId)) {
            return this._showCache.get(imdbId);
        }
        
        // Try IMDB ID lookup
        const result = await this._apiRequest('/shows/display', { imdb_id: imdbId });
        
        if (result && result.show) {
            const showId = result.show.id;
            this._showCache.set(imdbId, showId);
            log('debug', `[BetaSeries] Found show: ${result.show.title} (ID: ${showId})`);
            return showId;
        }
        
        return null;
    }

    /**
     * Get BetaSeries episode ID
     * @private
     */
    async _getEpisodeId(showId, season, episode) {
        const cacheKey = `${showId}:${season}:${episode}`;
        
        // Check cache
        if (this._episodeCache.has(cacheKey)) {
            return this._episodeCache.get(cacheKey);
        }
        
        // Fetch all episodes for the show
        const result = await this._apiRequest('/shows/episodes', { id: showId });
        
        if (result && result.episodes) {
            // Cache all episodes while we have them
            for (const ep of result.episodes) {
                const key = `${showId}:${ep.season}:${ep.episode}`;
                this._episodeCache.set(key, ep.id);
            }
            
            // Return the requested episode
            return this._episodeCache.get(cacheKey) || null;
        }
        
        return null;
    }

    /**
     * Search for subtitles
     * 
     * @param {Object} query
     * @param {string} query.imdbId - IMDB ID
     * @param {number|null} query.season - Season number
     * @param {number|null} query.episode - Episode number
     * @param {string|null} query.language - Language filter (ISO 639-2 code)
     * @returns {Promise<Array<SubtitleResult>>}
     */
    async search(query) {
        if (!this.enabled) {
            log('debug', '[BetaSeriesProvider] Provider is disabled');
            return [];
        }

        // BetaSeries only has French (fr/fre) and English (en/eng)
        // Skip API call if requesting other languages
        if (query.language) {
            const lang = query.language.toLowerCase();
            const supportedLanguages = ['fr', 'fre', 'en', 'eng'];
            
            if (!supportedLanguages.includes(lang)) {
                log('debug', `[BetaSeriesProvider] Skipping - language "${lang}" not supported (only French and English)`);
                return [];
            }
        }

        const startTime = Date.now();
        
        try {
            // BetaSeries only supports TV series, not movies
            if (!query.season || !query.episode) {
                log('debug', '[BetaSeries] Skipping - no season/episode (movies not supported)');
                return [];
            }

            // Get show ID from IMDB
            const showId = await this._getShowId(query.imdbId);
            if (!showId) {
                log('debug', `[BetaSeries] Show not found: ${query.imdbId}`);
                this.updateStats(true, Date.now() - startTime, 0);
                return [];
            }

            // Get episode ID
            const episodeId = await this._getEpisodeId(showId, query.season, query.episode);
            if (!episodeId) {
                log('debug', `[BetaSeries] Episode not found: S${query.season}E${query.episode}`);
                this.updateStats(true, Date.now() - startTime, 0);
                return [];
            }

            // Determine language filter using unified language module
            let bsLanguage = null;
            if (query.language) {
                bsLanguage = toBetaseriesCode(query.language) || toBetaseriesCode(query.language.toLowerCase());
            }

            // Fetch subtitles
            const params = { id: episodeId };
            if (bsLanguage) {
                params.language = bsLanguage;
            }
            
            const result = await this._apiRequest('/subtitles/episode', params);
            
            if (!result || !result.subtitles) {
                log('debug', '[BetaSeries] No subtitles returned');
                this.updateStats(true, Date.now() - startTime, 0);
                return [];
            }

            // Track discovered sources dynamically
            result.subtitles.forEach(sub => {
                if (sub.source) {
                    this._discoveredSources.add(sub.source.toLowerCase());
                }
            });

            // Normalize results
            const subtitles = result.subtitles.map(sub => this._normalizeResult(sub, query));
            
            const fetchTime = Date.now() - startTime;
            this.updateStats(true, fetchTime, subtitles.length);
            
            log('info', `[BetaSeries] Found ${subtitles.length} subtitles in ${fetchTime}ms`);
            return subtitles;
            
        } catch (error) {
            log('error', `[BetaSeries] Search error: ${error.message}`);
            this.updateStats(false, Date.now() - startTime, 0, error);
            return [];
        }
    }

    /**
     * Normalize BetaSeries result to SubtitleResult
     * @private
     */
    _normalizeResult(sub, query) {
        const fileName = sub.file || '';
        const fileNameLower = fileName.toLowerCase();
        const isZip = fileNameLower.endsWith('.zip');
        const isAss = fileNameLower.endsWith('.ass') || fileNameLower.endsWith('.ssa');
        
        // Determine format based on file extension
        let format = 'srt';
        let needsConversion = false;
        
        if (isAss) {
            format = 'ass';
            needsConversion = true;
        } else if (isZip) {
            // ZIP format is determined after extraction - assume SRT for now
            // The ZIP proxy will handle ASS detection and conversion
            format = 'srt';
            needsConversion = false;
        }
        
        // Determine the URL to use
        let url;
        
        if (isZip) {
            // Use proxy for ZIP extraction
            // We'll extract the file matching the requested language
            const langParam = toBetaseriesCode(query.language) || sub.language?.toLowerCase() || 'vo';
            url = `${this.baseUrl}/api/betaseries/proxy/${sub.id}?lang=${langParam}`;
        } else if (isAss) {
            // Direct ASS file - will be routed through formatForStremio dual-format handling
            // which uses /api/subtitle/ass/ and /api/subtitle/srt/ proxies
            url = sub.url;
        } else {
            // Direct SRT URL (BetaSeries redirects to actual SRT file)
            url = sub.url;
        }
        
        // Map BetaSeries language to ISO 639-2 using unified module
        const bsLang = sub.language || 'VO';
        const langEntry = getByBetaseriesCode(bsLang);
        const languageCode = langEntry ? langEntry.alpha3B : 'eng';
        
        // Build display name using unified module
        const langDisplay = langEntry ? langEntry.name : (bsLang === 'VF' ? 'French' : bsLang === 'VO' ? 'English' : bsLang);
        const display = `[${sub.source || 'betaseries'}] ${langDisplay}`;
        
        return new SubtitleResult({
            id: `bs-${sub.id}`,
            url: url,
            language: langEntry ? langEntry.alpha2 : 'en',
            languageCode: languageCode,
            source: sub.source || 'betaseries',
            provider: 'betaseries',
            releaseName: fileName.replace(/\.(srt|ass|ssa|zip)$/i, ''),
            hearingImpaired: false,
            rating: sub.quality || null,
            downloadCount: null,
            display: display,
            format: format,
            needsConversion: needsConversion
        });
    }
}

module.exports = BetaSeriesProvider;

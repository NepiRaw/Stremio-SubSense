/**
 * WyzieProvider - Subtitle provider using wyzie-lib
 * 
 * Wyzie aggregates subtitles from multiple sources:
 * - OpenSubtitles
 * - SubDL
 * - Subf2m
 * - Podnapisi
 * - AnimeTosho
 * - Gestdown
 * 
 * Fast-First Parallel Strategy:
 * - Query all sources in parallel for primary language
 * - Return as soon as minSubtitles threshold is met
 * - Continue fetching in background for caching
 * - Fallback to secondary language if 0 primary found
 */

const { searchSubtitles } = require('wyzie-lib');
const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { log } = require('../utils');

// Default sources if not configured (includes gestdown)
const DEFAULT_SOURCES = ['opensubtitles', 'subdl', 'subf2m', 'podnapisi', 'animetosho', 'gestdown'];

// Fast-first configuration (can be made configurable later)
const FAST_FIRST_CONFIG = {
    minSubtitles: 3,  // Return when we have at least X subtitles
    enabled: true     // Enable fast-first strategy
};

class WyzieProvider extends BaseProvider {
    /**
     * @param {Object} options
     * @param {Array<string>} options.sources - List of sources to query
     * @param {boolean} options.enabled - Whether provider is enabled
     * @param {number} options.minSubtitles - Min subs before returning (fast-first)
     */
    constructor(options = {}) {
        super('wyzie', options);
        
        // Get sources from options or environment
        this.sources = options.sources || this._getSourcesFromEnv();
        
        // Fast-first configuration
        this.minSubtitles = options.minSubtitles || FAST_FIRST_CONFIG.minSubtitles;
        this.fastFirstEnabled = options.fastFirstEnabled !== false && FAST_FIRST_CONFIG.enabled;
        
        // Cache for background-fetched full results
        this._backgroundCache = new Map();
    }

    /**
     * Get sources from environment variable
     * @private
     */
    _getSourcesFromEnv() {
        const envSources = process.env.SUBTITLE_SOURCES;
        if (envSources) {
            return envSources.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
        }
        return DEFAULT_SOURCES;
    }

    /**
     * Get configured sources
     * @returns {Array<string>}
     */
    getSources() {
        return this.sources;
    }

    /**
     * Search for subtitles using wyzie-lib (original method - fetches all sources at once)
     * 
     * @param {Object} query
     * @param {string} query.imdbId - IMDB ID
     * @param {number|null} query.season - Season number
     * @param {number|null} query.episode - Episode number
     * @param {string|null} query.language - Language filter (optional)
     * @returns {Promise<Array<SubtitleResult>>}
     */
    async search(query) {
        if (!this.enabled) {
            log('debug', `[WyzieProvider] Provider is disabled`);
            return [];
        }

        const startTime = Date.now();
        
        try {
            const params = this._buildParams(query);
            log('debug', `[WyzieProvider] Searching with params: ${JSON.stringify(params)}`);

            const results = await searchSubtitles(params);
            const subtitles = Array.isArray(results) ? results : [];
            
            // Normalize results to SubtitleResult format
            const normalized = subtitles.map(sub => this._normalizeResult(sub));
            
            const fetchTimeMs = Date.now() - startTime;
            this.updateStats(true, fetchTimeMs, normalized.length);
            
            log('debug', `[WyzieProvider] Found ${normalized.length} subtitles in ${fetchTimeMs}ms`);
            
            return normalized;

        } catch (error) {
            const fetchTimeMs = Date.now() - startTime;
            this.updateStats(false, fetchTimeMs, 0, error);
            log('error', `[WyzieProvider] Search failed: ${error.message}`);
            return [];
        }
    }

    /**
     * Fast-First Parallel Search Strategy
     * 
     * Queries all sources in parallel and returns as soon as minSubtitles 
     * threshold is met for the primary language. Continues fetching in 
     * background for caching.
     * 
     * @param {Object} query - Search query
     * @param {string} primaryLang - Primary language (2-letter ISO 639-1)
     * @param {string|null} secondaryLang - Secondary language for fallback
     * @returns {Promise<{subtitles: Array<SubtitleResult>, fromCache: boolean, backgroundPromise: Promise}>}
     */
    async searchFastFirst(query, primaryLang, secondaryLang = null) {
        if (!this.enabled) {
            return { subtitles: [], fromCache: false, backgroundPromise: null };
        }

        // Check cache first
        const cacheKey = this._getCacheKey(query);
        const cached = this._backgroundCache.get(cacheKey);
        if (cached && cached.subtitles) {
            log('debug', `[WyzieProvider] Returning ${cached.subtitles.length} cached subtitles`);
            const filtered = this._filterByLanguage(cached.subtitles, primaryLang, secondaryLang);
            return { subtitles: filtered, fromCache: true, backgroundPromise: null };
        }

        const startTime = Date.now();
        
        // State for tracking collected subtitles
        const state = {
            allSubtitles: [],
            primarySubtitles: [],
            secondarySubtitles: [],
            sourcesCompleted: 0,
            totalSources: this.sources.length,
            resolved: false,
            seenUrls: new Set() // For deduplication by URL
        };

        // Create parallel promises for each source WITH primary language filter (fast)
        const sourcePromises = this.sources.map(source => 
            this._searchSource(query, source, primaryLang)
                .then(subs => {
                    this._handleSourceResult(state, subs, primaryLang, secondaryLang);
                    return subs;
                })
                .catch(err => {
                    log('debug', `[WyzieProvider] Source ${source} failed: ${err.message}`);
                    state.sourcesCompleted++;
                    return [];
                })
        );
        
        // Create background promises WITHOUT language filter (for full caching)
        const backgroundState = {
            allSubtitles: [],
            seenUrls: new Set(),
            languagesFound: new Set()
        };
        
        const backgroundSourcePromises = this.sources.map(source => 
            this._searchSource(query, source, null) // No language filter
                .then(subs => {
                    for (const sub of subs) {
                        if (!backgroundState.seenUrls.has(sub.url)) {
                            backgroundState.seenUrls.add(sub.url);
                            backgroundState.allSubtitles.push(sub);
                            if (sub.language) {
                                backgroundState.languagesFound.add(sub.language);
                            }
                        }
                    }
                    return subs;
                })
                .catch(err => {
                    log('debug', `[WyzieProvider] Background source ${source} failed: ${err.message}`);
                    return [];
                })
        );

        // Fast-first promise: resolves when threshold is met
        const fastResultPromise = new Promise((resolve) => {
            const checkThreshold = () => {
                if (!state.resolved && state.primarySubtitles.length >= this.minSubtitles) {
                    state.resolved = true;
                    const fetchTimeMs = Date.now() - startTime;
                    log('info', `[WyzieProvider] Fast-first: returning ${state.primarySubtitles.length} primary subs in ${fetchTimeMs}ms`);
                    resolve(state.primarySubtitles.slice(0, this.minSubtitles * 10)); // Return up to 10x threshold
                }
            };

            // Check after initial delay to allow first sources to respond
            const checkInterval = setInterval(() => {
                checkThreshold();
                if (state.resolved || state.sourcesCompleted >= state.totalSources) {
                    clearInterval(checkInterval);
                }
            }, 50); // Check every 50ms

            // Also check after each source completes (via handleSourceResult callback)
            state.checkThreshold = checkThreshold;
        });

        // Background promise: wait for ALL language sources to complete (for caching)
        const backgroundPromise = Promise.allSettled(backgroundSourcePromises).then(() => {
            const fetchTimeMs = Date.now() - startTime;
            const languagesList = [...backgroundState.languagesFound].sort().join(', ');
            log('info', `[WyzieProvider] Background complete: ${backgroundState.allSubtitles.length} total subs in ${fetchTimeMs}ms (languages: ${languagesList || 'none'})`);
            
            // Cache the full results (ALL languages)
            this._backgroundCache.set(cacheKey, {
                subtitles: backgroundState.allSubtitles,
                languages: [...backgroundState.languagesFound],
                timestamp: Date.now()
            });
            
            this.updateStats(true, fetchTimeMs, backgroundState.allSubtitles.length);
            
            // If we haven't resolved yet (threshold not met), resolve now
            if (!state.resolved) {
                state.resolved = true;
            }
            
            return backgroundState.allSubtitles;
        });

        // Wait for fast result or all sources to complete
        const raceResult = await Promise.race([
            fastResultPromise,
            backgroundPromise.then(() => {
                // All sources done, return what we have
                if (state.primarySubtitles.length > 0) {
                    return state.primarySubtitles;
                } else if (secondaryLang && state.secondarySubtitles.length > 0) {
                    log('info', `[WyzieProvider] No primary subs, falling back to secondary`);
                    return state.secondarySubtitles;
                }
                return state.allSubtitles;
            })
        ]);

        return {
            subtitles: raceResult,
            fromCache: false,
            backgroundPromise: backgroundPromise
        };
    }

    /**
     * Search a single source
     * @private
     */
    async _searchSource(query, source, language = null) {
        const params = {
            imdb_id: query.imdbId,
            source: source
        };

        if (query.season !== null && query.season !== undefined &&
            query.episode !== null && query.episode !== undefined) {
            params.season = query.season;
            params.episode = query.episode;
        }

        if (language) {
            params.language = language;
        }

        try {
            const results = await searchSubtitles(params);
            const subtitles = Array.isArray(results) ? results : [];
            return subtitles.map(sub => this._normalizeResult(sub));
        } catch (error) {
            log('debug', `[WyzieProvider] Source ${source} error: ${error.message}`);
            return [];
        }
    }

    /**
     * Handle results from a source, update state
     * @private
     */
    _handleSourceResult(state, subtitles, primaryLang, secondaryLang) {
        state.sourcesCompleted++;
        
        for (const sub of subtitles) {
            // Deduplicate by URL
            if (state.seenUrls.has(sub.url)) {
                continue;
            }
            state.seenUrls.add(sub.url);
            
            state.allSubtitles.push(sub);
            
            // Categorize by language
            const subLang = (sub.language || '').toLowerCase();
            if (primaryLang && subLang === primaryLang.toLowerCase()) {
                state.primarySubtitles.push(sub);
            } else if (secondaryLang && subLang === secondaryLang.toLowerCase()) {
                state.secondarySubtitles.push(sub);
            }
        }

        // Trigger threshold check if callback exists
        if (state.checkThreshold) {
            state.checkThreshold();
        }
    }

    /**
     * Filter cached subtitles by language preference
     * @private
     */
    _filterByLanguage(subtitles, primaryLang, secondaryLang) {
        const primary = [];
        const secondary = [];
        const others = [];

        for (const sub of subtitles) {
            const subLang = (sub.language || '').toLowerCase();
            if (primaryLang && subLang === primaryLang.toLowerCase()) {
                primary.push(sub);
            } else if (secondaryLang && subLang === secondaryLang.toLowerCase()) {
                secondary.push(sub);
            } else {
                others.push(sub);
            }
        }

        // Return primary, then secondary, then others
        if (primary.length > 0) {
            return [...primary, ...secondary, ...others];
        } else if (secondary.length > 0) {
            return [...secondary, ...others];
        }
        return others;
    }

    /**
     * Generate cache key for a query
     * @private
     */
    _getCacheKey(query) {
        return `${query.imdbId}:${query.season || 0}:${query.episode || 0}`;
    }

    /**
     * Clear the background cache
     */
    clearCache() {
        this._backgroundCache.clear();
        log('debug', `[WyzieProvider] Cache cleared`);
    }

    /**
     * Get cache statistics
     */
    getCacheStats() {
        return {
            size: this._backgroundCache.size,
            entries: Array.from(this._backgroundCache.keys())
        };
    }

    /**
     * Search for subtitles with specific language filter (legacy method)
     * @deprecated Use searchFastFirst instead
     */
    async searchByLanguages(query, languages) {
        if (!languages || languages.length === 0) {
            return this.search(query);
        }

        const startTime = Date.now();

        try {
            const params = this._buildParams(query);
            
            if (languages.length === 1) {
                params.language = languages[0];
            }

            log('debug', `[WyzieProvider] Searching by languages: ${languages.join(', ')}`);

            const results = await searchSubtitles(params);
            const subtitles = Array.isArray(results) ? results : [];
            const normalized = subtitles.map(sub => this._normalizeResult(sub));

            const fetchTimeMs = Date.now() - startTime;
            this.updateStats(true, fetchTimeMs, normalized.length);

            return normalized;

        } catch (error) {
            const fetchTimeMs = Date.now() - startTime;
            this.updateStats(false, fetchTimeMs, 0, error);
            log('error', `[WyzieProvider] Search by language failed: ${error.message}`);
            return [];
        }
    }

    /**
     * Build wyzie-lib search parameters
     * @private
     */
    _buildParams(query) {
        const params = {
            imdb_id: query.imdbId,
            source: this.sources
        };

        // Add season/episode for series
        if (query.season !== null && query.season !== undefined &&
            query.episode !== null && query.episode !== undefined) {
            params.season = query.season;
            params.episode = query.episode;
        }

        // Add language filter if specified
        if (query.language) {
            params.language = query.language;
        }

        return params;
    }

    /**
     * Normalize wyzie-lib result to SubtitleResult
     * @private
     */
    _normalizeResult(sub) {
        // Get source - can be string or array in wyzie response
        let source = 'unknown';
        if (sub.source) {
            source = Array.isArray(sub.source) ? sub.source[0] : sub.source;
        }

        // Get language code (wyzie uses 2-letter codes)
        const langCode = sub.lang || sub.language || 'und';
        const language = langCode.substring(0, 2).toLowerCase();

        // Detect format from URL (Wyzie-specific: uses format=xxx parameter)
        const formatInfo = this._detectFormatFromUrl(sub.url);

        return new SubtitleResult({
            id: sub.id || `wyzie-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            url: sub.url,
            language: language,
            languageCode: null, // Will be mapped to 3-letter by subtitles.js
            source: source,
            provider: this.name,
            releaseName: sub.releaseName || sub.release || sub.media || '',
            hearingImpaired: sub.hearingImpaired || sub.isHearingImpaired || sub.hi || false,
            rating: sub.rating || null,
            downloadCount: sub.downloads || null,
            display: sub.display || '',
            
            // Format hints from URL analysis
            format: formatInfo.format,
            needsConversion: formatInfo.needsConversion
        });
    }

    /**
     * Detect subtitle format from Wyzie URL patterns
     * Wyzie URLs typically include format=xxx parameter
     * 
     * @private
     * @param {string} url - Subtitle URL
     * @returns {{ format: string|null, needsConversion: boolean|null }}
     */
    _detectFormatFromUrl(url) {
        if (!url) {
            return { format: null, needsConversion: null };
        }

        // Check for format parameter (Wyzie-specific)
        const formatMatch = url.match(/[?&]format=([^&]+)/i);
        const formatParam = formatMatch ? formatMatch[1].toLowerCase() : null;

        // Check for file extension
        const extMatch = url.match(/\.([a-z0-9]+)(?:\?|$)/i);
        const extension = extMatch ? extMatch[1].toLowerCase() : null;

        // Determine format and conversion needs
        // SRT: No conversion needed
        if (formatParam === 'srt' || extension === 'srt') {
            return { format: 'srt', needsConversion: false };
        }

        // ASS/SSA: Definitely needs conversion
        if (formatParam === 'ass' || formatParam === 'ssa' || 
            extension === 'ass' || extension === 'ssa') {
            return { format: 'ass', needsConversion: true };
        }

        // Ambiguous formats (bluray, webdl, other, etc.): Need content inspection
        // These might be ASS files mislabeled as release type
        if (formatParam && !['srt', 'ass', 'ssa', 'vtt', 'sub'].includes(formatParam)) {
            // Format param is something like "bluray", "webdl", "other"
            // This is NOT a file format - it's a release type
            // We need to inspect content to determine actual format
            return { format: 'unknown', needsConversion: null };
        }

        // VTT/SUB: Currently not converting, but flag as known formats
        if (formatParam === 'vtt' || extension === 'vtt') {
            return { format: 'vtt', needsConversion: false };
        }
        if (formatParam === 'sub' || extension === 'sub') {
            return { format: 'sub', needsConversion: false };
        }

        // No format info available - need content inspection
        return { format: null, needsConversion: null };
    }
}

module.exports = WyzieProvider;

/**
 * WyzieProvider
 * Subtitle provider using wyzie-lib
 * 
 * Wyzie aggregates subtitles from:
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
 */

const { searchSubtitles } = require('wyzie-lib');
const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { log } = require('../utils');

// Default sources if not configured
const DEFAULT_SOURCES = ['OpenSubtitles', 'Subdl', 'Subf2m', 'Podnapisi', 'AnimeTosho', 'Gestdown'];

// Fast-first configuration 
const FAST_FIRST_CONFIG = {
    minSubtitles: 1,  // Return when we have at least X subtitles
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
     * Uses WYZIE_SOURCES if set, otherwise uses DEFAULT_SOURCES
     * @private
     */
    _getSourcesFromEnv() {
        const envSources = process.env.WYZIE_SOURCES;
        if (envSources) {
            const sources = envSources.split(',').map(s => s.trim()).filter(s => s);
            log('debug', `[WyzieProvider] Using sources from WYZIE_SOURCES: ${sources.join(', ')}`);
            return sources;
        }
        log('debug', `[WyzieProvider] Using default sources: ${DEFAULT_SOURCES.join(', ')}`);
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

        const cacheKey = this._getCacheKey(query);
        const cached = this._backgroundCache.get(cacheKey);
        if (cached && cached.subtitles) {
            log('debug', `[WyzieProvider] Returning ${cached.subtitles.length} cached subtitles`);
            const filtered = this._filterByLanguage(cached.subtitles, primaryLang, secondaryLang);
            return { subtitles: filtered, fromCache: true, backgroundPromise: null };
        }

        const startTime = Date.now();
        
        const state = {
            allSubtitles: [],
            primarySubtitles: [],
            secondarySubtitles: [],
            sourcesCompleted: 0,
            totalSources: this.sources.length,
            resolved: false,
            seenUrls: new Set() // For deduplication by URL
        };

        // Create parallel promises for each source (fast)
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
        
        // Create background promises with no language filter (caching)
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
        let checkInterval = null;
        const MAX_INTERVAL_TIMEOUT = 30000; // Force cleanup after 30 seconds max
        
        const fastResultPromise = new Promise((resolve) => {
            const checkThreshold = () => {
                if (!state.resolved && state.primarySubtitles.length >= this.minSubtitles) {
                    state.resolved = true;
                    const fetchTimeMs = Date.now() - startTime;
                    log('info', `[WyzieProvider] Fast-first: returning ${state.primarySubtitles.length} primary subs in ${fetchTimeMs}ms (threshold met)`);
                    if (checkInterval) {
                        clearInterval(checkInterval);
                        checkInterval = null;
                    }
                    resolve(state.primarySubtitles.slice(0, this.minSubtitles * 20));
                }
            };

            checkInterval = setInterval(() => {
                checkThreshold();
                const elapsed = Date.now() - startTime;
                if (state.resolved || state.sourcesCompleted >= state.totalSources || elapsed > MAX_INTERVAL_TIMEOUT) {
                    if (checkInterval) {
                        clearInterval(checkInterval);
                        checkInterval = null;
                    }
                    if (elapsed > MAX_INTERVAL_TIMEOUT && !state.resolved) {
                        log('warn', `[WyzieProvider] Fast-first: interval timeout after ${elapsed}ms, forcing cleanup`);
                        state.resolved = true;
                        resolve(state.primarySubtitles);
                    }
                }
            }, 50);

            state.checkThreshold = checkThreshold;
            state._checkInterval = () => {
                if (checkInterval) {
                    clearInterval(checkInterval);
                    checkInterval = null;
                }
            };
        });

        const primaryDonePromise = Promise.allSettled(sourcePromises).then(() => {
            if (state._checkInterval) state._checkInterval();
            if (!state.resolved) {
                state.resolved = true;
                const fetchTimeMs = Date.now() - startTime;
                if (state.primarySubtitles.length > 0) {
                    log('info', `[WyzieProvider] Fast-first: ${state.primarySubtitles.length} primary subs in ${fetchTimeMs}ms (all sources done)`);
                    return state.primarySubtitles;
                } else if (secondaryLang && state.secondarySubtitles.length > 0) {
                    log('info', `[WyzieProvider] Fast-first: ${state.secondarySubtitles.length} secondary subs in ${fetchTimeMs}ms (fallback)`);
                    return state.secondarySubtitles;
                } else {
                    log('warn', `[WyzieProvider] Fast-first: no subs found after ${fetchTimeMs}ms`);
                    return [];
                }
            }
            return state.primarySubtitles;
        });

        // Background promise: wait for ALL language sources to complete (for caching)
        const backgroundPromise = Promise.allSettled(backgroundSourcePromises).then(() => {
            const fetchTimeMs = Date.now() - startTime;
            const languagesList = [...backgroundState.languagesFound].sort().join(', ');
            log('info', `[WyzieProvider] Background complete: ${backgroundState.allSubtitles.length} total subs in ${fetchTimeMs}ms (languages: ${languagesList || 'none'})`);
            
            // Cache the full results
            this._backgroundCache.set(cacheKey, {
                subtitles: backgroundState.allSubtitles,
                languages: [...backgroundState.languagesFound],
                timestamp: Date.now()
            });
            
            this.updateStats(true, fetchTimeMs, backgroundState.allSubtitles.length);
            
            if (!state.resolved) {
                state.resolved = true;
            }
            
            return backgroundState.allSubtitles;
        });

        const raceResult = await Promise.race([
            fastResultPromise,
            primaryDonePromise
        ]);

        return {
            subtitles: raceResult,
            fromCache: false,
            backgroundPromise: backgroundPromise
        };
    }

    /**
     * Multi-Language Fast-First Parallel Search Strategy
     * 
     * Queries all sources in parallel for EACH language (N languages × M sources).
     * Returns when any language hits the threshold. All selected languages are
     * treated with equal priority (no primary/secondary distinction).
     * 
     * @param {Object} query - Search query
     * @param {Array<string>} languages - Array of language codes (2-letter ISO 639-1), max 5
     * @returns {Promise<{subtitles: Array<SubtitleResult>, fromCache: boolean, backgroundPromise: Promise}>}
     */
    async searchFastFirstMulti(query, languages = []) {
        if (!this.enabled || languages.length === 0) {
            return { subtitles: [], fromCache: false, backgroundPromise: null };
        }

        const cacheKey = this._getCacheKey(query);
        const cached = this._backgroundCache.get(cacheKey);
        if (cached && cached.subtitles) {
            log('debug', `[WyzieProvider] Returning ${cached.subtitles.length} cached subtitles for ${languages.length} languages`);
            const filtered = this._filterByLanguages(cached.subtitles, languages);
            return { subtitles: filtered, fromCache: true, backgroundPromise: null };
        }

        const startTime = Date.now();
        
        const state = {
            allSubtitles: [],
            byLanguage: {},
            sourcesCompleted: 0,
            totalSources: this.sources.length * languages.length,
            resolved: false,
            seenUrls: new Set()
        };
        
        languages.forEach(lang => {
            state.byLanguage[lang.toLowerCase()] = [];
        });

        const allLanguagePromises = [];
        
        for (const lang of languages) {
            const langPromises = this.sources.map(source => 
                this._searchSource(query, source, lang)
                    .then(subs => {
                        this._handleMultiLanguageResult(state, subs, lang);
                        return subs;
                    })
                    .catch(err => {
                        log('debug', `[WyzieProvider] Source ${source} for ${lang} failed: ${err.message}`);
                        state.sourcesCompleted++;
                        return [];
                    })
            );
            allLanguagePromises.push(...langPromises);
        }
        
        const backgroundState = {
            allSubtitles: [],
            seenUrls: new Set(),
            languagesFound: new Set()
        };
        
        const backgroundSourcePromises = this.sources.map(source => 
            this._searchSource(query, source, null)
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

        // Fast-first promise: resolves when all languages have at least some results or any has hit threshold
        let checkInterval = null;
        const MAX_INTERVAL_TIMEOUT = 30000; // Force cleanup after 30 seconds max
        
        const fastResultPromise = new Promise((resolve) => {
            const checkThreshold = () => {
                    if (!state.resolved) {
                        // Check if all preferred languages have at least 1 subtitle each
                    let allLanguagesHaveResults = true;
                    let anyLanguageHitThreshold = false;
                    let totalFromPreferred = 0;
                    
                    for (const lang of languages) {
                        const langKey = lang.toLowerCase();
                        const count = state.byLanguage[langKey]?.length || 0;
                        totalFromPreferred += count;
                        
                        if (count === 0) {
                            allLanguagesHaveResults = false;
                        }
                        if (count >= this.minSubtitles) {
                            anyLanguageHitThreshold = true;
                        }
                    }
                    
                    // Resolve if all languages have at least 1 result and total is good enough
                    // OR if any single language hit the threshold and we've waited for others
                    if (allLanguagesHaveResults && totalFromPreferred >= this.minSubtitles) {
                        state.resolved = true;
                        const fetchTimeMs = Date.now() - startTime;
                        const langCounts = languages.map(l => `${l}:${(state.byLanguage[l.toLowerCase()] || []).length}`).join(', ');
                        log('info', `[WyzieProvider] Multi-lang fast-first: all languages have results (${langCounts}) in ${fetchTimeMs}ms`);
                        if (checkInterval) {
                            clearInterval(checkInterval);
                            checkInterval = null;
                        }
                        resolve(state.allSubtitles);
                        return;
                    }
                    
                    // If one language hit threshold and we've been waiting for 3000ms+, resolve anyway
                    if (anyLanguageHitThreshold && (Date.now() - startTime) >= 3000) {
                        state.resolved = true;
                        const fetchTimeMs = Date.now() - startTime;
                        const langCounts = languages.map(l => `${l}:${(state.byLanguage[l.toLowerCase()] || []).length}`).join(', ');
                        log('info', `[WyzieProvider] Multi-lang fast-first: timeout with partial results (${langCounts}) in ${fetchTimeMs}ms`);
                        if (checkInterval) {
                            clearInterval(checkInterval);
                            checkInterval = null;
                        }
                        resolve(state.allSubtitles);
                        return;
                    }
                }
            };

            checkInterval = setInterval(() => {
                checkThreshold();
                // Add timeout check to prevent infinite intervals
                const elapsed = Date.now() - startTime;
                if (state.resolved || state.sourcesCompleted >= state.totalSources || elapsed > MAX_INTERVAL_TIMEOUT) {
                    if (checkInterval) {
                        clearInterval(checkInterval);
                        checkInterval = null;
                    }
                    if (elapsed > MAX_INTERVAL_TIMEOUT && !state.resolved) {
                        log('warn', `[WyzieProvider] Multi-lang: interval timeout after ${elapsed}ms, forcing cleanup`);
                        state.resolved = true;
                        resolve(state.allSubtitles);
                    }
                }
            }, 50);

            state.checkThreshold = checkThreshold;
            state._checkInterval = () => {
                if (checkInterval) {
                    clearInterval(checkInterval);
                    checkInterval = null;
                }
            };
        });

        const allDonePromise = Promise.allSettled(allLanguagePromises).then(() => {
            if (state._checkInterval) state._checkInterval();
            if (!state.resolved) {
                state.resolved = true;
                const fetchTimeMs = Date.now() - startTime;
                const langCounts = languages.map(l => `${l}:${(state.byLanguage[l.toLowerCase()] || []).length}`).join(', ');
                log('info', `[WyzieProvider] Multi-lang complete: ${state.allSubtitles.length} total subs in ${fetchTimeMs}ms (${langCounts})`);
            }
            return state.allSubtitles;
        });

        const backgroundPromise = Promise.allSettled(backgroundSourcePromises).then(() => {
            const fetchTimeMs = Date.now() - startTime;
            const languagesList = [...backgroundState.languagesFound].sort().join(', ');
            log('info', `[WyzieProvider] Background complete: ${backgroundState.allSubtitles.length} total subs (languages: ${languagesList || 'none'})`);
            
            this._backgroundCache.set(cacheKey, {
                subtitles: backgroundState.allSubtitles,
                languages: [...backgroundState.languagesFound],
                timestamp: Date.now()
            });
            
            this.updateStats(true, fetchTimeMs, backgroundState.allSubtitles.length);
            
            return backgroundState.allSubtitles;
        });

        const raceResult = await Promise.race([
            fastResultPromise,
            allDonePromise
        ]);

        return {
            subtitles: raceResult,
            fromCache: false,
            backgroundPromise: backgroundPromise
        };
    }

    /**
     * Handle results from a source for multi-language search
     * @private
     */
    _handleMultiLanguageResult(state, subtitles, language) {
        state.sourcesCompleted++;
        const langKey = language.toLowerCase();
        
        for (const sub of subtitles) {
            if (state.seenUrls.has(sub.url)) {
                continue;
            }
            state.seenUrls.add(sub.url);
            state.allSubtitles.push(sub);
            
            const subLang = (sub.language || '').toLowerCase();
            if (state.byLanguage[subLang]) {
                state.byLanguage[subLang].push(sub);
            }
        }

        if (state.checkThreshold) {
            state.checkThreshold();
        }
    }

    /**
     * Filter cached subtitles by multiple languages (equal priority)
     * @private
     */
    _filterByLanguages(subtitles, languages) {
        const langSet = new Set(languages.map(l => l.toLowerCase()));
        const selected = [];
        const others = [];

        for (const sub of subtitles) {
            const subLang = (sub.language || '').toLowerCase();
            if (langSet.has(subLang)) {
                selected.push(sub);
            } else {
                others.push(sub);
            }
        }

        return [...selected, ...others];
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
            
            // Filter out subtitle formats: PGS, SUP, IDX, VOB
            const filtered = subtitles.filter(sub => {
                if (!sub.url) return true;
                
                const formatMatch = sub.url.match(/[?&]format=([^&]+)/i);
                if (formatMatch) {
                    const format = formatMatch[1].toLowerCase();
                    if (['pgs', 'sup', 'idx', 'vobsub', 'sub/idx'].includes(format)) {
                        log('debug', `[WyzieProvider] Filtering out ${format} subtitle from ${source}`);
                        return false;
                    }
                }
                return true;
            });
            
            if (filtered.length < subtitles.length) {
                log('debug', `[WyzieProvider] Filtered out ${subtitles.length - filtered.length} PGS/binary subs from ${source}`);
            }
            
            return filtered.map(sub => this._normalizeResult(sub));
        } catch (error) {
            const errorMsg = error.message || '';
            if (errorMsg.includes('status: 400') || errorMsg.includes('400')) {
                log('debug', `[WyzieProvider] Source ${source}${language ? ` (${language})` : ''}: No subtitles found`);
            } else if (errorMsg.includes('status: 404') || errorMsg.includes('404')) {
                log('debug', `[WyzieProvider] Source ${source}${language ? ` (${language})` : ''}: Content not found`);
            } else if (errorMsg.includes('status: 429') || errorMsg.includes('429')) {
                log('warn', `[WyzieProvider] Source ${source}: Rate limited`);
            } else if (errorMsg.includes('status: 5') || errorMsg.includes('500') || errorMsg.includes('502') || errorMsg.includes('503')) {
                log('debug', `[WyzieProvider] Source ${source}: Server error`);
            } else {
                log('debug', `[WyzieProvider] Source ${source} error: ${error.message}`);
            }
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
            if (state.seenUrls.has(sub.url)) {
                continue;
            }
            state.seenUrls.add(sub.url);
            
            state.allSubtitles.push(sub);
            
            const subLang = (sub.language || '').toLowerCase();
            if (primaryLang && subLang === primaryLang.toLowerCase()) {
                state.primarySubtitles.push(sub);
            } else if (secondaryLang && subLang === secondaryLang.toLowerCase()) {
                state.secondarySubtitles.push(sub);
            }
        }

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

        if (query.season !== null && query.season !== undefined &&
            query.episode !== null && query.episode !== undefined) {
            params.season = query.season;
            params.episode = query.episode;
        }

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
        let source = 'unknown';
        if (sub.source) {
            source = Array.isArray(sub.source) ? sub.source[0] : sub.source;
        }

        // Get language code (wyzie uses 2-letter codes)
        const langCode = sub.lang || sub.language || 'und';
        const language = langCode.substring(0, 2).toLowerCase();

        // Detect format from URL (format=xxx parameter)
        const formatInfo = this._detectFormatFromUrl(sub.url);

        const rawFileName = sub.fileName || null;
        const fileName = this._isUsefulFileName(rawFileName) ? rawFileName : null;

        return new SubtitleResult({
            id: sub.id || `wyzie-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            url: sub.url,
            language: language,
            languageCode: null, // Will be mapped to 3-letter by subtitles.js
            source: source,
            provider: this.name,
            releaseName: sub.releaseName || sub.release || sub.media || '',
            fileName: fileName,
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
     * Check if a fileName is useful for matching (not GUID, not too short, contains release info)
     * @private
     * @param {string|null} fileName - The filename to check
     * @returns {boolean}
     */
    _isUsefulFileName(fileName) {
        if (!fileName || typeof fileName !== 'string') return false;
        
        // Reject GUIDs (e.g., "69cf7d79-052c-4f12-a57d-995d77de43ad")
        if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(fileName)) {
            return false;
        }
        
        if (fileName.length < 10) return false;
        
        // Require release-like patterns
        const hasReleasePattern = /[\.\-_]/.test(fileName) && (
            /\.(srt|ass|ssa|sub|vtt)$/i.test(fileName) ||  // Has subtitle extension
            /s\d{1,2}e\d{1,2}/i.test(fileName) ||           // Has S01E01 pattern
            /\d{3,4}p/i.test(fileName) ||                    // Has resolution
            /x26[45]|hevc|avc/i.test(fileName)               // Has codec
        );
        
        return hasReleasePattern;
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

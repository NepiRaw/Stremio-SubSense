const { providerManager, WyzieProvider } = require('./providers');
const { parseStremioId, log } = require('./utils');
const { mapStremioToWyzie, mapWyzieToStremio, normalizeLanguageCode } = require('./languages');
const statsService = require('./stats');
const { isAssFormat } = require('./services/subtitle-converter');
const { sortByFilenameSimilarityAsync, isRealFilename, preloadParser } = require('./utils/filenameMatcher');

// Crypto utilities for encrypting API keys in download URLs
let encryptConfig = null;
try {
    const crypto = require('./utils/crypto');
    encryptConfig = crypto.encryptConfig;
} catch (err) {
    log('warn', '[Subtitles] Crypto module not available, SubSource downloads will fail');
}

const MAX_SUBTITLES = parseInt(process.env.MAX_SUBTITLES, 10) || 30;

// Cache modules
const ENABLE_CACHE = process.env.ENABLE_CACHE !== 'false';
let subtitleCache = null;
let statsDB = null;

if (ENABLE_CACHE) {
    try {
        const cache = require('./cache');
        subtitleCache = cache.subtitleCache;
        statsDB = cache.statsDB;
        log('info', '[Server] Subtitle cache enabled');
    } catch (error) {
        log('warn', `[Server] Cache disabled: ${error.message}`);
    }
}

// Flag to use fast-first strategy (can be made configurable later)
const USE_FAST_FIRST = true;

/**
 * Handle subtitle request from Stremio
 * Supports multi-language selection (up to 5 languages with equal priority)
 * @param {Object} args - Stremio request args (type, id, extra)
 * @param {Object} config - User configuration (languages array)
 * @returns {Object} Stremio subtitle response
 */
async function handleSubtitles(args, config) {
    const startTime = Date.now();
    let cacheHit = false;
    
    try {
        // Parse the Stremio ID
        const parsed = parseStremioId(args.id);
        log('debug', `[Subtitles] Parsed ID: imdb=${parsed.imdbId}, season=${parsed.season}, episode=${parsed.episode}`);

        // Extract Stremio extra parameters (video file info)
        const stremioExtra = args.extra || {};
        const videoContext = {
            videoHash: stremioExtra.videoHash || null,      // OpenSubtitles-style hash
            videoSize: stremioExtra.videoSize || null,      // File size in bytes
            filename: stremioExtra.filename || null         // User's video filename - Filename similarity ranking
        };
        
        if (videoContext.filename) {
            log('debug', `[Subtitles] Video context: filename="${videoContext.filename}", hash=${videoContext.videoHash ? 'present' : 'none'}`);
        }

        // Get languages from config
        const languages = config.languages || [];

        // Log incoming request
        const sessionInfo = config.userId ? `session=${config.userId}` : 'no-session';
        log('info', `[Request] ${sessionInfo} ${parsed.type} ${parsed.imdbId}${parsed.season ? `:${parsed.season}:${parsed.episode}` : ''} langs=[${languages.join(',')}]`);

        // Convert Stremio 3-letter codes to wyzie 2-letter
        const wyzieLanguages = languages.map(lang => mapStremioToWyzie(lang)).filter(Boolean);

        let rawSubtitles = [];
        let backgroundPromise = null;

        // Check cache first for all requested languages
        if (subtitleCache && wyzieLanguages.length > 0) {
            const cachedSubtitles = [];
            let allCached = true;
            let needsRefresh = false;
            
            for (const lang of wyzieLanguages) {
                const cached = subtitleCache.get(parsed.imdbId, parsed.season, parsed.episode, lang);
                if (cached && cached.subtitles.length > 0) {
                    cachedSubtitles.push(...cached.subtitles);
                    if (cached.needsRefresh) {
                        needsRefresh = true;
                    }
                } else {
                    allCached = false;
                }
            }
            
            if (cachedSubtitles.length > 0) {
                // Regenerate SubSource URLs with current user's encrypted API key
                rawSubtitles = regenerateSubsourceUrls(cachedSubtitles, config, parsed.episode);
                cacheHit = true;
                log('info', `[Subtitles] Cache HIT: ${rawSubtitles.length} subtitles for ${wyzieLanguages.join(', ')}`);
                
                if (needsRefresh) {
                    log('debug', 'Cache stale, triggering background refresh');
                    backgroundPromise = refreshCacheInBackground(parsed, wyzieLanguages, videoContext, config);
                }
                
                if (statsDB) {
                    statsDB.increment('cache_hits');
                    statsDB.recordDaily({ cacheHits: 1 });
                }
            }
        }

        // If no cache hit, fetch from providers
        if (!cacheHit) {
            log('info', `[Subtitles] Cache MISS: fetching ${wyzieLanguages.join(', ')} from providers`);
            if (statsDB) {
                statsDB.increment('cache_misses');
                statsDB.recordDaily({ cacheMisses: 1 });
            }

            if (USE_FAST_FIRST) {
                // Multi-language fast-first strategy
                const result = await fetchSubtitlesFastFirstMulti(parsed, wyzieLanguages, videoContext, config);
                rawSubtitles = result.subtitles;
                backgroundPromise = result.backgroundPromise;
                log('info', `[Subtitles] Fast-first multi-lang: got ${rawSubtitles.length} subtitles`);
            } else {
                // Legacy: fetch all at once
                rawSubtitles = await fetchSubtitles(parsed, videoContext, config);
                log('debug', `Fetched ${rawSubtitles.length} raw subtitles from providers`);
            }

            // Store in cache per language
            if (subtitleCache && rawSubtitles.length > 0) {
                cacheSubtitlesByLanguage(parsed, rawSubtitles);
            }
        }

        // Prioritize by user's selected languages (all with equal priority)
        const maxSubtitles = config.maxSubtitles || 0; // 0 means unlimited
        const { subtitles: prioritized, languageMatch } = prioritizeSubtitlesMulti(rawSubtitles, languages, maxSubtitles);
        log('debug', `After prioritization: ${prioritized.length} subtitles`);

        // Sort by filename similarity if a real filename was provided
        let sortedSubtitles = prioritized;
        if (videoContext.filename && isRealFilename(videoContext.filename)) {
            sortedSubtitles = await sortByFilenameSimilarityAsync(prioritized, videoContext.filename, parsed.type);
        }

        // Format for Stremio
        const formatted = formatForStremio(sortedSubtitles);

        // Track stats
        const fetchTimeMs = Date.now() - startTime;
        statsService.trackRequest({
            type: parsed.type,
            fetchTimeMs,
            subtitleCount: formatted.length,
            subtitles: formatted,
            languageMatch,
            providerStats: providerManager.getStats()
        });

        // Log detailed request to database
        if (statsDB) {
            // Compute per-request language success metrics
            const anyPreferredFound = languages.some(lang => languageMatch?.byLanguage?.[lang]?.found);
            const allPreferredFound = languages.every(lang => languageMatch?.byLanguage?.[lang]?.found);
            
            // Normalize language codes to alpha3B for consistent grouping
            const normalizedLanguages = languages.map(lang => normalizeLanguageCode(lang));
            
            statsDB.logRequest({
                imdbId: parsed.imdbId,
                contentType: parsed.type,
                languages: normalizedLanguages,
                resultCount: formatted.length,
                cacheHit,
                responseTimeMs: fetchTimeMs,
                anyPreferredFound,
                allPreferredFound
            });
            
            statsDB.recordDaily({
                requests: 1,
                movies: parsed.type === 'movie' ? 1 : 0,
                series: parsed.type === 'series' ? 1 : 0
            });
            
            // Record language stats for each selected language (normalized to B-variant)
            for (const lang of languages) {
                const found = languageMatch?.byLanguage?.[lang]?.found || false;
                statsDB.recordLanguageStats({
                    languageCode: normalizeLanguageCode(lang),
                    found: found
                });
            }
        }

        // Record session analytics
        if (statsDB && config.userId) {
            statsDB.trackUserRequest(config.userId, {
                imdbId: parsed.imdbId,
                contentType: parsed.type,
                languages: languages,
                season: parsed.season,
                episode: parsed.episode
            });
        }

        log('debug', `Returning ${formatted.length} subtitles in ${fetchTimeMs}ms`);

        // Fire-and-forget: handle background fetch completion
        if (backgroundPromise && !cacheHit) {
            backgroundPromise
                .then(backgroundSubtitles => {
                    if (backgroundSubtitles && backgroundSubtitles.length > 0) {
                        cacheSubtitlesByLanguage(parsed, backgroundSubtitles);
                    }
                })
                .catch(err => log('debug', `Background fetch error: ${err.message}`));
        }

        return { subtitles: formatted };

    } catch (error) {
        log('error', `handleSubtitles error: ${error.message}`);
        statsService.trackError(error, { id: args.id, type: args.type });
        return { subtitles: [] };
    }
}

/**
 * Fetch subtitles using multi-language fast-first parallel strategy
 * Calls ALL enabled providers in parallel, combining results
 * @param {Object} parsed - Parsed Stremio ID
 * @param {Array<string>} languages - Array of language codes (2-letter)
 * @param {Object} videoContext - Video file context from Stremio (optional)
 * @param {string|null} videoContext.videoHash - OpenSubtitles-style hash
 * @param {number|null} videoContext.videoSize - File size in bytes
 * @param {string|null} videoContext.filename - Video filename
 * @param {Object} config - User configuration (optional)
 * @param {string|null} config.subsourceApiKey - SubSource API key (if configured)
 * @returns {Object} { subtitles, fromCache, backgroundPromise }
 */
async function fetchSubtitlesFastFirstMulti(parsed, languages, videoContext = {}, config = {}) {
    // Generate encrypted API key for SubSource download URLs
    let encryptedApiKey = null;
    if (config.subsourceApiKey && encryptConfig) {
        try {
            encryptedApiKey = encryptConfig({ apiKey: config.subsourceApiKey });
        } catch (err) {
            log('warn', `[Subtitles] Failed to encrypt API key for SubSource: ${err.message}`);
        }
    }
    
    const query = {
        imdbId: parsed.imdbId,
        season: parsed.season,
        episode: parsed.episode,
        language: languages[0], // Primary language for providers that need it
        videoHash: videoContext.videoHash, // Include video context for providers that support it
        videoSize: videoContext.videoSize,
        filename: videoContext.filename,
        // SubSource API key (if user has configured it)
        apiKey: config.subsourceApiKey || null,
        // Encrypted API key for download URLs
        encryptedApiKey: encryptedApiKey
    };

    const enabledProviders = providerManager.getEnabled();
    const wyzieProvider = providerManager.get('wyzie');
    const otherProviders = enabledProviders.filter(p => p.name !== 'wyzie');
    
    log('debug', `[Subtitles] Fetching from ${enabledProviders.length} providers: ${enabledProviders.map(p => p.name).join(', ')}`);
    
    // Build promises for all providers
    const providerPromises = [];
    const providerNames = [];
    
    // Wyzie uses fast-first if available
    if (wyzieProvider && wyzieProvider.enabled) {
        if (wyzieProvider.searchFastFirstMulti) {
            providerPromises.push(wyzieProvider.searchFastFirstMulti(query, languages));
            providerNames.push('wyzie');
        } else if (wyzieProvider.searchFastFirst && languages.length > 0) {
            providerPromises.push(wyzieProvider.searchFastFirst(query, languages[0], languages[1] || null));
            providerNames.push('wyzie');
        } else {
            providerPromises.push(wyzieProvider.search(query));
            providerNames.push('wyzie');
        }
    }
    
    // Other providers use regular search (e.g., BetaSeries)
    for (const provider of otherProviders) {
        // Create language-specific queries for each requested language
        for (const lang of languages) {
            const langQuery = { ...query, language: lang };
            providerPromises.push(provider.search(langQuery));
            providerNames.push(`${provider.name}(${lang})`);
        }
    }
    
    if (providerPromises.length === 0) {
        log('warn', '[Subtitles] No providers available');
        return { subtitles: [], fromCache: false, backgroundPromise: null };
    }
    
    // Execute all providers in parallel
    const startTime = Date.now();
    const results = await Promise.allSettled(providerPromises);
    const totalTime = Date.now() - startTime;
    
    // Aggregate results
    let allSubtitles = [];
    let backgroundPromise = null;
    const summary = [];
    
    results.forEach((result, index) => {
        const providerName = providerNames[index];
        
        if (result.status === 'fulfilled') {
            const value = result.value;
            
            // Handle Wyzie's fast-first response format
            if (value && value.subtitles) {
                allSubtitles.push(...value.subtitles);
                summary.push(`${providerName}:${value.subtitles.length}`);
                // Capture background promise if present
                if (value.backgroundPromise && !backgroundPromise) {
                    backgroundPromise = value.backgroundPromise;
                }
            } else if (Array.isArray(value)) {
                // Standard provider response
                allSubtitles.push(...value);
                summary.push(`${providerName}:${value.length}`);
            } else {
                summary.push(`${providerName}:0`);
            }
        } else {
            summary.push(`${providerName}:ERR`);
            log('debug', `[Subtitles] ${providerName} failed: ${result.reason?.message || 'Unknown'}`);
        }
    });
    
    log('info', `[Subtitles] Multi-provider: ${allSubtitles.length} total in ${totalTime}ms (${summary.join(', ')})`);
    
    return { subtitles: allSubtitles, fromCache: false, backgroundPromise };
}

/**
 * Fetch subtitles from all registered providers (legacy method)
 * Uses the provider abstraction layer for flexibility
 * @param {Object} parsed - Parsed Stremio ID
 * @param {Object} videoContext - Video file context from Stremio (optional)
 * @param {Object} config - User configuration (optional)
 * @returns {Array} Normalized subtitle objects from all providers
 */
async function fetchSubtitles(parsed, videoContext = {}, config = {}) {
    // Generate encrypted API key for SubSource download URLs
    let encryptedApiKey = null;
    if (config.subsourceApiKey && encryptConfig) {
        try {
            encryptedApiKey = encryptConfig({ apiKey: config.subsourceApiKey });
        } catch (err) {
            log('warn', `[Subtitles] Failed to encrypt API key for SubSource: ${err.message}`);
        }
    }
    
    const query = {
        imdbId: parsed.imdbId,
        season: parsed.season,
        episode: parsed.episode,
        videoHash: videoContext.videoHash, // Include video context for providers that support it
        videoSize: videoContext.videoSize,
        filename: videoContext.filename,
        // SubSource API key (if user has configured it)
        apiKey: config.subsourceApiKey || null,
        // Encrypted API key for download URLs
        encryptedApiKey: encryptedApiKey
    };

    log('debug', `Fetching from ${providerManager.getEnabled().length} provider(s)`);

    const results = await providerManager.searchAll(query);
    return results;
}

/**
 * Prioritize subtitles by user's selected languages (all with equal priority)
 * Interleaves subtitles across all selected languages to ensure balanced distribution
 * @param {Array} subtitles - Raw subtitles from providers
 * @param {Array<string>} languages - User's selected languages (3-letter codes)
 * @param {number} maxSubtitles - Max subtitles per language (0 = unlimited)
 * @returns {Object} { subtitles: Array, languageMatch: Object }
 */
function prioritizeSubtitlesMulti(subtitles, languages, maxSubtitles = 0) {
    // Convert Stremio 3-letter codes to wyzie 2-letter for comparison
    const wyzieLangs = languages.map(lang => ({
        stremio: lang,
        wyzie: mapStremioToWyzie(lang)?.toLowerCase()
    })).filter(l => l.wyzie);

    // Group subtitles by language
    const byLanguage = {};
    for (const lang of languages) {
        byLanguage[lang] = [];
    }
    const others = [];

    for (const sub of subtitles) {
        const subLang = (sub.lang || sub.language || '').toLowerCase().substring(0, 2);
        const source = Array.isArray(sub.source) ? sub.source[0] : (sub.source || 'unknown');
        
        // Check if this subtitle matches any selected language
        const matchedLang = wyzieLangs.find(l => l.wyzie === subLang);
        
        if (matchedLang) {
            byLanguage[matchedLang.stremio].push(sub);
        } else {
            others.push(sub);
        }
    }

    // Sort within each group by quality indicators
    const sortByQuality = (a, b) => {
        // Prefer non-hearing-impaired
        const hiA = a.hearingImpaired || a.isHearingImpaired || a.hi || false;
        const hiB = b.hearingImpaired || b.isHearingImpaired || b.hi || false;
        if (hiA !== hiB) return hiA ? 1 : -1;
        return 0;
    };

    // Sort each language group
    for (const lang of languages) {
        byLanguage[lang].sort(sortByQuality);
    }
    others.sort(sortByQuality);

    // Build language match info
    const languageMatch = {
        languages: languages,
        byLanguage: {},
        selectedCount: 0,
        othersCount: others.length
    };
    
    for (const lang of languages) {
        languageMatch.byLanguage[lang] = {
            found: byLanguage[lang].length > 0,
            count: byLanguage[lang].length,
            sources: [...new Set(byLanguage[lang].map(s => 
                Array.isArray(s.source) ? s.source[0] : (s.source || 'unknown')
            ))]
        };
        languageMatch.selectedCount += byLanguage[lang].length;
    }

    // Log language matching results
    const matchSummary = languages.map(lang => {
        const info = languageMatch.byLanguage[lang];
        return `${lang}(${info.count})`;
    }).join(', ');
    log('info', `[Subtitles] Language matching: ${matchSummary}, others=${others.length}`);
    
    // Log warnings for missing languages
    for (const lang of languages) {
        if (!languageMatch.byLanguage[lang].found) {
            log('warn', `[Subtitles] Selected language "${lang}" not found in available subtitles`);
        }
    }

    // Return up to maxSubtitles per language (0 = unlimited)
    const results = [];
    const limit = maxSubtitles > 0 ? maxSubtitles : Infinity;
    
    for (const lang of languages) {
        const langSubs = byLanguage[lang];
        // Take up to maxSubtitles for this language
        const limited = maxSubtitles > 0 ? langSubs.slice(0, maxSubtitles) : langSubs;
        results.push(...limited);
    }

    const limitStr = maxSubtitles > 0 ? maxSubtitles.toString() : 'unlimited';
    log('debug', `Returning ${results.length} subtitles from ${languages.length} languages (max ${limitStr} per language)`);

    return {
        subtitles: results,
        languageMatch
    };
}

/**
 * Format subtitles for Stremio response
 * Implements dual-format strategy: ASS subtitles are returned as both:
 * 1. Original ASS format (for devices that support it)
 * 2. Converted SRT format (for devices that don't support ASS)
 * 
 * @param {Array} subtitles - Prioritized subtitles
 * @returns {Array} Stremio-formatted subtitle objects
 */
function formatForStremio(subtitles) {
    log('debug', `[formatForStremio] Formatting ${subtitles.length} subtitles for Stremio`);
    
    // Get base URL for proxy
    const port = process.env.PORT || 3100;
    const proxyBaseUrl = process.env.SUBSENSE_BASE_URL || `http://127.0.0.1:${port}`;
    
    const results = [];
    let outputIndex = 0;
    
    for (const sub of subtitles) {
        // Get language code (wyzie uses 2-letter, Stremio needs 3-letter)
        const subLang = sub.lang || sub.language || 'und';
        const lang = mapWyzieToStremio(subLang.substring(0, 2));

        // Get display name from wyzie response (e.g., "English", "French")
        const displayName = sub.display || lang;

        // Get source - can be string or array
        let source = 'Unknown';
        if (sub.source) {
            source = Array.isArray(sub.source) ? sub.source[0] : sub.source;
        }

        // Build label components
        const hi = (sub.hearingImpaired || sub.isHearingImpaired || sub.hi) ? ' [HI]' : '';
        const release = sub.releaseName || sub.release || '';
        const mediaPart = release || sub.media || '';
        
        // Base label: "English | opensubtitles - Release Name [HI]"
        const baseLabel = mediaPart 
            ? `${displayName} | ${source} - ${mediaPart}${hi}`
            : `${displayName} | ${source}${hi}`;

        // Determine the subtitle format
        const format = (sub.format || '').toLowerCase();
        const isAss = format === 'ass' || format === 'ssa' || sub.needsConversion === true;
        
        // Generate unique subtitle ID base
        const subIdBase = sub.id || Date.now();
        
        if (isAss && proxyBaseUrl) {
            // === DUAL FORMAT: Return both VTT (styled) and SRT (plain fallback) ===
            // VTT comes first as it preserves styling (bold, italic, underline)
            // SRT is fallback for players that don't support VTT
            
            // 1. First: VTT subtitle (converted from ASS with styling preserved)
            const vttUrl = `${proxyBaseUrl}/api/subtitle/vtt/${sub.url}`;
            results.push({
                id: `subsense-${outputIndex}-${subIdBase}-vtt-${source}`,
                url: vttUrl,
                lang: lang,
                label: baseLabel,
                source: source
            });
            log('debug', `[formatForStremio] [${outputIndex}] VTT styled: ${sub.url.substring(0, 50)}...`);
            outputIndex++;
            
            // 2. Second: SRT subtitle (converted from ASS, no styling - fallback)
            const srtUrl = `${proxyBaseUrl}/api/subtitle/srt/${sub.url}`;
            results.push({
                id: `subsense-${outputIndex}-${subIdBase}-srt-${source}`,
                url: srtUrl,
                lang: lang,
                label: baseLabel,
                source: source
            });
            log('debug', `[formatForStremio] [${outputIndex}] SRT fallback: ${sub.url.substring(0, 50)}...`);
            outputIndex++;
            
        } else {
            // === SINGLE FORMAT: Non-ASS subtitles or no proxy available ===
            
            // Determine URL - use proxy for inspection if available
            let url = sub.url;
            const detectedFormat = format || 'srt'; // Default to SRT if unknown
            
            if (proxyBaseUrl && sub.needsConversion !== false) {
                // Wrap in proxy for potential format inspection/conversion
                // Use VTT endpoint to preserve styling if content turns out to be ASS
                url = `${proxyBaseUrl}/api/subtitle/vtt/${sub.url}`;
                log('debug', `[formatForStremio] [${outputIndex}] Proxying ${detectedFormat}: ${sub.url.substring(0, 50)}...`);
            }
            
            results.push({
                id: `subsense-${outputIndex}-${subIdBase}-${detectedFormat}-${source}`,
                url: url,
                lang: lang,
                label: baseLabel,
                source: source
            });
            outputIndex++;
        }
    }
    
    // Filter out any entries without valid URLs
    const validResults = results.filter(sub => !!sub.url);
    
    log('info', `[formatForStremio] Formatted ${subtitles.length} subtitles => ${validResults.length} entries`);
    
    return validResults;
}

/**
 * Refresh cache in background for multiple languages (fire-and-forget)
 * @param {Object} parsed - Parsed Stremio ID
 * @param {Array<string>} languages - Language codes (2-letter)
 * @param {Object} videoContext - Video file context (optional)
 * @param {Object} config - User configuration (optional)
 * @returns {Promise} Background fetch promise
 */
async function refreshCacheInBackground(parsed, languages, videoContext = {}, config = {}) {
    try {
        log('debug', `Background refresh starting for ${parsed.imdbId}`);
        
        const result = await fetchSubtitlesFastFirstMulti(parsed, languages, videoContext, config);
        
        if (result.subtitles.length > 0 && subtitleCache) {
            // Cache ALL languages for future users
            cacheSubtitlesByLanguage(parsed, result.subtitles);
            log('debug', `Background refresh complete: ${result.subtitles.length} total subtitles`);
        }
        
        return result.subtitles;
    } catch (error) {
        log('warn', `Background refresh error: ${error.message}`);
        return [];
    }
}

/**
 * Cache subtitles grouped by language - caches ALL languages for any future user
 * @param {Object} parsed - Parsed Stremio ID
 * @param {Array} subtitles - Array of subtitle objects
 */
function cacheSubtitlesByLanguage(parsed, subtitles) {
    if (!subtitleCache || !subtitles || subtitles.length === 0) return;
    
    // Group subtitles by language
    const byLang = {};
    for (const sub of subtitles) {
        const subLang = (sub.lang || sub.language || '').toLowerCase().substring(0, 2);
        if (!subLang) continue; // Skip if no language
        if (!byLang[subLang]) byLang[subLang] = [];
        byLang[subLang].push(sub);
    }
    
    // Cache each language separately
    const languages = Object.keys(byLang);
    for (const lang of languages) {
        subtitleCache.set(parsed.imdbId, parsed.season, parsed.episode, lang, byLang[lang]);
    }
    
    log('info', `[Cache] Stored ${subtitles.length} subtitles across ${languages.length} languages for ${parsed.imdbId}`);
}

/**
 * Regenerate SubSource URLs with current user's encrypted API key
 * Cached SubSource subtitles may have been stored without API key (from other users)
 * This ensures each user's requests have their own encrypted API key in download URLs
 * @param {Array} subtitles - Cached subtitle objects
 * @param {Object} config - User configuration with subsourceApiKey
 * @param {number|null} episode - Episode number for TV series
 * @returns {Array} Subtitles with regenerated SubSource URLs
 */
function regenerateSubsourceUrls(subtitles, config, episode = null) {
    if (!config.subsourceApiKey || !encryptConfig) {
        return subtitles; // No API key or encryption not available
    }
    
    let encryptedApiKey = null;
    try {
        encryptedApiKey = encryptConfig({ apiKey: config.subsourceApiKey });
    } catch (err) {
        log('warn', `[Subtitles] Failed to encrypt API key for cache regeneration: ${err.message}`);
        return subtitles;
    }
    
    const baseUrl = process.env.SUBSENSE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3100}`;
    
    return subtitles.map(sub => {
        // Only modify SubSource subtitles
        if (sub.source !== 'subsource' && sub.provider !== 'subsource') {
            return sub;
        }
        
        // Extract subtitle ID from existing URL
        const match = sub.url?.match(/\/api\/subsource\/proxy\/(\d+)/);
        if (!match) {
            return sub;
        }
        
        const subtitleId = match[1];
        
        // Build new URL with encrypted API key
        const params = new URLSearchParams();
        params.set('key', encryptedApiKey);
        if (episode) {
            params.set('episode', episode.toString());
        }
        
        return {
            ...sub,
            url: `${baseUrl}/api/subsource/proxy/${subtitleId}?${params.toString()}`
        };
    });
}

module.exports = {
    handleSubtitles
};

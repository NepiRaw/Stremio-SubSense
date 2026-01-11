const { providerManager, WyzieProvider } = require('./providers');
const { parseStremioId, log } = require('./utils');
const { mapStremioToWyzie, mapWyzieToStremio, normalizeLanguageCode } = require('./languages');
const statsService = require('./stats');
const { isAssFormat } = require('./services/subtitle-converter');
const { sortByFilenameSimilarityAsync, isRealFilename } = require('./utils/filenameMatcher');

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

// Fast-First timeout: return whatever we have after this timeout (8 seconds)
// Slow providers (e.g., BetaSeries) will continue in background and cache results
const FAST_FIRST_TIMEOUT_MS = 8000;

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
                rawSubtitles = regenerateSubsourceUrls(cachedSubtitles, config, parsed.season, parsed.episode);
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
 * Race a provider promise against a deadline. Returns early result or null if timed out.
 * @param {Promise} promise - Provider search promise
 * @param {string} name - Provider name for logging
 * @param {number} deadline - Deadline timestamp (Date.now() + timeout)
 * @returns {Object} { name, result, timedOut, promise }
 */
async function raceProviderWithDeadline(promise, name, deadline) {
    const remainingTime = Math.max(0, deadline - Date.now());
    
    if (remainingTime <= 0) {
        return { name, result: null, timedOut: true, promise };
    }
    
    const timeoutPromise = new Promise(resolve => 
        setTimeout(() => resolve({ timedOut: true }), remainingTime)
    );
    
    try {
        const raceResult = await Promise.race([
            promise.then(result => ({ result, timedOut: false })),
            timeoutPromise
        ]);
        
        if (raceResult.timedOut) {
            log('debug', `[FastFirst] ${name} timed out after ${FAST_FIRST_TIMEOUT_MS - remainingTime}ms`);
            return { name, result: null, timedOut: true, promise };
        }
        
        return { name, result: raceResult.result, timedOut: false, promise: null };
    } catch (error) {
        log('debug', `[FastFirst] ${name} failed: ${error.message}`);
        return { name, result: null, timedOut: false, error, promise: null };
    }
}

/**
 * Fetch subtitles from all providers with Fast-First timeout strategy.
 * Returns available results after FAST_FIRST_TIMEOUT_MS, slow providers continue in background.
 * @param {Object} parsed - Parsed Stremio ID
 * @param {Array} languages - Array of 2-letter language codes
 * @param {Object} videoContext - Video file context from Stremio (optional)
 * @param {Object} config - User configuration (optional)
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
        language: languages[0],
        videoHash: videoContext.videoHash,
        videoSize: videoContext.videoSize,
        filename: videoContext.filename,
        apiKey: config.subsourceApiKey || null,
        encryptedApiKey: encryptedApiKey
    };

    const enabledProviders = providerManager.getEnabled();
    const wyzieProvider = providerManager.get('wyzie');
    const otherProviders = enabledProviders.filter(p => p.name !== 'wyzie');
    
    log('debug', `[FastFirst] Starting with ${enabledProviders.length} providers: ${enabledProviders.map(p => p.name).join(', ')}`);
    
    // Build provider entries: { name, promise }
    const providers = [];
    
    // Wyzie uses fast-first if available
    if (wyzieProvider && wyzieProvider.enabled) {
        let promise;
        if (wyzieProvider.searchFastFirstMulti) {
            promise = wyzieProvider.searchFastFirstMulti(query, languages);
        } else if (wyzieProvider.searchFastFirst && languages.length > 0) {
            promise = wyzieProvider.searchFastFirst(query, languages[0], languages[1] || null);
        } else {
            promise = wyzieProvider.search(query);
        }
        providers.push({ name: 'wyzie', promise });
    }
    
    // Other providers use regular search per language
    for (const provider of otherProviders) {
        for (const lang of languages) {
            const langQuery = { ...query, language: lang };
            providers.push({ 
                name: `${provider.name}(${lang})`, 
                promise: provider.search(langQuery) 
            });
        }
    }
    
    if (providers.length === 0) {
        log('warn', '[FastFirst] No providers available');
        return { subtitles: [], fromCache: false, backgroundPromise: null };
    }
    
    // Calculate deadline once for all providers
    const startTime = Date.now();
    const deadline = startTime + FAST_FIRST_TIMEOUT_MS;
    
    // Race all providers against the deadline in parallel
    const raceResults = await Promise.all(
        providers.map(p => raceProviderWithDeadline(p.promise, p.name, deadline))
    );
    
    const elapsedTime = Date.now() - startTime;
    
    // Aggregate results and track timed-out providers
    let allSubtitles = [];
    const summary = [];
    const timedOutProviders = [];
    let wyzieBackgroundPromise = null;
    
    for (const result of raceResults) {
        if (result.timedOut) {
            summary.push(`${result.name}:TIMEOUT`);
            timedOutProviders.push({ name: result.name, promise: result.promise });
        } else if (result.error) {
            summary.push(`${result.name}:ERR`);
        } else if (result.result) {
            const value = result.result;
            
            // Handle Wyzie's fast-first response format
            if (value && value.subtitles) {
                allSubtitles.push(...value.subtitles);
                summary.push(`${result.name}:${value.subtitles.length}`);
                if (value.backgroundPromise && !wyzieBackgroundPromise) {
                    wyzieBackgroundPromise = value.backgroundPromise;
                }
            } else if (Array.isArray(value)) {
                allSubtitles.push(...value);
                summary.push(`${result.name}:${value.length}`);
            } else {
                summary.push(`${result.name}:0`);
            }
        } else {
            summary.push(`${result.name}:0`);
        }
    }
    
    log('info', `[FastFirst] Got ${allSubtitles.length} subs in ${elapsedTime}ms (${summary.join(', ')})`);
    
    // Create background promise for timed-out providers to cache their results
    let backgroundPromise = null;
    if (timedOutProviders.length > 0) {
        backgroundPromise = (async () => {
            const bgStartTime = Date.now();
            log('debug', `[FastFirst] Background: waiting for ${timedOutProviders.length} timed-out providers...`);
            
            const bgResults = await Promise.allSettled(
                timedOutProviders.map(p => p.promise)
            );
            
            let bgSubtitles = [];
            const bgSummary = [];
            
            bgResults.forEach((result, i) => {
                const providerName = timedOutProviders[i].name;
                if (result.status === 'fulfilled') {
                    const value = result.value;
                    if (value && value.subtitles) {
                        bgSubtitles.push(...value.subtitles);
                        bgSummary.push(`${providerName}:${value.subtitles.length}`);
                    } else if (Array.isArray(value)) {
                        bgSubtitles.push(...value);
                        bgSummary.push(`${providerName}:${value.length}`);
                    } else {
                        bgSummary.push(`${providerName}:0`);
                    }
                } else {
                    bgSummary.push(`${providerName}:ERR`);
                }
            });
            
            const bgElapsed = Date.now() - bgStartTime;
            log('info', `[FastFirst] Background complete: ${bgSubtitles.length} subs in ${bgElapsed}ms (${bgSummary.join(', ')})`);
            
            // Cache the background results for next request
            if (subtitleCache && bgSubtitles.length > 0) {
                // Group by language and cache
                const byLang = {};
                for (const sub of bgSubtitles) {
                    const lang = (sub.lang || sub.language || '').toLowerCase().substring(0, 2);
                    if (!byLang[lang]) byLang[lang] = [];
                    byLang[lang].push(sub);
                }
                
                for (const [lang, subs] of Object.entries(byLang)) {
                    const existingCache = subtitleCache.get(parsed.imdbId, parsed.season, parsed.episode, lang);
                    if (existingCache) {
                        // Merge with existing cache (dedup by URL)
                        const existingUrls = new Set(existingCache.subtitles.map(s => s.url));
                        const newSubs = subs.filter(s => !existingUrls.has(s.url));
                        if (newSubs.length > 0) {
                            const merged = [...existingCache.subtitles, ...newSubs];
                            subtitleCache.set(parsed.imdbId, parsed.season, parsed.episode, lang, merged);
                            log('debug', `[FastFirst] Background cached: ${newSubs.length} new ${lang} subs (${merged.length} total)`);
                        }
                    } else {
                        subtitleCache.set(parsed.imdbId, parsed.season, parsed.episode, lang, subs);
                        log('debug', `[FastFirst] Background cached: ${subs.length} ${lang} subs`);
                    }
                }
            }
            
            return bgSubtitles;
        })();
    }
    
    // Wrap Wyzie's background promise to cache its results
    if (wyzieBackgroundPromise) {
        wyzieBackgroundPromise = wyzieBackgroundPromise.then(wyzieBgSubs => {
            // Cache Wyzie's background results
            if (subtitleCache && wyzieBgSubs && wyzieBgSubs.length > 0) {
                const byLang = {};
                for (const sub of wyzieBgSubs) {
                    const lang = (sub.lang || sub.language || '').toLowerCase().substring(0, 2);
                    if (!byLang[lang]) byLang[lang] = [];
                    byLang[lang].push(sub);
                }
                
                for (const [lang, subs] of Object.entries(byLang)) {
                    const existingCache = subtitleCache.get(parsed.imdbId, parsed.season, parsed.episode, lang);
                    if (existingCache) {
                        const existingUrls = new Set(existingCache.subtitles.map(s => s.url));
                        const newSubs = subs.filter(s => !existingUrls.has(s.url));
                        if (newSubs.length > 0) {
                            const merged = [...existingCache.subtitles, ...newSubs];
                            subtitleCache.set(parsed.imdbId, parsed.season, parsed.episode, lang, merged);
                            log('debug', `[FastFirst] Wyzie background cached: ${newSubs.length} new ${lang} subs (${merged.length} total)`);
                        }
                    } else {
                        subtitleCache.set(parsed.imdbId, parsed.season, parsed.episode, lang, subs);
                    }
                }
            }
            return wyzieBgSubs || [];
        });
    }
    
    // Combine with Wyzie's background promise if present, flatten results
    if (wyzieBackgroundPromise && backgroundPromise) {
        backgroundPromise = Promise.all([wyzieBackgroundPromise, backgroundPromise])
            .then(([wyzieSubs, timedOutSubs]) => [...(wyzieSubs || []), ...(timedOutSubs || [])]);
    } else if (wyzieBackgroundPromise) {
        backgroundPromise = wyzieBackgroundPromise;
    }
    
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
function regenerateSubsourceUrls(subtitles, config, season = null, episode = null) {
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
        
        // Extract subtitle ID and releaseName from existing URL
        // Pattern: /api/subsource/proxy/:subtitleId/:releaseName?params
        // or: /api/subsource/proxy/:subtitleId?params (if releaseName missing)
        const match = sub.url?.match(/\/api\/subsource\/proxy\/(\d+)(?:\/([^?]+))?/);
        if (!match) {
            return sub;
        }
        
        const subtitleId = match[1];
        
        let releaseName = match[2] 
            ? decodeURIComponent(match[2]) 
            : (sub.releaseName || sub.title || 'subtitle');
        
        const sanitizedRelease = releaseName
            .replace(/[^a-zA-Z0-9._-]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 100) || 'subtitle';
        
        const params = new URLSearchParams();
        params.set('key', encryptedApiKey);
        if (season) {
            params.set('season', season.toString());
        }
        if (episode) {
            params.set('episode', episode.toString());
        }
        
        return {
            ...sub,
            url: `${baseUrl}/api/subsource/proxy/${subtitleId}/${encodeURIComponent(sanitizedRelease)}?${params.toString()}`
        };
    });
}

module.exports = {
    handleSubtitles
};

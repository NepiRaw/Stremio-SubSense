const { providerManager, WyzieProvider } = require('./providers');
const { parseStremioId, log } = require('./utils');
const { mapStremioToWyzie, mapWyzieToStremio, normalizeLanguageCode } = require('./languages');
const statsService = require('./stats');

const MAX_SUBTITLES = parseInt(process.env.MAX_SUBTITLES, 10) || 30;

// Cache modules (Phase 2)
const ENABLE_CACHE = process.env.ENABLE_CACHE !== 'false';
let subtitleCache = null;
let statsDB = null;

if (ENABLE_CACHE) {
    try {
        const cache = require('./cache');
        subtitleCache = cache.subtitleCache;
        statsDB = cache.statsDB;
        log('info', 'Subtitle cache enabled');
    } catch (error) {
        log('warn', `Cache disabled: ${error.message}`);
    }
}

// Flag to use fast-first strategy (can be made configurable later)
const USE_FAST_FIRST = true;

/**
 * Handle subtitle request from Stremio
 * Supports multi-language selection (up to 5 languages with equal priority)
 * @param {Object} args - Stremio request args (type, id, extra)
 * @param {Object} config - User configuration (languages array or legacy primaryLang/secondaryLang)
 * @returns {Object} Stremio subtitle response
 */
async function handleSubtitles(args, config) {
    const startTime = Date.now();
    let cacheHit = false;
    
    try {
        // Parse the Stremio ID
        const parsed = parseStremioId(args.id);
        log('debug', `Parsed ID: imdb=${parsed.imdbId}, season=${parsed.season}, episode=${parsed.episode}`);

        // Get languages from config (supports both new and legacy format)
        const languages = config.languages || [];
        if (languages.length === 0 && config.primaryLang) {
            // Legacy fallback
            languages.push(config.primaryLang);
            if (config.secondaryLang && config.secondaryLang !== 'none') {
                languages.push(config.secondaryLang);
            }
        }

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
                rawSubtitles = cachedSubtitles;
                cacheHit = true;
                log('info', `Cache HIT: ${cachedSubtitles.length} subtitles for ${wyzieLanguages.join(', ')}`);
                
                if (needsRefresh) {
                    log('debug', 'Cache stale, triggering background refresh');
                    backgroundPromise = refreshCacheInBackground(parsed, wyzieLanguages);
                }
                
                if (statsDB) {
                    statsDB.increment('cache_hits');
                    statsDB.recordDaily({ cacheHits: 1 });
                }
            }
        }

        // If no cache hit, fetch from providers
        if (!cacheHit) {
            if (statsDB) {
                statsDB.increment('cache_misses');
                statsDB.recordDaily({ cacheMisses: 1 });
            }

            if (USE_FAST_FIRST) {
                // Multi-language fast-first strategy
                const result = await fetchSubtitlesFastFirstMulti(parsed, wyzieLanguages);
                rawSubtitles = result.subtitles;
                backgroundPromise = result.backgroundPromise;
                log('info', `Fast-first multi-lang: got ${rawSubtitles.length} subtitles`);
            } else {
                // Legacy: fetch all at once
                rawSubtitles = await fetchSubtitles(parsed);
                log('debug', `Fetched ${rawSubtitles.length} raw subtitles from providers`);
            }

            // Store in cache per language
            if (subtitleCache && rawSubtitles.length > 0) {
                cacheSubtitlesByLanguage(parsed, rawSubtitles);
            }
        }

        // Prioritize by user's selected languages (all with equal priority)
        const { subtitles: prioritized, languageMatch } = prioritizeSubtitlesMulti(rawSubtitles, languages);
        log('debug', `After prioritization: ${prioritized.length} subtitles`);

        // Format for Stremio
        const formatted = formatForStremio(prioritized);

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

        // Log detailed request to database (Phase 2.5)
        if (statsDB) {
            statsDB.logRequest({
                imdbId: parsed.imdbId,
                contentType: parsed.type,
                languages: languages,
                resultCount: formatted.length,
                cacheHit,
                responseTimeMs: fetchTimeMs
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
 * @param {Object} parsed - Parsed Stremio ID
 * @param {Array<string>} languages - Array of language codes (2-letter)
 * @returns {Object} { subtitles, fromCache, backgroundPromise }
 */
async function fetchSubtitlesFastFirstMulti(parsed, languages) {
    const query = {
        imdbId: parsed.imdbId,
        season: parsed.season,
        episode: parsed.episode
    };

    const wyzieProvider = providerManager.get('wyzie');
    if (!wyzieProvider) {
        log('debug', 'Wyzie provider not available, using regular search');
        const subtitles = await providerManager.searchAll(query);
        return { subtitles, fromCache: false, backgroundPromise: null };
    }

    // Use multi-language fast-first if available
    if (wyzieProvider.searchFastFirstMulti) {
        return await wyzieProvider.searchFastFirstMulti(query, languages);
    }
    
    // Fallback to legacy fast-first with first two languages
    if (wyzieProvider.searchFastFirst && languages.length > 0) {
        return await wyzieProvider.searchFastFirst(query, languages[0], languages[1] || null);
    }

    const subtitles = await providerManager.searchAll(query);
    return { subtitles, fromCache: false, backgroundPromise: null };
}

/**
 * Fetch subtitles from all registered providers (legacy method)
 * Uses the provider abstraction layer for flexibility
 * @param {Object} parsed - Parsed Stremio ID
 * @returns {Array} Normalized subtitle objects from all providers
 */
async function fetchSubtitles(parsed) {
    const query = {
        imdbId: parsed.imdbId,
        season: parsed.season,
        episode: parsed.episode
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
 * @returns {Object} { subtitles: Array, languageMatch: Object }
 */
function prioritizeSubtitlesMulti(subtitles, languages) {
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
    log('info', `Language matching: ${matchSummary}, others=${others.length}`);
    
    // Log warnings for missing languages
    for (const lang of languages) {
        if (!languageMatch.byLanguage[lang].found) {
            log('warn', `Selected language "${lang}" not found in available subtitles`);
        }
    }

    // Return up to MAX_SUBTITLES per language
    const results = [];
    
    for (const lang of languages) {
        const langSubs = byLanguage[lang];
        // Take up to MAX_SUBTITLES for this language
        const limited = langSubs.slice(0, MAX_SUBTITLES);
        results.push(...limited);
    }

    log('debug', `Returning ${results.length} subtitles from ${languages.length} languages (up to ${MAX_SUBTITLES} per language)`);

    return {
        subtitles: results,
        languageMatch
    };
}

/**
 * Format subtitles for Stremio response
 * @param {Array} subtitles - Prioritized subtitles
 * @returns {Array} Stremio-formatted subtitle objects
 */
function formatForStremio(subtitles) {
    log('debug', `[formatForStremio] Formatting ${subtitles.length} subtitles for Stremio`);
    
    // Get base URL for proxy
    const port = process.env.PORT || 3100;
    const proxyBaseUrl = process.env.SUBSENSE_BASE_URL || `http://127.0.0.1:${port}`;
    
    return subtitles.map((sub, index) => {
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

        // Build label with display name and source
        const hi = (sub.hearingImpaired || sub.isHearingImpaired || sub.hi) ? ' [HI]' : '';
        const release = sub.releaseName || sub.release || '';
        const mediaPart = release || sub.media || '';
        
        // Format: "English | opensubtitles - Release Name [HI]"
        const label = mediaPart 
            ? `${displayName} | ${source} - ${mediaPart}${hi}`
            : `${displayName} | ${source}${hi}`;

        // Determine URL - use proxy for potential ASS format conversion
        let url = sub.url;
        
        const needsProxy = proxyBaseUrl && sub.needsConversion !== false;
        
        if (needsProxy) {
            // Wrap in our conversion proxy which will inspect content and convert if ASS
            url = `${proxyBaseUrl}/api/subtitle/srt/${sub.url}`;
            
            if (sub.needsConversion === true) {
                log('debug', `[formatForStremio] Proxying ${sub.format || 'unknown'}→SRT: ${sub.url.substring(0, 50)}...`);
            } else {
                log('debug', `[formatForStremio] Proxying for inspection (format=${sub.format || 'unknown'}): ${sub.url.substring(0, 50)}...`);
            }
        }

        return {
            id: `subsense-${index}-${sub.id || Date.now()}`,
            url: url,
            lang: lang,
            label: label,
            source: source // Include for stats tracking
        };
    }).filter(sub => {
        const valid = !!sub.url;
        if (valid && log) {
            log('debug', `[formatForStremio] Subtitle: id=${sub.id}, lang=${sub.lang}, source=${sub.source}`);
        }
        return valid;
    });
}

/**
 * Refresh cache in background for multiple languages (fire-and-forget)
 * @param {Object} parsed - Parsed Stremio ID
 * @param {Array<string>} languages - Language codes (2-letter)
 * @returns {Promise} Background fetch promise
 */
async function refreshCacheInBackground(parsed, languages) {
    try {
        log('debug', `Background refresh starting for ${parsed.imdbId}`);
        
        const result = await fetchSubtitlesFastFirstMulti(parsed, languages);
        
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
    
    log('debug', `Cached subtitles for ${languages.length} languages: ${languages.join(', ')} (${subtitles.length} total)`);
}

module.exports = {
    handleSubtitles
};

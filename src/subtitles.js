const { providerManager, WyzieProvider } = require('./providers');
const { parseStremioId, log } = require('./utils');
const { mapStremioToWyzie, mapWyzieToStremio } = require('./languages');
const statsService = require('./stats');

const MAX_SUBTITLES = parseInt(process.env.MAX_SUBTITLES, 10) || 30;

// Flag to use fast-first strategy (can be made configurable later)
const USE_FAST_FIRST = true;

/**
 * Handle subtitle request from Stremio
 * @param {Object} args - Stremio request args (type, id, extra)
 * @param {Object} config - User configuration (primaryLang, secondaryLang)
 * @returns {Object} Stremio subtitle response
 */
async function handleSubtitles(args, config) {
    const startTime = Date.now();
    
    try {
        // Parse the Stremio ID
        const parsed = parseStremioId(args.id);
        log('debug', `Parsed ID: imdb=${parsed.imdbId}, season=${parsed.season}, episode=${parsed.episode}`);

        // Convert Stremio 3-letter codes to wyzie 2-letter
        const primaryWyzie = mapStremioToWyzie(config.primaryLang);
        const secondaryWyzie = config.secondaryLang !== 'none' ? mapStremioToWyzie(config.secondaryLang) : null;

        let rawSubtitles;
        let backgroundPromise = null;

        if (USE_FAST_FIRST) {
            // Fast-first strategy: parallel queries, return on threshold
            const result = await fetchSubtitlesFastFirst(parsed, primaryWyzie, secondaryWyzie);
            rawSubtitles = result.subtitles;
            backgroundPromise = result.backgroundPromise;
            log('info', `Fast-first: got ${rawSubtitles.length} subtitles${result.fromCache ? ' (cached)' : ''}`);
        } else {
            // Legacy: fetch all at once
            rawSubtitles = await fetchSubtitles(parsed);
            log('debug', `Fetched ${rawSubtitles.length} raw subtitles from providers`);
        }

        // Prioritize by language (fast-first already filters, but this adds sorting)
        const { subtitles: prioritized, languageMatch } = prioritizeSubtitles(rawSubtitles, config);
        log('debug', `After prioritization: ${prioritized.length} subtitles`);

        // Format for Stremio
        const formatted = formatForStremio(prioritized);

        // Track stats (including provider stats)
        const fetchTimeMs = Date.now() - startTime;
        statsService.trackRequest({
            type: parsed.type,
            fetchTimeMs,
            subtitleCount: formatted.length,
            subtitles: formatted,
            languageMatch,
            providerStats: providerManager.getStats()
        });

        log('debug', `Returning ${formatted.length} subtitles in ${fetchTimeMs}ms`);

        // Fire-and-forget: let background complete for caching
        if (backgroundPromise) {
            backgroundPromise.catch(err => log('debug', `Background fetch error: ${err.message}`));
        }

        return { subtitles: formatted };

    } catch (error) {
        log('error', `handleSubtitles error: ${error.message}`);
        statsService.trackError(error, { id: args.id, type: args.type });
        return { subtitles: [] };
    }
}

/**
 * Fetch subtitles using fast-first parallel strategy
 * Queries all sources in parallel and returns as soon as threshold is met
 * @param {Object} parsed - Parsed Stremio ID
 * @param {string} primaryLang - Primary language (2-letter code)
 * @param {string|null} secondaryLang - Secondary language for fallback
 * @returns {Object} { subtitles, fromCache, backgroundPromise }
 */
async function fetchSubtitlesFastFirst(parsed, primaryLang, secondaryLang) {
    const query = {
        imdbId: parsed.imdbId,
        season: parsed.season,
        episode: parsed.episode
    };

    // Get the Wyzie provider
    const wyzieProvider = providerManager.get('wyzie');
    if (!wyzieProvider || !wyzieProvider.searchFastFirst) {
        // Fallback to regular search if provider doesn't support fast-first
        log('debug', 'Fast-first not available, using regular search');
        const subtitles = await providerManager.searchAll(query);
        return { subtitles, fromCache: false, backgroundPromise: null };
    }

    return await wyzieProvider.searchFastFirst(query, primaryLang, secondaryLang);
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
 * Fetch subtitles by specific languages (potentially faster)
 * @param {Object} parsed - Parsed Stremio ID  
 * @param {Array<string>} languages - Language codes to filter
 * @returns {Array} Filtered subtitle objects
 */
async function fetchSubtitlesByLanguages(parsed, languages) {
    const query = {
        imdbId: parsed.imdbId,
        season: parsed.season,
        episode: parsed.episode
    };

    return await providerManager.searchByLanguages(query, languages);
}

/**
 * Prioritize subtitles by user's language preferences
 * Order: Primary language first, then secondary, then others
 * @param {Array} subtitles - Raw subtitles from providers
 * @param {Object} config - User config with primaryLang, secondaryLang
 * @returns {Object} { subtitles: Array, languageMatch: Object }
 */
function prioritizeSubtitles(subtitles, config) {
    const { primaryLang, secondaryLang } = config;
    
    // Convert Stremio 3-letter codes to wyzie 2-letter for comparison
    const primaryWyzie = mapStremioToWyzie(primaryLang);
    const secondaryWyzie = secondaryLang !== 'none' ? mapStremioToWyzie(secondaryLang) : null;

    const primary = [];
    const secondary = [];
    const others = [];

    // Track sources for each language group
    const primarySources = new Set();
    const secondarySources = new Set();

    for (const sub of subtitles) {
        const subLang = sub.lang || sub.language || '';
        const normalizedLang = subLang.toLowerCase().substring(0, 2);
        const source = Array.isArray(sub.source) ? sub.source[0] : (sub.source || 'unknown');

        if (primaryWyzie && normalizedLang === primaryWyzie.toLowerCase()) {
            primary.push(sub);
            primarySources.add(source);
        } else if (secondaryWyzie && normalizedLang === secondaryWyzie.toLowerCase()) {
            secondary.push(sub);
            secondarySources.add(source);
        } else {
            others.push(sub);
        }
    }

    // Language matching results
    const primaryFound = primary.length > 0;
    const secondaryFound = secondary.length > 0;
    
    const languageMatch = {
        primaryLang,
        primaryFound,
        primaryCount: primary.length,
        primarySources: [...primarySources],
        secondaryLang,
        secondaryFound,
        secondaryCount: secondary.length,
        secondarySources: [...secondarySources],
        othersCount: others.length
    };

    // Log language matching results
    log('info', `Language matching: primary=${primaryLang} (${primary.length} found from: ${languageMatch.primarySources.join(', ') || 'none'}), secondary=${secondaryLang || 'none'} (${secondary.length} found from: ${languageMatch.secondarySources.join(', ') || 'none'}), others=${others.length}`);
    
    if (!primaryFound && primaryLang !== 'none') {
        log('warn', `Primary language "${primaryLang}" not found in available subtitles`);
    }
    if (secondaryLang && secondaryLang !== 'none' && !secondaryFound) {
        log('warn', `Secondary language "${secondaryLang}" not found in available subtitles`);
    }

    // Sort within each group by quality indicators
    const sortByQuality = (a, b) => {
        // Prefer non-hearing-impaired
        const hiA = a.hearingImpaired || a.isHearingImpaired || a.hi || false;
        const hiB = b.hearingImpaired || b.isHearingImpaired || b.hi || false;
        if (hiA !== hiB) return hiA ? 1 : -1;
        
        // Could add more sorting criteria here (release name match, etc.)
        return 0;
    };

    primary.sort(sortByQuality);
    secondary.sort(sortByQuality);
    others.sort(sortByQuality);

    // Combine and limit
    const combined = [...primary, ...secondary, ...others];
    return {
        subtitles: combined.slice(0, MAX_SUBTITLES),
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
    // This URL must be reachable by Stremio (could be on a different device)
    // If SUBSENSE_BASE_URL is set, use it (for production deployments)
    // Otherwise, construct from PORT (for local development)
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
        // 
        // The provider's `format` and `needsConversion` flags indicate:
        // - format: 'srt' | 'ass' | 'ssa' | 'vtt' | 'sub' | 'unknown' | null
        // - needsConversion: true (definitely needs) | false (definitely not) | null (needs inspection)
        //
        // We proxy through our converter for:
        // 1. needsConversion === true: Provider confirmed it needs conversion (e.g., format=ass)
        // 2. needsConversion === null: Unknown format, proxy will inspect content and convert if ASS
        // We DON'T proxy:
        // - needsConversion === false: Provider confirmed it's SRT or another format we don't convert
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
            log('debug', `[formatForStremio] Subtitle: id=${sub.id}, lang=${sub.lang}, source=${sub.source}, url=${sub.url}...`);
        }
        return valid;
    }); // Only return subs with valid URLs
}

module.exports = {
    handleSubtitles
};
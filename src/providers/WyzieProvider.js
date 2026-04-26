'use strict';

const { searchSubtitles, configure: configureWyzie } = require('wyzie-lib');
const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { log } = require('../utils');

// =====================================================
// Wyzie Sources Registry
// =====================================================

const WYZIE_SOURCES_URL = 'https://sub.wyzie.io/sources';
const WYZIE_BASE_URL = 'https://sub.wyzie.io';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 10000;

function getWyzieApiKey() {
    return process.env.WYZIE_API_KEY || null;
}

const SOURCE_METADATA = {
    'opensubtitles': { display: 'OpenSubtitles', icon: 'opensubtitles.ico', url: 'https://www.opensubtitles.com' },
    'subdl':         { display: 'SubDL',         icon: 'subdl.png',         url: 'https://subdl.com' },
    'subf2m':        { display: 'Subf2m',        icon: 'subf2m.png',        url: 'https://subf2m.co' },
    'podnapisi':     { display: 'Podnapisi',     icon: 'podnapisi.ico',     url: 'https://www.podnapisi.net' },
    'animetosho':    { display: 'AnimeTosho',    icon: 'animetosho.ico',    url: 'https://animetosho.org' },
    'gestdown':      { display: 'Gestdown',      icon: 'gestdown.png',      url: 'https://gestdown.info' },
    'jimaku':        { display: 'Jimaku',         icon: 'jimaku.png',        url: 'https://jimaku.cc' },
    'kitsunekko':    { display: 'Kitsunekko',    icon: 'kitsunekko.png',    url: 'https://kitsunekko.net' },
    'yify':          { display: 'YIFY',           icon: 'yify.ico',          url: 'https://yts-subs.com' }
};

const FALLBACK_SOURCES = [
    'subdl', 'subf2m', 'opensubtitles', 'podnapisi',
    'animetosho', 'jimaku', 'kitsunekko', 'gestdown', 'yify'
];

let _cachedSources = null;
let _lastFetchTime = 0;
let _refreshTimer = null;

async function fetchWyzieSources() {
    try {
        let url = WYZIE_SOURCES_URL;
        const apiKey = getWyzieApiKey();
        if (apiKey) {
            url += `?key=${encodeURIComponent(apiKey)}`;
        }
        const response = await fetch(url, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { 'Accept': 'application/json' }
        });
        if (!response.ok) {
            log('warn', `[WyzieSources] API returned ${response.status}`);
            return null;
        }
        const data = await response.json();
        if (!data || !Array.isArray(data.sources) || data.sources.length === 0) {
            log('warn', '[WyzieSources] API response missing or empty sources array');
            return null;
        }
        const valid = data.sources.every(s => typeof s === 'string' && s.length > 0);
        if (!valid) {
            log('warn', '[WyzieSources] API response contains invalid source entries');
            return null;
        }
        return data.sources.map(s => s.toLowerCase());
    } catch (error) {
        log('warn', `[WyzieSources] Failed to fetch: ${error.message}`);
        return null;
    }
}

function getActiveSources() {
    const envSources = process.env.WYZIE_SOURCES;
    if (envSources) {
        const sources = envSources.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
        if (sources.length > 0) return sources;
    }
    if (_cachedSources && _cachedSources.length > 0) return _cachedSources;
    return [...FALLBACK_SOURCES];
}

function getSourceDisplayName(source) {
    const meta = SOURCE_METADATA[source.toLowerCase()];
    return meta ? meta.display : source.charAt(0).toUpperCase() + source.slice(1);
}

function getActiveSourcesMetadata() {
    const sources = getActiveSources();
    return sources.map(source => {
        const meta = SOURCE_METADATA[source] || {};
        return {
            id: source,
            display: meta.display || source.charAt(0).toUpperCase() + source.slice(1),
            icon: meta.icon || null,
            url: meta.url || null
        };
    });
}

async function initWyzieSources() {
    const apiKey = getWyzieApiKey();
    configureWyzie({ baseUrl: WYZIE_BASE_URL, ...(apiKey && { key: apiKey }) });

    log('info', `[WyzieSources] API key: ${apiKey ? 'configured (global)' : 'NOT SET (required — get one free at https://sub.wyzie.io/redeem)'}`);
    log('info', '[WyzieSources] Initializing — fetching available sources from API...');
    const sources = await fetchWyzieSources();
    if (sources) {
        _cachedSources = sources;
        _lastFetchTime = Date.now();
        log('info', `[WyzieSources] Loaded ${sources.length} sources from API: ${sources.join(', ')}`);
    } else {
        _cachedSources = [...FALLBACK_SOURCES];
        log('warn', `[WyzieSources] API unavailable, using ${FALLBACK_SOURCES.length} fallback sources`);
    }
    if (_refreshTimer) clearInterval(_refreshTimer);
    _refreshTimer = setInterval(async () => {
        log('debug', '[WyzieSources] Periodic refresh — fetching sources...');
        const refreshed = await fetchWyzieSources();
        if (refreshed) {
            const changed = JSON.stringify(refreshed) !== JSON.stringify(_cachedSources);
            _cachedSources = refreshed;
            _lastFetchTime = Date.now();
            if (changed) log('info', `[WyzieSources] Sources updated: ${refreshed.join(', ')}`);
        } else {
            log('warn', '[WyzieSources] Refresh failed, keeping previous sources');
        }
    }, REFRESH_INTERVAL_MS);
    return getActiveSources();
}

const FAST_FIRST_CONFIG = { minSubtitles: 1, enabled: true };

/**
 * Wyzie aggregates many upstream sources and runs its own fast-first race
 * across them per language.
 */
class WyzieProvider extends BaseProvider {
    constructor(options = {}) {
        super('wyzie', options);
        this.sources = options.sources || this._resolveActiveSources();
        this.minSubtitles = options.minSubtitles || FAST_FIRST_CONFIG.minSubtitles;
        this.fastFirstEnabled = options.fastFirstEnabled !== false && FAST_FIRST_CONFIG.enabled;
        this._backgroundCache = new Map();
    }

    _resolveActiveSources() {
        const sources = getActiveSources();
        const displayNames = sources.map(s => getSourceDisplayName(s));
        log('debug', `[WyzieProvider] Active sources: ${displayNames.join(', ')}`);
        return displayNames;
    }

    refreshSources() {
        this.sources = this._resolveActiveSources();
    }

    getSources() {
        return this.sources;
    }

    async search(query) {
        if (!this.enabled) return { subtitles: [] };

        const languages = Array.isArray(query.languages) ? query.languages : [];
        const startedAt = Date.now();

        try {
            if (languages.length === 0) {
                const subs = await this._searchAllSources({
                    imdbId: query.imdbId,
                    season: query.season,
                    episode: query.episode,
                    language: null
                });
                this._recordRequest(true, Date.now() - startedAt, subs.length);
                return { subtitles: subs };
            }

            const result = await this._searchFastFirstMulti(
                { imdbId: query.imdbId, season: query.season, episode: query.episode },
                languages
            );
            this._recordRequest(true, Date.now() - startedAt, result.subtitles.length);
            return {
                subtitles: result.subtitles,
                backgroundPromise: result.backgroundPromise || null
            };
        } catch (err) {
            this._recordRequest(false, Date.now() - startedAt, 0, err);
            return { subtitles: [] };
        }
    }

    async _searchAllSources(query) {
        try {
            const params = this._buildParams(query);
            log('debug', `[WyzieProvider] Searching with params: ${JSON.stringify(params)}`);
            const results = await searchSubtitles(params);
            const subtitles = Array.isArray(results) ? results : [];
            return subtitles.map(sub => this._normalizeResult(sub));
        } catch (error) {
            log('error', `[WyzieProvider] Search failed: ${error.message}`);
            return [];
        }
    }

    async _searchFastFirstMulti(query, languages = []) {
        if (!this.enabled || languages.length === 0) {
            return { subtitles: [], fromCache: false, backgroundPromise: null };
        }

        const cacheKey = this._getCacheKey(query);
        const cached = this._backgroundCache.get(cacheKey);
        if (cached && cached.subtitles) {
            log('debug', `[WyzieProvider] Returning ${cached.subtitles.length} cached subtitles for ${languages.length} languages`);
            return { subtitles: this._filterByLanguages(cached.subtitles, languages), fromCache: true, backgroundPromise: null };
        }

        const startTime = Date.now();
        const state = {
            allSubtitles: [], byLanguage: {}, sourcesCompleted: 0,
            totalSources: this.sources.length * languages.length,
            resolved: false, seenUrls: new Set()
        };
        languages.forEach(lang => { state.byLanguage[lang.toLowerCase()] = []; });

        const allLanguagePromises = [];
        for (const lang of languages) {
            const langPromises = this.sources.map(source =>
                this._searchSource(query, source, lang)
                    .then(subs => { this._handleMultiLanguageResult(state, subs, lang); return subs; })
                    .catch(err => { log('debug', `[WyzieProvider] Source ${source} for ${lang} failed: ${err.message}`); state.sourcesCompleted++; return []; })
            );
            allLanguagePromises.push(...langPromises);
        }

        const backgroundState = { allSubtitles: [], seenUrls: new Set(), languagesFound: new Set() };
        const backgroundSourcePromises = this.sources.map(source =>
            this._searchSource(query, source, null)
                .then(subs => {
                    for (const sub of subs) {
                        if (!backgroundState.seenUrls.has(sub.url)) {
                            backgroundState.seenUrls.add(sub.url);
                            backgroundState.allSubtitles.push(sub);
                            if (sub.language) backgroundState.languagesFound.add(sub.language);
                        }
                    }
                    return subs;
                })
                .catch(err => { log('debug', `[WyzieProvider] Background source ${source} failed: ${err.message}`); return []; })
        );

        let checkInterval = null;
        const MAX_INTERVAL_TIMEOUT = 30000;

        const fastResultPromise = new Promise((resolve) => {
            const checkThreshold = () => {
                if (!state.resolved) {
                    let allLanguagesHaveResults = true;
                    let anyLanguageHitThreshold = false;
                    let totalFromPreferred = 0;
                    for (const lang of languages) {
                        const count = state.byLanguage[lang.toLowerCase()]?.length || 0;
                        totalFromPreferred += count;
                        if (count === 0) allLanguagesHaveResults = false;
                        if (count >= this.minSubtitles) anyLanguageHitThreshold = true;
                    }
                    if (allLanguagesHaveResults && totalFromPreferred >= this.minSubtitles) {
                        state.resolved = true;
                        if (checkInterval) { clearInterval(checkInterval); checkInterval = null; }
                        const langCounts = languages.map(l => `${l}:${(state.byLanguage[l.toLowerCase()] || []).length}`).join(', ');
                        log('info', `[WyzieProvider] Multi-lang fast-first: all languages have results (${langCounts}) in ${Date.now() - startTime}ms`);
                        resolve(state.allSubtitles);
                        return;
                    }
                    if (anyLanguageHitThreshold && (Date.now() - startTime) >= 3000) {
                        state.resolved = true;
                        if (checkInterval) { clearInterval(checkInterval); checkInterval = null; }
                        const langCounts = languages.map(l => `${l}:${(state.byLanguage[l.toLowerCase()] || []).length}`).join(', ');
                        log('info', `[WyzieProvider] Multi-lang fast-first: timeout with partial results (${langCounts}) in ${Date.now() - startTime}ms`);
                        resolve(state.allSubtitles);
                        return;
                    }
                }
            };
            checkInterval = setInterval(() => {
                checkThreshold();
                const elapsed = Date.now() - startTime;
                if (state.resolved || state.sourcesCompleted >= state.totalSources || elapsed > MAX_INTERVAL_TIMEOUT) {
                    if (checkInterval) { clearInterval(checkInterval); checkInterval = null; }
                    if (elapsed > MAX_INTERVAL_TIMEOUT && !state.resolved) {
                        log('warn', `[WyzieProvider] Multi-lang: interval timeout after ${elapsed}ms, forcing cleanup`);
                        state.resolved = true;
                        resolve(state.allSubtitles);
                    }
                }
            }, 50);
            state.checkThreshold = checkThreshold;
            state._checkInterval = () => { if (checkInterval) { clearInterval(checkInterval); checkInterval = null; } };
        });

        const allDonePromise = Promise.allSettled(allLanguagePromises).then(() => {
            if (state._checkInterval) state._checkInterval();
            if (!state.resolved) {
                state.resolved = true;
                const langCounts = languages.map(l => `${l}:${(state.byLanguage[l.toLowerCase()] || []).length}`).join(', ');
                log('info', `[WyzieProvider] Multi-lang complete: ${state.allSubtitles.length} total subs in ${Date.now() - startTime}ms (${langCounts})`);
            }
            return state.allSubtitles;
        });

        const backgroundPromise = Promise.allSettled(backgroundSourcePromises).then(() => {
            const languagesList = [...backgroundState.languagesFound].sort().join(', ');
            log('info', `[WyzieProvider] Background complete: ${backgroundState.allSubtitles.length} total subs (languages: ${languagesList || 'none'})`);
            this._backgroundCache.set(cacheKey, {
                subtitles: backgroundState.allSubtitles,
                languages: [...backgroundState.languagesFound],
                timestamp: Date.now()
            });
            return backgroundState.allSubtitles;
        });

        const raceResult = await Promise.race([fastResultPromise, allDonePromise]);
        return { subtitles: raceResult, fromCache: false, backgroundPromise };
    }

    _handleMultiLanguageResult(state, subtitles, language) {
        state.sourcesCompleted++;
        for (const sub of subtitles) {
            if (state.seenUrls.has(sub.url)) continue;
            state.seenUrls.add(sub.url);
            state.allSubtitles.push(sub);
            const subLang = (sub.language || '').toLowerCase();
            if (state.byLanguage[subLang]) state.byLanguage[subLang].push(sub);
        }
        if (state.checkThreshold) state.checkThreshold();
    }

    _filterByLanguages(subtitles, languages) {
        const langSet = new Set(languages.map(l => l.toLowerCase()));
        const selected = [];
        const others = [];
        for (const sub of subtitles) {
            const subLang = (sub.language || '').toLowerCase();
            if (langSet.has(subLang)) selected.push(sub);
            else others.push(sub);
        }
        return [...selected, ...others];
    }

    async _searchSource(query, source, language = null) {
        const params = { imdb_id: query.imdbId, source: source };
        if (query.season !== null && query.season !== undefined &&
            query.episode !== null && query.episode !== undefined) {
            params.season = query.season;
            params.episode = query.episode;
        }
        if (language) params.language = language;

        try {
            const results = await searchSubtitles(params);
            const subtitles = Array.isArray(results) ? results : [];
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
            if (errorMsg.includes('400')) log('debug', `[WyzieProvider] Source ${source}${language ? ` (${language})` : ''}: No subtitles found`);
            else if (errorMsg.includes('404')) log('debug', `[WyzieProvider] Source ${source}${language ? ` (${language})` : ''}: Content not found`);
            else if (errorMsg.includes('429')) log('warn', `[WyzieProvider] Source ${source}: Rate limited`);
            else if (errorMsg.includes('5') && (errorMsg.includes('500') || errorMsg.includes('502') || errorMsg.includes('503'))) log('debug', `[WyzieProvider] Source ${source}: Server error`);
            else log('debug', `[WyzieProvider] Source ${source} error: ${error.message}`);
            return [];
        }
    }

    _buildParams(query) {
        const params = { imdb_id: query.imdbId, source: this.sources };
        if (query.season !== null && query.season !== undefined &&
            query.episode !== null && query.episode !== undefined) {
            params.season = query.season;
            params.episode = query.episode;
        }
        if (query.language) params.language = query.language;
        return params;
    }

    _normalizeResult(sub) {
        let source = 'unknown';
        if (sub.source) source = Array.isArray(sub.source) ? sub.source[0] : sub.source;

        const langCode = sub.lang || sub.language || 'und';
        const language = langCode.substring(0, 2).toLowerCase();
        const formatInfo = this._detectFormatFromUrl(sub.url);
        const rawFileName = sub.fileName || null;
        const fileName = this._isUsefulFileName(rawFileName) ? rawFileName : null;

        return new SubtitleResult({
            id: sub.id || `wyzie-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            url: sub.url, language, languageCode: null, source, provider: this.name,
            releaseName: sub.releaseName || sub.release || sub.media || '',
            fileName, releases: Array.isArray(sub.releases) ? sub.releases.filter(r => r && r.length > 0) : [],
            hearingImpaired: sub.hearingImpaired || sub.isHearingImpaired || sub.hi || false,
            rating: sub.rating || null, downloadCount: sub.downloadCount ?? null,
            display: sub.display || '', format: formatInfo.format, needsConversion: formatInfo.needsConversion
        });
    }

    _isUsefulFileName(fileName) {
        if (!fileName || typeof fileName !== 'string') return false;
        if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(fileName)) return false;
        if (fileName.length < 10) return false;
        return /[\.\-_]/.test(fileName) && (
            /\.(srt|ass|ssa|sub|vtt)$/i.test(fileName) || /s\d{1,2}e\d{1,2}/i.test(fileName) ||
            /\d{3,4}p/i.test(fileName) || /x26[45]|hevc|avc/i.test(fileName)
        );
    }

    _detectFormatFromUrl(url) {
        if (!url) return { format: null, needsConversion: null };
        const formatMatch = url.match(/[?&]format=([^&]+)/i);
        const formatParam = formatMatch ? formatMatch[1].toLowerCase() : null;
        const extMatch = url.match(/\.([a-z0-9]+)(?:\?|$)/i);
        const extension = extMatch ? extMatch[1].toLowerCase() : null;
        if (formatParam === 'srt' || extension === 'srt') return { format: 'srt', needsConversion: false };
        if (['ass', 'ssa'].includes(formatParam) || ['ass', 'ssa'].includes(extension)) return { format: 'ass', needsConversion: true };
        if (formatParam && !['srt', 'ass', 'ssa', 'vtt', 'sub'].includes(formatParam)) return { format: 'unknown', needsConversion: null };
        if (formatParam === 'vtt' || extension === 'vtt') return { format: 'vtt', needsConversion: false };
        if (formatParam === 'sub' || extension === 'sub') return { format: 'sub', needsConversion: false };
        return { format: null, needsConversion: null };
    }

    _getCacheKey(query) {
        return `${query.imdbId}:${query.season || 0}:${query.episode || 0}`;
    }

    clearCache() {
        this._backgroundCache.clear();
        log('debug', `[WyzieProvider] Cache cleared`);
    }

    getCacheStats() {
        return { size: this._backgroundCache.size, entries: Array.from(this._backgroundCache.keys()) };
    }
}

WyzieProvider.initWyzieSources = initWyzieSources;
WyzieProvider.getActiveSources = getActiveSources;
WyzieProvider.getActiveSourcesMetadata = getActiveSourcesMetadata;
WyzieProvider.getSourceDisplayName = getSourceDisplayName;
WyzieProvider.SOURCE_METADATA = SOURCE_METADATA;
WyzieProvider.FALLBACK_SOURCES = FALLBACK_SOURCES;

module.exports = WyzieProvider;

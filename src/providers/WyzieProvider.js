'use strict';

const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { log } = require('../utils');

// =====================================================
// Wyzie Key Pool
// =====================================================

const WYZIE_USAGE_ENDPOINT = 'https://store.wyzie.io/api/usage-limit';
const WYZIE_SOURCES_ENDPOINT = 'https://sub.wyzie.io/sources';

class WyzieKeyPool {
    constructor(keys = []) {
        this.keys = keys.filter(k => k && k.length > 10);
        this.state = new Map();
    }

    static fromEnv() {
        const multi = process.env.WYZIE_API_KEYS;
        const single = process.env.WYZIE_API_KEY;
        let raw = '';
        if (multi) raw = multi;
        else if (single) raw = single;
        const keys = raw.split(',').map(k => k.trim()).filter(Boolean);
        return new WyzieKeyPool(keys);
    }

    get size() {
        return this.keys.length;
    }

    getNextKey() {
        if (this.keys.length === 0) return null;
        const now = Date.now();
        let best = null;
        let bestRemaining = -1;

        for (const key of this.keys) {
            const s = this.state.get(key);
            if (!s) return key;
            if (s.resetAt && now >= s.resetAt) {
                s.remaining = s.limit || 1000;
                s.resetAt = this._nextMidnightUTC();
            }
            if (s.remaining <= 0) continue;
            if (s.remaining > bestRemaining) {
                bestRemaining = s.remaining;
                best = key;
            }
        }
        return best;
    }

    isExhausted(key) {
        const s = this.state.get(key);
        if (!s) return false;
        if (s.resetAt && Date.now() >= s.resetAt) {
            s.remaining = s.limit || 1000;
            s.resetAt = this._nextMidnightUTC();
            return false;
        }
        return s.remaining <= 0;
    }

    markExhausted(key) {
        const s = this.state.get(key) || { limit: 1000, resetAt: this._nextMidnightUTC() };
        s.remaining = 0;
        this.state.set(key, s);
    }

    updateFromHeaders(key, headers) {
        const remaining = parseInt(headers.get('x-ratelimit-remaining'));
        const limit = parseInt(headers.get('x-ratelimit-limit'));
        const reset = parseInt(headers.get('x-ratelimit-reset'));
        if (isNaN(remaining) || isNaN(limit)) return;

        const s = this.state.get(key) || {};
        s.remaining = remaining;
        s.limit = limit;
        s.resetAt = !isNaN(reset) ? reset * 1000 : this._nextMidnightUTC();
        s.lastChecked = Date.now();
        this.state.set(key, s);

        if (remaining <= 5) {
            log('warn', `[WyzieKeyPool] Key ${key.slice(0, 12)}... nearly exhausted: ${remaining}/${limit} remaining`);
        }
    }

    getKeyType(key) {
        const s = this.state.get(key);
        return s?.keyType || null;
    }

    async detectKeyType(key) {
        try {
            const res = await fetch(`${WYZIE_USAGE_ENDPOINT}?api_key=${encodeURIComponent(key)}`, {
                signal: AbortSignal.timeout(5000)
            });
            if (!res.ok) return 'unknown';
            const data = await res.json();
            const s = this.state.get(key) || {};
            s.keyType = data.key_type || 'unknown';
            s.remaining = data.remainingRequests ?? s.remaining;
            s.limit = data.daily_limit ?? 1000;
            s.resetAt = s.resetAt || this._nextMidnightUTC();
            s.lastChecked = Date.now();
            this.state.set(key, s);
            log('info', `[WyzieKeyPool] Key ${key.slice(0, 12)}...: type=${s.keyType}, remaining=${s.remaining}/${s.limit}`);
            return s.keyType;
        } catch (err) {
            log('debug', `[WyzieKeyPool] Failed to detect key type: ${err.message}`);
            return 'unknown';
        }
    }

    async fetchSources(key) {
        try {
            const res = await fetch(`${WYZIE_SOURCES_ENDPOINT}?key=${encodeURIComponent(key)}`, {
                signal: AbortSignal.timeout(5000)
            });
            if (!res.ok) return null;
            const data = await res.json();
            const raw = Array.isArray(data) ? data : data?.sources;
            const sources = Array.isArray(raw)
                ? raw.map(s => (typeof s === 'string' ? s : s.name || s.id)).filter(Boolean)
                : null;
            if (sources && sources.length > 0) {
                const s = this.state.get(key) || {};
                s.sources = sources;
                this.state.set(key, s);
                log('info', `[WyzieKeyPool] Key ${key.slice(0, 12)}...: ${sources.length} sources available`);
            }
            return sources;
        } catch (err) {
            log('debug', `[WyzieKeyPool] Failed to fetch sources for key: ${err.message}`);
            return null;
        }
    }

    getSources(key) {
        const s = this.state.get(key);
        return s?.sources || null;
    }

    async initialize() {
        if (this.keys.length === 0) {
            log('warn', '[WyzieKeyPool] No API keys configured');
            return;
        }
        log('info', `[WyzieKeyPool] Initializing ${this.keys.length} key(s)...`);
        await Promise.all(this.keys.map(async (key) => {
            await this.detectKeyType(key);
            await this.fetchSources(key);
        }));
    }

    getStatus() {
        return this.keys.map(key => {
            const s = this.state.get(key) || {};
            return {
                key: key.slice(0, 12) + '...',
                type: s.keyType || 'unknown',
                remaining: s.remaining ?? '?',
                limit: s.limit ?? '?'
            };
        });
    }

    _nextMidnightUTC() {
        const now = new Date();
        const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
        return midnight.getTime();
    }
}

// =====================================================
// Wyzie Sources & Config
// =====================================================

const WYZIE_SEARCH_URL = 'https://sub.wyzie.io/search';
const WYZIE_SOURCES_URL = 'https://sub.wyzie.io/sources';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;
const POOL_TTL_MS = (parseInt(process.env.L2_TTL_DAYS, 10) || 7) * 24 * 60 * 60 * 1000;
const POOL_MAX_ENTRIES = parseInt(process.env.WYZIE_POOL_MAX, 10) || 5000;

const SOURCE_METADATA = {
    'opensubtitles': { display: 'OpenSubtitles', icon: 'opensubtitles.ico', url: 'https://www.opensubtitles.com' },
    'subf2m':        { display: 'Subf2m',        icon: 'subf2m.png',        url: 'https://subf2m.co' },
    'animetosho':    { display: 'AnimeTosho',    icon: 'animetosho.ico',    url: 'https://animetosho.org' },
    'gestdown':      { display: 'Gestdown',      icon: 'gestdown.png',      url: 'https://gestdown.info' },
    'jimaku':        { display: 'Jimaku',         icon: 'jimaku.png',        url: 'https://jimaku.cc' },
    'kitsunekko':    { display: 'Kitsunekko',    icon: 'kitsunekko.png',    url: 'https://kitsunekko.net' },
    'yify':          { display: 'YIFY',           icon: 'yify.ico',          url: 'https://yts-subs.com' },
    'ajatttools':    { display: 'AjattTools',     icon: null,                url: null },
    'tvsubtitles':   { display: 'TVsubtitles',    icon: 'tvsubtitles.png',   url: 'https://www.tvsubtitles.net' }
};

const FREE_SOURCES = 'opensubtitles,tvsubtitles';

const FALLBACK_SOURCES = [
    'subf2m', 'opensubtitles', 'animetosho',
    'jimaku', 'kitsunekko', 'gestdown', 'yify',
    'ajatttools', 'tvsubtitles'
];

let _cachedSources = null;
let _refreshTimer = null;

function getSourcesForKeyType(keyType) {
    switch (keyType) {
        case 'pro':
        case 'dev':
            return getActiveSources().join(',');
        default:
            return FREE_SOURCES;
    }
}

async function fetchWyzieSources() {
    try {
        let url = WYZIE_SOURCES_URL;
        const apiKey = process.env.WYZIE_API_KEY || process.env.WYZIE_API_KEYS?.split(',')[0];
        if (apiKey) url += `?key=${encodeURIComponent(apiKey.trim())}`;
        const response = await fetch(url, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { 'Accept': 'application/json' }
        });
        if (!response.ok) {
            log('warn', `[WyzieSources] API returned ${response.status}`);
            return null;
        }
        const data = await response.json();
        if (!data || !Array.isArray(data.sources) || data.sources.length === 0) return null;
        return data.sources.filter(s => typeof s === 'string' && s.length > 0).map(s => s.toLowerCase());
    } catch (error) {
        log('warn', `[WyzieSources] Failed to fetch: ${error.message}`);
        return null;
    }
}

function getActiveSources() {
    const envSources = process.env.WYZIE_SOURCES;
    if (envSources) {
        const sources = envSources.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
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
    log('info', '[WyzieSources] Initializing...');
    const sources = await fetchWyzieSources();
    if (sources) {
        _cachedSources = sources;
        log('info', `[WyzieSources] Loaded ${sources.length} sources: ${sources.join(', ')}`);
    } else {
        _cachedSources = [...FALLBACK_SOURCES];
        log('warn', `[WyzieSources] Using ${FALLBACK_SOURCES.length} fallback sources`);
    }
    if (_refreshTimer) clearInterval(_refreshTimer);
    _refreshTimer = setInterval(async () => {
        const refreshed = await fetchWyzieSources();
        if (refreshed) {
            const changed = JSON.stringify(refreshed) !== JSON.stringify(_cachedSources);
            _cachedSources = refreshed;
            if (changed) log('info', `[WyzieSources] Updated: ${refreshed.join(', ')}`);
        }
    }, REFRESH_INTERVAL_MS);
    return getActiveSources();
}

// =====================================================
// WyzieProvider
// =====================================================

class WyzieProvider extends BaseProvider {
    constructor(options = {}) {
        super('wyzie', options);
        this.keyPool = WyzieKeyPool.fromEnv();
        // In-memory pool: content key → { subtitles: SubtitleResult[], timestamp }
        this._pool = new Map();
        this._keyTypeCache = new Map(); // apiKey → keyType string
    }

    async initialize() {
        await this.keyPool.initialize();
        const status = this.keyPool.getStatus();
        if (status.length > 0) {
            log('info', `[WyzieProvider] Key pool: ${status.map(s => `${s.key}(${s.type},${s.remaining}/${s.limit})`).join(', ')}`);
        } else {
            log('warn', '[WyzieProvider] No server API keys configured');
        }
    }

    async validateApiKey(apiKey) {
        if (!apiKey || apiKey.length < 10) {
            return { valid: false, error: 'Invalid key format' };
        }
        const attempts = 2;
        for (let i = 0; i < attempts; i++) {
            try {
                const res = await fetch(`${WYZIE_USAGE_ENDPOINT}?api_key=${encodeURIComponent(apiKey)}`, {
                    signal: AbortSignal.timeout(10000)
                });
                if (!res.ok) return { valid: false, error: 'Key not recognized' };
                const data = await res.json();
                return {
                    valid: true,
                    keyType: data.key_type || 'unknown',
                    remaining: data.remainingRequests,
                    limit: data.daily_limit
                };
            } catch (err) {
                if (i < attempts - 1) continue;
                return { valid: false, error: 'Validation timed out - try again' };
            }
        }
    }

    getSources() {
        return getActiveSources().map(s => getSourceDisplayName(s));
    }

    async search(query) {
        if (!this.enabled) return { subtitles: [] };

        const languages = Array.isArray(query.languages) ? query.languages : [];
        const startedAt = Date.now();

        try {
            // Check pool cache first
            const poolKey = this._poolKey(query);
            const poolHit = this._poolGet(poolKey);
            if (poolHit) {
                const filtered = languages.length > 0
                    ? this._filterByLanguages(poolHit, languages)
                    : poolHit;
                this._recordRequest(true, Date.now() - startedAt, filtered.length);
                log('debug', `[WyzieProvider] Pool hit: ${poolHit.length} total, ${filtered.length} after filter`);
                return { subtitles: filtered };
            }

            // Select API key
            const keySelection = this._selectKey(query);
            if (!keySelection) {
                log('warn', '[WyzieProvider] No API key available');
                this._recordRequest(false, Date.now() - startedAt, 0, new Error('NO_KEY'));
                return { subtitles: [] };
            }

            const { key: apiKey, isUserKey } = keySelection;
            let result;

            if (isUserKey) {
                result = await this._searchWithUserKey(query, apiKey, languages);
            } else {
                result = await this._searchWithServerKey(query, apiKey, languages);
            }

            this._recordRequest(true, Date.now() - startedAt, result.subtitles.length);
            return {
                subtitles: result.subtitles,
                backgroundPromise: result.backgroundPromise || null
            };
        } catch (err) {
            this._recordRequest(false, Date.now() - startedAt, 0, err);
            log('error', `[WyzieProvider] Search failed: ${err.message}`);
            return { subtitles: [] };
        }
    }

    // User has their own key: 2 calls (foreground filtered + background all-lang)
    async _searchWithUserKey(query, apiKey, languages) {
        const sources = await this._getSourcesForKey(apiKey);
        const baseParams = this._buildUrlParams(query, sources, apiKey);

        // Foreground: filtered by languages for fast response
        const fgParams = languages.length > 0
            ? `${baseParams}&language=${languages.join(',')}`
            : baseParams;

        const fgResponse = await this._apiFetch(fgParams, 7500);
        const fgResults = await fgResponse.json();
        this._updateKeyFromHeaders(apiKey, fgResponse.headers);

        const subtitles = this._processResults(fgResults);

        // Background: all-lang (no language filter) to populate pool
        const backgroundPromise = this._apiFetch(baseParams, 20000)
            .then(async (bgRes) => {
                this._updateKeyFromHeaders(apiKey, bgRes.headers);
                const bgResults = await bgRes.json();
                const allSubs = this._processResults(bgResults);
                this._poolSet(this._poolKey(query), allSubs);
                log('info', `[WyzieProvider] Background pool set: ${allSubs.length} subs for ${query.imdbId}`);
                return { subtitles: allSubs };
            })
            .catch(err => {
                log('debug', `[WyzieProvider] Background fetch failed: ${err.message}`);
                return { subtitles: [] };
            });

        return { subtitles, backgroundPromise };
    }

    // Server key - 1 call (all-lang), store in pool, filter for user
    async _searchWithServerKey(query, apiKey, languages) {
        const sources = await this._getSourcesForKey(apiKey);
        const params = this._buildUrlParams(query, sources, apiKey);

        const response = await this._apiFetch(params, 7500);

        if (response.status === 429) {
            this.keyPool.markExhausted(apiKey);
            // Try next key
            const nextKey = this.keyPool.getNextKey();
            if (nextKey && nextKey !== apiKey) {
                return this._searchWithServerKey(query, nextKey, languages);
            }
            throw new Error('RATE_LIMITED');
        }

        if (!response.ok) throw new Error(`API_${response.status}`);

        this._updateKeyFromHeaders(apiKey, response.headers);
        const results = await response.json();
        const allSubs = this._processResults(results);

        this._poolSet(this._poolKey(query), allSubs);

        const filtered = languages.length > 0
            ? this._filterByLanguages(allSubs, languages)
            : allSubs;

        log('info', `[WyzieProvider] Server key: ${allSubs.length} total, ${filtered.length} filtered for [${languages.join(',')}]`);
        return { subtitles: filtered, backgroundPromise: null };
    }

    // =====================================================
    // API & Key Helpers
    // =====================================================

    _selectKey(query) {
        const userKey = query.apiKeys?.wyzie;
        if (userKey && userKey.length > 10) {
            return { key: userKey, isUserKey: true };
        }
        const serverKey = this.keyPool.getNextKey();
        if (serverKey) return { key: serverKey, isUserKey: false };
        return null;
    }

    _buildUrlParams(query, sources, apiKey) {
        let params = `id=${query.imdbId}&source=${sources}&key=${apiKey}`;
        if (query.season != null && query.episode != null) {
            params += `&season=${query.season}&episode=${query.episode}`;
        }
        return params;
    }

    async _apiFetch(params, timeoutMs) {
        const url = `${WYZIE_SEARCH_URL}?${params}`;
        const response = await fetch(url, {
            signal: AbortSignal.timeout(timeoutMs),
            headers: { 'Accept': 'application/json' }
        });
        if (!response.ok && response.status !== 429) {
            throw new Error(`API_${response.status}`);
        }
        return response;
    }

    _updateKeyFromHeaders(apiKey, headers) {
        if (!headers) return;
        this.keyPool.updateFromHeaders(apiKey, headers);
    }

    async _getSourcesForKey(apiKey) {
        let keyType = this._keyTypeCache.get(apiKey);
        if (!keyType) {
            keyType = this.keyPool.getKeyType(apiKey);
            if (!keyType) {
                keyType = await this.keyPool.detectKeyType(apiKey);
            }
            this._keyTypeCache.set(apiKey, keyType);
        }
        // Free keys: restricted to 2 providers (server-side enforced by Wyzie)
        if (keyType === 'free' || keyType === 'free-verified') {
            return FREE_SOURCES;
        }
        // Pro/Dev: use dynamic sources list from API (all available sources)
        const dynamicSources = this.keyPool.getSources(apiKey);
        if (dynamicSources && dynamicSources.length > 0) {
            return dynamicSources.join(',');
        }
        // Fallback: fetch on-demand
        const fetched = await this.keyPool.fetchSources(apiKey);
        if (fetched && fetched.length > 0) {
            return fetched.join(',');
        }
        return getActiveSources().join(',');
    }

    // =====================================================
    // Pool Cache (in-memory, content-keyed, all-language)
    // =====================================================

    _poolKey(query) {
        return `${query.imdbId}:${query.season || 0}:${query.episode || 0}`;
    }

    _poolGet(key) {
        const entry = this._pool.get(key);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > POOL_TTL_MS) {
            this._pool.delete(key);
            return null;
        }
        return entry.subtitles;
    }

    _poolSet(key, subtitles) {
        if (this._pool.size >= POOL_MAX_ENTRIES) {
            const oldest = this._pool.keys().next().value;
            this._pool.delete(oldest);
        }
        this._pool.set(key, { subtitles, timestamp: Date.now() });
    }

    // =====================================================
    // Result Processing
    // =====================================================

    _processResults(results) {
        if (!Array.isArray(results)) return [];
        return results
            .filter(sub => {
                if (!sub.url) return true;
                const m = sub.url.match(/[?&]format=([^&]+)/i);
                if (m && ['pgs', 'sup', 'idx', 'vobsub', 'sub/idx'].includes(m[1].toLowerCase())) return false;
                return true;
            })
            .map(sub => this._normalizeResult(sub));
    }

    _filterByLanguages(subtitles, languages) {
        if (!languages || languages.length === 0) return subtitles;
        const langSet = new Set(languages.map(l => l.toLowerCase()));
        const matched = [];
        const rest = [];
        for (const sub of subtitles) {
            if (langSet.has((sub.language || '').toLowerCase())) matched.push(sub);
            else rest.push(sub);
        }
        return [...matched, ...rest];
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

    // =====================================================
    // Utilities
    // =====================================================

    clearCache() {
        this._pool.clear();
        log('debug', '[WyzieProvider] Pool cache cleared');
    }

    getCacheStats() {
        return {
            poolSize: this._pool.size,
            poolMaxEntries: POOL_MAX_ENTRIES,
            poolTtlMs: POOL_TTL_MS,
            keyPool: this.keyPool.getStatus()
        };
    }
}

WyzieProvider.initWyzieSources = initWyzieSources;
WyzieProvider.getActiveSources = getActiveSources;
WyzieProvider.getActiveSourcesMetadata = getActiveSourcesMetadata;
WyzieProvider.getSourceDisplayName = getSourceDisplayName;
WyzieProvider.SOURCE_METADATA = SOURCE_METADATA;
WyzieProvider.FALLBACK_SOURCES = FALLBACK_SOURCES;

module.exports = WyzieProvider;

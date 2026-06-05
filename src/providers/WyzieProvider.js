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
            if (s.remaining == null) return key;
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
                const keyType = s.keyType || 'unknown';
                const isFree = keyType === 'free' || keyType === 'free-verified' || keyType === 'dev';
                const freeSrcs = Array.isArray(data?.free) ? data.free : _cachedFreeSources || [];
                const usable = isFree && freeSrcs.length > 0
                    ? sources.filter(src => freeSrcs.includes(src))
                    : sources;
                log('info', `[WyzieKeyPool] Key ${key.slice(0, 12)}...: ${usable.length} usable sources (${usable.join(', ')})`);
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
    'subdl':         { display: 'SubDL',          icon: null,                url: 'https://subdl.com' },
    'animetosho':    { display: 'AnimeTosho',    icon: 'animetosho.ico',    url: 'https://animetosho.org' },
    'gestdown':      { display: 'Gestdown',      icon: 'gestdown.png',      url: 'https://gestdown.info' },
    'jimaku':        { display: 'Jimaku',         icon: 'jimaku.png',        url: 'https://jimaku.cc' },
    'kitsunekko':    { display: 'Kitsunekko',    icon: 'kitsunekko.png',    url: 'https://kitsunekko.net' },
    'yify':          { display: 'YIFY',           icon: 'yify.ico',          url: 'https://yts-subs.com' },
    'addic7ed':      { display: 'Addic7ed',       icon: null,                url: 'https://www.addic7ed.com' },
    'podnapisi':     { display: 'Podnapisi',      icon: null,                url: 'https://www.podnapisi.net' },
    'ajatttools':    { display: 'AjattTools',     icon: null,                url: null },
    'tvsubtitles':   { display: 'TVsubtitles',    icon: 'tvsubtitles.png',   url: 'https://www.tvsubtitles.net' },
    'indexsubtitle': { display: 'IndexSubtitle',  icon: null,                url: 'https://indexsubtitle.cc' },
    'ai':            { display: 'AI',             icon: null,                url: null }
};

// Codename → real source name mapping (Wyzie API returns NATO codenames in search results)
// Inferred from /api/status capabilities + /sources tiers:
//   charlie (free, movies+TV) = opensubtitles
//   lima (free, movies+TV) = indexsubtitle (indexsubtitle.cc)
//   kilo (free, TV only) = tvsubtitles
//   india (paid, movies only) = yify
//   hotel (paid, TV only) = gestdown
//   bravo (paid, movies+TV) = subf2m
//   golf (paid, movies+TV) = kitsunekko
const SOURCE_CODENAME_MAP = {
    'charlie': 'opensubtitles',
    'lima':    'indexsubtitle',
    'kilo':    'tvsubtitles',
    'india':   'yify',
    'hotel':   'gestdown',
    'bravo':   'subf2m',
    'golf':    'kitsunekko',
    'ai':      'ai'
};

const FALLBACK_FREE_SOURCES = 'opensubtitles,indexsubtitle';

const FALLBACK_SOURCES = [
    'subf2m', 'opensubtitles', 'kitsunekko',
    'gestdown', 'yify', 'tvsubtitles'
];

let _cachedSources = null;
let _cachedFreeSources = null;   // string[] from API "free" field
let _cachedPaidSources = null;   // string[] from API "paid" field
let _cachedTiered = null;        // [{key, name, tier}] from API "tiered" field
let _refreshTimer = null;

function getSourcesForKeyType(keyType) {
    switch (keyType) {
        case 'pro':
        case 'dev':
            return getActiveSources().join(',');
        default:
            return getFreeSources();
    }
}

/**
 * Returns comma-separated free sources string (from API or fallback)
 */
function getFreeSources() {
    if (_cachedFreeSources && _cachedFreeSources.length > 0) {
        return _cachedFreeSources.join(',');
    }
    return FALLBACK_FREE_SOURCES;
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

        const sources = data.sources.filter(s => typeof s === 'string' && s.length > 0).map(s => s.toLowerCase());

        // Store free/paid tier info from API
        if (Array.isArray(data.free) && data.free.length > 0) {
            _cachedFreeSources = data.free.map(s => s.toLowerCase());
        }
        if (Array.isArray(data.paid) && data.paid.length > 0) {
            _cachedPaidSources = data.paid.map(s => s.toLowerCase());
        }
        if (Array.isArray(data.tiered) && data.tiered.length > 0) {
            _cachedTiered = data.tiered;
        }

        return sources;
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
    const key = source.toLowerCase();
    const resolved = SOURCE_CODENAME_MAP[key];
    const lookupKey = resolved || key;
    const meta = SOURCE_METADATA[lookupKey];
    return meta ? meta.display : lookupKey.charAt(0).toUpperCase() + lookupKey.slice(1);
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
        if (_cachedFreeSources) log('info', `[WyzieSources] Free: ${_cachedFreeSources.join(', ')}`);
        if (_cachedPaidSources) log('info', `[WyzieSources] Paid: ${_cachedPaidSources.join(', ')}`);
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

const wyzieDump = require('./wyzie-dump');

class WyzieProvider extends BaseProvider {
    constructor(options = {}) {
        super('wyzie', options);
        this.keyPool = WyzieKeyPool.fromEnv();
        this._pool = new Map();
        this._keyTypeCache = new Map();
        this._inflight = new Map();
    }

    async initialize() {
        await this.keyPool.initialize();
        await wyzieDump.initDumpDb().catch(() => {});
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

            const dumpPromise = wyzieDump.isAvailable()
                ? wyzieDump.lookupDump(query.imdbId, query.season, query.episode, languages)
                    .catch(() => [])
                : Promise.resolve([]);

            // Select API key
            const keySelection = this._selectKey(query);
            let apiResult = { subtitles: [], backgroundPromise: null };

            if (keySelection) {
                const { key: apiKey, isUserKey } = keySelection;
                try {
                    if (isUserKey) {
                        apiResult = await this._searchWithUserKey(query, apiKey, languages);
                    } else {
                        apiResult = await this._searchWithServerKey(query, apiKey, languages);
                    }
                } catch (apiErr) {
                    if (!keySelection.isUserKey && (apiErr.message === 'KEY_INVALID_403' || apiErr.message === 'RATE_LIMITED')) {
                        const nextKey = this.keyPool.getNextKey();
                        if (nextKey && nextKey !== keySelection.key) {
                            try {
                                apiResult = await this._searchWithServerKey(query, nextKey, languages);
                            } catch (retryErr) {
                                log('warn', `[WyzieProvider] Retry key also failed: ${retryErr.message}`);
                            }
                        }
                    }
                    if (apiResult.subtitles.length === 0) {
                        log('warn', `[WyzieProvider] API failed (dump fallback): ${apiErr.message}`);
                    }
                }
            } else {
                log('warn', '[WyzieProvider] No API key available');
            }

            const dumpSubs = await dumpPromise;
            let merged = apiResult.subtitles;

            if (dumpSubs.length > 0) {
                const existingIds = new Set(merged.map(s => s.id));
                const dumpResults = dumpSubs
                    .filter(s => !existingIds.has(s.id))
                    .map(s => this._normalizeResult(s));
                merged = [...merged, ...dumpResults];
                log('info', `[WyzieProvider] Dump: +${dumpResults.length} subs merged (${dumpSubs.length} found, ${dumpSubs.length - dumpResults.length} dupes)`);

                wyzieDump.validateUrls(dumpSubs).catch(() => {});
            }

            this._recordRequest(true, Date.now() - startedAt, merged.length);
            return {
                subtitles: merged,
                backgroundPromise: apiResult.backgroundPromise || null
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
        const poolKey = this._poolKey(query);

        const fetchPromise = this._apiFetch(params, 25000)
            .then(async (response) => {
                if (response.status === 403) {
                    this.keyPool.markExhausted(apiKey);
                    throw new Error('KEY_INVALID_403');
                }
                if (response.status === 429) {
                    this.keyPool.markExhausted(apiKey);
                    throw new Error('RATE_LIMITED');
                }
                this._updateKeyFromHeaders(apiKey, response.headers);
                const results = await response.json();
                return this._processResults(results);
            });

        const DISPLAY_DEADLINE_MS = 7500;
        const deadline = new Promise(resolve =>
            setTimeout(() => resolve(null), DISPLAY_DEADLINE_MS)
        );

        const raceResult = await Promise.race([fetchPromise, deadline]);

        if (raceResult !== null) {
            const allSubs = raceResult;
            this._poolSet(poolKey, allSubs);
            this._inflight.delete(poolKey);

            const filtered = languages.length > 0
                ? this._filterByLanguages(allSubs, languages)
                : allSubs;

            log('info', `[WyzieProvider] Server key: ${allSubs.length} total, ${filtered.length} filtered for [${languages.join(',')}]`);
            return { subtitles: filtered, backgroundPromise: null };
        }

        if (!this._inflight.has(poolKey)) {
            const bgPromise = fetchPromise
                .then(allSubs => {
                    this._poolSet(poolKey, allSubs);
                    log('info', `[WyzieProvider] Background fetch done: ${allSubs.length} subs cached for ${query.imdbId}`);
                })
                .catch(err => {
                    log('debug', `[WyzieProvider] Background fetch failed: ${err.message}`);
                })
                .finally(() => {
                    this._inflight.delete(poolKey);
                });
            this._inflight.set(poolKey, bgPromise);
        }

        log('info', `[WyzieProvider] Display deadline hit (${DISPLAY_DEADLINE_MS}ms), deferring to dump`);
        throw new Error('DISPLAY_TIMEOUT');
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
        if (!response.ok && response.status !== 429 && response.status !== 403) {
            if (response.status === 400) {
                const body = await response.json().catch(() => ({}));
                log('info', `[WyzieProvider] HTTP ${response.status} - ${body.message || 'No subtitles found'} - ${body.details || ''}`);
                return { ok: false, status: 400, headers: response.headers, json: async () => [] };
            }
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
        // Free/dev keys: restricted to free-tier providers (dynamic from API)
        if (keyType === 'free' || keyType === 'free-verified' || keyType === 'dev') {
            return getFreeSources();
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
        const resolved = SOURCE_CODENAME_MAP[source.toLowerCase()];
        if (resolved) {
            source = resolved;
        } else if (source !== 'unknown' && !SOURCE_METADATA[source.toLowerCase()]) {
            // Unknown codename — not in our map and not a known source name
            log('warn', `[WyzieProvider] Unknown source codename: "${source}" — add to SOURCE_CODENAME_MAP`);
        }

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
        this._inflight.clear();
        log('debug', '[WyzieProvider] Pool cache cleared');
    }

    getCacheStats() {
        return {
            poolSize: this._pool.size,
            inflightSize: this._inflight.size,
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

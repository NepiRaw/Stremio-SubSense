'use strict';

const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { log } = require('../utils');
const { getByName, toGestdownName } = require('../languages');

const GESTDOWN_BASE = 'https://api.gestdown.info';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TVDB_BASE = 'https://api4.thetvdb.com/v4';
const TIMEOUT = 12000;

/**
 * GestdownProvider - TV-only subtitle provider using the Gestdown REST API.
 * Requires either TVDB_API_KEY (direct) or TMDB_API_KEY for IMDB → TVDB ID resolution.
 * Gestdown only provides SRT format subtitles.
 * 
 * Flow:
 *   1. Resolve IMDB ID → TVDB ID (via TVDB /search/remoteid or TMDB fallback)
 *   2. Look up show on Gestdown by TVDB ID
 *   3. Fetch subtitles for specific season/episode/language
 */
class GestdownProvider extends BaseProvider {
    constructor(options = {}) {
        super('gestdown', options);
        this.supportedTypes = ['series'];
        this.tvdbApiKey = options.tvdbApiKey || process.env.TVDB_API_KEY;
        this.tmdbApiKey = options.tmdbApiKey || process.env.TMDB_API_KEY;
        this.baseUrl = options.baseUrl || process.env.SUBSENSE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3100}`;

        this._tvdbToken = null;
        this._tvdbTokenExpiry = null;
        this._tvdbCache = new Map(); // imdbId → tvdbId
        this._showCache = new Map(); // tvdbId → { id, name }
        this._negativeTvdb = new Set(); // imdbIds that failed resolution
    }

    getSources() {
        return ['gestdown'];
    }

    async search(query) {
        if (!this.enabled) return { subtitles: [] };

        if (query.season == null || query.episode == null) return { subtitles: [] };

        if (!this.tvdbApiKey && !this.tmdbApiKey) {
            log('warn', '[GestdownProvider] No TVDB_API_KEY or TMDB_API_KEY configured — cannot resolve IDs');
            return { subtitles: [] };
        }

        const startedAt = Date.now();
        try {
            const subs = await this._searchSubtitles(query);
            this._recordRequest(true, Date.now() - startedAt, subs.length);
            return { subtitles: subs };
        } catch (err) {
            this._recordRequest(false, Date.now() - startedAt, 0, err);
            log('error', `[GestdownProvider] Search failed: ${err.message}`);
            return { subtitles: [] };
        }
    }

    async _searchSubtitles(query) {
        const { imdbId, season, episode, languages } = query;
        if (!imdbId) return [];

        if (this._negativeTvdb.has(imdbId)) {
            log('debug', `[GestdownProvider] Skipping ${imdbId} (negative cache hit)`);
            return [];
        }

        // Step 1: Resolve IMDB → TVDB → Gestdown show ID
        const showId = await this._resolveShowId(imdbId);
        if (!showId) return [];

        // Step 2: Fetch subtitles for each requested language
        const langNames = this._getLanguageNames(languages);
        if (langNames.length === 0) {
            langNames.push('English');
        }

        const allResults = [];
        for (const langName of langNames) {
            try {
                const subs = await this._fetchSubtitles(showId, season, episode, langName);
                allResults.push(...subs);
            } catch (err) {
                log('debug', `[GestdownProvider] ${langName} fetch failed: ${err.message}`);
            }
        }

        log('info', `[GestdownProvider] ${imdbId} S${season}E${episode}: ${allResults.length} subtitles (${langNames.join(',')})`);
        return allResults;
    }

    async _fetchSubtitles(showId, season, episode, languageName) {
        const url = `${GESTDOWN_BASE}/subtitles/get/${showId}/${season}/${episode}/${encodeURIComponent(languageName)}`;
        log('debug', `[GestdownProvider] Fetching: ${url}`);

        const response = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT)
        });

        if (!response.ok) {
            if (response.status === 404) return [];
            if (response.status === 423) {
                await new Promise(r => setTimeout(r, 500));
                const retry = await fetch(url, {
                    headers: { 'Accept': 'application/json' },
                    signal: AbortSignal.timeout(TIMEOUT)
                });
                if (!retry.ok) return [];
                const retryData = await retry.json();
                return this._parseSubtitles(retryData, languageName);
            }
            throw new Error(`Gestdown HTTP ${response.status}`);
        }

        const data = await response.json();
        return this._parseSubtitles(data, languageName);
    }

    _parseSubtitles(data, languageName) {
        const items = data.matchingSubtitles || data.subtitles || [];
        if (!Array.isArray(items)) return [];

        const langEntry = getByName(languageName);
        const alpha2 = langEntry ? langEntry.alpha2 : languageName.substring(0, 2).toLowerCase();
        const alpha3B = langEntry ? langEntry.alpha3B : alpha2;

        return items.map(item => {
            const subtitleId = item.subtitleId || item.id;
            const downloadUrl = `${GESTDOWN_BASE}/subtitles/download/${subtitleId}`;
            const proxyUrl = `${this.baseUrl}/api/gestdown/proxy/${subtitleId}`;

            const version = item.version || item.release || '';
            const releaseName = version || 'Unknown';

            let releases = [];
            if (version.includes(',') && version.includes('-')) {
                releases = version.split(',').map(s => s.trim()).filter(Boolean);
            }

            return new SubtitleResult({
                id: `gd-${subtitleId}`,
                url: proxyUrl,
                language: alpha2,
                languageCode: alpha3B,
                source: 'gestdown',
                provider: 'gestdown',
                releaseName,
                releases,
                hearingImpaired: item.hearingImpaired || false,
                downloadCount: item.downloadCount || null,
                display: langEntry ? langEntry.name : languageName,
                format: 'srt',
                needsConversion: false
            });
        });
    }

    async _resolveShowId(imdbId) {
        const cachedTvdb = this._tvdbCache.get(imdbId);
        if (cachedTvdb) {
            const cachedShow = this._showCache.get(cachedTvdb);
            if (cachedShow) return cachedShow.id;
        }

        try {
            let tvdbId = null;
            if (this.tvdbApiKey) {
                tvdbId = await this._resolveImdbToTvdbDirect(imdbId);
            }
            if (!tvdbId && this.tmdbApiKey) {
                tvdbId = await this._resolveImdbToTvdbViaTmdb(imdbId);
            }

            if (!tvdbId) {
                this._negativeTvdb.add(imdbId);
                return null;
            }
            this._tvdbCache.set(imdbId, tvdbId);

            const showId = await this._resolveGestdownShow(tvdbId);
            if (!showId) {
                this._negativeTvdb.add(imdbId);
                return null;
            }
            return showId;
        } catch (err) {
            log('warn', `[GestdownProvider] ID resolution failed for ${imdbId}: ${err.message}`);
            this._negativeTvdb.add(imdbId);
            return null;
        }
    }

    /**
     * Resolve IMDB → TVDB directly via TVDB API /search/remoteid endpoint.
     */
    async _resolveImdbToTvdbDirect(imdbId) {
        try {
            const token = await this._ensureTvdbToken();
            const url = `${TVDB_BASE}/search/remoteid/${imdbId}`;
            const res = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json'
                },
                signal: AbortSignal.timeout(8000)
            });

            if (!res.ok) {
                log('debug', `[GestdownProvider] TVDB remoteid lookup: HTTP ${res.status}`);
                return null;
            }

            const data = await res.json();
            const results = data.data || [];
            const series = results.find(r => r.series);
            if (series && series.series) {
                const tvdbId = series.series.id;
                log('debug', `[GestdownProvider] TVDB direct: ${imdbId} → TVDB ${tvdbId}`);
                return tvdbId;
            }
            return null;
        } catch (err) {
            log('debug', `[GestdownProvider] TVDB direct lookup failed: ${err.message}`);
            return null;
        }
    }

    /**
     * Resolve IMDB → TVDB via TMDB (fallback).
     */
    async _resolveImdbToTvdbViaTmdb(imdbId) {
        const findUrl = `${TMDB_BASE}/find/${imdbId}?api_key=${this.tmdbApiKey}&external_source=imdb_id`;
        const findRes = await fetch(findUrl, { signal: AbortSignal.timeout(8000) });
        if (!findRes.ok) throw new Error(`TMDB find: HTTP ${findRes.status}`);

        const findData = await findRes.json();
        const tvResult = (findData.tv_results || [])[0];
        if (!tvResult) {
            log('debug', `[GestdownProvider] ${imdbId} not found as TV on TMDB`);
            return null;
        }

        const tmdbId = tvResult.id;

        const extUrl = `${TMDB_BASE}/tv/${tmdbId}/external_ids?api_key=${this.tmdbApiKey}`;
        const extRes = await fetch(extUrl, { signal: AbortSignal.timeout(8000) });
        if (!extRes.ok) throw new Error(`TMDB external_ids: HTTP ${extRes.status}`);

        const extData = await extRes.json();
        const tvdbId = extData.tvdb_id;
        if (!tvdbId) {
            log('debug', `[GestdownProvider] ${imdbId} (TMDB ${tmdbId}) has no TVDB ID`);
            return null;
        }

        log('debug', `[GestdownProvider] TMDB fallback: ${imdbId} → TMDB ${tmdbId} → TVDB ${tvdbId}`);
        return tvdbId;
    }

    async _ensureTvdbToken() {
        if (this._tvdbToken && this._tvdbTokenExpiry && Date.now() < this._tvdbTokenExpiry) {
            return this._tvdbToken;
        }

        const res = await fetch(`${TVDB_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apikey: this.tvdbApiKey }),
            signal: AbortSignal.timeout(8000)
        });

        if (!res.ok) throw new Error(`TVDB login failed: HTTP ${res.status}`);
        const data = await res.json();
        this._tvdbToken = data.data.token;
        this._tvdbTokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
        log('debug', '[GestdownProvider] TVDB token acquired');
        return this._tvdbToken;
    }

    async _resolveGestdownShow(tvdbId) {
        const cached = this._showCache.get(tvdbId);
        if (cached) return cached.id;

        const url = `${GESTDOWN_BASE}/shows/external/tvdb/${tvdbId}`;
        const response = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT)
        });

        if (!response.ok) {
            if (response.status === 404) {
                log('debug', `[GestdownProvider] TVDB ${tvdbId} not found on Gestdown`);
                return null;
            }
            throw new Error(`Gestdown show lookup: HTTP ${response.status}`);
        }

        const data = await response.json();
        const shows = data.shows || [data];
        const show = shows[0];
        if (!show || !show.id) return null;

        this._showCache.set(tvdbId, { id: show.id, name: show.name });
        log('debug', `[GestdownProvider] TVDB ${tvdbId} → Gestdown show: ${show.name} (${show.id})`);
        return show.id;
    }

    // =====================================================
    // Language Utilities
    // =====================================================
    
    _getLanguageNames(languages) {
        if (!languages || languages.length === 0) return [];

        const names = [];
        for (const code of languages) {
            const name = toGestdownName(code);
            if (name && !names.includes(name)) {
                names.push(name);
            }
        }
        return names;
    }
}

module.exports = GestdownProvider;

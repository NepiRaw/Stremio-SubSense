'use strict';

const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { log } = require('../utils');
const { toBetaseriesCode, getByBetaseriesCode, toAlpha3B, getDisplayName } = require('../languages');

const API_BASE = 'https://api.betaseries.com';
const API_VERSION = '3.0';
const SUPPORTED = new Set(['fr', 'fre', 'en', 'eng']);

class BetaSeriesProvider extends BaseProvider {
    constructor(options = {}) {
        super('betaseries', options);

        this.apiKey = options.apiKey || process.env.BETASERIES_API_KEY;
        this.baseUrl = options.baseUrl || process.env.SUBSENSE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3100}`;

        if (!this.apiKey) {
            log('warn', '[BetaSeriesProvider] No API key configured, provider disabled');
            this.enabled = false;
        }

        this._showCache = new Map();
        this._episodeCache = new Map();
        this._discoveredSources = new Set(['betaseries']);
    }

    getSources() {
        return Array.from(this._discoveredSources);
    }

    /**
     * Search interface — adapts languages[] to internal per-lang calls.
     */
    async search(query) {
        if (!this.enabled) return { subtitles: [] };
        if (query.season == null || query.episode == null) return { subtitles: [] };

        const languages = Array.isArray(query.languages) && query.languages.length > 0
            ? query.languages.filter((l) => SUPPORTED.has(l.toLowerCase()))
            : [null];

        if (languages.length === 0) return { subtitles: [] };

        const startedAt = Date.now();
        try {
            const perLang = await Promise.all(
                languages.map((lang) => this._searchInternal({
                    imdbId: query.imdbId,
                    season: query.season,
                    episode: query.episode,
                    language: lang
                }))
            );
            const subtitles = dedupeByUrl(perLang.flat());
            this._recordRequest(true, Date.now() - startedAt, subtitles.length);
            return { subtitles };
        } catch (err) {
            this._recordRequest(false, Date.now() - startedAt, 0, err);
            return { subtitles: [] };
        }
    }

    /**
     * Internal search (single language at a time).
     */
    async _searchInternal(query) {
        if (query.language) {
            const lang = query.language.toLowerCase();
            if (!SUPPORTED.has(lang)) {
                log('debug', `[BetaSeriesProvider] Skipping - language "${lang}" not supported`);
                return [];
            }
        }

        if (!query.season || !query.episode) return [];

        const showId = await this._getShowId(query.imdbId);
        if (!showId) {
            log('debug', `[BetaSeries] Show not found: ${query.imdbId}`);
            return [];
        }

        const episodeId = await this._getEpisodeId(showId, query.season, query.episode);
        if (!episodeId) {
            log('debug', `[BetaSeries] Episode not found: S${query.season}E${query.episode}`);
            return [];
        }

        let bsLanguage = null;
        if (query.language) {
            bsLanguage = toBetaseriesCode(query.language) || toBetaseriesCode(query.language.toLowerCase());
        }

        const params = { id: episodeId };
        if (bsLanguage) params.language = bsLanguage;

        const result = await this._apiRequest('/subtitles/episode', params);

        if (!result || !result.subtitles) {
            log('debug', '[BetaSeries] No subtitles returned');
            return [];
        }

        result.subtitles.forEach(sub => {
            if (sub.source) this._discoveredSources.add(sub.source.toLowerCase());
        });

        return result.subtitles.map(sub => this._normalizeResult(sub, query));
    }

    async _apiRequest(endpoint, params = {}) {
        const url = new URL(`${API_BASE}${endpoint}`);
        url.searchParams.set('v', API_VERSION);
        url.searchParams.set('key', this.apiKey);
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) url.searchParams.set(key, value);
        }
        log('debug', `[BetaSeries] API request: ${endpoint} params=${JSON.stringify(params)}`);
        try {
            const response = await fetch(url.toString(), {
                headers: { 'User-Agent': 'SubSense-Stremio/1.0', 'Accept': 'application/json' }
            });
            const data = await response.json();
            if (data.errors && data.errors.length > 0) {
                log('debug', `[BetaSeries] API error: ${JSON.stringify(data.errors)}`);
                return null;
            }
            return data;
        } catch (error) {
            log('error', `[BetaSeries] API request failed: ${error.message}`);
            return null;
        }
    }

    async _getShowId(imdbId) {
        if (this._showCache.has(imdbId)) return this._showCache.get(imdbId);
        const result = await this._apiRequest('/shows/display', { imdb_id: imdbId });
        if (result && result.show) {
            const showId = result.show.id;
            this._showCache.set(imdbId, showId);
            log('debug', `[BetaSeries] Found show: ${result.show.title} (ID: ${showId})`);
            return showId;
        }
        return null;
    }

    async _getEpisodeId(showId, season, episode) {
        const cacheKey = `${showId}:${season}:${episode}`;
        if (this._episodeCache.has(cacheKey)) return this._episodeCache.get(cacheKey);
        const result = await this._apiRequest('/shows/episodes', { id: showId });
        if (result && result.episodes) {
            for (const ep of result.episodes) {
                this._episodeCache.set(`${showId}:${ep.season}:${ep.episode}`, ep.id);
            }
            return this._episodeCache.get(cacheKey) || null;
        }
        return null;
    }

    _normalizeResult(sub, query) {
        const fileName = sub.file || '';
        const fileNameLower = fileName.toLowerCase();
        const isZip = fileNameLower.endsWith('.zip');
        const isAss = fileNameLower.endsWith('.ass') || fileNameLower.endsWith('.ssa');

        let format = 'srt';
        let needsConversion = false;
        if (isAss) { format = 'ass'; needsConversion = true; }

        let url;
        if (isZip) {
            const langParam = toBetaseriesCode(query.language) || sub.language?.toLowerCase() || 'vo';
            url = `${this.baseUrl}/api/betaseries/proxy/${sub.id}?lang=${langParam}`;
        } else {
            url = sub.url;
        }

        const bsLang = sub.language || 'VO';
        const langEntry = getByBetaseriesCode(bsLang);
        const languageCode = langEntry ? langEntry.alpha3B : 'eng';
        const langDisplay = langEntry ? langEntry.name : (bsLang === 'VF' ? 'French' : bsLang === 'VO' ? 'English' : bsLang);

        return new SubtitleResult({
            id: `bs-${sub.id}`,
            url,
            language: langEntry ? langEntry.alpha2 : 'en',
            languageCode,
            source: sub.source || 'betaseries',
            provider: 'betaseries',
            releaseName: fileName.replace(/\.(srt|ass|ssa|zip)$/i, ''),
            hearingImpaired: false,
            rating: sub.quality || null,
            downloadCount: null,
            display: `[${sub.source || 'betaseries'}] ${langDisplay}`,
            format,
            needsConversion
        });
    }
}

function dedupeByUrl(list) {
    const seen = new Set();
    const out = [];
    for (const sub of list) {
        const key = sub.url || sub.id;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        out.push(sub);
    }
    return out;
}

module.exports = BetaSeriesProvider;

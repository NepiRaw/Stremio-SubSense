'use strict';

const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { log } = require('../utils');
const { toSubsourceCode, getBySubsourceCode, toAlpha3B, getDisplayName } = require('../languages');

let filenameParseFn = null;
async function getFilenameParser() {
    if (!filenameParseFn) {
        const { filenameParse } = await import('@ctrl/video-filename-parser');
        filenameParseFn = filenameParse;
    }
    return filenameParseFn;
}

const API_BASE = 'https://api.subsource.net/api/v1';

/**
 * SubSource requires a per-user API key. When no key is present the ResponseCache
 * stores a placeholder URL that is either rewritten with the requesting user's
 * key or stripped entirely at delivery time.
 */
class SubSourceProvider extends BaseProvider {
    constructor(options = {}) {
        super('subsource', options);
        this.baseUrl = options.baseUrl || process.env.SUBSENSE_BASE_URL ||
                       `http://127.0.0.1:${process.env.PORT || 3100}`;
        this._movieCache = new Map();
    }

    getSources() {
        return ['subsource'];
    }

    /**
     * Search interface — extracts apiKey from query, maps languages[].
     */
    async search(query) {
        if (!this.enabled) return { subtitles: [] };

        const apiKey = query.apiKeys && query.apiKeys.subsource;
        if (!apiKey) return { subtitles: [] };

        const languages = Array.isArray(query.languages) && query.languages.length > 0
            ? query.languages
            : [null];

        const baseQuery = {
            imdbId: query.imdbId,
            season: query.season,
            episode: query.episode,
            apiKey,
            encryptedApiKey: query.encryptedApiKeys && query.encryptedApiKeys.subsource,
            filename: query.filename || null
        };

        const startedAt = Date.now();
        try {
            const perLang = await Promise.all(
                languages.map((lang) => this._searchInternal({ ...baseQuery, language: lang }))
            );
            const subtitles = dedupeById(perLang.flat());
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
        if (!query.apiKey) return [];

        try {
            const movieInfo = await this._findMovieId(query.apiKey, query.imdbId, query.season);
            if (!movieInfo) {
                log('debug', `[SubSource] No results for ${query.imdbId}`);
                return [];
            }

            const subSourceLang = query.language ? toSubsourceCode(query.language) : null;
            if (query.language && !subSourceLang) {
                log('debug', `[SubSource] Unsupported language: ${query.language}`);
                return [];
            }

            let subtitles = await this._fetchAllSubtitles(query.apiKey, movieInfo.movieId, subSourceLang);
            if (subtitles.length === 0) return [];

            const filterResults = await Promise.all(
                subtitles.map(sub => this._shouldIncludeSubtitle(sub, query))
            );
            subtitles = subtitles.filter((_, index) => filterResults[index]);

            return subtitles.map(sub => this._toSubtitleResult(sub, query));
        } catch (error) {
            log('error', `[SubSource] Search error: ${error.message}`);
            return [];
        }
    }

    async _apiRequest(apiKey, endpoint, params = {}) {
        const url = new URL(`${API_BASE}${endpoint}`);
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) url.searchParams.set(key, value);
        }
        try {
            const response = await fetch(url.toString(), {
                headers: { 'X-API-Key': apiKey, 'User-Agent': 'SubSense-Stremio/1.0', 'Accept': 'application/json' }
            });
            if (response.status === 401) { log('warn', '[SubSource] Invalid API key (401)'); return { error: 'invalid_api_key', status: 401 }; }
            if (response.status === 429) { const reset = response.headers.get('X-RateLimit-Reset'); log('warn', `[SubSource] Rate limited, reset at ${reset}`); return { error: 'rate_limited', status: 429, reset }; }
            if (!response.ok) { log('error', `[SubSource] API error: ${response.status}`); return { error: 'api_error', status: response.status }; }
            return await response.json();
        } catch (error) {
            log('error', `[SubSource] Request failed: ${error.message}`);
            return { error: 'network_error', message: error.message };
        }
    }

    async _fetchAllSubtitles(apiKey, movieId, language = null) {
        const allSubtitles = [];
        let page = 1;
        const limit = 100;
        let totalPages = 1;
        do {
            const params = { movieId, limit, page };
            if (language) params.language = language;
            const result = await this._apiRequest(apiKey, '/subtitles', params);
            if (result.error) { log('warn', `[SubSource] Pagination error on page ${page}: ${result.error}`); break; }
            if (!result.success || !result.data) break;
            allSubtitles.push(...result.data);
            if (result.pagination) totalPages = result.pagination.pages || 1;
            page++;
        } while (page <= totalPages);
        return allSubtitles;
    }

    async _findMovieId(apiKey, imdbId, season = null) {
        const cacheKey = `${imdbId}:${season || 'movie'}`;
        if (this._movieCache.has(cacheKey)) return this._movieCache.get(cacheKey);

        const result = await this._apiRequest(apiKey, '/movies/search', { searchType: 'imdb', imdb: imdbId });
        if (result.error || !result.success || !result.data || result.data.length === 0) return null;

        if (result.data[0].type === 'movie') {
            const info = { movieId: result.data[0].movieId, type: 'movie' };
            this._movieCache.set(cacheKey, info);
            return info;
        }

        for (const entry of result.data) {
            this._movieCache.set(`${imdbId}:${entry.season}`, { movieId: entry.movieId, type: 'series', season: entry.season });
        }
        return this._movieCache.get(cacheKey) || null;
    }

    async _shouldIncludeSubtitle(sub, query) {
        if (!query.episode || !query.season) return true;

        const releaseInfo = Array.isArray(sub.releaseInfo)
            ? sub.releaseInfo.join(' ')
            : (sub.releaseInfo || '');
        if (!releaseInfo) return true;

        const requestedEpisode = parseInt(query.episode, 10);
        const requestedSeason = parseInt(query.season, 10);

        try {
            const parse = await getFilenameParser();
            const parsed = parse(releaseInfo, true);
            if (parsed.episodeNumbers && parsed.episodeNumbers.length > 0) {
                if (!parsed.episodeNumbers.includes(requestedEpisode)) return false;
                if (parsed.seasons && parsed.seasons.length > 0 && !parsed.seasons.includes(requestedSeason)) return false;
                return true;
            }
        } catch (err) {}

        const episodeWordPattern = /\b(?:Episode|EP)[.\-_\s]*(\d{1,4})\b/i;
        const episodeWordMatch = releaseInfo.match(episodeWordPattern);
        if (episodeWordMatch) {
            const fileEpisode = parseInt(episodeWordMatch[1], 10);
            if (fileEpisode >= 1900 && fileEpisode <= 2099) { /* year, skip */ }
            else if (fileEpisode !== requestedEpisode) return false;
            else return true;
        }

        const xPattern = /\b(\d{1,2})x(\d{1,4})\b/i;
        const xMatch = releaseInfo.match(xPattern);
        if (xMatch) {
            if (parseInt(xMatch[1], 10) !== requestedSeason || parseInt(xMatch[2], 10) !== requestedEpisode) return false;
            return true;
        }

        if (!/[sS]\d{1,2}[.\-_]?[eE]\d{1,4}/.test(releaseInfo)) {
            const animePattern = /[\s\-]\s*(\d{1,4})\s*(?:[\[\(]|$|\s*\-)/;
            const animeMatch = releaseInfo.match(animePattern);
            if (animeMatch) {
                const fileEpisode = parseInt(animeMatch[1], 10);
                if (fileEpisode > 0 && fileEpisode <= 2000 && fileEpisode !== requestedEpisode) {
                    if (![720, 1080, 480, 2160, 576, 360].includes(fileEpisode)) return false;
                }
            }
        }

        const rangePattern = /[sS](\d{1,2})[.\-_]?[eE](\d{1,4})\-[eE]?(\d{1,4})/;
        const rangeMatch = releaseInfo.match(rangePattern);
        if (rangeMatch) {
            if (parseInt(rangeMatch[1], 10) !== requestedSeason) return false;
            if (requestedEpisode < parseInt(rangeMatch[2], 10) || requestedEpisode > parseInt(rangeMatch[3], 10)) return false;
            return true;
        }

        const fullPattern = /[sS](\d{1,2})[.\-_]?[eE](\d{1,4})(?!\d)/;
        const fullMatch = releaseInfo.match(fullPattern);
        if (fullMatch) {
            if (parseInt(fullMatch[1], 10) !== requestedSeason || parseInt(fullMatch[2], 10) !== requestedEpisode) return false;
            return true;
        }

        return true;
    }

    _toSubtitleResult(sub, query) {
        const releaseInfo = Array.isArray(sub.releaseInfo)
            ? sub.releaseInfo.join(' | ')
            : (sub.releaseInfo || '');

        const params = new URLSearchParams();
        if (query.encryptedApiKey) params.set('key', query.encryptedApiKey);
        if (query.season) params.set('season', query.season.toString());
        if (query.episode) params.set('episode', query.episode.toString());
        if (query.filename) params.set('filename', query.filename);

        const sanitizedRelease = releaseInfo
            ? releaseInfo.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').substring(0, 100)
            : 'subtitle';

        const queryStr = params.toString();
        const downloadUrl = `${this.baseUrl}/api/subsource/proxy/${sub.subtitleId}/${encodeURIComponent(sanitizedRelease)}${queryStr ? '?' + queryStr : ''}`;

        const lang = getBySubsourceCode(sub.language);
        const stremioCode = lang ? toAlpha3B(lang.alpha2) : 'und';
        const displayName = lang ? getDisplayName(lang.alpha2) : sub.language;

        return new SubtitleResult({
            id: `subsource-${sub.subtitleId}`,
            url: downloadUrl,
            language: sub.language,
            languageCode: stremioCode,
            source: 'subsource',
            provider: 'subsource',
            releaseName: releaseInfo,
            hearingImpaired: sub.hearingImpaired || false,
            rating: null,
            downloadCount: sub.downloads || null,
            display: displayName,
            format: 'srt',
            needsConversion: false
        });
    }

    async validateApiKey(apiKey) {
        const result = await this._apiRequest(apiKey, '/movies/search', { searchType: 'imdb', imdb: 'tt1375666' });
        if (result.error === 'invalid_api_key') return { valid: false, error: 'Invalid API key' };
        if (result.error === 'rate_limited') return { valid: true, remaining: 0, error: 'Rate limited' };
        if (result.error) return { valid: false, error: result.message || result.error };
        return { valid: true };
    }
}

function dedupeById(list) {
    const seen = new Set();
    const out = [];
    for (const sub of list) {
        const key = sub.id;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        out.push(sub);
    }
    return out;
}

module.exports = SubSourceProvider;

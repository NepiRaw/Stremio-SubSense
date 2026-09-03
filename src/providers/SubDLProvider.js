'use strict';

const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { log } = require('../utils');
const { toSubdlCode, getBySubdlCode, toAlpha3B, getDisplayName } = require('../languages');
const mediaParser = require('../utils/mediaParser');
const { declaredTrack } = require('../utils/trackType');

const API_BASE = 'https://api.subdl.com/api/v1';

// A language-filtered search returns 1-2 pages for an episode and 4-12 for a movie
const MAX_SEARCH_PAGES = 10;

function intEnv(name, fallback) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

// SubDL sheds on how many requests are in flight from one exit IP
const MAX_IN_FLIGHT = intEnv('SUBDL_MAX_IN_FLIGHT', 8);
let inFlight = 0;
const waiting = [];

function acquireSlot() {
    if (inFlight < MAX_IN_FLIGHT) {
        inFlight++;
        return Promise.resolve();
    }
    return new Promise(resolve => waiting.push(resolve));
}

function releaseSlot() {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
}

const RATE_LIMIT_DEFAULT_MS = 5 * 1000;
const RATE_LIMIT_MAX_MS = 60 * 1000;
let rateLimitedUntil = 0;

function parseRetryAfter(value) {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const when = Date.parse(value);
    return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

function rateLimitRemaining() {
    const left = rateLimitedUntil - Date.now();
    return left > 0 ? left : 0;
}

function noteRateLimited(retryAfterMs) {
    const waitMs = Math.min(retryAfterMs == null ? RATE_LIMIT_DEFAULT_MS : retryAfterMs, RATE_LIMIT_MAX_MS);
    rateLimitedUntil = Date.now() + waitMs;
    return waitMs;
}

class SubDLProvider extends BaseProvider {
    constructor(options = {}) {
        super('subdl', options);
        this.baseUrl = options.baseUrl || process.env.SUBSENSE_BASE_URL ||
                       `http://127.0.0.1:${process.env.PORT || 3100}`;
    }

    getSources() {
        return ['subdl'];
    }

    async search(query) {
        if (!this.enabled) return { subtitles: [] };

        const apiKey = query.apiKeys && query.apiKeys.subdl;
        if (!apiKey) return { subtitles: [] };

        if (rateLimitRemaining() > 0) return { subtitles: [] };

        const languages = Array.isArray(query.languages) && query.languages.length > 0
            ? query.languages : [null];

        const subdlLangs = languages
            .map(l => l ? toSubdlCode(l) : null)
            .filter(Boolean);

        if (subdlLangs.length === 0) {
            log('debug', '[SubDL] no requested language maps to a SubDL code, skipping search');
            return { subtitles: [] };
        }

        const startedAt = Date.now();
        try {
            const subtitles = await this._searchSubtitles({
                apiKey,
                imdbId: query.imdbId,
                season: query.season,
                episode: query.episode,
                languages: subdlLangs,
                filename: query.filename || null
            });
            this._recordRequest(true, Date.now() - startedAt, subtitles.length);
            return { subtitles };
        } catch (err) {
            this._recordRequest(false, Date.now() - startedAt, 0, err);
            return { subtitles: [] };
        }
    }

    async _searchSubtitles(opts) {
        const { apiKey, imdbId, season, episode, languages, filename } = opts;

        const params = {
            api_key: apiKey,
            imdb_id: imdbId,
            subs_per_page: '30',
            releases: '1'
        };

        if (season != null) {
            params.type = 'tv';
            params.season_number = String(season);
            if (episode != null) params.episode_number = String(episode);
        } else {
            params.type = 'movie';
        }

        if (languages.length > 0) {
            params.languages = languages.join(',');
        }

        const result = await this._apiRequest(params);
        if (!result || !result.status || !Array.isArray(result.subtitles)) {
            return [];
        }

        let allSubs = [...result.subtitles];

        const reportedPages = result.totalPages || 1;
        const totalPages = Math.min(reportedPages, MAX_SEARCH_PAGES);
        if (reportedPages > MAX_SEARCH_PAGES) {
            log('debug', `[SubDL] capped at ${MAX_SEARCH_PAGES} of ${reportedPages} pages`);
        }
        for (let page = 2; page <= totalPages; page++) {
            const pageResult = await this._apiRequest({ ...params, page: String(page) });
            if (!pageResult || pageResult.error === 'rate_limited') break;
            if (pageResult.status && Array.isArray(pageResult.subtitles)) {
                allSubs.push(...pageResult.subtitles);
            }
        }

        if (season != null && episode != null) {
            allSubs = allSubs.filter(sub => this._matchesEpisode(sub, season, episode));
        }

        return allSubs.map(sub => this._toSubtitleResult(sub, {
            season,
            episode,
            filename
        }));
    }

    async _apiRequest(params) {
        const url = new URL(`${API_BASE}/subtitles`);
        for (const [k, v] of Object.entries(params)) {
            if (v != null) url.searchParams.set(k, v);
        }

        await acquireSlot();
        try {
            if (rateLimitRemaining() > 0) return { status: false, error: 'rate_limited' };

            const response = await fetch(url.toString(), {
                headers: {
                    'User-Agent': 'SubSense-Stremio/2.0',
                    'Accept': 'application/json'
                }
            });
            if (response.status === 403) {
                log('warn', '[SubDL] Invalid API key (403)');
                return { status: false, error: 'invalid_api_key' };
            }
            if (response.status === 429) {
                const waitMs = noteRateLimited(parseRetryAfter(response.headers.get('retry-after')));
                log('warn', `[SubDL] shed (429), pausing searches for ${Math.round(waitMs / 1000)}s`);
                return { status: false, error: 'rate_limited' };
            }
            if (!response.ok) {
                log('error', `[SubDL] API error: ${response.status}`);
                return null;
            }
            return await response.json();
        } catch (error) {
            log('error', `[SubDL] Request failed: ${error.message}`);
            return null;
        } finally {
            releaseSlot();
        }
    }

    _matchesEpisode(sub, season, episode) {
        const subEpisode = sub.episode === '' || sub.episode == null ? null : Number(sub.episode);
        const subFrom = sub.episode_from === '' || sub.episode_from == null ? null : Number(sub.episode_from);
        const subEnd = sub.episode_end === '' || sub.episode_end == null ? null : Number(sub.episode_end);

        if (sub.full_season === true) {
            if (subFrom != null && subEnd != null && subEnd > 0) {
                if (episode < subFrom || episode > subEnd) return false;
            }
            return true;
        }

        if (subEpisode === null && subFrom === null) return true;

        if (subEpisode === episode) return true;

        if (subFrom != null && subEnd != null && subEnd > 0) {
            if (episode >= subFrom && episode <= subEnd) return true;
        }

        const releaseName = sub.release_name || sub.name || '';
        return this._releaseMatchesEpisode(releaseName, season, episode);
    }

    _releaseMatchesEpisode(releaseName, season, episode) {
        if (!releaseName) return true;

        try {
            const parsed = mediaParser.parse(releaseName);

            if (parsed.contentType === 'movie') return false;

            const parsedSeasons = parsed.seasons || [];
            const parsedSeason = parsedSeasons.length === 1 ? parsedSeasons[0] : null;
            const parsedEpisodes = parsed.episodes || [];

            if (parsedEpisodes.length === 0) {
                if (parsedSeason == null || parsedSeason === season) return true;
                return false; // Wrong season entirely
            }

            if (parsedEpisodes.includes(episode)) {
                if (parsedSeason != null && parsedSeason !== season) return false;
                return true;
            }

            return false;
        } catch (err) {
            return true;
        }
    }

    _toSubtitleResult(sub, opts) {
        const { season, episode, filename } = opts;

        // Build proxy URL (SubDL downloads are public, no API key needed)
        const releaseName = sub.release_name || sub.name || '';
        // A pack holds several tracks per episode; `track` tells the proxy which one this line is.
        const track = declaredTrack(releaseName, !!sub.hi);

        const encodedUrl = encodeURIComponent((sub.url || '').replace(/^\/+/, ''));
        const params = new URLSearchParams();
        if (season != null) params.set('season', String(season));
        if (episode != null) params.set('episode', String(episode));
        if (filename) params.set('filename', filename);
        if (track !== 'plain') params.set('track', track);
        const queryStr = params.toString();
        const downloadUrl = `${this.baseUrl}/api/subdl/proxy/${encodedUrl}${queryStr ? '?' + queryStr : ''}`;

        const lang = getBySubdlCode(sub.lang || sub.language);
        const stremioCode = lang ? toAlpha3B(lang.alpha2) : 'und';
        const displayName = lang ? getDisplayName(lang.alpha2) : (sub.language || 'Unknown');

        const releases = Array.isArray(sub.releases) ? sub.releases : [];

        return new SubtitleResult({
            id: `subdl-${this._subtitleIdFromUrl(sub.url)}`,
            url: downloadUrl,
            language: lang ? lang.alpha2 : (sub.lang || '').toLowerCase(),
            languageCode: stremioCode,
            source: 'subdl',
            provider: 'subdl',
            releaseName: releaseName,
            releases: releases,
            hearingImpaired: !!sub.hi,
            rating: null,
            downloadCount: null,
            display: displayName,
            format: 'srt',
            needsConversion: false
        });
    }

    _subtitleIdFromUrl(url) {
        const match = (url || '').match(/(\d+-\d+)/);
        return match ? match[1] : url;
    }

    async validateApiKey(apiKey) {
        const result = await this._apiRequest({
            api_key: apiKey,
            imdb_id: 'tt1375666',
            type: 'movie',
            subs_per_page: '1'
        });

        if (!result) return { valid: false, error: 'Network error' };
        if (result.error === 'invalid_api_key') return { valid: false, error: 'Invalid API key' };
        if (result.error === 'rate_limited') return { valid: true, remaining: 0, error: 'Rate limited' };
        if (result.status === true) return { valid: true };
        return { valid: false, error: result.message || 'Unknown error' };
    }
}

module.exports = SubDLProvider;

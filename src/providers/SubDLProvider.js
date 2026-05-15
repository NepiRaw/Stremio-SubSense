'use strict';

const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { log } = require('../utils');
const { toSubdlCode, getBySubdlCode, toAlpha3B, getDisplayName } = require('../languages');
const { guessit } = require('guessit-js');

const API_BASE = 'https://api.subdl.com/api/v1';

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

        const languages = Array.isArray(query.languages) && query.languages.length > 0
            ? query.languages : [null];

        const subdlLangs = languages
            .map(l => l ? toSubdlCode(l) : null)
            .filter(Boolean);

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

        const totalPages = result.totalPages || 1;
        for (let page = 2; page <= totalPages; page++) {
            const pageResult = await this._apiRequest({ ...params, page: String(page) });
            if (pageResult?.status && Array.isArray(pageResult.subtitles)) {
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

        try {
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
                log('warn', '[SubDL] Rate limited (429)');
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
        }
    }

    _matchesEpisode(sub, season, episode) {
        const subEpisode = sub.episode === '' || sub.episode == null ? null : Number(sub.episode);
        const subFrom = sub.episode_from === '' || sub.episode_from == null ? null : Number(sub.episode_from);
        const subEnd = sub.episode_end === '' || sub.episode_end == null ? null : Number(sub.episode_end);

        if (sub.full_season === true) {
            // SubDL sometimes marks partial zips as full_season; verify range if available
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
            const parsed = guessit(releaseName);

            if (parsed.type === 'movie') return false;

            const parsedSeason = parsed.season || null;
            const parsedEpisodes = parsed.episode != null
                ? (Array.isArray(parsed.episode) ? parsed.episode : [parsed.episode])
                : [];

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
        const encodedUrl = encodeURIComponent((sub.url || '').replace(/^\/+/, ''));
        const params = new URLSearchParams();
        if (season != null) params.set('season', String(season));
        if (episode != null) params.set('episode', String(episode));
        if (filename) params.set('filename', filename);
        const queryStr = params.toString();
        const downloadUrl = `${this.baseUrl}/api/subdl/proxy/${encodedUrl}${queryStr ? '?' + queryStr : ''}`;

        const lang = getBySubdlCode(sub.lang || sub.language);
        const stremioCode = lang ? toAlpha3B(lang.alpha2) : 'und';
        const displayName = lang ? getDisplayName(lang.alpha2) : (sub.language || 'Unknown');

        const releaseName = sub.release_name || sub.name || '';
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
            format: null,
            needsConversion: null
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

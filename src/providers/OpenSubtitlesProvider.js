'use strict';

const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { log } = require('../utils');
const { toAlpha2, toAlpha3B, getDisplayName, getByAnyCode } = require('../languages');

const BASE_URL = 'https://rest.opensubtitles.org';
const USER_AGENT = 'VLSub 0.10.3';
const TIMEOUT = 12000;
const REQUEST_DELAY_MS = 250;

/**
 * OpenSubtitles Legacy REST API provider.
 * Covers movies + TV shows. No API key required — just the VLSub User-Agent header.
 * 
 * API URL patterns:
 *   Movies:  /search/imdbid-{id}
 *   TV:      /search/episode-{ep}/imdbid-{id}/season-{season}
 *   Lang:    /search/episode-{ep}/imdbid-{id}/season-{season}/sublanguageid-{code3}
 * 
 * Download URL transform:
 *   Raw: https://dl.opensubtitles.org/en/download/src-api/vrf-{vrf}/file/{id}.gz
 *   UTF8: https://dl.opensubtitles.org/en/download/subencoding-utf8/src-api/vrf-{vrf}/file/{id}
 */
class OpenSubtitlesProvider extends BaseProvider {
    constructor(options = {}) {
        super('opensubtitles', options);
        this.supportedTypes = ['movie', 'series'];
        this._lastRequestAt = 0;
    }

    getSources() {
        return ['opensubtitles'];
    }

    async search(query) {
        if (!this.enabled) return { subtitles: [] };

        const startedAt = Date.now();
        try {
            const subs = await this._searchSubtitles(query);
            this._recordRequest(true, Date.now() - startedAt, subs.length);
            return { subtitles: subs };
        } catch (err) {
            this._recordRequest(false, Date.now() - startedAt, 0, err);
            log('error', `[OpenSubtitlesProvider] Search failed: ${err.message}`);
            return { subtitles: [] };
        }
    }

    async _searchSubtitles(query) {
        const { imdbId, season, episode, languages } = query;
        if (!imdbId) return [];

        const numericId = imdbId.replace(/^tt/, '');

        let searchPath = `/search/imdbid-${numericId}`;
        if (season != null && episode != null) {
            searchPath = `/search/episode-${episode}/imdbid-${numericId}/season-${season}`;
        }

        // Add language filter if only 1 language requested (server-side filtering)
        // The legacy API only supports a single sublanguageid per request
        // For multiple languages, fetch all and filter client-side
        if (languages && languages.length === 1) {
            const langCode = this._toOsLangCode(languages[0]);
            if (langCode) {
                searchPath += `/sublanguageid-${langCode}`;
            }
        }

        const url = `${BASE_URL}${searchPath}`;
        log('debug', `[OpenSubtitlesProvider] Fetching: ${url}`);

        await this._throttle();
        const response = await fetch(url, {
            headers: {
                'X-User-Agent': USER_AGENT,
                'Accept': 'application/json'
            },
            signal: AbortSignal.timeout(TIMEOUT),
            redirect: 'follow'
        });

        if (!response.ok) {
            if (response.status === 404) {
                log('debug', `[OpenSubtitlesProvider] No results for ${imdbId}`);
                return [];
            }
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        if (!Array.isArray(data)) return [];

        const results = [];
        const seenIds = new Set();

        for (const entry of data) {
            const id = entry.IDSubtitleFile;
            if (!id || seenIds.has(id)) continue;
            seenIds.add(id);

            const iso639 = (entry.ISO639 || '').toLowerCase();
            const langEntry = getByAnyCode(iso639);
            const alpha2 = langEntry ? langEntry.alpha2 : iso639;
            const alpha3B = langEntry ? langEntry.alpha3B : (toAlpha3B(iso639) || iso639);

            // Client-side language filter (for >1 languages since server only filters single lang)
            if (languages && languages.length > 1) {
                const matchesFilter = languages.some(l => {
                    const lAlpha2 = toAlpha2(l) || l;
                    return lAlpha2 === alpha2;
                });
                if (!matchesFilter) continue;
            }

            const downloadUrl = this._buildDownloadUrl(entry.SubDownloadLink);
            const fmt = (entry.SubFormat || 'srt').toLowerCase();

            results.push(new SubtitleResult({
                id: `os-${id}`,
                url: `${downloadUrl}.${fmt}`,
                language: alpha2,
                languageCode: alpha3B,
                source: 'opensubtitles',
                provider: 'opensubtitles',
                releaseName: entry.MovieReleaseName || '',
                fileName: entry.SubFileName || null,
                hearingImpaired: entry.SubHearingImpaired === '1',
                rating: entry.SubRating !== '0.0' ? parseFloat(entry.SubRating) : null,
                downloadCount: parseInt(entry.SubDownloadsCnt) || null,
                display: langEntry ? langEntry.name : getDisplayName(iso639),
                format: fmt,
                needsConversion: false
            }));
        }

        log('info', `[OpenSubtitlesProvider] ${imdbId} S${season || '-'}E${episode || '-'}: ${results.length} subtitles`);
        return results;
    }

    /**
     * Build a UTF-8 direct download URL from the raw SubDownloadLink.
     * Raw:  https://dl.opensubtitles.org/en/download/src-api/vrf-{vrf}/file/{id}.gz
     * UTF8: https://dl.opensubtitles.org/en/download/subencoding-utf8/src-api/vrf-{vrf}/file/{id}
     */
    _buildDownloadUrl(rawUrl) {
        if (!rawUrl) return null;
        return rawUrl
            .replace(/\.gz$/, '')
            .replace('/download/', '/download/subencoding-utf8/');
    }

    /**
     * Convert any language code to OpenSubtitles 3-letter format.
     * OS uses ISO 639-2/B but with some non-standard codes (pob, scc, etc.)
     */
    _toOsLangCode(code) {
        if (!code) return null;
        const lower = code.toLowerCase();

        const OS_SPECIAL = {
            'pt-br': 'pob',
            'pb': 'pob',
            'zh-tw': 'zht',
            'zh-cn': 'zho',
            'sr': 'scc',
            'no': 'nor',
            'nb': 'nor'
        };
        if (OS_SPECIAL[lower]) return OS_SPECIAL[lower];

        const alpha3 = toAlpha3B(lower);
        if (alpha3) return alpha3;

        if (lower.length === 3) return lower;

        return null;
    }

    /**
     * Throttle to avoid hammering the API
     */
    async _throttle() {
        const now = Date.now();
        const elapsed = now - this._lastRequestAt;
        if (elapsed < REQUEST_DELAY_MS) {
            await new Promise(r => setTimeout(r, REQUEST_DELAY_MS - elapsed));
        }
        this._lastRequestAt = Date.now();
    }
}

module.exports = OpenSubtitlesProvider;

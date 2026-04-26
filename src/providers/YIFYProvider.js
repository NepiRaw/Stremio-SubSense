'use strict';

const cheerio = require('cheerio');
const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { log } = require('../utils');
const { getByYifyCode, getDisplayName, toAlpha2 } = require('../languages');

const BASE_URL = 'https://yts-subs.com';
const TIMEOUT = 15000;

/**
 * YIFY is movie-only and ignores the language list (one fetch returns all
 * languages). Language filtering happens downstream in ResponseCache.
 */
class YIFYProvider extends BaseProvider {
    constructor(options = {}) {
        super('yify', options);
        this.supportedTypes = ['movie'];
        this.baseUrl = options.baseUrl || process.env.SUBSENSE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3100}`;
    }

    getSources() {
        return ['yts-subs.com'];
    }

    async search(query) {
        if (!this.enabled) return { subtitles: [] };
        if (query.season != null || query.episode != null) return { subtitles: [] };

        const startedAt = Date.now();
        try {
            const subs = await this._searchSubtitles(query.imdbId, null);
            this._recordRequest(true, Date.now() - startedAt, subs.length);
            return { subtitles: subs };
        } catch (err) {
            this._recordRequest(false, Date.now() - startedAt, 0, err);
            return { subtitles: [] };
        }
    }

    async _searchSubtitles(imdbId, languageFilter = null) {
        const movieUrl = `${BASE_URL}/movie-imdb/${imdbId}`;
        log('debug', `[YIFYProvider] Fetching: ${movieUrl}`);

        const response = await fetch(movieUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(TIMEOUT)
        });

        if (!response.ok) {
            if (response.status === 404) { log('debug', `[YIFYProvider] Movie not found: ${imdbId}`); return []; }
            throw new Error(`HTTP ${response.status}`);
        }

        const html = await response.text();
        const $ = cheerio.load(html);
        const results = [];

        $('table.other-subs tbody tr, table tbody tr').each((i, row) => {
            try {
                const $row = $(row);
                const $link = $row.find('a[href*="/subtitles/"]').first();
                const href = $link.attr('href');
                if (!href) return;

                const langText = $row.find('.sub-lang').text().trim().toLowerCase();
                const langEntry = getByYifyCode(langText);
                const langInfo = langEntry
                    ? { code: langEntry.alpha2, display: langEntry.name }
                    : { code: langText.substring(0, 2), display: langText.charAt(0).toUpperCase() + langText.slice(1) };

                if (languageFilter) {
                    const filterLower = languageFilter.toLowerCase();
                    if (langText !== filterLower && langInfo.code !== filterLower && !langText.includes(filterLower)) return;
                }

                const ratingText = $row.find('.rating-cell, td:nth-child(3)').text().trim();
                const rating = parseInt(ratingText) || null;

                const idMatch = href.match(/subtitles\/([^/]+)$/);
                const subtitleId = idMatch ? idMatch[1] : `yify-${i}`;
                const proxyUrl = `${this.baseUrl}/api/yify/proxy/${subtitleId}`;

                results.push(new SubtitleResult({
                    id: `yify-${subtitleId}`,
                    url: proxyUrl,
                    language: langInfo.code,
                    languageCode: langInfo.code,
                    source: 'yts-subs',
                    provider: 'yify',
                    releaseName: this._extractReleaseName(subtitleId),
                    rating,
                    display: langInfo.display,
                    format: 'srt',
                    needsConversion: false
                }));
            } catch (err) {
                log('debug', `[YIFYProvider] Error parsing row: ${err.message}`);
            }
        });

        return results;
    }

    async getDownloadUrl(subtitlePageUrl) {
        log('debug', `[YIFYProvider] Getting download URL from: ${subtitlePageUrl}`);
        const response = await fetch(subtitlePageUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(TIMEOUT)
        });
        if (!response.ok) throw new Error(`Failed to fetch subtitle page: HTTP ${response.status}`);

        const html = await response.text();
        const $ = cheerio.load(html);
        const downloadBtn = $('a.download-subtitle, a[data-link]').first();
        const dataLink = downloadBtn.attr('data-link');
        if (!dataLink) throw new Error('No data-link attribute found on subtitle page');

        const downloadUrl = Buffer.from(dataLink, 'base64').toString('utf-8');
        log('debug', `[YIFYProvider] Decoded download URL: ${downloadUrl}`);
        return downloadUrl;
    }

    _extractReleaseName(subtitleId) {
        const parts = subtitleId.split('-');
        if (parts.length >= 3) {
            const nameParts = parts.slice(0, -3);
            return nameParts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
        }
        return subtitleId;
    }
}

module.exports = YIFYProvider;

'use strict';

const cheerio = require('cheerio');
const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { log } = require('../utils');
const { getByTvsubtitlesCode, toTvsubtitlesCode, getDisplayName, toAlpha2 } = require('../languages');

const BASE_URL = 'http://www.tvsubtitles.net';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';
const TIMEOUT = 15000;

class TVsubtitlesProvider extends BaseProvider {
    constructor(options = {}) {
        super('tvsubtitles', options);
        this.supportedTypes = ['series'];
        this.baseUrl = options.baseUrl || process.env.SUBSENSE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3100}`;
        this._showIdCache = new Map();
    }

    getSources() {
        return ['tvsubtitles.net'];
    }

    /**
     * V2 search interface — maps languages[] to per-lang internal calls.
     */
    async search(query) {
        if (!this.enabled) return { subtitles: [] };
        if (query.season == null || query.episode == null) return { subtitles: [] };

        const languages = Array.isArray(query.languages) && query.languages.length > 0
            ? query.languages
            : [null];

        const startedAt = Date.now();
        try {
            const perLang = await Promise.all(
                languages.map((lang) => this._searchInternal(
                    query.imdbId, query.season, query.episode, lang
                ))
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
     * Internal search for a single language.
     */
    async _searchInternal(imdbId, season, episode, languageFilter = null) {
        const seriesName = await this._getSeriesTitle(imdbId);
        if (!seriesName) {
            log('debug', `[TVsubtitlesProvider] Could not get series title for ${imdbId}`);
            return [];
        }
        log('debug', `[TVsubtitlesProvider] Series name: ${seriesName}`);

        const showId = await this._getShowId(seriesName);
        if (!showId) {
            log('debug', `[TVsubtitlesProvider] Show not found: ${seriesName}`);
            return [];
        }
        log('debug', `[TVsubtitlesProvider] Show ID: ${showId}`);

        return await this._getEpisodeSubtitles(showId, season, episode, languageFilter);
    }

    async _getSeriesTitle(imdbId) {
        try {
            const url = `${CINEMETA_URL}/series/${imdbId}.json`;
            const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
            if (!response.ok) return null;
            const data = await response.json();
            return data.meta?.name || null;
        } catch (error) {
            log('debug', `[TVsubtitlesProvider] Cinemeta error: ${error.message}`);
            return null;
        }
    }

    _calculateSimilarity(str1, str2) {
        if (!str1 || !str2) return 0;
        const s1 = str1.toLowerCase().trim();
        const s2 = str2.toLowerCase().trim();
        if (s1 === s2) return 1;
        if (s1.length < 2 || s2.length < 2) return 0;
        const getBigrams = (str) => {
            const bigrams = new Set();
            for (let i = 0; i < str.length - 1; i++) bigrams.add(str.substring(i, i + 2));
            return bigrams;
        };
        const bigrams1 = getBigrams(s1);
        const bigrams2 = getBigrams(s2);
        let intersection = 0;
        for (const bigram of bigrams1) { if (bigrams2.has(bigram)) intersection++; }
        return (2 * intersection) / (bigrams1.size + bigrams2.size);
    }

    async _getShowId(seriesName) {
        if (this._showIdCache.has(seriesName)) return this._showIdCache.get(seriesName);

        try {
            const response = await fetch(`${BASE_URL}/search.php`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                body: `qs=${encodeURIComponent(seriesName)}`,
                signal: AbortSignal.timeout(TIMEOUT)
            });

            const html = await response.text();
            const $ = cheerio.load(html);
            const showLinks = [];

            $('a[href^="/tvshow-"]').each((i, el) => {
                const href = $(el).attr('href');
                const text = $(el).text().trim();
                const showName = text.replace(/\s*\(\d{4}-\d{4}\)\s*$/, '').trim();
                const match = href.match(/tvshow-(\d+)/);
                if (match) {
                    showLinks.push({
                        showId: match[1], href, text, showName,
                        similarity: this._calculateSimilarity(seriesName, showName)
                    });
                }
            });

            if (showLinks.length === 0) return null;

            showLinks.sort((a, b) => b.similarity - a.similarity);
            const bestMatch = showLinks[0];
            const SIMILARITY_THRESHOLD = 0.5;
            if (bestMatch.similarity < SIMILARITY_THRESHOLD) {
                log('debug', `[TVsubtitlesProvider] Best match "${bestMatch.showName}" has low similarity (${(bestMatch.similarity * 100).toFixed(1)}%) - rejecting`);
                return null;
            }

            log('debug', `[TVsubtitlesProvider] Matched "${seriesName}" to "${bestMatch.showName}" (${(bestMatch.similarity * 100).toFixed(1)}%)`);
            this._showIdCache.set(seriesName, bestMatch.showId);
            return bestMatch.showId;
        } catch (error) {
            log('debug', `[TVsubtitlesProvider] Show search error: ${error.message}`);
            return null;
        }
    }

    async _getEpisodeSubtitles(showId, season, episode, languageFilter = null) {
        const seasonUrl = `${BASE_URL}/tvshow-${showId}-${season}.html`;
        log('debug', `[TVsubtitlesProvider] Fetching season page: ${seasonUrl}`);

        const response = await fetch(seasonUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(TIMEOUT)
        });
        if (!response.ok) throw new Error(`Season page returned ${response.status}`);

        const html = await response.text();
        const $ = cheerio.load(html);
        const results = [];
        const episodePattern = `${season}x${String(episode).padStart(2, '0')}`;

        $('tr').each((i, row) => {
            const $row = $(row);
            const firstTd = $row.find('td').first().text().trim();
            if (firstTd !== episodePattern) return;

            $row.find('img[src*="flags/"]').each((j, img) => {
                try {
                    const $img = $(img);
                    const flagSrc = $img.attr('src') || '';
                    const langMatch = flagSrc.match(/flags\/([a-z]+)\.gif/);
                    if (!langMatch) return;

                    const tvsLangCode = langMatch[1];
                    if (tvsLangCode === 'blank') return;

                    const langEntry = getByTvsubtitlesCode(tvsLangCode);
                    const langInfo = langEntry
                        ? { code: langEntry.alpha2, display: langEntry.name }
                        : { code: tvsLangCode, display: tvsLangCode.toUpperCase() };

                    if (languageFilter) {
                        const filterLower = languageFilter.toLowerCase();
                        const tvsFilterCode = toTvsubtitlesCode(filterLower) || filterLower;
                        if (tvsLangCode !== tvsFilterCode && langInfo.code !== filterLower) return;
                    }

                    const $link = $img.parent('a');
                    const href = $link.attr('href');
                    if (!href) return;

                    let subtitleType = 'unknown';
                    let subtitleId = null;

                    if (href.includes('episode-')) {
                        subtitleType = 'episode-page';
                        const match = href.match(/episode-(\d+)-/);
                        if (match) subtitleId = match[1];
                    } else if (href.includes('subtitle-')) {
                        subtitleType = 'subtitle-direct';
                        const match = href.match(/subtitle-(\d+)/);
                        if (match) subtitleId = match[1];
                    }
                    if (!subtitleId) return;

                    const fullUrl = href.startsWith('http') ? href : `${BASE_URL}/${href}`;
                    let proxyUrl = `${this.baseUrl}/api/tvsubtitles/proxy/${subtitleId}?lang=${tvsLangCode}`;
                    if (subtitleType === 'episode-page') {
                        proxyUrl += `&episodeUrl=${encodeURIComponent(fullUrl)}`;
                    }

                    const subtitleResult = new SubtitleResult({
                        id: `tvsubtitles-${subtitleId}-${tvsLangCode}`,
                        url: proxyUrl,
                        language: langInfo.code,
                        languageCode: langInfo.code,
                        source: 'tvsubtitles',
                        provider: 'tvsubtitles',
                        releaseName: `S${season}E${String(episode).padStart(2, '0')}`,
                        display: langInfo.display,
                        format: 'srt',
                        needsConversion: false
                    });
                    subtitleResult._tvsMetadata = { subtitleType, subtitleId, langCode: tvsLangCode };
                    results.push(subtitleResult);
                } catch (err) {
                    log('debug', `[TVsubtitlesProvider] Error parsing flag: ${err.message}`);
                }
            });
        });

        return results;
    }

    async getDownloadUrl(subtitle) {
        const metadata = subtitle._tvsMetadata;
        if (!metadata) throw new Error('No metadata available for download URL resolution');

        let finalSubtitleId = metadata.subtitleId;

        if (metadata.subtitleType === 'episode-page') {
            const episodeUrl = `${BASE_URL}/episode-${metadata.subtitleId}-${metadata.langCode}.html`;
            log('debug', `[TVsubtitlesProvider] Fetching episode page: ${episodeUrl}`);
            const response = await fetch(episodeUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                signal: AbortSignal.timeout(TIMEOUT)
            });
            const html = await response.text();
            const $ = cheerio.load(html);
            const subtitleLink = $('a[href*="/subtitle-"]').first().attr('href');
            if (!subtitleLink) throw new Error('No subtitle found on episode page');
            const match = subtitleLink.match(/subtitle-(\d+)/);
            if (!match) throw new Error('Could not parse subtitle ID');
            finalSubtitleId = match[1];
        }

        const downloadPageUrl = `${BASE_URL}/download-${finalSubtitleId}.html`;
        log('debug', `[TVsubtitlesProvider] Fetching download page: ${downloadPageUrl}`);
        const response = await fetch(downloadPageUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(TIMEOUT)
        });
        const html = await response.text();
        const jsMatch = html.match(/var\s+s1\s*=\s*['"]([^'"]+)['"][\s\S]*?var\s+s2\s*=\s*['"]([^'"]+)['"][\s\S]*?var\s+s3\s*=\s*['"]([^'"]+)['"][\s\S]*?var\s+s4\s*=\s*['"]([^'"]+)['"]/);
        if (!jsMatch) throw new Error('Could not parse download page JavaScript');
        const filename = jsMatch[1] + jsMatch[2] + jsMatch[3] + jsMatch[4];
        const downloadUrl = `${BASE_URL}/${filename}`;
        log('debug', `[TVsubtitlesProvider] Download URL: ${downloadUrl}`);
        return downloadUrl;
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

module.exports = TVsubtitlesProvider;

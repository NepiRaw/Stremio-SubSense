/**
 * TVsubtitlesProvider - Subtitle provider for TV series from TVsubtitles.net
 * 
 * Supports: TV Series only
 * Languages: Multiple (40+ languages)
 * 
 * URL Patterns:
 * - Season page: http://www.tvsubtitles.net/tvshow-{showId}-{season}.html
 * - Episode page: http://www.tvsubtitles.net/episode-{episodeId}-{lang}.html
 * - Download page: http://www.tvsubtitles.net/download-{subtitleId}.html
 * - Direct download: http://www.tvsubtitles.net/files/{filename}
 * 
 * Flow:
 * 1. Get series title from IMDB ID via Cinemeta
 * 2. POST search.php with series name to get show ID
 * 3. Fetch season page to find episode
 * 4. Navigate to get subtitle ID
 * 5. Parse download page JavaScript for direct file URL
 */

const cheerio = require('cheerio');
const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { log } = require('../utils');
const { getByTvsubtitlesCode, toTvsubtitlesCode, getDisplayName, toAlpha2 } = require('../languages');

const BASE_URL = 'http://www.tvsubtitles.net';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';
const TIMEOUT = 15000;

class TVsubtitlesProvider extends BaseProvider {
    /**
     * @param {Object} options
     * @param {boolean} options.enabled - Whether provider is enabled
     * @param {string} options.baseUrl - SubSense public URL for proxy
     */
    constructor(options = {}) {
        super('tvsubtitles', options);
        this.supportedTypes = ['series'];
        this.baseUrl = options.baseUrl || process.env.SUBSENSE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3100}`;
        
        // Cache show IDs to avoid repeated searches
        this._showIdCache = new Map();
    }

    /**
     * Get configured sources
     * @returns {Array<string>}
     */
    getSources() {
        return ['tvsubtitles.net'];
    }

    /**
     * Search for subtitles
     * 
     * @param {Object} query
     * @param {string} query.imdbId - IMDB ID
     * @param {number|null} query.season - Season number
     * @param {number|null} query.episode - Episode number
     * @param {string|null} query.language - Optional language filter (ISO 639-1)
     * @returns {Promise<Array<SubtitleResult>>}
     */
    async search(query) {
        if (!this.enabled) {
            log('debug', `[TVsubtitlesProvider] Provider is disabled`);
            return [];
        }

        // TVsubtitles only supports series
        if (query.season == null || query.episode == null) {
            log('debug', `[TVsubtitlesProvider] Skipping - requires season and episode`);
            return [];
        }

        const startTime = Date.now();

        try {
            const results = await this._searchSubtitles(
                query.imdbId, 
                query.season, 
                query.episode,
                query.language
            );
            
            const fetchTimeMs = Date.now() - startTime;
            this.updateStats(true, fetchTimeMs, results.length);
            
            log('debug', `[TVsubtitlesProvider] Found ${results.length} subtitles in ${fetchTimeMs}ms`);
            return results;

        } catch (error) {
            const fetchTimeMs = Date.now() - startTime;
            this.updateStats(false, fetchTimeMs, 0, error);
            log('error', `[TVsubtitlesProvider] Search failed: ${error.message}`);
            return [];
        }
    }

    /**
     * Internal search implementation
     * @private
     */
    async _searchSubtitles(imdbId, season, episode, languageFilter = null) {
        // Step 1: Get series title from Cinemeta
        const seriesName = await this._getSeriesTitle(imdbId);
        if (!seriesName) {
            log('debug', `[TVsubtitlesProvider] Could not get series title for ${imdbId}`);
            return [];
        }

        log('debug', `[TVsubtitlesProvider] Series name: ${seriesName}`);

        // Step 2: Search for show and get show ID
        const showId = await this._getShowId(seriesName);
        if (!showId) {
            log('debug', `[TVsubtitlesProvider] Show not found: ${seriesName}`);
            return [];
        }

        log('debug', `[TVsubtitlesProvider] Show ID: ${showId}`);

        // Step 3: Get season page and parse episode subtitles
        const results = await this._getEpisodeSubtitles(showId, season, episode, languageFilter);
        
        return results;
    }

    /**
     * Get series title from IMDB ID via Cinemeta
     * @private
     */
    async _getSeriesTitle(imdbId) {
        try {
            const url = `${CINEMETA_URL}/series/${imdbId}.json`;
            const response = await fetch(url, {
                signal: AbortSignal.timeout(TIMEOUT)
            });

            if (!response.ok) {
                return null;
            }

            const data = await response.json();
            return data.meta?.name || null;
        } catch (error) {
            log('debug', `[TVsubtitlesProvider] Cinemeta error: ${error.message}`);
            return null;
        }
    }

    /**
     * Calculate similarity between two strings (Dice coefficient)
     * @private
     */
    _calculateSimilarity(str1, str2) {
        if (!str1 || !str2) return 0;
        
        const s1 = str1.toLowerCase().trim();
        const s2 = str2.toLowerCase().trim();
        
        if (s1 === s2) return 1;
        if (s1.length < 2 || s2.length < 2) return 0;
        
        // Create bigrams
        const getBigrams = (str) => {
            const bigrams = new Set();
            for (let i = 0; i < str.length - 1; i++) {
                bigrams.add(str.substring(i, i + 2));
            }
            return bigrams;
        };
        
        const bigrams1 = getBigrams(s1);
        const bigrams2 = getBigrams(s2);
        
        let intersection = 0;
        for (const bigram of bigrams1) {
            if (bigrams2.has(bigram)) intersection++;
        }
        
        return (2 * intersection) / (bigrams1.size + bigrams2.size);
    }

    /**
     * Search for show and get show ID
     * @private
     */
    async _getShowId(seriesName) {
        // Check cache first
        if (this._showIdCache.has(seriesName)) {
            return this._showIdCache.get(seriesName);
        }

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

            // Find all show links and pick the best match
            const showLinks = [];
            $('a[href^="/tvshow-"]').each((i, el) => {
                const href = $(el).attr('href');
                const text = $(el).text().trim();
                // Extract just the show name (remove year range like "2008-2009")
                const showName = text.replace(/\s*\(\d{4}-\d{4}\)\s*$/, '').trim();
                const match = href.match(/tvshow-(\d+)/);
                if (match) {
                    showLinks.push({
                        showId: match[1],
                        href,
                        text,
                        showName,
                        similarity: this._calculateSimilarity(seriesName, showName)
                    });
                }
            });

            if (showLinks.length === 0) {
                return null;
            }

            // Sort by similarity and pick the best match
            showLinks.sort((a, b) => b.similarity - a.similarity);
            const bestMatch = showLinks[0];

            // Require at least 50% similarity to avoid completely wrong matches
            const SIMILARITY_THRESHOLD = 0.5;
            if (bestMatch.similarity < SIMILARITY_THRESHOLD) {
                log('debug', `[TVsubtitlesProvider] Best match "${bestMatch.showName}" has low similarity (${(bestMatch.similarity * 100).toFixed(1)}%) to "${seriesName}" - rejecting`);
                return null;
            }

            log('debug', `[TVsubtitlesProvider] Matched "${seriesName}" to "${bestMatch.showName}" (${(bestMatch.similarity * 100).toFixed(1)}% similarity)`);

            const showId = bestMatch.showId;
            this._showIdCache.set(seriesName, showId);
            return showId;

        } catch (error) {
            log('debug', `[TVsubtitlesProvider] Show search error: ${error.message}`);
            return null;
        }
    }

    /**
     * Get episode subtitles from season page
     * @private
     */
    async _getEpisodeSubtitles(showId, season, episode, languageFilter = null) {
        const seasonUrl = `${BASE_URL}/tvshow-${showId}-${season}.html`;
        log('debug', `[TVsubtitlesProvider] Fetching season page: ${seasonUrl}`);

        const response = await fetch(seasonUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            signal: AbortSignal.timeout(TIMEOUT)
        });

        if (!response.ok) {
            throw new Error(`Season page returned ${response.status}`);
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        const results = [];
        const episodePattern = `${season}x${String(episode).padStart(2, '0')}`;

        // Find the correct episode row
        $('tr').each((i, row) => {
            const $row = $(row);
            const firstTd = $row.find('td').first().text().trim();

            if (firstTd !== episodePattern) return;

            // Found the episode row - parse all language flags
            // Each flag links to either:
            // - episode-{id}-{lang}.html (multiple subs for this language)
            // - subtitle-{id}.html (single sub, flag indicates language)
            
            $row.find('img[src*="flags/"]').each((j, img) => {
                try {
                    const $img = $(img);
                    const flagSrc = $img.attr('src') || '';
                    const langMatch = flagSrc.match(/flags\/([a-z]+)\.gif/);
                    
                    if (!langMatch) return;
                    
                    const tvsLangCode = langMatch[1];
                    if (tvsLangCode === 'blank') return; // Skip blank flags
                    
                    const langEntry = getByTvsubtitlesCode(tvsLangCode);
                    const langInfo = langEntry 
                        ? { code: langEntry.alpha2, display: langEntry.name }
                        : { code: tvsLangCode, display: tvsLangCode.toUpperCase() };

                    if (languageFilter) {
                        const filterLower = languageFilter.toLowerCase();
                        const tvsFilterCode = toTvsubtitlesCode(filterLower) || filterLower;
                        if (tvsLangCode !== tvsFilterCode && langInfo.code !== filterLower) {
                            return;
                        }
                    }

                    const $link = $img.parent('a');
                    const href = $link.attr('href');

                    if (!href) return;

                    let subtitleType = 'unknown';
                    let subtitleId = null;

                    if (href.includes('episode-')) {
                        // Multiple subtitles available - links to episode-{id}-{lang}.html
                        subtitleType = 'episode-page';
                        const match = href.match(/episode-(\d+)-/);
                        if (match) subtitleId = match[1];
                    } else if (href.includes('subtitle-')) {
                        // Single subtitle - links directly to subtitle-{id}.html
                        subtitleType = 'subtitle-direct';
                        const match = href.match(/subtitle-(\d+)/);
                        if (match) subtitleId = match[1];
                    }

                    if (!subtitleId) return;

                    const fullUrl = href.startsWith('http') ? href : `${BASE_URL}/${href}`;

                    // Build proxy URL with episodeUrl if needed
                    let proxyUrl = `${this.baseUrl}/api/tvsubtitles/proxy/${subtitleId}?lang=${tvsLangCode}`;
                    if (subtitleType === 'episode-page') {
                        // For episode pages, we need to pass the URL so the proxy can resolve the subtitle
                        proxyUrl += `&episodeUrl=${encodeURIComponent(fullUrl)}`;
                    }

                    // Create the subtitle result
                    const subtitleResult = new SubtitleResult({
                        id: `tvsubtitles-${subtitleId}-${tvsLangCode}`,
                        // URL points to our proxy endpoint which handles all the heavy lifting
                        url: proxyUrl,
                        language: langInfo.code,
                        languageCode: langInfo.code,
                        source: 'tvsubtitles',
                        provider: 'tvsubtitles',
                        releaseName: `S${season}E${String(episode).padStart(2, '0')}`,
                        display: langInfo.display,
                        format: 'srt',  // TVsubtitles typically provides SRT in ZIP
                        needsConversion: false
                    });
                    
                    // Store metadata for download URL resolution (as a direct property)
                    subtitleResult._tvsMetadata = {
                        subtitleType,
                        subtitleId,
                        langCode: tvsLangCode
                    };
                    
                    results.push(subtitleResult);

                } catch (err) {
                    log('debug', `[TVsubtitlesProvider] Error parsing flag: ${err.message}`);
                }
            });
        });

        return results;
    }

    /**
     * Get direct download URL for a subtitle
     * 
     * @param {SubtitleResult} subtitle - Subtitle result with _tvsMetadata
     * @returns {Promise<string>} Direct download URL
     */
    async getDownloadUrl(subtitle) {
        const metadata = subtitle._tvsMetadata;
        
        if (!metadata) {
            throw new Error('No metadata available for download URL resolution');
        }

        let finalSubtitleId = metadata.subtitleId;

        // If this is an episode page, we need to fetch it to get actual subtitle ID
        if (metadata.subtitleType === 'episode-page') {
            const episodeUrl = `${BASE_URL}/episode-${metadata.subtitleId}-${metadata.langCode}.html`;
            log('debug', `[TVsubtitlesProvider] Fetching episode page: ${episodeUrl}`);

            const response = await fetch(episodeUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                signal: AbortSignal.timeout(TIMEOUT)
            });

            const html = await response.text();
            const $ = cheerio.load(html);

            // Get first subtitle link
            const subtitleLink = $('a[href*="/subtitle-"]').first().attr('href');
            if (!subtitleLink) {
                throw new Error('No subtitle found on episode page');
            }

            const match = subtitleLink.match(/subtitle-(\d+)/);
            if (!match) {
                throw new Error('Could not parse subtitle ID');
            }

            finalSubtitleId = match[1];
        }

        // Fetch download page and parse JavaScript
        const downloadPageUrl = `${BASE_URL}/download-${finalSubtitleId}.html`;
        log('debug', `[TVsubtitlesProvider] Fetching download page: ${downloadPageUrl}`);

        const response = await fetch(downloadPageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            signal: AbortSignal.timeout(TIMEOUT)
        });

        const html = await response.text();

        // Parse JavaScript to extract filename
        // Pattern: var s1= 'fil'; var s2= 'es/B'; var s3= 're'; var s4= 'aking Bad_1x01_es.zip';
        const jsMatch = html.match(/var\s+s1\s*=\s*['"]([^'"]+)['"][\s\S]*?var\s+s2\s*=\s*['"]([^'"]+)['"][\s\S]*?var\s+s3\s*=\s*['"]([^'"]+)['"][\s\S]*?var\s+s4\s*=\s*['"]([^'"]+)['"]/);

        if (!jsMatch) {
            throw new Error('Could not parse download page JavaScript');
        }

        const filename = jsMatch[1] + jsMatch[2] + jsMatch[3] + jsMatch[4];
        const downloadUrl = `${BASE_URL}/${filename}`;

        log('debug', `[TVsubtitlesProvider] Download URL: ${downloadUrl}`);
        return downloadUrl;
    }
}

module.exports = TVsubtitlesProvider;

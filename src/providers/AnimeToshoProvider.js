'use strict';

/**
 * AnimeTosho subtitle provider.
 *
 * Fetches anime subtitles embedded in MKV releases from AnimeTosho.ORG.
 * Uses purely ID-based resolution (no title matching):
 *   IMDB → Fribb anime-lists → AniDB ID → AniDB HTTP API → eid → AT ?eids=
 *
 * Fallback: when eid mismatch occurs (AniDB eids differ from AT's indexed eids),
 * falls back to ?aids= + episode filtering via title parsing.
 *
 * Movies use ?aids= (AniDB anime ID) directly.
 */

const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { log } = require('../utils');
const { getAnidbIdForImdb, getAnimeListReady, isAnime } = require('../utils/animeLists');
const { getEpisodeId, isAnidbConfigured } = require('../utils/anidbApi');
const { searchByEpisodeId, searchByAnidbId, getTorrentDetail, buildProxyUrl } = require('../utils/animetoshoApi');
const { getByAlpha3B, getDisplayName, toAlpha3B } = require('../languages');

const SEARCH_THRESHOLD = parseInt(process.env.ANIMETOSHO_SEARCH_THRESHOLD, 10) || 6;

let filenameParse = null;
async function getParser() {
    if (!filenameParse) {
        const module = await import('@ctrl/video-filename-parser');
        filenameParse = module.filenameParse;
    }
    return filenameParse;
}

class AnimeToshoProvider extends BaseProvider {
    constructor(options = {}) {
        super('animetosho', options);
        this.baseUrl = options.baseUrl || process.env.SUBSENSE_BASE_URL ||
                       `http://127.0.0.1:${process.env.PORT || 3100}`;
        this._subtitleCache = new Map();
        this._cacheMaxAge = 3600000; // 1 hour
        this._cacheMaxSize = 200;
    }

    getSources() {
        return ['animetosho'];
    }

    async search(query) {
        if (!this.enabled) return { subtitles: [] };
        if (!query.imdbId) return { subtitles: [] };

        if (!getAnimeListReady()) return { subtitles: [] };

        if (!isAnime(query.imdbId)) return { subtitles: [] };

        const mapping = getAnidbIdForImdb(query.imdbId, query.season);
        if (!mapping) return { subtitles: [] };

        const cacheKey = `${query.imdbId}:${query.season || 0}:${query.episode || 0}`;
        const cached = this._getFromCache(cacheKey);
        if (cached) {
            const filtered = this._filterByLanguages(cached, query.languages);
            log('debug', `[AnimeTosho] Cache hit: ${cached.length} total, ${filtered.length} after lang filter`);
            return { subtitles: filtered };
        }

        const startedAt = Date.now();
        try {
            let subtitles;
            if (query.season != null && query.episode != null) {
                subtitles = await this._searchEpisode(query, mapping, cacheKey);
            } else {
                subtitles = await this._searchMovie(query, mapping, cacheKey);
            }
            this._recordRequest(true, Date.now() - startedAt, subtitles.length);
            return { subtitles };
        } catch (err) {
            this._recordRequest(false, Date.now() - startedAt, 0, err);
            log('error', `[AnimeTosho] Search failed: ${err.message}`);
            return { subtitles: [] };
        }
    }

    _getFromCache(key) {
        const entry = this._subtitleCache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > this._cacheMaxAge) {
            this._subtitleCache.delete(key);
            return null;
        }
        return entry.subtitles;
    }

    _putInCache(key, subtitles) {
        if (this._subtitleCache.size >= this._cacheMaxSize) {
            const firstKey = this._subtitleCache.keys().next().value;
            this._subtitleCache.delete(firstKey);
        }
        this._subtitleCache.set(key, { subtitles, timestamp: Date.now() });
    }

    _filterByLanguages(subtitles, languages) {
        if (!languages || languages.length === 0) return subtitles;
        return subtitles.filter(s => languages.includes(s.language));
    }

    async _searchEpisode(query, mapping, cacheKey) {
        if (!isAnidbConfigured()) {
            log('debug', '[AnimeTosho] AniDB not configured — skipping TV episode search');
            return [];
        }

        const { anidbId, episodeOffset } = mapping;
        const episodeNum = query.episode - episodeOffset;

        if (episodeNum < 1) {
            log('warn', `[AnimeTosho] Episode ${query.episode} with offset ${episodeOffset} = ${episodeNum} (invalid)`);
            return [];
        }

        // 1. Get eid from AniDB (cached in SQLite)
        const eid = await getEpisodeId(anidbId, episodeNum);
        if (!eid) {
            log('debug', `[AnimeTosho] No eid for AniDB ${anidbId} ep ${episodeNum}`);
            return [];
        }

        // 2. Search AT by eid (most precise)
        let entries = await searchByEpisodeId(eid);

        // 3. Fallback: eid mismatch — AT may have indexed different eids than AniDB
        if (!entries.length) {
            log('info', `[AnimeTosho] eid ${eid} returned 0 results, falling back to aids=${anidbId} + episode filter`);
            const allEntries = await searchByAnidbId(anidbId);
            entries = await this._filterEntriesByEpisode(allEntries, query.season, episodeNum);
            log('debug', `[AnimeTosho] Fallback filtered ${allEntries.length} → ${entries.length} entries for S${query.season}E${episodeNum}`);
        }

        if (!entries.length) return [];

        // 4. Fetch details with early exit, background fetches ALL remaining
        return this._fetchSubtitlesFromEntries(entries, query, cacheKey);
    }

    async _searchMovie(query, mapping, cacheKey) {
        const { anidbId } = mapping;

        // For movies: search AT by AniDB anime ID
        const entries = await searchByAnidbId(anidbId);
        if (!entries.length) return [];

        return this._fetchSubtitlesFromEntries(entries, query, cacheKey);
    }

    async _fetchSubtitlesFromEntries(entries, query, cacheKey) {
        const topEntries = entries.slice(0, SEARCH_THRESHOLD);
        const subtitles = [];
        const seenAttachments = new Set();

        for (let i = 0; i < topEntries.length; i++) {
            const entry = topEntries[i];
            const detail = await getTorrentDetail(entry.id);
            if (!detail) continue;

            const allResults = this._buildSubtitleResults(detail, entry, null, seenAttachments);
            subtitles.push(...allResults);

            // Early exit: if we found matching subs for the requested language
            const matchingLang = this._filterByLanguages(subtitles, query.languages);
            if (matchingLang.length > 0 && i < topEntries.length - 1) {
                // Background fetches ALL remaining entries
                const remaining = entries.slice(i + 1);
                this._fetchRemainingInBackground(remaining, seenAttachments, subtitles, cacheKey);
                return matchingLang;
            }
        }

        // If we exhausted the top entries without early exit, background fetches the rest
        if (entries.length > SEARCH_THRESHOLD) {
            const remaining = entries.slice(SEARCH_THRESHOLD);
            this._fetchRemainingInBackground(remaining, seenAttachments, subtitles, cacheKey);
        } else {
            this._putInCache(cacheKey, subtitles);
        }

        return this._filterByLanguages(subtitles, query.languages);
    }

    /**
     * Continue fetching ALL remaining torrent details in the background.
     * Does NOT filter by language — caches all subtitles for future requests.
     */
    _fetchRemainingInBackground(entries, seenAttachments, subtitles, cacheKey) {
        const bgStart = Date.now();
        (async () => {
            for (const entry of entries) {
                try {
                    const detail = await getTorrentDetail(entry.id);
                    if (!detail) continue;
                    const results = this._buildSubtitleResults(detail, entry, null, seenAttachments);
                    subtitles.push(...results);
                } catch (err) {
                    log('debug', `[AnimeTosho] Background fetch ${entry.id} failed: ${err.message}`);
                }
            }
            // Cache ALL subtitles (all languages) for future requests
            this._putInCache(cacheKey, subtitles);
            const langs = [...new Set(subtitles.map(s => s.language))].join(',');
            log('info', `[AnimeTosho] Background done for ${cacheKey}: ${subtitles.length} subs (${langs}) in ${((Date.now() - bgStart) / 1000).toFixed(1)}s`);
        })().catch(err => log('error', `[AnimeTosho] Background fetch error: ${err.message}`));
    }

    /**
     * Filter entries from ?aids= response by episode number using title parsing.
     * Uses @ctrl/video-filename-parser + fallback regex for anime-style titles.
     */
    async _filterEntriesByEpisode(entries, season, episodeNum) {
        const parse = await getParser();
        const matched = [];

        for (const entry of entries) {
            if (!entry.title) continue;

            // Parse title with video-filename-parser
            try {
                const parsed = parse(entry.title, true);
                if (parsed && parsed.episodeNumbers && parsed.episodeNumbers.length > 0) {
                    if (parsed.episodeNumbers.includes(episodeNum)) {
                        matched.push(entry);
                        continue;
                    }
                    continue;
                }
            } catch (e) { }

            // Method 3: Regex fallback for anime-style naming (e.g., "- 01", "Episode 01", "E01")
            if (this._titleMatchesEpisode(entry.title, season, episodeNum)) {
                matched.push(entry);
            }
        }

        return matched;
    }

    /**
     * Regex fallback for episode matching in anime titles.
     * Matches patterns like: S01E01, "- 01", "Episode 01", "Ep 01", "E01"
     */
    _titleMatchesEpisode(title, season, episodeNum) {
        const epStr = String(episodeNum).padStart(2, '0');
        const epNum = String(episodeNum);
        const seasonStr = season != null ? String(season).padStart(2, '0') : null;

        if (seasonStr) {
            const sxex = new RegExp(`S${seasonStr}E${epStr}\\b`, 'i');
            if (sxex.test(title)) return true;
        }

        const dashEp = new RegExp(`\\s-\\s0*${epNum}\\s*(?:[\\[\\(v]|$)`, 'i');
        if (dashEp.test(title)) return true;

        const epWord = new RegExp(`\\b(?:Episode|Ep)\\s*0*${epNum}\\b`, 'i');
        if (epWord.test(title)) return true;

        return false;
    }

    /**
     * Build SubtitleResult objects from a torrent detail response.
     * Deduplicates by attachment ID across entries.
     */
    _buildSubtitleResults(detail, entry, query, seenAttachments) {
        const results = [];
        const files = detail.files || [];

        for (const file of files) {
            const attachments = file.attachments || [];
            const subs = attachments.filter(a => a.type === 'subtitle');

            for (const sub of subs) {
                if (seenAttachments.has(sub.id)) continue;
                seenAttachments.add(sub.id);

                const langCode = sub.info?.lang;
                if (!langCode) continue;

                const langEntry = getByAlpha3B(langCode);
                const alpha2 = langEntry ? langEntry.alpha2 : null;
                const alpha3B = langEntry ? langEntry.alpha3B : langCode;

                const codec = (sub.info?.codec || '').toLowerCase();
                const format = codec === 'ass' || codec === 'ssa' ? 'ass' :
                              codec === 'srt' ? 'srt' :
                              codec === 'webvtt' ? 'vtt' : codec || 'unknown';

                const keepAss = query && query.keepAss;
                const outputFmt = (format === 'ass' && keepAss) ? 'ass' : 'vtt';
                const proxyUrl = buildProxyUrl(this.baseUrl, sub.id, outputFmt);

                const trackName = (sub.info?.name || '').toLowerCase();
                const hearingImpaired = trackName.includes('sdh') ||
                                       trackName.includes('hearing') ||
                                       trackName.includes('cc');

                const displayName = langEntry ? getDisplayName(alpha2) : langCode;

                results.push(new SubtitleResult({
                    id: `animetosho-${sub.id}`,
                    url: proxyUrl,
                    language: alpha2 || langCode,
                    languageCode: alpha3B,
                    source: 'animetosho',
                    provider: 'animetosho',
                    releaseName: entry.title || '',
                    fileName: file.filename || null,
                    releases: [entry.title || ''],
                    hearingImpaired,
                    format,
                    needsConversion: format === 'ass',
                    display: displayName
                }));
            }
        }

        return results;
    }
}

module.exports = AnimeToshoProvider;

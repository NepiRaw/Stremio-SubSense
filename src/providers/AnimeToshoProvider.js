'use strict';

/**
 * AnimeTosho subtitle provider.
 *
 * Fetches anime subtitles embedded in MKV releases from AnimeTosho.ORG.
 * Uses purely ID-based resolution (no title matching):
 *   IMDB → Fribb anime-lists → AniDB ID → AniDB HTTP API → eid → AT ?eids=
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

class AnimeToshoProvider extends BaseProvider {
    constructor(options = {}) {
        super('animetosho', options);
        this.baseUrl = options.baseUrl || process.env.SUBSENSE_BASE_URL ||
                       `http://127.0.0.1:${process.env.PORT || 3100}`;
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

        const startedAt = Date.now();
        try {
            let subtitles;
            if (query.season != null && query.episode != null) {
                subtitles = await this._searchEpisode(query, mapping);
            } else {
                subtitles = await this._searchMovie(query, mapping);
            }
            this._recordRequest(true, Date.now() - startedAt, subtitles.length);
            return { subtitles };
        } catch (err) {
            this._recordRequest(false, Date.now() - startedAt, 0, err);
            log('error', `[AnimeTosho] Search failed: ${err.message}`);
            return { subtitles: [] };
        }
    }

    async _searchEpisode(query, mapping) {
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

        // 2. Search AT by eid
        const entries = await searchByEpisodeId(eid);
        if (!entries.length) return [];

        // 3. Fetch details for top entries and extract subtitles
        return this._fetchSubtitlesFromEntries(entries, query);
    }

    async _searchMovie(query, mapping) {
        const { anidbId } = mapping;

        // For movies: search AT by AniDB anime ID
        const entries = await searchByAnidbId(anidbId);
        if (!entries.length) return [];

        return this._fetchSubtitlesFromEntries(entries, query);
    }

    async _fetchSubtitlesFromEntries(entries, query) {
        const topEntries = entries.slice(0, SEARCH_THRESHOLD);
        const subtitles = [];
        const seenAttachments = new Set();

        for (const entry of topEntries) {
            const detail = await getTorrentDetail(entry.id);
            if (!detail) continue;

            const results = this._buildSubtitleResults(detail, entry, query, seenAttachments);
            subtitles.push(...results);
        }

        return subtitles;
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

                if (query.languages && query.languages.length > 0 && alpha2) {
                    if (!query.languages.includes(alpha2)) continue;
                }

                const codec = (sub.info?.codec || '').toLowerCase();
                const format = codec === 'ass' || codec === 'ssa' ? 'ass' :
                              codec === 'srt' ? 'srt' :
                              codec === 'webvtt' ? 'vtt' : codec || 'unknown';

                const outputFmt = (format === 'ass' && query.keepAss) ? 'ass' : 'vtt';
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

'use strict';

/**
 * AnimeTosho subtitle provider.
 *
 * Fetches anime subtitles embedded in MKV releases, from two sources:
 *   .xyz  the live feed, searched by AniDB anime id, subtitles read from attachments[]
 *   .org  a frozen archive (last ingest 2026-05-08), searched by AniDB episode id
 *
 * IMDB -> Fribb anime-lists -> AniDB anime id is enough for .xyz, so the AniDB HTTP API is only
 * needed when .xyz has nothing and the .org path is reached.
 */

const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { log } = require('../utils');
const { getAnidbIdForImdb, getAnimeListReady, isAnime } = require('../utils/animeLists');
const { getEpisodeId, getAnimeTitle, isAnidbConfigured } = require('../utils/anidbApi');
const { searchByEpisodeId, searchByAnidbId, getTorrentDetail, buildProxyUrl } = require('../utils/animetoshoApi');
const xyzApi = require('../utils/animetoshoXyzApi');
const absoluteEpisode = require('../utils/absoluteEpisode');
const { scoreReleaseSeason, parse: parseMedia } = require('../utils/mediaParser');
const { getByAlpha3B, getDisplayName, toAlpha3B } = require('../languages');

const SEARCH_THRESHOLD = parseInt(process.env.ANIMETOSHO_SEARCH_THRESHOLD, 10) || 2;
const XYZ_SEARCH_THRESHOLD = parseInt(process.env.ANIMETOSHO_XYZ_SEARCH_THRESHOLD, 10) || 3;
const XYZ_MAX_OFFSET = parseInt(process.env.ANIMETOSHO_XYZ_MAX_OFFSET, 10) || 4000;
const XYZ_BACKGROUND_DETAILS = 12;
const XYZ_PAGE_DELAY_MS = 800;

class AnimeToshoProvider extends BaseProvider {
    constructor(options = {}) {
        super('animetosho', options);
        this.baseUrl = options.baseUrl || process.env.SUBSENSE_BASE_URL ||
                       `http://127.0.0.1:${process.env.PORT || 3100}`;
        this._subtitleCache = new Map();
        this._cacheMaxAge = 3600000; // 1 hour
        this._cacheMaxSize = 200;

        this._xyzWalks = new Map();

        // metadata_fetched does not imply attachments, so .xyz coverage is measured, not assumed.
        this.stats.xyzReleasesExamined = 0;
        this.stats.xyzReleasesWithoutAttachments = 0;
        this.stats.xyzWalks = 0;
        this.stats.absoluteRefused = 0;
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
        if (!mapping) {
            log('debug', `[AnimeTosho] No AniDB mapping for ${query.imdbId} S${query.season}`);
            return { subtitles: [] };
        }

        const cacheKey = `${query.imdbId}:${query.season || 0}:${query.episode || 0}`;
        const cached = this._getFromCache(cacheKey);
        if (cached) {
            const filtered = this._filterByLanguages(cached, query.languages);
            log('debug', `[AnimeTosho] Cache hit: ${cached.length} total, ${filtered.length} after lang filter`);
            return { subtitles: filtered };
        }

        const resolved = await this._resolveEpisode(query, mapping);
        if (!resolved) return { subtitles: [] };

        const startedAt = Date.now();
        try {
            const subtitles = await this._searchSources(resolved.query, resolved.mapping, cacheKey);
            this._recordRequest(true, Date.now() - startedAt, subtitles.length);
            return { subtitles, backgroundPromise: this._backgroundPromise(resolved.query, cacheKey) };
        } catch (err) {
            this._recordRequest(false, Date.now() - startedAt, 0, err);
            log('error', `[AnimeTosho] Search failed: ${err.message}`);
            return { subtitles: [] };
        }
    }

    /**
     * The AniDB episode number that bare-numbered file names are matched against
     */
    async _resolveEpisode(query, mapping) {
        const q = { ...query, backgroundTasks: [] };
        if (query.season == null || query.episode == null) return { query: q, mapping };

        q.seriesTitle = await getAnimeTitle(mapping.anidbId).catch(() => null);

        if (!mapping.absolute) {
            q.absoluteEpisode = query.episode - mapping.episodeOffset;
            return { query: q, mapping };
        }

        const absolute = await absoluteEpisode.resolveAbsoluteEpisode({
            imdbId: query.imdbId, season: query.season, episode: query.episode,
            anidbId: mapping.anidbId, coveredBelowSeason: mapping.coveredBelowSeason
        });
        if (!absolute) {
            this.stats.absoluteRefused++;
            return null;
        }
        q.absoluteEpisode = absolute;
        return { query: q, mapping: { ...mapping, episodeOffset: query.episode - absolute } };
    }

    _backgroundPromise(query, cacheKey) {
        const tasks = query.backgroundTasks;
        if (!tasks || !tasks.length) return null;
        return Promise.allSettled(tasks).then(() => ({
            subtitles: this._filterByLanguages(this._getFromCache(cacheKey) || [], query.languages)
        }));
    }

    _track(query, promise) {
        if (query.backgroundTasks) query.backgroundTasks.push(promise);
        return promise;
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

    /**
     * .xyz answers first: it is the live source and needs no AniDB call. .org is the archive and
     * spaces requests 7 seconds apart, so it is reached on a miss and warmed in the background.
     */
    async _searchSources(query, mapping, cacheKey) {
        const seenLanguageKeys = new Set();
        const xyzResults = await this._fetchXyzSubtitles(mapping.anidbId, query, seenLanguageKeys, cacheKey);
        if (xyzResults.length) {
            this._putInCache(cacheKey, xyzResults);
            this._warmOrgInBackground(query, mapping, cacheKey, xyzResults);
            return this._filterByLanguages(xyzResults, query.languages);
        }

        // Missing this request is acceptable, the walk feeds the cache and the background promise.
        if (query.season != null && query.episode != null) {
            this._pageXyzInBackground(mapping.anidbId, query, cacheKey, seenLanguageKeys);
        }

        const { entries, viaAnime } = await this._resolveOrgEntries(query, mapping);
        const subtitles = entries.length ? await this._fetchSubtitlesFromEntries(entries, query, cacheKey) : [];
        if (subtitles.length || !entries.length || viaAnime) return subtitles;

        const batches = await this._orgEntriesByAnime(query, mapping);
        return batches.length ? this._fetchSubtitlesFromEntries(batches, query, cacheKey) : [];
    }

    /** Release list from .org: by episode id for TV, by anime id for movies and as the fallback. */
    async _resolveOrgEntries(query, mapping) {
        const { anidbId, episodeOffset } = mapping;
        const none = { entries: [], viaAnime: false };
        if (query.season == null || query.episode == null) return { entries: await searchByAnidbId(anidbId), viaAnime: true };

        if (!isAnidbConfigured()) {
            log('debug', '[AnimeTosho] AniDB not configured - skipping .org TV episode search');
            return none;
        }

        const episodeNum = query.episode - episodeOffset;
        if (!Number.isFinite(episodeNum) || episodeNum < 1) {
            log('warn', `[AnimeTosho] Episode ${query.episode} with offset ${episodeOffset} = ${episodeNum} (invalid)`);
            return none;
        }

        const eid = await getEpisodeId(anidbId, episodeNum);
        if (!eid) {
            log('debug', `[AnimeTosho] No eid for AniDB ${anidbId} ep ${episodeNum}`);
            return none;
        }

        const byEid = await searchByEpisodeId(eid);
        if (byEid.length) return { entries: byEid, viaAnime: false };

        log('info', `[AnimeTosho] eid ${eid} returned 0 results, falling back to aids=${anidbId} + episode filter`);
        return { entries: await this._orgEntriesByAnime(query, mapping), viaAnime: true };
    }

    async _orgEntriesByAnime(query, mapping) {
        const allEntries = await searchByAnidbId(mapping.anidbId);
        const filtered = this._filterEntriesByEpisode(allEntries, query);
        log('debug', `[AnimeTosho] Anime filter ${allEntries.length} -> ${filtered.length} entries for S${query.season}E${query.episode} (abs ${query.absoluteEpisode})`);
        return filtered;
    }

    /** Add the .org archive to the cache after a .xyz hit, off the deadline. */
    _warmOrgInBackground(query, mapping, cacheKey, subtitles) {
        this._track(query, (async () => {
            const { entries } = await this._resolveOrgEntries(query, mapping);
            if (!entries.length) return;
            await this._fetchRemainingInBackground(entries, new Set(), subtitles, cacheKey, query);
        })().catch(err => log('debug', `[AnimeTosho] Background .org warm failed: ${err.message}`)));
    }

    async _fetchSubtitlesFromEntries(entries, query, cacheKey) {
        const topEntries = entries.slice(0, SEARCH_THRESHOLD);
        const subtitles = [];
        const seenAttachments = new Set();

        for (let i = 0; i < topEntries.length; i++) {
            const entry = topEntries[i];
            const detail = await getTorrentDetail(entry.id);
            if (!detail) continue;

            const allResults = this._buildSubtitleResults(detail, entry, query, seenAttachments);
            subtitles.push(...allResults);

            // Early exit: if we found matching subs for the requested language
            const matchingLang = this._filterByLanguages(subtitles, query.languages);
            if (matchingLang.length > 0 && i < topEntries.length - 1) {
                // Background fetches ALL remaining entries
                const remaining = entries.slice(i + 1);
                this._track(query, this._fetchRemainingInBackground(remaining, seenAttachments, subtitles, cacheKey, query));
                return matchingLang;
            }
        }

        if (entries.length > SEARCH_THRESHOLD) {
            const remaining = entries.slice(SEARCH_THRESHOLD);
            this._track(query, this._fetchRemainingInBackground(remaining, seenAttachments, subtitles, cacheKey, query));
        } else {
            this._mergeIntoCache(cacheKey, subtitles);
        }

        return this._filterByLanguages(subtitles, query.languages);
    }

    /**
     * Continue fetching ALL remaining torrent details in the background.
     * Does NOT filter by language - caches all subtitles for future requests.
     */
    _fetchRemainingInBackground(entries, seenAttachments, subtitles, cacheKey, query) {
        const bgStart = Date.now();
        return (async () => {
            for (const entry of entries) {
                try {
                    const detail = await getTorrentDetail(entry.id);
                    if (!detail) continue;
                    const results = this._buildSubtitleResults(detail, entry, query, seenAttachments);
                    subtitles.push(...results);
                } catch (err) {
                    log('debug', `[AnimeTosho] Background fetch ${entry.id} failed: ${err.message}`);
                }
            }

            // Cache ALL subtitles (all languages) for future requests
            this._mergeIntoCache(cacheKey, subtitles);
            const langs = [...new Set(subtitles.map(s => s.language))].join(',');
            log('info', `[AnimeTosho] Background done for ${cacheKey}: ${subtitles.length} subs (${langs}) in ${((Date.now() - bgStart) / 1000).toFixed(1)}s`);
        })().catch(err => log('error', `[AnimeTosho] Background fetch error: ${err.message}`));
    }

    /** Entries from ?aids= whose title names the episode. Batches pass, their files are filtered on detail. */
    _filterEntriesByEpisode(entries, query) {
        return entries.filter(entry => this._titleMatchesEpisode(entry.title || '', query, { allowRange: true }));
    }

    _titleMatchesEpisode(name, query, opts = {}) {
        return this._episodeVerdict(name, query, opts) === 'match';
    }

    /**
     * A season form must equal the Stremio pair, a bare number must equal the AniDB absolute number
     */
    _episodeVerdict(name, query, { allowRange = false } = {}) {
        const parsed = parseMedia(String(name || '').split('/').pop());
        if (namesAnotherShow(parsed.title, query.seriesTitle)) return 'other';

        const episodes = parsed.episodes || [];
        if (!episodes.length) return 'unknown';
        if (!allowRange && episodes.length > 2) return 'other';

        const { season, episode, absoluteEpisode = episode } = query;
        const seasons = parsed.seasons || [];
        const match = seasons.length ? seasons.includes(season) && episodes.includes(episode) : episodes.includes(absoluteEpisode);
        return match ? 'match' : 'other';
    }

    /**
     * Build SubtitleResult objects from a torrent detail response.
     * Deduplicates by attachment ID across entries. 
     * A multi-file torrent keeps only the file that names the wanted episode
     */
    _buildSubtitleResults(detail, entry, query, seenAttachments) {
        const results = [];
        let files = detail.files || [];
        if (query && query.season != null && query.episode != null) {
            const verdict = (name) => this._episodeVerdict(name || '', query);
            files = files.length > 1
                ? files.filter(f => verdict(f.filename) === 'match')
                : files.filter(f => verdict(f.filename) !== 'other' && verdict(entry.title) !== 'other');
        }

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

                const rawTrackName = sub.info?.name || '';
                const trackNameLower = rawTrackName.toLowerCase();
                const hearingImpaired = trackNameLower.includes('sdh') ||
                                       trackNameLower.includes('hearing') ||
                                       trackNameLower.includes('cc');
                const isForced = trackNameLower.includes('forced') ||
                                 trackNameLower.includes('signs') ||
                                 trackNameLower.includes('foreign');

                // Skip forced/signs-only tracks
                if (isForced) continue;

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
                    trackName: rawTrackName || null,
                    format,
                    needsConversion: format === 'ass',
                    display: displayName
                }));
            }
        }

        return results;
    }

    /** One walk per episode per cache window, so a series that never yields does not re-pay it. */
    _shouldWalk(cacheKey) {
        const startedAt = this._xyzWalks.get(cacheKey);
        if (startedAt && Date.now() - startedAt < this._cacheMaxAge) return false;
        if (this._xyzWalks.size >= this._cacheMaxSize) {
            this._xyzWalks.delete(this._xyzWalks.keys().next().value);
        }
        this._xyzWalks.set(cacheKey, Date.now());
        return true;
    }

    /** Merge a late arrival into the cache without discarding whatever landed there first. */
    _mergeIntoCache(cacheKey, found) {
        if (!found.length) return;
        const cached = this._getFromCache(cacheKey) || [];
        const known = new Set(cached.map(s => s.id));
        this._putInCache(cacheKey, [...cached, ...found.filter(s => !known.has(s.id))]);
    }

    /** Collect the releases the deadline had no time for, so the next request sees them. */
    _collectXyzInBackground(releases, query, cacheKey, seenLanguageKeys) {
        this._track(query, (async () => {
            const found = await this._collectXyzSubtitles(releases, query, seenLanguageKeys, { background: true });
            this._mergeIntoCache(cacheKey, found);
            if (found.length) {
                log('info', `[AnimeTosho-XYZ] Background added ${found.length} subs for ${cacheKey}`);
            }
        })().catch(err => log('debug', `[AnimeTosho-XYZ] Background collect failed: ${err.message}`)));
    }

    /**
     * One anime id lists packs for several seasons, so rank before spending any detail fetch:
     * 2 names the wanted season, 1 names none, 0 names only others and is dropped. Multisub and
     * batch releases break ties, they carry the most tracks per fetch.
     */
    _orderXyzReleases(releases, season) {
        const scored = [];
        for (const release of releases) {
            if (!release.metadata_fetched) continue;
            const score = scoreReleaseSeason(release.title, season);
            if (score === 0) continue;
            scored.push({ release, score });
        }
        scored.sort((a, b) =>
            b.score - a.score ||
            (b.release.is_multisub_release ? 1 : 0) - (a.release.is_multisub_release ? 1 : 0) ||
            (b.release.is_batch ? 1 : 0) - (a.release.is_batch ? 1 : 0));
        return scored.map(s => s.release);
    }

    /**
     * Subtitle tracks from .xyz, searched by AniDB anime id. The packs that carry tracks hold a
     * whole season, so the episode is matched on the file inside the release, never on the release.
     */
    async _fetchXyzSubtitles(anidbId, query, seenLanguageKeys, cacheKey = null) {
        if (!anidbId) return [];
        try {
            const releases = await xyzApi.searchByAnidbId(anidbId);
            const ordered = this._orderXyzReleases(releases, query.season);
            if (!ordered.length) return [];

            const budget = ordered.slice(0, XYZ_SEARCH_THRESHOLD);
            const results = await this._collectXyzSubtitles(budget, query, seenLanguageKeys, { cacheKey });
            log('info', `[AnimeTosho-XYZ] ${results.length} subs from ${budget.length} of ${releases.length} releases`);
            return results;
        } catch (err) {
            log('error', `[AnimeTosho-XYZ] Error: ${err.message}`);
            return [];
        }
    }

    /**
     * Fetch each release detail and keep the tracks on the file that holds the wanted episode.
     * A cacheKey opts into the early exit: stop once the requested languages are covered and
     * leave the rest of the ranked pool to the background.
     */
    async _collectXyzSubtitles(releases, query, seenLanguageKeys, { cacheKey = null, background = false } = {}) {
        const byEpisode = query.season != null && query.episode != null;
        const results = [];

        for (let i = 0; i < releases.length; i++) {
            const release = releases[i];
            const detail = await xyzApi.getReleaseDetail(release.id, { background });
            if (!detail) continue;
            this.stats.xyzReleasesExamined++;

            const tracks = xyzApi.extractSubtitles(detail);
            if (!tracks.length) {
                if (xyzApi.countMediainfoTracks(detail)) this.stats.xyzReleasesWithoutAttachments++;
                continue;
            }

            // A one-file release whose title names the episode is that episode, whatever the file is called.
            const wholeRelease = byEpisode && (detail.files || []).length === 1 &&
                this._titleMatchesEpisode(release.title || '', query);

            for (const track of tracks) {
                if (track.forced || !track.languageCode) continue;
                if (byEpisode && !wholeRelease && !this._titleMatchesEpisode(track.fileName || '', query)) continue;

                const dedupKey = `${track.languageCode}:${track.format}:${track.title || ''}`;
                if (seenLanguageKeys.has(dedupKey)) continue;
                seenLanguageKeys.add(dedupKey);

                const langEntry = getByAlpha3B(track.languageCode);
                const alpha2 = langEntry ? langEntry.alpha2 : null;
                const alpha3B = langEntry ? langEntry.alpha3B : track.languageCode;

                const trackTitleLower = String(track.title || '').toLowerCase();
                const hearingImpaired = trackTitleLower.includes('sdh') ||
                                       trackTitleLower.includes('hearing') ||
                                       trackTitleLower.includes('cc');

                const keepAss = query && query.keepAss;
                const outputFmt = (track.format === 'ass' && keepAss) ? 'ass' : 'vtt';

                results.push(new SubtitleResult({
                    id: `animetosho-xyz-${track.id}`,
                    url: xyzApi.buildProxyUrl(this.baseUrl, track, outputFmt),
                    language: alpha2 || track.languageCode,
                    languageCode: alpha3B,
                    source: 'animetosho-xyz',
                    provider: 'animetosho',
                    releaseName: release.title || detail.torrent_name || '',
                    fileName: track.fileName,
                    releases: [release.title || ''],
                    hearingImpaired,
                    trackName: track.title || null,
                    format: track.format,
                    needsConversion: track.format === 'ass',
                    display: langEntry ? getDisplayName(alpha2) : track.languageCode
                }));
            }

            if (cacheKey && i < releases.length - 1 &&
                this._filterByLanguages(results, query.languages).length > 0) {
                this._collectXyzInBackground(releases.slice(i + 1), query, cacheKey, seenLanguageKeys);
                break;
            }
        }

        return results;
    }

    /**
     * Walk the listing past the deadline, for an old episode that the first page cannot reach.
     * Only a release whose own title names the episode earns a detail fetch, so the budget is
     * not spent on packs the foreground already examined.
     */
    _pageXyzInBackground(anidbId, query, cacheKey, seenLanguageKeys) {
        if (!this._shouldWalk(cacheKey)) return;
        this.stats.xyzWalks++;

        this._track(query, (async () => {
            let budget = XYZ_BACKGROUND_DETAILS;

            for (let offset = xyzApi.PAGE_SIZE; offset <= XYZ_MAX_OFFSET && budget > 0; offset += xyzApi.PAGE_SIZE) {
                await new Promise(r => setTimeout(r, XYZ_PAGE_DELAY_MS));
                const page = await xyzApi.searchByAnidbId(anidbId, offset);
                if (!page.length) break;

                const named = this._orderXyzReleases(page, query.season)
                    .filter(r => this._titleMatchesEpisode(r.title || '', query))
                    .slice(0, Math.min(budget, XYZ_SEARCH_THRESHOLD));
                if (!named.length) continue;

                budget -= named.length;
                const found = await this._collectXyzSubtitles(named, query, seenLanguageKeys, { background: true });
                if (!found.length) continue;

                this._mergeIntoCache(cacheKey, found);
                log('info', `[AnimeTosho-XYZ] Background walk found ${found.length} subs at offset ${offset} for ${cacheKey}`);
                return;
            }
            log('debug', `[AnimeTosho-XYZ] Background walk found nothing for ${cacheKey}`);
        })().catch(err => log('debug', `[AnimeTosho-XYZ] Background walk failed: ${err.message}`)));
    }
}

const normalizeTitle = (s) => String(s || '').toLowerCase().replace(/\(\d{4}\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/** Equal titles are the same show; one extending the other by a word is a sequel or spin-off; unrelated spellings are left alone. */
function namesAnotherShow(title, seriesTitle) {
    const a = normalizeTitle(title);
    const b = normalizeTitle(seriesTitle);
    if (!a || !b || a === b) return false;
    return a.startsWith(b + ' ') || b.startsWith(a + ' ');
}

module.exports = AnimeToshoProvider;

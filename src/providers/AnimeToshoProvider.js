'use strict';

/**
 * AnimeTosho subtitle provider.
 *
 * Fetches anime subtitles embedded in MKV releases from animetosho.net, searched by AniDB anime id, subtitles read from attachments[]
 * IMDB -> Fribb anime-lists -> AniDB anime id is enough to search.
 */

const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { log } = require('../utils');
const { getAnidbIdForImdb, getAnimeListReady, isAnime } = require('../utils/animeLists');
const { getAnimeTitle } = require('../utils/anidbApi');
const xyzApi = require('../utils/animetoshoXyzApi');
const absoluteEpisode = require('../utils/absoluteEpisode');
const { scoreReleaseSeason, parse: parseMedia } = require('../utils/mediaParser');
const { getByAlpha3B, getDisplayName, toAlpha3B } = require('../languages');

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

    async _searchSources(query, mapping, cacheKey) {
        const seenLanguageKeys = new Set();
        const xyzResults = await this._fetchXyzSubtitles(mapping.anidbId, query, seenLanguageKeys, cacheKey);
        if (xyzResults.length) {
            this._putInCache(cacheKey, xyzResults);
            return this._filterByLanguages(xyzResults, query.languages);
        }

        // Missing this request is acceptable, the walk feeds the cache and the background promise.
        if (query.season != null && query.episode != null) {
            this._pageXyzInBackground(mapping.anidbId, query, cacheKey, seenLanguageKeys);
        }
        return [];
    }

    _titleMatchesEpisode(name, query) {
        return this._episodeVerdict(name, query) === 'match';
    }

    /**
     * A season form must equal the Stremio pair, a bare number must equal the AniDB absolute number
     */
    _episodeVerdict(name, query) {
        const parsed = parseMedia(String(name || '').split('/').pop());
        if (namesAnotherShow(parsed.title, query.seriesTitle)) return 'other';

        const episodes = parsed.episodes || [];
        if (!episodes.length) return 'unknown';
        if (episodes.length > 2) return 'other';

        const { season, episode, absoluteEpisode = episode } = query;
        const seasons = parsed.seasons || [];
        const match = seasons.length ? seasons.includes(season) && episodes.includes(episode) : episodes.includes(absoluteEpisode);
        return match ? 'match' : 'other';
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
                const page = await xyzApi.searchByAnidbId(anidbId, offset, { background: true });
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

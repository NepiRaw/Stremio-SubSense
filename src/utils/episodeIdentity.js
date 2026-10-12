'use strict';

/**
 * Resolve the IMDb episode identity that OpenSubtitles' legacy API should use.
 *
 * OpenSubtitles occasionally serves a result for a different season/episode when
 * searching by the series IMDb id and the requested catalog coordinates.  The
 * resolver first asks Cinemeta for the title at those coordinates, then accepts an
 * OpenSubtitles result only when the parent IMDb id and the complete episode name
 * agree.  A title-only lookup is used as a repair path when the canonical lookup
 * does not identify that exact episode.
 *
 * This module deliberately has no provider or application dependencies.  A fetch
 * implementation may be supplied as the second argument (or as `request.fetch`)
 * for tests; production calls use the process-global fetch.
 */

const CINEMETA_BASE_URL = 'https://v3-cinemeta.strem.io/meta/series';
const OPENSUBTITLES_BASE_URL = 'https://rest.opensubtitles.org';
const OPENSUBTITLES_USER_AGENT = 'VLSub 0.10.3';

const DEFAULT_TIMEOUT_MS = 10_000;
const CACHE_MAX_ENTRIES = 256;
const SUCCESS_CACHE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 60 * 1000;

const cache = new Map();
const inFlight = new Map();

const GENERIC_SERIES_NAMES = new Set([
    'episode',
    'episodes',
    'series',
    'show',
    'untitled',
    'unknown'
]);

const GENERIC_EPISODE_TITLES = new Set([
    'episode',
    'chapter',
    'finale',
    'pilot',
    'premiere',
    'untitled',
    'unknown'
]);

/**
 * Resolve a series request to an episode IMDb id and the coordinates understood
 * by OpenSubtitles.
 *
 * Movie requests return `{ status: 'bypassed', reason: 'movie' }`.  Invalid or
 * unresolvable series requests return `{ status: 'unresolved', reason }` and
 * never throw.  A successful result has this shape:
 *
 * {
 *   status: 'resolved',
 *   seriesImdbId: 'tt1234567',
 *   episodeImdbId: 'tt7654321',
 *   season: 3,               // requested Stremio coordinates
 *   episode: 9,              // requested Stremio coordinates
 *   expectedTitle: 'Episode name',
 *   expectedSeriesTitle: 'Series name',
 *   catalogSeason: 2,        // coordinates returned by OpenSubtitles
 *   catalogEpisode: 16       // coordinates returned by OpenSubtitles
 * }
 */
async function resolveEpisodeIdentity(request = {}, options = {}) {
    const input = request && typeof request === 'object' ? request : {};
    const opts = typeof options === 'function'
        ? { fetch: options }
        : (options && typeof options === 'object' ? options : {});

    const explicitType = String(input.type || input.contentType || '').toLowerCase();
    const season = parseCoordinate(input.season);
    const episode = parseCoordinate(input.episode);

    // Absence of coordinates is how the Stremio movie route is represented.  An
    // explicit movie type also wins when a caller carries stale coordinates.
    if (explicitType === 'movie' || season === null || episode === null) {
        return { status: 'bypassed', reason: 'movie' };
    }
    if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode)
        || season < 0 || episode < 1) {
        return { status: 'unresolved', reason: 'invalid-season-episode' };
    }

    const seriesImdbId = normalizeImdbId(input.imdbId);
    if (!seriesImdbId) return { status: 'unresolved', reason: 'invalid-series-imdb-id' };

    const fetchImpl = opts.fetch || opts.fetchImpl || input.fetch || input.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') return { status: 'unresolved', reason: 'fetch-unavailable' };

    const key = `${seriesImdbId}:${season}:${episode}`;
    const cached = readCache(key);
    if (cached) return cloneResult(cached);

    const pending = inFlight.get(key);
    if (pending) return cloneResult(await pending);

    const task = resolveUncached({
        fetchImpl,
        seriesImdbId,
        season,
        episode,
        timeoutMs: normalizeTimeout(opts.timeoutMs)
    }).catch(() => unresolved('identity-resolution-failed'));
    inFlight.set(key, task);

    try {
        const result = await task;
        writeCache(key, result);
        return cloneResult(result);
    } finally {
        // Only remove our own promise.  This matters if a future implementation
        // replaces an entry while a slow request is unwinding.
        if (inFlight.get(key) === task) inFlight.delete(key);
    }
}

async function resolveUncached({ fetchImpl, seriesImdbId, season, episode, timeoutMs }) {
    const metadataUrl = `${CINEMETA_BASE_URL}/${seriesImdbId}.json`;
    const metadata = await fetchJson(fetchImpl, metadataUrl, timeoutMs, {});
    const episodeInfo = extractEpisodeInfo(metadata, season, episode);
    if (!episodeInfo) return unresolved('episode-metadata-unavailable');

    const seriesName = firstText(
        metadata?.meta?.name,
        metadata?.meta?.title,
        metadata?.meta?.originalName,
        metadata?.meta?.seriesName,
        metadata?.name,
        metadata?.title,
        episodeInfo.seriesName
    );
    const expectedTitleCandidates = uniqueTexts([
        episodeInfo.title,
        episodeInfo.name
    ]);
    // Generic names are not enough to distinguish episodes across arcs or
    // seasons.  If Cinemeta exposes both a generic `title` and a meaningful
    // `name`, retain only the meaningful title for identity matching.
    const expectedTitles = expectedTitleCandidates.filter(title => !isGenericEpisodeTitle(title));
    const expectedTitle = expectedTitles[0] || expectedTitleCandidates[0] || null;
    const names = new Set(expectedTitles.map(normalizeTitle));
    const sameTitleEpisodes = metadata.meta.videos.filter(video =>
        [video?.name, video?.title].some(title => title && names.has(normalizeTitle(title))));
    const uniqueCoordinates = new Set(sameTitleEpisodes.map(video =>
        `${parseCoordinate(video?.season)}:${parseCoordinate(video?.episode ?? video?.number)}`));
    if (uniqueCoordinates.size > 1) return unresolved('ambiguous-catalog-title');

    // The parent title is part of the identity check.  Without it, a generic
    // episode title such as "Pilot" would become a global title search.
    if (!hasDistinguishingName(seriesName) || expectedTitles.length === 0) {
        return unresolved('episode-name-not-distinguishing');
    }

    const expectedNames = new Set(expectedTitles.map(title => normalizeTitle(`${seriesName} ${title}`)));
    const parentId = normalizeImdbId(seriesImdbId);
    const osOptions = {
        headers: {
            'X-User-Agent': OPENSUBTITLES_USER_AGENT,
            Accept: 'application/json'
        }
    };

    // Search with the requested catalog coordinates first.  We do not trust the
    // returned coordinates by themselves; the complete title and exact parent
    // check below are the source of identity.
    const canonicalUrl = `${OPENSUBTITLES_BASE_URL}/search/episode-${episode}`
        + `/imdbid-${parentId.slice(2)}/season-${season}`;
    const canonicalResponse = await fetchJson(fetchImpl, canonicalUrl, timeoutMs, osOptions);
    const canonicalCandidates = collectCandidates(
        responseEntries(canonicalResponse),
        { parentId, expectedNames, expectedTitles, seriesName, season, episode, mode: 'canonical' }
    );

    if (canonicalCandidates.length > 0) {
        return finalizeCandidates(canonicalCandidates, {
            seriesImdbId,
            season,
            episode,
            expectedTitle,
            expectedTitles,
            expectedSeriesTitle: seriesName
        });
    }

    // Canonical lookup was empty or had a title/parent mismatch.  Query only the
    // episode title; the result still must carry the exact parent and exact quoted
    // series+episode name.  Try an alternate `title`/`name` field only when it is
    // actually different, since some Cinemeta feeds expose one or the other.
    const titleCandidates = [];
    for (const title of expectedTitles) {
        // The legacy endpoint's title route is case-sensitive. Keep the title's
        // punctuation/accents intact while matching its lowercase query form;
        // normalizeTitle is reserved for identity comparison, not URL input.
        const titleUrl = `${OPENSUBTITLES_BASE_URL}/search/query-${encodeURIComponent(title.toLocaleLowerCase())}`;
        const titleResponse = await fetchJson(fetchImpl, titleUrl, timeoutMs, osOptions);
        titleCandidates.push(...collectCandidates(
            responseEntries(titleResponse),
            { parentId, expectedNames, expectedTitles, seriesName, season, episode, mode: 'title' }
        ));
    }

    return finalizeCandidates(titleCandidates, {
        seriesImdbId,
        season,
        episode,
        expectedTitle,
        expectedTitles,
        expectedSeriesTitle: seriesName
    });
}

/**
 * Read a metadata episode while requiring both catalog coordinates to match.
 * Cinemeta has used both `episode` and `number` over time, and both `title` and
 * `name` for the title, so the aliases are intentionally kept here.
 */
function extractEpisodeInfo(payload, season, episode) {
    const videos = payload?.meta?.videos;
    if (!Array.isArray(videos)) return null;

    const video = videos.find(candidate => {
        const candidateSeason = parseCoordinate(candidate?.season);
        const candidateEpisode = parseCoordinate(
            candidate?.episode !== undefined && candidate?.episode !== null
                ? candidate.episode
                : candidate?.number
        );
        return candidateSeason === season && candidateEpisode === episode;
    });
    if (!video) return null;

    return {
        title: firstText(video.title),
        name: firstText(video.name),
        seriesName: firstText(video.seriesName, video.showName)
    };
}

function collectCandidates(entries, context) {
    const out = [];
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;

        const parent = normalizeImdbId(firstText(
            entry.SeriesIMDBParent,
            entry.SeriesImdbParent,
            entry.seriesImdbParent,
            entry.seriesIMDBParent
        ));
        if (!parent || parent !== context.parentId) continue;
        if (entry.MovieKind !== undefined && entry.MovieKind !== null
            && String(entry.MovieKind).trim().toLowerCase() !== 'episode') continue;

        const movieNames = uniqueTexts([
            entry.MovieName,
            entry.movieName,
            entry.MovieNameEng,
            entry.movieNameEng,
            entry.name
        ]);
        if (movieNames.length === 0 || !movieNames.some(movieName => movieNameMatches(movieName, context))) continue;

        const episodeImdbId = normalizeImdbId(firstText(
            entry.IDMovieImdb,
            entry.IdMovieImdb,
            entry.idMovieImdb,
            entry.episodeImdbId
        ));
        if (!episodeImdbId) continue;

        const catalog = readCatalogCoordinates(entry, context);
        if (!catalog) continue;

        out.push({
            episodeImdbId,
            catalogSeason: catalog.season,
            catalogEpisode: catalog.episode
        });
    }
    return out;
}

function movieNameMatches(movieName, context) {
    const normalizedMovieName = normalizeTitle(movieName);
    if (context.expectedNames.has(normalizedMovieName)) return true;

    // A title lookup is accepted only with a quoted series name and an exact
    // episode title.  This avoids treating a fuzzy global title match as an IMDb
    // identity.  The full-name check above also permits APIs that omit quote marks
    // while retaining the same exact parent+title identity.
    if (context.mode !== 'title') return false;
    const quoted = extractQuotedMovieName(movieName);
    if (!quoted) return false;
    if (normalizeTitle(quoted.seriesName) !== normalizeTitle(context.seriesName)) return false;
    return context.expectedTitles.some(title => normalizeTitle(quoted.episodeName) === normalizeTitle(title));
}

function extractQuotedMovieName(movieName) {
    const text = String(movieName || '').trim();
    // OpenSubtitles uses ASCII quotes in MovieName, while fixtures and newer
    // responses may use curly quote characters.
    const match = text.match(/^["“]([\s\S]*?)["”]\s*(.+?)\s*$/u);
    if (!match) return null;
    return { seriesName: match[1], episodeName: match[2] };
}

function readCatalogCoordinates(entry, context) {
    const rawSeason = entry.SeriesSeason !== undefined
        ? entry.SeriesSeason
        : (entry.seriesSeason !== undefined ? entry.seriesSeason : entry.season);
    const rawEpisode = entry.SeriesEpisode !== undefined
        ? entry.SeriesEpisode
        : (entry.seriesEpisode !== undefined ? entry.seriesEpisode : entry.episode);

    const parsedSeason = parseCoordinate(rawSeason);
    const parsedEpisode = parseCoordinate(rawEpisode);

    // The canonical endpoint sometimes omits these fields.  Its URL already
    // supplies the requested coordinates, so using those is safe.  A title-only
    // response has no such guarantee and must carry both values explicitly.
    if (context.mode === 'canonical') {
        if (parsedSeason === null && parsedEpisode === null) {
            return { season: context.season, episode: context.episode };
        }
        if (parsedSeason === null || parsedEpisode === null
            || !Number.isSafeInteger(parsedSeason) || !Number.isSafeInteger(parsedEpisode)) {
            return null;
        }
        return { season: parsedSeason, episode: parsedEpisode };
    }

    if (parsedSeason === null || parsedEpisode === null
        || !Number.isSafeInteger(parsedSeason) || !Number.isSafeInteger(parsedEpisode)) {
        return null;
    }
    return { season: parsedSeason, episode: parsedEpisode };
}

function finalizeCandidates(candidates, context) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return unresolved('no-exact-os-match');
    }

    const byId = new Map();
    for (const candidate of candidates) {
        const prior = byId.get(candidate.episodeImdbId);
        if (!prior) {
            byId.set(candidate.episodeImdbId, candidate);
            continue;
        }
        // A duplicate subtitle/provider record for the same episode is harmless,
        // but disagreeing catalog coordinates would make the downstream query
        // nondeterministic, so fail closed.
        if (prior.catalogSeason !== candidate.catalogSeason
            || prior.catalogEpisode !== candidate.catalogEpisode) {
            return unresolved('ambiguous-catalog-episode');
        }
    }

    if (byId.size !== 1) return unresolved('ambiguous-episode-imdb-id');

    const candidate = byId.values().next().value;
    return {
        status: 'resolved',
        seriesImdbId: context.seriesImdbId,
        episodeImdbId: candidate.episodeImdbId,
        season: context.season,
        episode: context.episode,
        expectedTitle: context.expectedTitle,
        expectedTitles: context.expectedTitles,
        expectedSeriesTitle: context.expectedSeriesTitle,
        catalogSeason: candidate.catalogSeason,
        catalogEpisode: candidate.catalogEpisode
    };
}

function responseEntries(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.results)) return payload.results;
    if (Array.isArray(payload?.subtitles)) return payload.subtitles;
    return [];
}

async function fetchJson(fetchImpl, url, timeoutMs, requestOptions) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    let rejectTimeout;
    const timeout = new Promise((_, reject) => { rejectTimeout = reject; });

    if (controller) {
        timer = setTimeout(() => {
            controller.abort();
            rejectTimeout(new Error('request-timeout'));
        }, timeoutMs);
    } else {
        timer = setTimeout(() => rejectTimeout(new Error('request-timeout')), timeoutMs);
    }

    const operation = (async () => {
        const options = {
            ...requestOptions,
            ...(controller ? { signal: controller.signal } : {})
        };
        const response = await fetchImpl(url, options);
        if (!response || response.ok === false) return null;
        return await response.json();
    })();

    try {
        return await Promise.race([operation, timeout]);
    } catch (_) {
        return null;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function normalizeImdbId(value) {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    const match = raw.match(/^(?:tt)?(\d+)$/i);
    if (!match) return null;
    const digits = match[1];
    if (!digits || /^0+$/.test(digits)) return null;
    // IMDb's canonical numeric ids are at least seven digits.  OpenSubtitles
    // commonly returns the numeric form without the leading zero (for example
    // 944947 for tt0944947), so restore that padding while preserving any
    // already-canonical `tt` spelling.
    return `tt${digits.padStart(7, '0')}`;
}

function parseCoordinate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) ? value : Number.NaN;
    }
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) return Number.NaN;
    const number = Number(text);
    return Number.isSafeInteger(number) ? number : Number.NaN;
}

function normalizeTimeout(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 120_000) : DEFAULT_TIMEOUT_MS;
}

function firstText(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return null;
}

function uniqueTexts(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        const text = firstText(value);
        if (!text) continue;
        const key = normalizeTitle(text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

function hasDistinguishingName(value) {
    const normalized = normalizeTitle(value);
    return Boolean(normalized) && !GENERIC_SERIES_NAMES.has(normalized);
}

function isGenericEpisodeTitle(value) {
    const normalized = normalizeTitle(value);
    if (!normalized) return true;
    if (GENERIC_EPISODE_TITLES.has(normalized)) return true;
    if (/^(?:episode|chapter)(?:\s+\d+)+$/u.test(normalized)) return true;
    if (/^part(?:\s+\d+)?$/u.test(normalized)) return true;
    return false;
}

/**
 * Compare titles independent of case, accents, quote style and punctuation while
 * retaining word boundaries.  Apostrophes are removed so straight/curly forms
 * compare equally (`Someone's` and `Someone’s` -> `someones`).
 */
function normalizeTitle(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase()
        .replace(/[\u0027\u0060\u00b4\u2018\u2019\u201b\u2032]/gu, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function unresolved(reason) {
    return { status: 'unresolved', reason };
}

function readCache(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        cache.delete(key);
        return null;
    }
    // Keep hot entries at the newest end of the bounded Map.
    cache.delete(key);
    cache.set(key, entry);
    return entry.result;
}

function writeCache(key, result) {
    while (cache.size >= CACHE_MAX_ENTRIES && !cache.has(key)) {
        cache.delete(cache.keys().next().value);
    }
    cache.delete(key);
    cache.set(key, {
        result: cloneResult(result),
        expiresAt: Date.now() + (result?.status === 'resolved'
            ? SUCCESS_CACHE_TTL_MS
            : NEGATIVE_CACHE_TTL_MS)
    });
}

function cloneResult(result) {
    if (!result || typeof result !== 'object') return result;
    return { ...result };
}

function resetCache() {
    cache.clear();
    inFlight.clear();
}

module.exports = {
    resolveEpisodeIdentity,
    normalizeImdbId,
    normalizeTitle,
    resetCache,
    _resetCache: resetCache,
    resetEpisodeIdentityCache: resetCache
};

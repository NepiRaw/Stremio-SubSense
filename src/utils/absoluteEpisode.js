'use strict';

/**
 * Stremio season/episode -> AniDB absolute episode number, for shows AniDB numbers 1..N while
 * Stremio splits them into seasons. The position among Cinemeta's regular episodes is the number,
 * accepted only when the covered episode count equals AniDB's
 */

const anidbApi = require('./anidbApi');
const { log } = require('../utils');

const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta/series';
const FETCH_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;

const videosCache = new Map();

async function cinemetaVideos(imdbId) {
    const hit = videosCache.get(imdbId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.videos;

    let videos = null;
    try {
        const res = await fetch(`${CINEMETA_URL}/${imdbId}.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (res.ok) {
            const json = await res.json();
            if (Array.isArray(json?.meta?.videos)) videos = json.meta.videos;
        }
    } catch (err) {
        log('debug', `[AbsoluteEpisode] Cinemeta ${imdbId}: ${err.message}`);
    }
    if (!videos) return null;

    if (videosCache.size >= CACHE_MAX) videosCache.delete(videosCache.keys().next().value);
    videosCache.set(imdbId, { videos, at: Date.now() });
    return videos;
}

/** Absolute number for the episode, or null when the show is refused or the episode unknown. */
async function resolveAbsoluteEpisode({ imdbId, season, episode, anidbId, coveredBelowSeason = Infinity }) {
    if (!(season > 0) || !(episode > 0) || season >= coveredBelowSeason) return null;

    const videos = await cinemetaVideos(imdbId);
    if (!videos) return null;

    const covered = videos
        .filter(v => v.season > 0 && v.season < coveredBelowSeason)
        .sort((a, b) => a.season - b.season || a.episode - b.episode);

    const expected = await anidbApi.getEpisodeCount(anidbId);
    if (!expected || covered.length !== expected) {
        log('debug', `[AbsoluteEpisode] ${imdbId} refused: cinemeta ${covered.length} episodes, anidb ${anidbId} ${expected ?? 'unknown'}`);
        return null;
    }

    const index = covered.findIndex(v => v.season === season && v.episode === episode);
    return index === -1 ? null : index + 1;
}

function _resetCache() {
    videosCache.clear();
}

module.exports = { resolveAbsoluteEpisode, _resetCache };

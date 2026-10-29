'use strict';

/**
 * Fribb anime-lists: IMDB → AniDB mapping with season-aware resolution.
 *
 * Source: https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json
 *
 * Loaded once at startup, refreshed every 24 hours.
 *
 * Kitsu ids map to IMDB through the Kitsu addon's own per-episode mapping: Fribb's season offsets
 * and Cinemeta positions disagree with it on split-cour seasons and long-running series.
 */

const { log } = require('../utils');

const LIST_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';
const REFRESH_INTERVAL_MS = (parseInt(process.env.ANIME_LISTS_REFRESH_HOURS, 10) || 24) * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30000;
const MIN_EXPECTED_ENTRIES = 10000;
const MIN_EXPECTED_IMDB_KEYS = 4000;
const SPOT_CHECK_IMDB_ID = 'tt0388629';

const KITSU_META_URL = 'https://anime-kitsu.strem.fun/meta/series';
const KITSU_FETCH_TIMEOUT_MS = 8000;
const KITSU_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const KITSU_CACHE_MAX = 500;
const kitsuCache = new Map();

/** Upstream sends imdb_id as an array, as a comma-joined string, or as a bare string. */
function imdbIdsOf(entry) {
    const raw = entry.imdb_id;
    const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : []);
    return list.map(v => String(v).trim()).filter(v => v.startsWith('tt'));
}

/** Upstream sends episode_offset as a number or, like season, as a per-source object. */
function episodeOffsetOf(entry) {
    const raw = entry.episode_offset;
    const value = raw && typeof raw === 'object' ? (raw.tvdb ?? raw.tmdb) : raw;
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

let imdbIndex = null;
let ready = false;
let refreshTimer = null;

async function loadAnimeLists() {
    try {
        const response = await fetch(LIST_URL, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { 'User-Agent': 'SubSense-Stremio/2.0' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const list = await response.json();
        if (!Array.isArray(list) || list.length < MIN_EXPECTED_ENTRIES) {
            throw new Error(`Unexpected list size: ${list?.length}`);
        }

        const index = new Map();
        for (const entry of list) {
            for (const id of imdbIdsOf(entry)) {
                if (!index.has(id)) index.set(id, []);
                index.get(id).push(entry);
            }
        }

        // An upstream shape change once emptied this index silently. Keep the previous one.
        if (index.size < MIN_EXPECTED_IMDB_KEYS) {
            throw new Error(`Unexpected IMDB mapping count: ${index.size}`);
        }

        imdbIndex = index;
        ready = true;
        const spotCheck = index.has(SPOT_CHECK_IMDB_ID) ? 'ok' : 'FAILED';
        log('info', `[AnimeLists] Loaded ${list.length} entries, ${index.size} IMDB mappings, spot check ${spotCheck}`);
    } catch (err) {
        log('error', `[AnimeLists] Failed to load: ${err.message}`);
    }
}

function getAnimeListReady() {
    return ready;
}

/**
 * Get AniDB anime ID for an IMDB + season combination
 */
function getAnidbIdForImdb(imdbId, season) {
    if (!imdbIndex) return null;
    const entries = imdbIndex.get(imdbId);
    if (!entries) return null;

    if (season == null) {
        return {
            anidbId: entries[0].anidb_id,
            episodeOffset: 0,
            type: entries[0].type || 'Unknown'
        };
    }

    for (const entry of entries) {
        const tvdbSeason = entry.season?.tvdb;
        if (tvdbSeason === season) {
            return {
                anidbId: entry.anidb_id,
                episodeOffset: episodeOffsetOf(entry),
                type: entry.type || 'TV'
            };
        }
    }

    if (entries.length === 1 && season === 1) {
        return {
            anidbId: entries[0].anidb_id,
            episodeOffset: episodeOffsetOf(entries[0]),
            type: entries[0].type || 'TV'
        };
    }

    return unseasonedFallback(entries, season);
}

/**
 * Long-running shows have one TV entry with no season at all: AniDB numbers it 1..N while
 * Stremio splits it into seasons. It covers every season below the first one a seasoned TV
 * sibling claims. The caller must map the season/episode to an absolute number.
 */
function unseasonedFallback(entries, season) {
    if (!(season > 0)) return null;
    const unseasoned = entries.filter(e => e.type === 'TV' && e.season == null);
    if (unseasoned.length !== 1) return null;

    const claimed = entries
        .filter(e => e.type === 'TV' && e.season?.tvdb > 0)
        .map(e => e.season.tvdb);
    const coveredBelowSeason = claimed.length ? Math.min(...claimed) : Infinity;
    if (season >= coveredBelowSeason) return null;

    return { anidbId: unseasoned[0].anidb_id, episodeOffset: 0, type: 'TV', absolute: true, coveredBelowSeason };
}

/**
 * Check if an IMDB ID is anime (exists in anime-lists).
 */
function isAnime(imdbId) {
    return !!(imdbIndex && imdbIndex.has(imdbId));
}

/**
 * `kitsu:<id>` or `kitsu:<id>:<episode>` -> { imdbId, season, episode, type }, or null when the
 * Kitsu addon gives that id or episode no IMDB mapping.
 */
async function resolveKitsuId(stremioId) {
    const kitsuId = String(stremioId).split(':')[1];
    if (!/^\d+$/.test(kitsuId || '')) return null;

    const mapping = await kitsuMapping(kitsuId);
    const target = mapping && mapping.videos.get(stremioId);
    if (!target) return null;

    return mapping.isMovie
        ? { imdbId: target.imdbId, season: null, episode: null, type: 'movie' }
        : { imdbId: target.imdbId, season: target.season, episode: target.episode, type: 'series' };
}

/** Video id -> IMDB target, cached per Kitsu id. A 404 is cached as empty, a failed fetch is not. */
async function kitsuMapping(kitsuId) {
    const hit = kitsuCache.get(kitsuId);
    if (hit && Date.now() - hit.at < KITSU_CACHE_TTL_MS) return hit.mapping;

    let mapping = null;
    try {
        const res = await fetch(`${KITSU_META_URL}/kitsu:${kitsuId}.json`, {
            signal: AbortSignal.timeout(KITSU_FETCH_TIMEOUT_MS),
            headers: { 'User-Agent': 'SubSense-Stremio/2.0' }
        });
        if (res.ok) mapping = kitsuVideoTargets((await res.json())?.meta);
        else if (res.status === 404) mapping = { isMovie: false, videos: new Map() };
    } catch (err) {
        log('debug', `[AnimeLists] Kitsu ${kitsuId}: ${err.message}`);
    }
    if (!mapping) return null;

    if (kitsuCache.size >= KITSU_CACHE_MAX) kitsuCache.delete(kitsuCache.keys().next().value);
    kitsuCache.set(kitsuId, { mapping, at: Date.now() });
    return mapping;
}

function kitsuVideoTargets(meta) {
    const videos = new Map();
    for (const video of (meta && meta.videos) || []) {
        const imdbId = video.imdb_id || meta.imdb_id;
        if (!/^tt\d+$/.test(imdbId || '') || !(video.imdbSeason >= 0) || !(video.imdbEpisode > 0)) continue;
        videos.set(video.id, { imdbId, season: video.imdbSeason, episode: video.imdbEpisode });
    }
    return { isMovie: meta?.type === 'movie', videos };
}

async function init() {
    await loadAnimeLists();
    refreshTimer = setInterval(loadAnimeLists, REFRESH_INTERVAL_MS);
    if (refreshTimer.unref) refreshTimer.unref();
}

function shutdown() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}

module.exports = { init, shutdown, getAnimeListReady, getAnidbIdForImdb, isAnime, resolveKitsuId };

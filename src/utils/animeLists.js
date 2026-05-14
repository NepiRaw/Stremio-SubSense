'use strict';

/**
 * Fribb anime-lists: IMDB → AniDB mapping with season-aware resolution.
 *
 * Source: https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json
 *
 * Loaded once at startup, refreshed every 24 hours.
 */

const { log } = require('../utils');

const LIST_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';
const REFRESH_INTERVAL_MS = (parseInt(process.env.ANIME_LISTS_REFRESH_HOURS, 10) || 24) * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30000;
const MIN_EXPECTED_ENTRIES = 10000;

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
            if (!entry.imdb_id) continue;
            if (!index.has(entry.imdb_id)) index.set(entry.imdb_id, []);
            index.get(entry.imdb_id).push(entry);
        }

        imdbIndex = index;
        ready = true;
        log('info', `[AnimeLists] Loaded ${list.length} entries, ${index.size} IMDB mappings`);
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
                episodeOffset: entry.episode_offset || 0,
                type: entry.type || 'TV'
            };
        }
    }

    if (entries.length === 1 && season === 1) {
        return {
            anidbId: entries[0].anidb_id,
            episodeOffset: entries[0].episode_offset || 0,
            type: entries[0].type || 'TV'
        };
    }

    return null;
}

/**
 * Check if an IMDB ID is anime (exists in anime-lists).
 */
function isAnime(imdbId) {
    return !!(imdbIndex && imdbIndex.has(imdbId));
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

module.exports = { init, shutdown, getAnimeListReady, getAnidbIdForImdb, isAnime };

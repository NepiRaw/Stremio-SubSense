'use strict';

/**
 * AnimeTosho XYZ (v1) API wrapper.
 *
 * Provides access to subtitle track data embedded in MKV files via the
 * feed.animetosho.xyz v1 JSON API + storage.animetosho.xyz downloads.
 *
 * Flow:
 *   1. /json/v1/episodes/{eid}  → releases list for an AniDB episode
 *   2. /json?show=torrent&id=X  → file detail with mediainfo JSON
 *   3. Parse mediainfo → compute track numbers (video + audio + sub_index)
 *   4. storage.animetosho.xyz/releases/{id}/subtitles/{name}_track{n}.{lang}.{ext}.xz
 *
 * Key differences from .org:
 *   - .org returns attachments already indexed per file
 *   - .xyz returns mediainfo JSON from which we compute subtitle tracks ourselves
 *   - .xyz storage uses a different URL pattern (release ID + torrent name + track num)
 */

const { log } = require('../utils');

const XYZ_FEED_URL = 'https://feed.animetosho.xyz/json';
const XYZ_STORAGE_URL = 'https://storage.animetosho.xyz/releases';
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'SubSense-Stremio/2.0';
const RATE_LIMIT_MS = 2500;

let detailQueue = Promise.resolve();
let lastDetailTime = 0;

function enqueueDetailFetch(releaseId) {
    const task = detailQueue.then(async () => {
        const now = Date.now();
        const elapsed = now - lastDetailTime;
        if (elapsed < RATE_LIMIT_MS) {
            await new Promise(r => setTimeout(r, RATE_LIMIT_MS - elapsed));
        }
        lastDetailTime = Date.now();
        return _fetchReleaseDetail(releaseId);
    });
    detailQueue = task.catch(() => {});
    return task;
}

/**
 * Search by AniDB episode ID using v1 API.
 * Returns releases array (filtered to those with metadata_fetched: true).
 */
async function searchByEpisodeId(eid) {
    try {
        const url = `${XYZ_FEED_URL}/v1/episodes/${eid}`;
        const response = await fetch(url, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { 'User-Agent': USER_AGENT }
        });
        if (!response.ok) {
            log('warn', `[AT-XYZ] Episode ${eid}: HTTP ${response.status}`);
            return [];
        }
        const json = await response.json();
        const releases = json.data?.releases || [];
        return releases.filter(r => r.metadata_fetched);
    } catch (err) {
        log('error', `[AT-XYZ] Episode search error: ${err.message}`);
        return [];
    }
}

/**
 * Search by AniDB anime ID using v1 API.
 * Returns releases array for the entire series.
 */
async function searchByAnidbId(anidbId) {
    try {
        const url = `${XYZ_FEED_URL}/v1/series/anidb/${anidbId}`;
        const response = await fetch(url, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { 'User-Agent': USER_AGENT }
        });
        if (!response.ok) {
            log('warn', `[AT-XYZ] Series ${anidbId}: HTTP ${response.status}`);
            return [];
        }
        const json = await response.json();
        const releases = json.data?.releases || [];
        return releases.filter(r => r.metadata_fetched);
    } catch (err) {
        log('error', `[AT-XYZ] Series search error: ${err.message}`);
        return [];
    }
}

/**
 * Get release detail including mediainfo.
 * Queued to respect rate limits.
 */
function getReleaseDetail(releaseId) {
    return enqueueDetailFetch(releaseId);
}

async function _fetchReleaseDetail(releaseId) {
    try {
        const response = await fetch(`${XYZ_FEED_URL}?show=torrent&id=${releaseId}`, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { 'User-Agent': USER_AGENT }
        });
        if (!response.ok) {
            log('warn', `[AT-XYZ] Detail ${releaseId}: HTTP ${response.status}`);
            return null;
        }
        return await response.json();
    } catch (err) {
        log('error', `[AT-XYZ] Detail ${releaseId}: ${err.message}`);
        return null;
    }
}

/**
 * Parse subtitle tracks from a release detail's mediainfo.
 */
function parseSubtitleTracks(detail) {
    if (!detail?.files?.length) return [];

    const file = detail.files[0];
    if (!file.processed || !file.info?.mediainfo) return [];

    let mediainfo;
    try {
        mediainfo = JSON.parse(file.info.mediainfo);
    } catch (err) {
        log('debug', `[AT-XYZ] Mediainfo parse error for ${detail.id}: ${err.message}`);
        return [];
    }

    const numVideo = mediainfo.video?.length || 0;
    const numAudio = mediainfo.audio?.length || 0;
    const subtitles = mediainfo.subtitles || [];

    return subtitles.map((sub, index) => ({
        trackNum: numVideo + numAudio + index,
        codec: sub.codec || 'unknown',
        language: sub.language || 'und',
        title: sub.title || null,
        ext: (sub.codec === 'ass' || sub.codec === 'ssa') ? 'ass' :
             sub.codec === 'subrip' ? 'srt' :
             sub.codec === 'webvtt' ? 'vtt' : sub.codec || 'unknown'
    }));
}

/**
 * Build the XZ download URL for a subtitle track on storage.animetosho.xyz.
 *
 * Pattern: /releases/{releaseId}/subtitles/{torrentName}_track{n}.{lang}.{ext}.xz
 */
function buildStorageUrl(releaseId, torrentName, track) {
    return `${XYZ_STORAGE_URL}/${releaseId}/subtitles/${encodeURIComponent(torrentName)}_track${track.trackNum}.${track.language}.${track.ext}.xz`;
}

/**
 * Build the SubSense proxy URL for an xyz subtitle track.
 * Encodes (releaseId, trackNum, torrentName) into a single opaque ID.
 */
function buildProxyUrl(baseUrl, releaseId, track, torrentName, fmt) {
    const payload = JSON.stringify({
        r: releaseId,
        t: track.trackNum,
        l: track.language,
        e: track.ext,
        n: torrentName
    });
    const encoded = Buffer.from(payload).toString('base64url');
    return `${baseUrl}/api/animetosho-xyz/proxy/${encoded}?fmt=${fmt}`;
}

/**
 * Decode a proxy token back to its components.
 */
function decodeProxyToken(token) {
    try {
        const json = Buffer.from(token, 'base64url').toString('utf8');
        return JSON.parse(json);
    } catch (err) {
        return null;
    }
}

module.exports = {
    searchByEpisodeId,
    searchByAnidbId,
    getReleaseDetail,
    parseSubtitleTracks,
    buildStorageUrl,
    buildProxyUrl,
    decodeProxyToken,
    XYZ_FEED_URL,
    XYZ_STORAGE_URL
};

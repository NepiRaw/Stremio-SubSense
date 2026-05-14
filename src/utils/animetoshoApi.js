'use strict';

/**
 * AnimeTosho.org JSON API wrapper.
 *
 * Endpoints:
 *   ?eids=X      — search by AniDB episode ID (TV episodes, most precise)
 *   ?aids=X      — search by AniDB anime ID (movies, all episodes)
 *   ?q=X         — keyword search (fallback)
 *   ?show=torrent&id=X — full torrent detail with file attachments
 *
 * No API key required. No known rate limits.
 */

const { log } = require('../utils');

const FEED_URL = 'https://feed.animetosho.org/json';
const STORAGE_URL = 'https://storage.animetosho.org/attach';
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'SubSense-Stremio/2.0';

/**
 * Search by AniDB episode ID — returns entries for ONE specific episode.
 * This is the PRIMARY search method for TV episodes.
 * Returns ALL entries containing this episode (including batch packs).
 */
async function searchByEpisodeId(eid) {
    return fetchEntries(`${FEED_URL}?eids=${eid}`);
}

/**
 * Search by AniDB anime ID — returns entries for ALL episodes of that anime.
 * Used for MOVIES (no eid needed).
 */
async function searchByAnidbId(anidbId) {
    return fetchEntries(`${FEED_URL}?aids=${anidbId}`);
}

/**
 * Get full torrent details including file attachments (subtitles, fonts).
 *
 * Response shape:
 *   { ..., files: [{ filename, size, attachments: [{ id, type, info, size }] }] }
 *
 * attachment.type: "subtitle" | "font" | "chapter" | ...
 * attachment.info: { lang, codec, name, tracknum } (for subtitles)
 */
async function getTorrentDetail(torrentId) {
    try {
        const response = await fetch(`${FEED_URL}?show=torrent&id=${torrentId}`, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { 'User-Agent': USER_AGENT }
        });
        if (!response.ok) {
            log('warn', `[AT-API] Detail ${torrentId}: HTTP ${response.status}`);
            return null;
        }
        return await response.json();
    } catch (err) {
        log('error', `[AT-API] Detail ${torrentId}: ${err.message}`);
        return null;
    }
}

/**
 * Build the XZ download URL for an attachment.
 */
function buildAttachmentUrl(attachmentId) {
    const hex = attachmentId.toString(16).padStart(8, '0');
    return `${STORAGE_URL}/${hex}/file.xz`;
}

/**
 * Build the proxy URL for a SubSense proxy endpoint.
 */
function buildProxyUrl(baseUrl, attachmentId, fmt) {
    const hex = attachmentId.toString(16).padStart(8, '0');
    return `${baseUrl}/api/animetosho/proxy/${hex}?fmt=${fmt}`;
}

async function fetchEntries(url) {
    try {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { 'User-Agent': USER_AGENT }
        });
        if (!response.ok) {
            log('warn', `[AT-API] ${url}: HTTP ${response.status}`);
            return [];
        }
        const data = await response.json();
        if (!Array.isArray(data)) return [];

        return data
            .filter(e => e.status === 'complete')
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    } catch (err) {
        log('error', `[AT-API] Fetch error: ${err.message}`);
        return [];
    }
}

module.exports = {
    searchByEpisodeId,
    searchByAnidbId,
    getTorrentDetail,
    buildAttachmentUrl,
    buildProxyUrl,
    STORAGE_URL,
    FEED_URL
};

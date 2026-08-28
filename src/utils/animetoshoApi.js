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
 * Rate limit: Datacenter IPs get hard 429 rejections.
 * Uses a global sequential queue with adaptive backoff:
 *   - Base interval: 7s between requests
 *   - On 429: retry up to 3 times at 2s intervals
 *   - If all retries fail: penalty +10s per consecutive failure (cap 37s total)
 *   - On success: reset to base interval
 */

const { log } = require('../utils');
const rateLimit = require('../infra/rate-limit');

const FEED_URL = 'https://feed.animetosho.org/json';
const STORAGE_URL = 'https://storage.animetosho.org/attach';
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'SubSense-Stremio/2.0';

const BASE_RATE_MS = 7000;
const RETRY_DELAY_MS = 2000;
const MAX_RETRIES = 3;
const PENALTY_BACKOFF_MS = 10000;

/**
 * Global sequential queue for all AnimeTosho requests.
 * Serializes requests with adaptive spacing based on 429 responses.
 */
let gatePromise = Promise.resolve();
let lastRequestTime = 0;
let currentInterval = BASE_RATE_MS;
let consecutiveFailures = 0;

function enqueueRequest(fn) {
    // Slots are reserved across every worker, so the interval is the addon's rate, not one process's.
    const gate = gatePromise.then(async () => {
        await rateLimit.throttle('animetosho', currentInterval);
        lastRequestTime = Date.now();
    });
    gatePromise = gate.catch(() => {});
    return gate.then(() => fn());
}

// --- Persistent detail cache (SQLite) ---
let _db = null;

/**
 * Initialize the torrent detail cache table.
 * Call once at startup with the shared libSQL database instance.
 */
async function initDetailCache(database) {
    _db = database;
    await _db.executeMultiple(`
        CREATE TABLE IF NOT EXISTS at_torrent_details (
            torrent_id  INTEGER PRIMARY KEY,
            data        TEXT NOT NULL,
            created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
    `);
    log('info', '[AT-API] Detail cache table initialized');
}

async function _getCachedDetail(torrentId) {
    if (!_db) return null;
    try {
        const row = await _db.execute('SELECT data FROM at_torrent_details WHERE torrent_id = ?', [torrentId]);
        if (row.rows.length === 0) return null;
        return JSON.parse(row.rows[0].data);
    } catch { return null; }
}

async function _setCachedDetail(torrentId, data) {
    if (!_db || !data) return;
    try {
        await _db.execute(
            'INSERT OR REPLACE INTO at_torrent_details (torrent_id, data) VALUES (?, ?)',
            [torrentId, JSON.stringify(data)]
        );
    } catch (err) {
        log('debug', `[AT-API] Cache write failed for ${torrentId}: ${err.message}`);
    }
}

/**
 * Search by AniDB episode ID — returns entries for ONE specific episode.
 * This is the PRIMARY search method for TV episodes.
 * Returns ALL entries containing this episode (including batch packs).
 */
async function searchByEpisodeId(eid) {
    return enqueueRequest(() => fetchEntries(`${FEED_URL}?eids=${eid}`));
}

/**
 * Search by AniDB anime ID — returns entries for ALL episodes of that anime.
 * Used for MOVIES (no eid needed).
 */
async function searchByAnidbId(anidbId) {
    return enqueueRequest(() => fetchEntries(`${FEED_URL}?aids=${anidbId}`));
}

/**
 * Get full torrent details including file attachments (subtitles, fonts).
 * Checks persistent SQLite cache first - torrent details are immutable.
 * Falls back to rate-limited API fetch with retry on 429.
 */
async function getTorrentDetail(torrentId) {
    const cached = await _getCachedDetail(torrentId);
    if (cached) return cached;
    return enqueueRequest(async () => {
        const data = await _fetchTorrentDetail(torrentId);
        if (data) await _setCachedDetail(torrentId, data);
        return data;
    });
}

async function _fetchTorrentDetail(torrentId) {
    const url = `${FEED_URL}?show=torrent&id=${torrentId}`;
    const result = await _fetchWithRetry(url, `Detail ${torrentId}`);
    return result;
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
    const data = await _fetchWithRetry(url, url);
    if (!data) return [];
    if (!Array.isArray(data)) return [];
    return data.filter(e => e.status === 'complete').sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

/**
 * Core fetch with retry logic for 429 handling.
 * Retries up to MAX_RETRIES times at RETRY_DELAY_MS intervals.
 * If all retries fail, applies penalty backoff for next queue item.
 * Returns parsed JSON or null on failure.
 */
async function _fetchWithRetry(url, label) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (attempt > 0) {
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                lastRequestTime = Date.now();
            }
            const response = await fetch(url, {
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                headers: { 'User-Agent': USER_AGENT }
            });
            if (response.status === 429) {
                if (attempt < MAX_RETRIES) {
                    log('debug', `[AT-API] ${label}: 429, retry ${attempt + 1}/${MAX_RETRIES}`);
                    continue;
                }
                consecutiveFailures++;
                const penalty = Math.min(PENALTY_BACKOFF_MS * consecutiveFailures, 30000);
                currentInterval = BASE_RATE_MS + penalty;
                log('warn', `[AT-API] ${label}: 429 after ${MAX_RETRIES} retries, backoff ${currentInterval}ms`);
                return null;
            }
            if (!response.ok) {
                log('warn', `[AT-API] ${label}: HTTP ${response.status}`);
                return null;
            }
            consecutiveFailures = 0;
            currentInterval = BASE_RATE_MS;
            return await response.json();
        } catch (err) {
            if (attempt === MAX_RETRIES) {
                log('error', `[AT-API] ${label}: ${err.message}`);
                return null;
            }
            log('debug', `[AT-API] ${label}: ${err.message}, retry ${attempt + 1}/${MAX_RETRIES}`);
        }
    }
    return null;
}

module.exports = {
    searchByEpisodeId,
    searchByAnidbId,
    getTorrentDetail,
    initDetailCache,
    buildAttachmentUrl,
    buildProxyUrl,
    STORAGE_URL,
    FEED_URL
};

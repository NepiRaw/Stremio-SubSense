'use strict';

/**
 * AnimeTosho XYZ (v1) API wrapper.
 *
 * feed.animetosho.net lists the releases of an AniDB anime id, and ?show=torrent on a release
 * returns every file with its subtitle attachments. Each attachment already carries a language
 * code, a format and a working storage URL, so nothing has to be read out of mediainfo.
 *
 * Flow:
 *   1. /json/v1/series/anidb/{aid}  -> releases for the series, 100 per page, ?offset walks back
 *   2. /json?show=torrent&id=X      -> files, each with attachments[]
 *   3. storage.animetosho.net/...xz  -> the subtitle itself, in one of two path shapes
 */

const { log } = require('../utils');
const rateLimit = require('../infra/rate-limit');
const { redis, isHealthy } = require('../infra/redis');

const XYZ_FEED_URL = 'https://feed.animetosho.net/json';
const XYZ_STORAGE_URL = 'https://storage.animetosho.net';
const PAGE_SIZE = 100;
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'SubSense-Stremio/2.0';

// Measured upstream limit (per IP): 1 request every 2.5 s holds, 1 every 2 s is blocked within two minutes, a block clears in ~11 s
const FEED_INTERVAL_MS = parseInt(process.env.ANIMETOSHO_FEED_INTERVAL_MS, 10) || 3000;
const FEED_PAUSE_MS = parseInt(process.env.ANIMETOSHO_FEED_PAUSE_MS, 10) || 15000;
const FEED_MAX_WAIT_MS = parseInt(process.env.ANIMETOSHO_FEED_MAX_WAIT_MS, 10) || 4000;
const FEED_SLOT_KEY = 'animetosho-feed';
const FEED_PAUSE_KEY = 'ss:at:pause';

let localPauseUntil = 0;

async function isPaused() {
    if (Date.now() < localPauseUntil) return true;
    if (!isHealthy()) return false;
    try { return (await redis.pttl(FEED_PAUSE_KEY)) > 0; } catch (_) { return false; }
}

async function pauseFeed() {
    localPauseUntil = Date.now() + FEED_PAUSE_MS;
    if (isHealthy()) await redis.set(FEED_PAUSE_KEY, '1', 'PX', FEED_PAUSE_MS).catch(() => {});
}

/**
 * Every feed call shares one pace across the cluster and stops while a 429 pause runs.
 * A viewer call waits up to FEED_MAX_WAIT_MS for its turn, a background call only takes a free slot.
 * Returns null when the call was not made.
 */
async function feedFetch(url, { background = false } = {}) {
    if (await isPaused()) return null;
    const waitMs = await rateLimit.reserve(FEED_SLOT_KEY, FEED_INTERVAL_MS, { maxWaitMs: background ? 0 : FEED_MAX_WAIT_MS });
    if (waitMs < 0) {
        if (!background) log('info', `[AT-XYZ] Feed busy, skipped ${url.replace(XYZ_FEED_URL, '')}`);
        return null;
    }
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
    const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': USER_AGENT }
    });
    if (response.status === 429) {
        await pauseFeed();
        log('warn', `[AT-XYZ] HTTP 429, feed paused for ${FEED_PAUSE_MS / 1000}s`);
        return null;
    }
    return response;
}

/** One page of releases, newest first. The feed caps a page at 100 whatever ?limit asks for. */
async function searchByAnidbId(anidbId, offset = 0, { background = false } = {}) {
    try {
        const url = `${XYZ_FEED_URL}/v1/series/anidb/${anidbId}?limit=${PAGE_SIZE}&offset=${offset}`;
        const response = await feedFetch(url, { background });
        if (!response) return [];
        if (!response.ok) {
            log('warn', `[AT-XYZ] Series ${anidbId}: HTTP ${response.status}`);
            return [];
        }
        const json = await response.json();
        return json.data?.releases || [];
    } catch (err) {
        log('error', `[AT-XYZ] Series search error: ${err.message}`);
        return [];
    }
}

/** Release detail with its per-file attachment list. Speculative callers pass background: true. */
async function getReleaseDetail(releaseId, { background = false } = {}) {
    try {
        const response = await feedFetch(`${XYZ_FEED_URL}?show=torrent&id=${releaseId}`, { background });
        if (!response) return null;
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

/** Every subtitle attachment of a release, across all of its files. */
function extractSubtitles(detail) {
    const out = [];
    for (const file of detail?.files || []) {
        const fileName = file.filename || file.name || null;
        for (const a of file.attachments || []) {
            if (a.type !== 'subtitle' || !a.url) continue;
            const info = a.info || {};
            const fmt = String(info.format || '').toLowerCase();
            out.push({
                id: a.id,
                url: a.url,
                fileName,
                languageCode: info.language_code || null,
                languageName: info.language || null,
                format: fmt === 'ssa' ? 'ass' : fmt === 'subrip' ? 'srt' : fmt,
                forced: !!info.forced,
                isDefault: !!info.default,
                title: info.title || null
            });
        }
    }
    return out;
}

/** Tracks mediainfo reports but that have no attachment, so no URL. Coverage only. */
function countMediainfoTracks(detail) {
    let count = 0;
    for (const file of detail?.files || []) {
        const mediainfo = file.info && file.info.mediainfoj;
        if (mediainfo && Array.isArray(mediainfo.subtitles)) count += mediainfo.subtitles.length;
    }
    return count;
}

/** The token carries the attachment id and its storage path, which is all the proxy needs. */
function buildProxyUrl(baseUrl, subtitle, fmt) {
    const path = String(subtitle.url).replace(`${XYZ_STORAGE_URL}/`, '');
    const payload = JSON.stringify({ i: subtitle.id, p: path });
    const encoded = Buffer.from(payload).toString('base64url');
    return `${baseUrl}/api/animetosho-xyz/proxy/${encoded}?fmt=${fmt}`;
}

function decodeProxyToken(token) {
    try {
        const json = Buffer.from(token, 'base64url').toString('utf8');
        return JSON.parse(json);
    } catch (err) {
        return null;
    }
}

/**
 * Rebuild a storage URL from a token path. The payload uses more than one path shape, so the
 * guard pins the host instead of matching a shape.
 */
function storageUrlForPath(path) {
    let p = String(path || '');
    if (p.startsWith(`${XYZ_STORAGE_URL}/`)) p = p.slice(XYZ_STORAGE_URL.length + 1);
    if (!p || p.startsWith('/') || p.includes('://') || p.includes('..') || p.includes('\\')) return null;
    if (!p.split('?')[0].toLowerCase().endsWith('.xz')) return null;
    return `${XYZ_STORAGE_URL}/${p}`;
}

module.exports = {
    searchByAnidbId,
    getReleaseDetail,
    extractSubtitles,
    countMediainfoTracks,
    buildProxyUrl,
    decodeProxyToken,
    storageUrlForPath,
    PAGE_SIZE,
    XYZ_FEED_URL,
    XYZ_STORAGE_URL
};

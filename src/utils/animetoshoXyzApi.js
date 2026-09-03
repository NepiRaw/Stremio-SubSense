'use strict';

/**
 * AnimeTosho XYZ (v1) API wrapper.
 *
 * feed.animetosho.xyz lists the releases of an AniDB anime id, and ?show=torrent on a release
 * returns every file with its subtitle attachments. Each attachment already carries a language
 * code, a format and a working storage URL, so nothing has to be read out of mediainfo.
 *
 * Flow:
 *   1. /json/v1/series/anidb/{aid}  -> releases for the series, 100 per page, ?offset walks back
 *   2. /json?show=torrent&id=X      -> files, each with attachments[]
 *   3. storage.animetosho.xyz/...xz  -> the subtitle itself, in one of two path shapes
 */

const { log } = require('../utils');

const XYZ_FEED_URL = 'https://feed.animetosho.xyz/json';
const XYZ_STORAGE_URL = 'https://storage.animetosho.xyz';
const PAGE_SIZE = 100;
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'SubSense-Stremio/2.0';
const RATE_LIMIT_MS = 2500;

const pending = { foreground: [], background: [] };
let running = false;
let lastDetailTime = 0;

/**
 * One request at a time, spaced by RATE_LIMIT_MS, foreground before background so a speculative
 * pass cannot push a user-facing fetch past the provider deadline.
 */
async function runDetailQueue() {
    if (running) return;
    running = true;
    try {
        for (;;) {
            const job = pending.foreground.shift() || pending.background.shift();
            if (!job) return;

            const wait = RATE_LIMIT_MS - (Date.now() - lastDetailTime);
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
            lastDetailTime = Date.now();

            let detail = null;
            try { detail = await _fetchReleaseDetail(job.releaseId); } catch (_) { }
            job.resolve(detail);
        }
    } finally {
        running = false;
    }
}

/** One page of releases, newest first. The feed caps a page at 100 whatever ?limit asks for. */
async function searchByAnidbId(anidbId, offset = 0) {
    try {
        const url = `${XYZ_FEED_URL}/v1/series/anidb/${anidbId}?limit=${PAGE_SIZE}&offset=${offset}`;
        const response = await fetch(url, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { 'User-Agent': USER_AGENT }
        });
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
function getReleaseDetail(releaseId, { background = false } = {}) {
    return new Promise((resolve) => {
        pending[background ? 'background' : 'foreground'].push({ releaseId, resolve });
        runDetailQueue();
    });
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
    const p = String(path || '');
    if (!p || p.startsWith('/') || p.includes('://') || p.includes('..') || p.includes('\\')) return null;
    if (!p.toLowerCase().endsWith('.xz')) return null;
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

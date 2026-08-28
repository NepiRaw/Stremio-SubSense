'use strict';

/**
 * Filters out Wyzie subtitle URLs that no longer resolve.
 *
 * Results are memoised in Redis so a URL is probed once per hour across all workers, and
 * this runs only when an entry is written to cache, never when one is served.
 */

const crypto = require('crypto');
const { redis, isHealthy } = require('../infra/redis');
const { log } = require('../../src/utils');

const VALIDATE_TIMEOUT_MS = parseInt(process.env.WYZIE_VALIDATE_TIMEOUT_MS, 10) || 3000;
const MEMO_TTL_SECONDS = parseInt(process.env.WYZIE_VALIDATE_MEMO_TTL_S, 10) || 3600;
const MEMO_PREFIX = 'ss:wv:';

const memoKey = (url) => MEMO_PREFIX + crypto.createHash('sha1').update(url).digest('hex');

function extractWyzieUrl(url) {
    if (!url) return null;
    if (url.startsWith('https://sub.wyzie.io/')) return url;
    const idx = url.indexOf('https://sub.wyzie.io/');
    return idx >= 0 ? url.slice(idx) : null;
}

async function readMemo(urls) {
    if (!isHealthy() || urls.length === 0) return new Map();
    try {
        const values = await redis.mget(urls.map(memoKey));
        const known = new Map();
        urls.forEach((url, i) => {
            if (values[i] === '1') known.set(url, true);
            else if (values[i] === '0') known.set(url, false);
        });
        return known;
    } catch (_) {
        return new Map();
    }
}

async function writeMemo(results) {
    if (!isHealthy() || results.size === 0) return;
    try {
        const p = redis.pipeline();
        for (const [url, ok] of results) p.set(memoKey(url), ok ? '1' : '0', 'EX', MEMO_TTL_SECONDS);
        await p.exec();
    } catch (_) { /* memo is an optimisation, not a requirement */ }
}

async function probe(url, timeoutMs) {
    try {
        const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
        if (response.body) response.body.cancel().catch(() => {});
        return response.ok;
    } catch (_) {
        return false;
    }
}

/** Returns `subtitles` without the entries whose Wyzie URL failed to respond. */
async function validateWyzieUrls(subtitles, timeoutMs = VALIDATE_TIMEOUT_MS) {
    if (!subtitles || subtitles.length === 0) return subtitles;

    const entries = [];
    for (let i = 0; i < subtitles.length; i++) {
        const rawUrl = extractWyzieUrl(subtitles[i].url);
        if (rawUrl) entries.push({ idx: i, rawUrl });
    }
    if (entries.length === 0) return subtitles;

    const uniqueUrls = [...new Set(entries.map(e => e.rawUrl))];
    const status = await readMemo(uniqueUrls);

    const unknown = uniqueUrls.filter(u => !status.has(u));
    if (unknown.length > 0) {
        const probed = await Promise.allSettled(
            unknown.map(async (url) => ({ url, ok: await probe(url, timeoutMs) }))
        );
        const fresh = new Map();
        for (const r of probed) {
            if (r.status === 'fulfilled') {
                status.set(r.value.url, r.value.ok);
                fresh.set(r.value.url, r.value.ok);
            }
        }
        await writeMemo(fresh);
    }

    const dead = new Set();
    for (const { idx, rawUrl } of entries) {
        if (status.get(rawUrl) === false) dead.add(idx);
    }
    if (dead.size > 0) {
        log('info', `[validateWyzie] filtered ${dead.size} dead URLs (${unknown.length} probed, ${uniqueUrls.length - unknown.length} memoised)`);
    }
    return subtitles.filter((_, i) => !dead.has(i));
}

module.exports = { validateWyzieUrls };

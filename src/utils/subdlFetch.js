'use strict';

const { log } = require('../utils');
const { forceWarpFetch, isWarpAvailable } = require('./warpFetch');
const { requestWarpRotation } = require('./warpRotation');
const { safe } = require('../infra/redis');

// Rate limiter: serial queue with token bucket + minimum spacing
const MAX_TOKENS = 5;
const REFILL_INTERVAL_MS = 1000; // refill all tokens every second
const MIN_SPACING_MS = 200;      // at least 200ms between dispatched requests

let tokens = MAX_TOKENS;
let lastRefill = Date.now();
let lastDispatch = 0;
const queue = [];
let processing = false;

function refillTokens() {
    const now = Date.now();
    const elapsed = now - lastRefill;
    const cycles = Math.floor(elapsed / REFILL_INTERVAL_MS);
    if (cycles > 0) {
        tokens = Math.min(MAX_TOKENS, tokens + cycles * MAX_TOKENS);
        lastRefill += cycles * REFILL_INTERVAL_MS;
    }
}

function processQueue() {
    if (processing) return;
    processing = true;

    function next() {
        if (queue.length === 0) { processing = false; return; }
        refillTokens();
        if (tokens <= 0) {
            const waitMs = REFILL_INTERVAL_MS - (Date.now() - lastRefill);
            setTimeout(next, Math.max(waitMs, 10));
            return;
        }
        const now = Date.now();
        const sinceLastDispatch = now - lastDispatch;
        if (sinceLastDispatch < MIN_SPACING_MS) {
            setTimeout(next, MIN_SPACING_MS - sinceLastDispatch);
            return;
        }
        tokens--;
        lastDispatch = Date.now();
        const resolve = queue.shift();
        resolve();
        setImmediate(next);
    }

    next();
}

function waitForToken() {
    return new Promise(resolve => {
        queue.push(resolve);
        processQueue();
    });
}

// Server block state (direct IP blocked by upstream)
let serverBlocked = false;
let serverBlockedAt = 0;
const PROBE_INTERVAL_MS = 5 * 60 * 1000; // retry the direct exit every 5 minutes

/**
 * Fetch from dl.subdl.com with tiered strategy:
 * 1. Direct (rate-limited) unless server is blocked
 * 2. WARP fallback on 429
 * 3. WARP IP rotation if WARP also returns 429, owned by the cluster primary
 * 4. Periodic server probe to detect unblocking
 */
async function subdlFetch(url, options = {}) {
    // Periodic probe: check if server unblocked
    if (serverBlocked && (Date.now() - serverBlockedAt > PROBE_INTERVAL_MS)) {
        log('info', '[subdlFetch] Probing direct access after block cooldown...');
        serverBlocked = false;
    }

    // Tier 1: Direct fetch with rate limiting
    if (!serverBlocked) {
        await waitForToken();
        const res = await fetch(url, options);
        if (res.ok) return res;
        if (res.status === 429) {
            log('warn', '[subdlFetch] Server blocked direct IP, switching to WARP fallback');
            serverBlocked = true;
            serverBlockedAt = Date.now();
        } else {
            return res;
        }
    }

    // Tier 2: WARP fallback (still rate-limited)
    if (!isWarpAvailable()) {
        const err = new Error('subdl download 429 (server blocked, WARP unavailable)');
        err.status = 429;
        throw err;
    }

    await waitForToken();
    const warpRes = await forceWarpFetch(url, options);
    if (warpRes.ok) return warpRes;

    if (warpRes.status === 429) {
        // Tier 3: Rotate WARP IP and let next request benefit
        log('warn', '[subdlFetch] WARP also got 429, requesting IP rotation');
        await requestWarpRotation();
    }

    return warpRes;
}

function getSubdlFetchStats() {
    return {
        serverBlocked,
        serverBlockedAt: serverBlocked ? new Date(serverBlockedAt).toISOString() : null,
        tokensRemaining: tokens,
        queueLength: queue.length,
        warpAvailable: isWarpAvailable()
    };
}

const MISS_PREFIX = 'ss:subdl-miss:';
const MISS_TTL_SECONDS = 30 * 24 * 60 * 60;

function missKey(path, season, episode, track) {
    return `${MISS_PREFIX}${path}:${season}:${episode}:${track || 'plain'}`;
}

function recordArchiveMiss(path, season, episode, track) {
    return safe(r => r.set(missKey(path, season, episode, track), '1', 'EX', MISS_TTL_SECONDS));
}

/** One boolean per [path, season, episode, track]; all false when Redis is unavailable. */
async function archiveMisses(keys) {
    if (!keys.length) return [];
    const values = await safe(r => r.mget(keys.map(k => missKey(...k))), null);
    return keys.map((_, i) => !!(values && values[i]));
}

module.exports = { subdlFetch, getSubdlFetchStats, recordArchiveMiss, archiveMisses };

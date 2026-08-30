'use strict';

const { execSync } = require('child_process');
const { log } = require('../utils');
const { forceWarpFetch, isWarpAvailable } = require('./warpFetch');

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

// WARP rotation state
let warpRotating = false;
let lastWarpRotation = 0;
let currentWarpIp = null;
const WARP_ROTATION_COOLDOWN_MS = 30000; // 30s cooldown between rotations
const MAX_ROTATION_ATTEMPTS = 3;
const WARP_PROXY_URL = process.env.WARP_PROXY_URL || 'socks5h://127.0.0.1:40000';

async function getWarpExitIp() {
    try {
        const res = execSync(
            `curl -s --max-time 5 --socks5-hostname ${WARP_PROXY_URL.replace('socks5h://', '')} https://ifconfig.me`,
            { timeout: 8000, stdio: 'pipe' }
        );
        return res.toString().trim();
    } catch (_) {
        return null;
    }
}

async function rotateWarpIp() {
    const now = Date.now();
    if (warpRotating || (now - lastWarpRotation < WARP_ROTATION_COOLDOWN_MS)) return false;
    warpRotating = true;
    try {
        const oldIp = currentWarpIp || await getWarpExitIp();

        for (let attempt = 1; attempt <= MAX_ROTATION_ATTEMPTS; attempt++) {
            execSync('warp-cli --accept-tos disconnect', { timeout: 5000, stdio: 'pipe' });
            execSync('sleep 2', { timeout: 5000, stdio: 'pipe' });
            execSync('warp-cli --accept-tos connect', { timeout: 5000, stdio: 'pipe' });
            execSync('sleep 3', { timeout: 5000, stdio: 'pipe' });

            const newIp = await getWarpExitIp();
            if (newIp && newIp !== oldIp) {
                currentWarpIp = newIp;
                lastWarpRotation = Date.now();
                log('info', `[subdlFetch] WARP IP rotated: ${oldIp} -> ${newIp} (attempt ${attempt})`);
                return true;
            }
            log('warn', `[subdlFetch] WARP IP unchanged after attempt ${attempt} (${newIp})`);
        }

        log('warn', `[subdlFetch] WARP IP rotation failed after ${MAX_ROTATION_ATTEMPTS} attempts`);
        lastWarpRotation = Date.now();
        return false;
    } catch (e) {
        log('warn', `[subdlFetch] WARP rotation error: ${e.message}`);
        return false;
    } finally {
        warpRotating = false;
    }
}

/**
 * Fetch from dl.subdl.com with tiered strategy:
 * 1. Direct (rate-limited) unless server is blocked
 * 2. WARP fallback on 429
 * 3. WARP IP rotation if WARP also returns 429
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
        log('warn', '[subdlFetch] WARP also got 429, attempting IP rotation');
        await rotateWarpIp();
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

module.exports = { subdlFetch, getSubdlFetchStats };

'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('../utils');

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://flaresolverr:8191';
const COOKIE_POOL_SIZE = parseInt(process.env.OS_COOKIE_POOL_SIZE, 10) || 10;
const DATA_DIR = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, '../../data');
const COOKIE_FILE = path.join(DATA_DIR, 'cf_cookies.json');
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const MAX_FAIL_COUNT = 3;
const TARGET_URL = 'https://dl.opensubtitles.org/en/download/sub/1';

let pool = [];
let roundRobinIdx = 0;
let available = false;
let refreshTimer = null;

function loadFromDisk() {
    try {
        if (fs.existsSync(COOKIE_FILE)) {
            const data = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
            if (Array.isArray(data)) {
                pool = data.filter(c => c && c.value && c.userAgent);
                log('info', `[cfCookieManager] Loaded ${pool.length} cookies from disk`);
            }
        }
    } catch (e) {
        log('warn', `[cfCookieManager] Failed to load cookies: ${e.message}`);
    }
}

function saveToDisk() {
    try {
        const dir = path.dirname(COOKIE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(COOKIE_FILE, JSON.stringify(pool, null, 2));
    } catch (e) {
        log('warn', `[cfCookieManager] Failed to save cookies: ${e.message}`);
    }
}

async function checkFlareSolverr() {
    try {
        const res = await fetch(FLARESOLVERR_URL, { signal: AbortSignal.timeout(5000) });
        return res.ok || res.status === 405;
    } catch {
        return false;
    }
}

async function generateCookie() {
    const body = JSON.stringify({
        cmd: 'request.get',
        url: TARGET_URL,
        maxTimeout: 60000
    });

    const res = await fetch(`${FLARESOLVERR_URL}/v1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(90000)
    });

    if (!res.ok) throw new Error(`FlareSolverr returned ${res.status}`);

    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.message || 'FlareSolverr failed');

    const cookies = data.solution?.cookies || [];
    const cfCookie = cookies.find(c => c.name === 'cf_clearance');
    if (!cfCookie) throw new Error('No cf_clearance in response');

    return {
        value: cfCookie.value,
        userAgent: data.solution.userAgent,
        createdAt: Date.now(),
        lastUsedAt: null,
        requestCount: 0,
        failCount: 0
    };
}

async function fillPool() {
    const needed = COOKIE_POOL_SIZE - pool.filter(c => c.failCount < MAX_FAIL_COUNT).length;
    if (needed <= 0) return;

    log('info', `[cfCookieManager] Generating ${needed} cookies (pool: ${pool.length}/${COOKIE_POOL_SIZE})`);

    for (let i = 0; i < needed; i++) {
        try {
            const cookie = await generateCookie();
            pool.push(cookie);
            saveToDisk();
            log('info', `[cfCookieManager] Cookie ${pool.length}/${COOKIE_POOL_SIZE} generated`);
        } catch (e) {
            log('warn', `[cfCookieManager] Cookie generation failed: ${e.message}`);
            break;
        }
    }
}

function pruneStale() {
    const before = pool.length;
    pool = pool.filter(c => c.failCount < MAX_FAIL_COUNT);
    if (pool.length < before) {
        log('info', `[cfCookieManager] Pruned ${before - pool.length} failed cookies`);
        saveToDisk();
    }
}

async function backgroundRefresh() {
    pruneStale();
    await fillPool();
}

async function init() {
    const reachable = await checkFlareSolverr();
    if (!reachable) {
        log('info', '[cfCookieManager] FlareSolverr not reachable, cookie bypass disabled (using WARP fallback)');
        return;
    }

    loadFromDisk();
    pruneStale();

    const validCount = pool.filter(c => c.failCount < MAX_FAIL_COUNT).length;
    if (validCount > 0) {
        available = true;
        log('info', `[cfCookieManager] Ready with ${validCount} valid cookies`);
        setImmediate(() => fillPool().catch(() => {}));
    } else {
        log('info', '[cfCookieManager] No valid cookies, generating first one...');
        try {
            const cookie = await generateCookie();
            pool.push(cookie);
            saveToDisk();
            available = true;
            log('info', '[cfCookieManager] First cookie ready, filling pool in background');
            setImmediate(() => fillPool().catch(() => {}));
        } catch (e) {
            log('warn', `[cfCookieManager] Initial cookie generation failed: ${e.message}`);
            log('info', '[cfCookieManager] Will retry in background, using WARP fallback for now');
            available = false;
        }
    }

    refreshTimer = setInterval(() => backgroundRefresh().catch(() => {}), REFRESH_INTERVAL_MS);
}

function getNextCookie() {
    const valid = pool.filter(c => c.failCount < MAX_FAIL_COUNT);
    if (valid.length === 0) return null;
    roundRobinIdx = roundRobinIdx % valid.length;
    const cookie = valid[roundRobinIdx];
    roundRobinIdx++;
    cookie.lastUsedAt = Date.now();
    cookie.requestCount++;
    return cookie;
}

function markFailed(cookie) {
    if (!cookie) return;
    cookie.failCount++;
    log('warn', `[cfCookieManager] Cookie marked failed (fails: ${cookie.failCount}/${MAX_FAIL_COUNT})`);
    if (cookie.failCount >= MAX_FAIL_COUNT) {
        log('info', '[cfCookieManager] Cookie exhausted, triggering background replacement');
        setImmediate(() => fillPool().catch(() => {}));
    }
    saveToDisk();
}

function isAvailable() {
    if (!available) return false;
    return pool.some(c => c.failCount < MAX_FAIL_COUNT);
}

function getStats() {
    const valid = pool.filter(c => c.failCount < MAX_FAIL_COUNT);
    return {
        total: pool.length,
        valid: valid.length,
        available,
        totalRequests: pool.reduce((sum, c) => sum + c.requestCount, 0)
    };
}

function shutdown() {
    if (refreshTimer) clearInterval(refreshTimer);
}

module.exports = { init, getNextCookie, markFailed, isAvailable, getStats, shutdown };

'use strict';

/**
 * Cross-process request deduplication. One worker fetches a given key, the others wait for
 * its result to appear in L1. Falls back to a per-process set when Redis is unavailable,
 * which degrades to v2 behaviour: dedup within a worker only.
 */

const { redis, isHealthy } = require('../infra/redis');

const PREFIX = 'ss:lock:';
const LOCK_TTL_SECONDS = 15;
const POLL_ATTEMPTS = 12;
const POLL_INTERVAL_MS = 200;

const localLocks = new Set();

const lockKey = (key) => PREFIX + key;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** True when this caller owns the fetch and must eventually call release(). */
async function acquire(key, ttlSeconds = LOCK_TTL_SECONDS) {
    if (isHealthy()) {
        try {
            const res = await redis.set(lockKey(key), '1', 'EX', ttlSeconds, 'NX');
            return res === 'OK';
        } catch (_) { /* fall through to the local set */ }
    }
    if (localLocks.has(key)) return false;
    localLocks.add(key);
    return true;
}

async function release(key) {
    localLocks.delete(key);
    if (isHealthy()) {
        try { await redis.del(lockKey(key)); } catch (_) { /* lock expires on its own */ }
    }
}

/**
 * Poll `read` until it returns a non-null value or the attempts run out.
 * Used by callers that lost the lock race.
 */
async function pollFor(read, { attempts = POLL_ATTEMPTS, intervalMs = POLL_INTERVAL_MS } = {}) {
    for (let i = 0; i < attempts; i++) {
        await sleep(intervalMs);
        const value = await read();
        if (value) return value;
    }
    return null;
}

function localSize() { return localLocks.size; }

module.exports = { acquire, release, pollFor, localSize, LOCK_TTL_SECONDS, POLL_ATTEMPTS, POLL_INTERVAL_MS };

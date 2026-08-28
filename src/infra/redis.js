'use strict';

/**
 * Shared Redis connection. Redis is a cache and a delta buffer, never a source of truth,
 * so commands fail fast while disconnected and callers fall back through `safe()`.
 */

const Redis = require('ioredis');
const { log } = require('../utils');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const COMMAND_TIMEOUT_MS = parseInt(process.env.REDIS_COMMAND_TIMEOUT_MS, 10) || 250;
const ERROR_LOG_INTERVAL_MS = 60_000;

let healthy = false;
let lastErrorLoggedAt = 0;
let suppressedErrors = 0;

const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: COMMAND_TIMEOUT_MS,
    retryStrategy: (times) => Math.min(times * 200, 5000)
});

redis.on('ready', () => {
    healthy = true;
    if (suppressedErrors > 0) {
        log('info', `[Redis] reconnected (${suppressedErrors} errors suppressed while down)`);
        suppressedErrors = 0;
    } else {
        log('info', `[Redis] connected: ${REDIS_URL}`);
    }
});

redis.on('error', (err) => {
    healthy = false;
    const now = Date.now();
    if (now - lastErrorLoggedAt >= ERROR_LOG_INTERVAL_MS) {
        lastErrorLoggedAt = now;
        log('warn', `[Redis] ${err.message} (serving continues without cache)`);
    } else {
        suppressedErrors++;
    }
});

redis.on('end', () => { healthy = false; });
redis.on('close', () => { healthy = false; });

function isHealthy() {
    return healthy && redis.status === 'ready';
}

/** Run a Redis operation, returning `fallback` if Redis is down or the command fails. */
async function safe(fn, fallback = null) {
    if (!isHealthy()) return fallback;
    try {
        return await fn(redis);
    } catch (err) {
        log('debug', `[Redis] command failed: ${err.message}`);
        return fallback;
    }
}

/** Connect without throwing. Returns true when usable. */
async function connect() {
    if (redis.status === 'ready') return true;
    try {
        if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
        return isHealthy();
    } catch (err) {
        log('warn', `[Redis] initial connect failed: ${err.message} (serving continues without cache)`);
        return false;
    }
}

async function close() {
    try { await redis.quit(); }
    catch (_) { redis.disconnect(); }
    healthy = false;
}

module.exports = { redis, isHealthy, safe, connect, close, REDIS_URL };

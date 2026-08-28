'use strict';

/**
 * Deep health probe, for humans and uptime monitors.
 *
 * It names what is broken rather than just failing, and every dependency is checked under
 * its own timeout so a stuck one cannot hold the answer open. Never wire this to a
 * container healthcheck: restarting the addon does not fix an upstream outage, and a deep
 * check on a restart trigger turns a dependency blip into a crash loop.
 */

const infra = require('./infra/db');
const redis = require('./infra/redis');
const metrics = require('./infra/metrics');
const { K, CL_QUEUE_MAX } = require('./stats/track');

function intEnv(name, fallback) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

const DB_TIMEOUT_MS = intEnv('HEALTH_DB_TIMEOUT_MS', 2000);
const HEARTBEAT_MAX_SECONDS = intEnv('HEALTH_HEARTBEAT_MAX_SECONDS', 300);
const FOLD_MAX_SECONDS = intEnv('HEALTH_FOLD_MAX_SECONDS', 300);
// Track sheds content rows once the queue passes CL_QUEUE_MAX, so warn while there is headroom.
const QUEUE_MAX = intEnv('HEALTH_QUEUE_MAX', Math.round(CL_QUEUE_MAX * 0.8));

const DB_NAMES = ['cache', 'stats', 'meta'];

function withTimeout(promise, ms, label) {
    let timer = null;
    const expiry = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

async function probeDb(name) {
    const startedAt = Date.now();
    try {
        await withTimeout(infra.clients[name].execute('SELECT 1'), DB_TIMEOUT_MS, `db:${name}`);
        return { ok: true, ms: Date.now() - startedAt };
    } catch (err) {
        return { ok: false, ms: Date.now() - startedAt, error: err.message };
    }
}

/** Age of a worker marker in seconds, or null when it is unreadable or was never written. */
async function markerAgeSeconds(key) {
    try {
        const raw = await withTimeout(infra.kvGet(key), DB_TIMEOUT_MS, key);
        const at = Number(raw);
        if (!Number.isFinite(at) || at <= 0) return null;
        return Math.max(0, Math.round((Date.now() - at) / 1000));
    } catch (_) {
        return null;
    }
}

async function deepHealth() {
    const [dbResults, heartbeatAge, foldAge, queueDepth] = await Promise.all([
        Promise.all(DB_NAMES.map(probeDb)),
        markerAgeSeconds(infra.KV.workerHeartbeat),
        markerAgeSeconds(infra.KV.lastFold),
        redis.safe(r => r.llen(K.contentQueue), null)
    ]);

    const databases = {};
    DB_NAMES.forEach((name, i) => { databases[name] = dbResults[i]; });

    const redisConnected = redis.isHealthy();
    const degraded = [];

    for (const name of DB_NAMES) {
        if (!databases[name].ok) degraded.push(`db:${name}`);
    }
    if (!redisConnected) degraded.push('redis');
    if (queueDepth != null && queueDepth >= QUEUE_MAX) degraded.push('queue-depth');
    if (heartbeatAge === null || heartbeatAge > HEARTBEAT_MAX_SECONDS) degraded.push('worker-heartbeat');
    if (foldAge === null || foldAge > FOLD_MAX_SECONDS) degraded.push('fold-stale');

    const m = metrics.snapshot();
    return {
        status: degraded.length === 0 ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        degraded,
        databases,
        redis: { connected: redisConnected, contentQueueDepth: queueDepth },
        worker: { heartbeatAgeSeconds: heartbeatAge, lastFoldAgeSeconds: foldAge },
        metrics: {
            requestsPerMinute: m.requestsPerMinute,
            eventLoopP99Ms: m.eventLoop.p99Ms,
            cacheHitRate: m.cache.hitRate,
            rssMb: m.memory.rssMb
        },
        thresholds: {
            heartbeatMaxSeconds: HEARTBEAT_MAX_SECONDS,
            foldMaxSeconds: FOLD_MAX_SECONDS,
            queueMax: QUEUE_MAX
        }
    };
}

module.exports = { deepHealth };

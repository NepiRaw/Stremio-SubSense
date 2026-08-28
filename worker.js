'use strict';

require('dotenv').config();

/**
 * SubSense maintenance worker.
 *
 * The only process that writes to stats.db on a schedule. Every job runs under a time
 * budget and reports what it left behind, so a backlog is drained across ticks rather
 * than in one unbounded pass.
 */

const fs = require('fs');
const path = require('path');

const { log } = require('./src/utils');
const infra = require('./src/infra/db');
const redis = require('./src/infra/redis');
const { createScheduler } = require('./src/jobs/scheduler');
const { initStats, isStatsEnabled, statsDB, track, contentLog, fold } = require('./src/stats');
const cacheCleanup = require('./src/jobs/cleanup-cache');
const metaPrune = require('./src/jobs/prune-meta');

function intEnv(name, fallback) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

const DRAIN_INTERVAL_MS      = intEnv('WORKER_DRAIN_INTERVAL_MS',      10 * 1000);
const FOLD_INTERVAL_MS       = intEnv('WORKER_FOLD_INTERVAL_MS',       60 * 1000);
const USERS_INTERVAL_MS      = intEnv('WORKER_USERS_INTERVAL_MS',      60 * 1000);
const CLEANUP_INTERVAL_MS    = intEnv('WORKER_CLEANUP_INTERVAL_MS',    2 * 60 * 60 * 1000);
const CHECKPOINT_INTERVAL_MS = intEnv('WORKER_CHECKPOINT_INTERVAL_MS', 30 * 60 * 1000);
const HEALTH_INTERVAL_MS     = intEnv('WORKER_HEALTH_INTERVAL_MS',     60 * 1000);
const PRUNE_USERS_INTERVAL_MS = intEnv('WORKER_PRUNE_USERS_INTERVAL_MS', 6 * 60 * 60 * 1000);
const PRUNE_META_INTERVAL_MS  = intEnv('WORKER_PRUNE_META_INTERVAL_MS', 24 * 60 * 60 * 1000);
const SHUTDOWN_TIMEOUT_MS    = intEnv('WORKER_SHUTDOWN_TIMEOUT_MS',    15 * 1000);

const DATA_DIR = process.env.DB_DIR || path.resolve(__dirname, 'data');
const HEALTH_PATH = path.join(DATA_DIR, 'worker-health.json');

const scheduler = createScheduler();
let isShuttingDown = false;

async function writeHealthSnapshot() {
    const snapshot = {
        generatedAt: new Date().toISOString(),
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        redis: redis.isHealthy(),
        jobs: scheduler.list()
    };
    try {
        snapshot.subtitleCacheRows = await cacheCleanup.cachedRowCount();
        snapshot.contentLogRows = await contentLog.totalRows();
    } catch (_) { /* tables may be empty on first boot */ }

    try {
        const stat = fs.statSync(path.join(DATA_DIR, path.basename(infra.PATHS.cache)));
        snapshot.cacheDbMB = +(stat.size / (1024 * 1024)).toFixed(2);
    } catch (_) { /* fresh install */ }

    await redis.safe(r => r.hset('ss:health:worker', {
        at: String(Date.now()),
        pid: String(process.pid),
        redis: '1'
    }), null);

    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(HEALTH_PATH, JSON.stringify(snapshot, null, 2));
    } catch (err) {
        log('warn', `[worker] health snapshot write failed: ${err.message}`);
    }

    await infra.kvSet(infra.KV.workerHeartbeat, String(Date.now()));
    return { done: true };
}

async function checkpoint() {
    for (const [name, client] of [['stats', infra.statsDb], ['meta', infra.metaDb]]) {
        try { await client.execute('PRAGMA wal_checkpoint(TRUNCATE)'); }
        catch (err) { log('warn', `[worker] ${name} checkpoint failed: ${err.message}`); }
    }
    // The API writes cache.db continuously, so a passive checkpoint avoids blocking it.
    try { await infra.cacheDb.execute('PRAGMA wal_checkpoint(PASSIVE)'); }
    catch (err) { log('warn', `[worker] cache checkpoint failed: ${err.message}`); }
    return { done: true };
}

async function pruneInactiveUsers() {
    if (!isStatsEnabled()) return { done: true };
    const removed = await statsDB.cleanupInactiveUsers();
    return { done: true, removed };
}

async function bootstrap() {
    log('info', '[worker] starting');
    await infra.initAll();
    await redis.connect();
    await initStats();

    let delay = 0;
    const stagger = () => (delay += 2000);

    scheduler.schedule({ name: 'drain-content-log', everyMs: DRAIN_INTERVAL_MS, budgetMs: 200, delayMs: stagger(), fn: contentLog.drain });
    scheduler.schedule({ name: 'fold-analytics',    everyMs: FOLD_INTERVAL_MS,  budgetMs: 500, delayMs: stagger(), fn: fold.foldAll });
    scheduler.schedule({ name: 'flush-users',       everyMs: USERS_INTERVAL_MS, budgetMs: 500, delayMs: stagger(), fn: fold.flushUsers });
    scheduler.schedule({ name: 'cleanup-cache',     everyMs: CLEANUP_INTERVAL_MS, budgetMs: 2000, delayMs: stagger(), fn: cacheCleanup.run });
    scheduler.schedule({ name: 'checkpoint',        everyMs: CHECKPOINT_INTERVAL_MS, delayMs: stagger(), fn: checkpoint });
    scheduler.schedule({ name: 'prune-users',       everyMs: PRUNE_USERS_INTERVAL_MS, budgetMs: 500, delayMs: stagger(), fn: pruneInactiveUsers });
    scheduler.schedule({ name: 'prune-meta',        everyMs: PRUNE_META_INTERVAL_MS, budgetMs: 1000, delayMs: stagger(), fn: metaPrune.run });
    scheduler.schedule({ name: 'heartbeat',         everyMs: HEALTH_INTERVAL_MS, delayMs: 1000, fn: writeHealthSnapshot });

    log('info', `[worker] ready with ${scheduler.list().length} jobs ` +
        `(drain=${DRAIN_INTERVAL_MS / 1000}s fold=${FOLD_INTERVAL_MS / 1000}s cleanup=${CLEANUP_INTERVAL_MS / 60000}m)`);
    installShutdownHandlers();
}

function installShutdownHandlers() {
    const handle = (signal) => () => shutdown(signal);
    process.on('SIGTERM', handle('SIGTERM'));
    process.on('SIGINT',  handle('SIGINT'));
    process.on('uncaughtException',  (err) => log('error', `[worker] uncaughtException: ${err.stack || err.message}`));
    process.on('unhandledRejection', (reason) => log('error', `[worker] unhandledRejection: ${reason && reason.stack || reason}`));
}

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log('info', `[worker] ${signal} received; finalizing...`);

    const force = setTimeout(() => {
        log('warn', `[worker] force-exit after ${SHUTDOWN_TIMEOUT_MS}ms`);
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    if (typeof force.unref === 'function') force.unref();

    scheduler.stopAll();

    // Drain what is already queued so a restart does not leave deltas stranded.
    for (const [name, fn] of [['track', track.stop], ['drain', contentLog.drain], ['fold', fold.foldAll], ['users', fold.flushUsers]]) {
        try { await fn({ deadline: Date.now() + 3000 }); }
        catch (err) { log('warn', `[worker] final ${name} failed: ${err.message}`); }
    }

    try { await checkpoint(); } catch (_) { /* best effort */ }
    try { await writeHealthSnapshot(); } catch (_) { /* best effort */ }
    try { await redis.close(); } catch (_) { /* best effort */ }
    try { infra.close(); } catch (err) { log('warn', `[worker] db close error: ${err.message}`); }

    clearTimeout(force);
    log('info', '[worker] shutdown complete');
    process.exit(0);
}

bootstrap().catch((err) => {
    log('error', `[worker] bootstrap failed: ${err.stack || err.message}`);
    process.exit(1);
});

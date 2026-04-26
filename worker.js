'use strict';

require('dotenv').config();

/**
 * SubSense worker process.
 *
 * The worker owns every background job that touches the cache database:
 *
 *   - cache cleanup (TTL-based DELETE in 500-row batches, every 2h)
 *   - WAL checkpoint (PASSIVE every 30min, TRUNCATE on shutdown)
 *   - PRAGMA optimize + incremental_vacuum (every 6h)
 *   - health snapshot (data/admin/dashboard.json every 60s)
 *
 * On SIGTERM/SIGINT it runs every interval one final time, performs a
 * TRUNCATE checkpoint, and closes the DB cleanly so the WAL is reclaimed.
 */

const fs = require('fs');
const path = require('path');

const { log } = require('./src/utils');
const db = require('./src/cache/database-libsql');
const CacheCleaner = require('./src/cache/cache-cleaner');
const { initStats, isFullStats, isStatsEnabled, statsDB, STATS_REFRESH_INTERVAL, flushWrites } = require('./src/stats');

const CLEANUP_INTERVAL_MS    = intEnv('WORKER_CLEANUP_INTERVAL_MS',    2 * 60 * 60 * 1000);
const CHECKPOINT_INTERVAL_MS = intEnv('WORKER_CHECKPOINT_INTERVAL_MS', 30 * 60 * 1000);
const OPTIMIZE_INTERVAL_MS   = intEnv('WORKER_OPTIMIZE_INTERVAL_MS',   6 * 60 * 60 * 1000);
const HEALTH_INTERVAL_MS     = intEnv('WORKER_HEALTH_INTERVAL_MS',     60 * 1000);
const SHUTDOWN_TIMEOUT_MS    = intEnv('WORKER_SHUTDOWN_TIMEOUT_MS',    15 * 1000);

const DATA_DIR  = process.env.DB_DIR || path.resolve(__dirname, 'data');
const HEALTH_PATH = path.join(DATA_DIR, 'worker-health.json');

const cleaner = new CacheCleaner();
const intervals = [];
let isShuttingDown = false;

function intEnv(name, fallback) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

async function bootstrap() {
    log('info', '[worker] starting');
    await db.initializeDatabase();
    await initStats();

    schedule('cleanup',    CLEANUP_INTERVAL_MS,    runCleanup);
    schedule('checkpoint', CHECKPOINT_INTERVAL_MS, runCheckpoint);
    schedule('optimize',   OPTIMIZE_INTERVAL_MS,   runOptimize);
    schedule('health',     HEALTH_INTERVAL_MS,     writeHealthSnapshot);

    if (isFullStats() && STATS_REFRESH_INTERVAL > 0) {
        schedule('stats-recompute', STATS_REFRESH_INTERVAL, runStatsRecompute);
    }

    if (isStatsEnabled()) {
        const SIX_HOURS_MS = 6 * 60 * 60 * 1000; // Cleanup inactive users daily (runs every 6 hours, deletes >30-day inactive)
        schedule('user-cleanup', SIX_HOURS_MS, runUserCleanup);
    }

    log('info',
        `[worker] ready cleanup=${CLEANUP_INTERVAL_MS/60000}m checkpoint=${CHECKPOINT_INTERVAL_MS/60000}m optimize=${OPTIMIZE_INTERVAL_MS/60000}m health=${HEALTH_INTERVAL_MS/1000}s`);
    installShutdownHandlers();
}

let staggerDelayMs = 0;
const STAGGER_STEP_MS = 2000;

function schedule(name, intervalMs, fn) {
    const wrapped = async () => {
        if (isShuttingDown) return;
        const startedAt = Date.now();
        try {
            await fn();
            log('debug', `[worker] ${name} ok in ${Date.now() - startedAt}ms`);
        } catch (err) {
            log('error', `[worker] ${name} failed: ${err.message}`);
        }
    };
    const delay = staggerDelayMs;
    staggerDelayMs += STAGGER_STEP_MS;
    setTimeout(wrapped, delay);
    const handle = setInterval(wrapped, intervalMs);
    intervals.push({ name, handle });
}

async function runCleanup() {
    const removed = await cleaner.run();
    if (removed > 0) {
        try { await db.execute('PRAGMA incremental_vacuum(1000)'); }
        catch (err) { log('warn', `[worker] incremental_vacuum failed: ${err.message}`); }
    }
}

async function runCheckpoint() {
    await db.checkpoint();
}

async function runOptimize() {
    try { await db.execute('PRAGMA optimize'); }
    catch (err) { log('warn', `[worker] PRAGMA optimize failed: ${err.message}`); return; }

    try {
        const pageCountRow = (await db.execute('PRAGMA page_count')).rows[0];
        const freeListRow  = (await db.execute('PRAGMA freelist_count')).rows[0];
        const pages = readPragmaInt(pageCountRow);
        const free  = readPragmaInt(freeListRow);
        if (pages > 0 && free / pages > 0.25) {
            log('info', `[worker] vacuum trigger: ${free}/${pages} free pages (${((free / pages) * 100).toFixed(0)}%)`);
            await db.execute('PRAGMA incremental_vacuum(5000)');
        }
    } catch (err) {
        log('warn', `[worker] vacuum check failed: ${err.message}`);
    }
}

function readPragmaInt(row) {
    if (!row) return 0;
    const v = Array.isArray(row) ? row[0] : Object.values(row)[0];
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

async function runStatsRecompute() {
    try {
        await statsDB.recomputeSummary();
    } catch (err) {
        log('warn', `[worker] stats recompute failed: ${err.message}`);
    }
}

async function runUserCleanup() {
    try {
        await statsDB.cleanupInactiveUsers();
    } catch (err) {
        log('warn', `[worker] user cleanup failed: ${err.message}`);
    }
}

async function writeHealthSnapshot() {
    let subtitle = 0;
    try {
        const r = await db.execute('SELECT COUNT(*) AS c FROM subtitle_cache');
        subtitle = readPragmaInt(r.rows[0]);
    } catch (_) { /* table may not exist yet on first boot */ }

    let dbSizeMB = null;
    try {
        const dbFile = path.join(DATA_DIR, 'subsense.db');
        const stat = fs.statSync(dbFile);
        dbSizeMB = +(stat.size / (1024 * 1024)).toFixed(2);
    } catch (_) { /* fresh install */ }

    const snapshot = {
        generatedAt: new Date().toISOString(),
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        subtitleCacheRows: subtitle,
        dbSizeMB
    };

    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(HEALTH_PATH, JSON.stringify(snapshot, null, 2));
    } catch (err) {
        log('warn', `[worker] health snapshot write failed: ${err.message}`);
    }
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

    for (const { handle } of intervals) clearInterval(handle);

    try {
        await flushWrites();
    } catch (_) { /* best-effort */ }

    try {
        await runCleanup();
    } catch (err) {
        log('warn', `[worker] final cleanup failed: ${err.message}`);
    }

    try {
        await db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (err) {
        log('warn', `[worker] final checkpoint failed: ${err.message}`);
    }

    try {
        await writeHealthSnapshot();
    } catch (_) { /* best-effort */ }

    try { db.close(); }
    catch (err) { log('warn', `[worker] db close error: ${err.message}`); }

    clearTimeout(force);
    log('info', '[worker] shutdown complete');
    process.exit(0);
}

bootstrap().catch((err) => {
    log('error', `[worker] bootstrap failed: ${err.stack || err.message}`);
    process.exit(1);
});

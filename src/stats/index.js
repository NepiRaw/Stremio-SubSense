'use strict';

/**
 * Stats module entry point.
 *
 * Single env var controls everything: STATS_REFRESH_INTERVAL
 *   - not set / empty        → minimal (default)
 *   - "0"                    → disabled (no tables, no tracking)
 *   - "minimal"              → minimal (user_tracking only, refreshed every 5min)
 *   - number > 0 (ms)        → full mode with that refresh interval
 *
 * Usage:
 *   const { statsDB, statsService, initStats, getStatsMode } = require('./stats');
 *   await initStats();
 *   statsService.trackRequest({ ... });
 */

const db = require('../cache/database-libsql');
const { MINIMAL_SCHEMA, FULL_SCHEMA } = require('./schema');
const StatsDBAsync = require('./stats-db');
const statsService = require('./stats-service');
const { log } = require('../../src/utils');

/* ------------------------------------------------------------------ */
/*  Mode detection from STATS_REFRESH_INTERVAL                         */
/* ------------------------------------------------------------------ */

function resolveMode() {
    const raw = (process.env.STATS_REFRESH_INTERVAL || '').trim().toLowerCase();

    // Not set / empty → minimal (default)
    if (raw === '' || raw === 'minimal') return 'minimal';

    // "0" → disabled
    if (raw === '0') return 'disabled';

    // Number > 0 → full
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return 'full';

    // Fallback
    return 'minimal';
}

function resolveRefreshInterval() {
    const raw = (process.env.STATS_REFRESH_INTERVAL || '').trim();
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    // Minimal mode default: 5 minutes
    if (STATS_MODE === 'minimal') return 5 * 60 * 1000;
    return 0;
}

const STATS_MODE = resolveMode();
const STATS_REFRESH_INTERVAL = resolveRefreshInterval();

function getStatsMode()   { return STATS_MODE; }
function isFullStats()    { return STATS_MODE === 'full'; }
function isMinimalStats() { return STATS_MODE === 'minimal'; }
function isStatsEnabled() { return STATS_MODE !== 'disabled'; }

/* ------------------------------------------------------------------ */
/*  StatsDB instance                                                   */
/* ------------------------------------------------------------------ */

const statsDB = new StatsDBAsync(
    () => STATS_MODE === 'full',
    () => STATS_MODE === 'full' || STATS_MODE === 'minimal'
);

statsService.init(statsDB, getStatsMode, queueWrite);

/* ------------------------------------------------------------------ */
/*  Write batching - buffer DB writes, flush periodically              */
/* ------------------------------------------------------------------ */

const FLUSH_INTERVAL_MS = 10_000; // flush every 10s
let _pendingWrites = [];
let _flushTimer = null;

/**
 * Queue a fire-and-forget DB write. Flushed in batches.
 */
function queueWrite(fn) {
    _pendingWrites.push(fn);
}

async function flushWrites() {
    if (_pendingWrites.length === 0) return;
    const batch = _pendingWrites.splice(0, _pendingWrites.length);
    try {
        await Promise.allSettled(batch.map(fn => fn()));
    } catch (err) {
        log('debug', `[stats] batch flush error: ${err.message}`);
    }
}

function startFlushTimer() {
    if (_flushTimer) return;
    _flushTimer = setInterval(() => {
        flushWrites().catch(() => {});
    }, FLUSH_INTERVAL_MS);
    if (_flushTimer.unref) _flushTimer.unref();
}

/* ---------------------------------- */
/*  Stats response cache              */
/* ---------------------------------- */

let _cachedStatsResponse = null;
let _cachedStatsAt = 0;
const STATS_CACHE_TTL_MS = 30_000; // serve cached stats for 30s

async function getCachedStats() {
    if (_cachedStatsResponse && (Date.now() - _cachedStatsAt) < STATS_CACHE_TTL_MS) {
        return _cachedStatsResponse;
    }
    const fresh = await statsService.getStats();
    _cachedStatsResponse = fresh;
    _cachedStatsAt = Date.now();
    return fresh;
}

function invalidateStatsCache() {
    _cachedStatsResponse = null;
    _cachedStatsAt = 0;
}

/* ------------------------------------------------------------------ */
/*  Initialisation (call once from server/worker bootstrap)            */
/* ------------------------------------------------------------------ */

let _initDone = false;

async function initStats() {
    if (_initDone) return;
    _initDone = true;

    if (STATS_MODE === 'disabled') {
        log('info', '[stats] mode=disabled - no tables created');
        return;
    }

    const schemaSQL = STATS_MODE === 'full' ? FULL_SCHEMA : MINIMAL_SCHEMA;
    try {
        await db.executeMultiple(schemaSQL);
        log('info', `[stats] mode=${STATS_MODE} - tables created (refresh=${STATS_REFRESH_INTERVAL}ms)`);
    } catch (err) {
        log('error', `[stats] schema init failed: ${err.message}`);
    }

    startFlushTimer();
}

module.exports = {
    statsDB,
    statsService,
    initStats,
    getStatsMode,
    isFullStats,
    isMinimalStats,
    isStatsEnabled,
    STATS_MODE,
    STATS_REFRESH_INTERVAL,
    queueWrite,
    flushWrites,
    getCachedStats,
    invalidateStatsCache
};

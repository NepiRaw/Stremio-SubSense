'use strict';

/**
 * Stats module entry point.
 *
 * There is one mode. The full/minimal split existed because full mode was expensive enough
 * to threaten the process; recording is now a buffered counter increment, so there is
 * nothing left to switch off. `STATS_ENABLED=false` still disables recording entirely.
 */

const StatsDBAsync = require('./stats-db');
const statsService = require('./stats-service');
const track = require('./track');
const contentLog = require('./content-log');
const fold = require('./fold');
const { log } = require('../../src/utils');

const ENABLED = (process.env.STATS_ENABLED || '').toLowerCase() !== 'false';

const statsDB = new StatsDBAsync(() => ENABLED, () => ENABLED);

statsService.init(statsDB, () => (ENABLED ? 'full' : 'disabled'));

/* ---------------------------------- */
/*  Stats response cache              */
/* ---------------------------------- */

const STATS_CACHE_TTL_MS = 30_000;
let _cachedStatsResponse = null;
let _cachedStatsAt = 0;

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

let _initDone = false;

/** Schema is owned by infra/db; this only starts the delta flush loop. */
async function initStats() {
    if (_initDone) return;
    _initDone = true;

    if (!ENABLED) {
        log('info', '[stats] disabled by STATS_ENABLED=false');
        return;
    }
    track.start();
    log('info', `[stats] recording enabled (flush every ${track.FLUSH_MS}ms)`);
}

async function flushWrites() {
    return track.flush();
}

function isStatsEnabled() { return ENABLED; }

module.exports = {
    statsDB,
    statsService,
    track,
    contentLog,
    fold,
    initStats,
    flushWrites,
    isStatsEnabled,
    getCachedStats,
    invalidateStatsCache,
    // The page and its API are available to everyone whenever stats are on.
    isFullStats: isStatsEnabled,
    getStatsMode: () => (ENABLED ? 'full' : 'disabled')
};

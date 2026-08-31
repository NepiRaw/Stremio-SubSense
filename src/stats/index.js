'use strict';

/**
 * Stats module entry point.
 *
 * STATS_ENABLED is 3-valued. `minimal`: drops the per-user content log and the dashboard while
 * keeping the /configure user counts and provider health.
 */

const StatsDBAsync = require('./stats-db');
const statsService = require('./stats-service');
const track = require('./track');
const contentLog = require('./content-log');
const fold = require('./fold');
const { log } = require('../../src/utils');

function resolveMode(raw) {
    const value = String(raw || '').toLowerCase().trim();
    if (value === 'false' || value === 'off') return 'disabled';
    if (value === 'minimal') return 'minimal';
    if (value && value !== 'true') {
        log('warn', `[stats] unrecognised STATS_ENABLED="${raw}", using full`);
    }
    return 'full';
}

const MODE = resolveMode(process.env.STATS_ENABLED);

const statsDB = new StatsDBAsync();

statsService.init(statsDB, () => MODE);

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

    if (MODE === 'disabled') {
        log('info', '[stats] disabled by STATS_ENABLED');
        return;
    }
    track.start();
    log('info', `[stats] recording enabled, mode=${MODE} (flush every ${track.FLUSH_MS}ms)`);
}

async function flushWrites() {
    return track.flush();
}

function isStatsEnabled() { return MODE !== 'disabled'; }
function isFullStats() { return MODE === 'full'; }

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
    isFullStats,
    getStatsMode: () => MODE
};

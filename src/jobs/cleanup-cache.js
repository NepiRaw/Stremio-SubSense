'use strict';

/**
 * Retention for the subtitle cache.
 *
 * Expired rows are read before deletion so their source and language counts can be
 * decremented, keeping the cache composition figures exact without ever scanning the
 * whole table. Runs in batches under a deadline.
 */

const { cacheDb } = require('../infra/db');
const store = require('../cache/subtitle-store');
const track = require('../stats/track');
const { log } = require('../../src/utils');

const BATCH_SIZE = 500;
const VACUUM_PAGES = 200;

/** Source and language counts for one batch of blobs, as negative deltas. */
function negativeDeltas(rows) {
    const deltas = Object.create(null);
    for (const row of rows) {
        let subs;
        try { subs = JSON.parse(row.subtitles || '[]'); } catch { continue; }
        if (!Array.isArray(subs)) continue;
        for (const s of subs) {
            if (s.source) deltas[`source:${s.source}`] = (deltas[`source:${s.source}`] || 0) - 1;
            if (s.lang) deltas[`lang:${s.lang}`] = (deltas[`lang:${s.lang}`] || 0) - 1;
        }
    }
    return deltas;
}

async function run({ deadline = Infinity } = {}) {
    const started = Date.now();
    let removed = 0;

    for (;;) {
        if (Date.now() >= deadline) {
            const remaining = await store.countExpired().catch(() => null);
            log('info', `[cleanup-cache] budget reached after ${removed} rows in ${Date.now() - started}ms`);
            return { done: false, removed, remaining };
        }

        let rows;
        try {
            rows = await store.selectExpiredBatch(BATCH_SIZE);
        } catch (err) {
            log('error', `[cleanup-cache] select failed: ${err.message}`);
            return { done: false, removed };
        }
        if (rows.length === 0) break;

        track.dist(negativeDeltas(rows));

        try {
            removed += await store.deleteByRowIds(rows.map(r => r.rid));
        } catch (err) {
            log('error', `[cleanup-cache] delete failed: ${err.message}`);
            return { done: false, removed };
        }
        if (rows.length < BATCH_SIZE) break;
    }

    if (removed > 0) {
        try { await cacheDb.execute(`PRAGMA incremental_vacuum(${VACUUM_PAGES})`); }
        catch (err) { log('debug', `[cleanup-cache] incremental_vacuum failed: ${err.message}`); }
        log('info', `[cleanup-cache] removed ${removed} expired rows in ${Date.now() - started}ms`);
    }
    return { done: true, removed };
}

async function cachedRowCount() {
    return store.count();
}

module.exports = { run, cachedRowCount, BATCH_SIZE };

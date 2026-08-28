'use strict';

/**
 * Retention for the provider metadata caches. These refill lazily from upstream, so old
 * rows are dropped in batches rather than kept indefinitely.
 */

const { metaDb } = require('../infra/db');
const { log } = require('../../src/utils');

const BATCH_SIZE = 1000;
const DAY_S = 24 * 60 * 60;

function intEnv(name, fallback) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

const TARGETS = [
    { table: 'at_torrent_details', column: 'created_at', ttlDays: () => intEnv('META_TTL_AT_DAYS', 90) },
    { table: 'anidb_episodes',     column: 'created_at', ttlDays: () => intEnv('META_TTL_ANIDB_DAYS', 180) },
    { table: 'anidb_anime_meta',   column: 'fetched_at', ttlDays: () => intEnv('META_TTL_ANIDB_DAYS', 180) }
];

async function run({ deadline = Infinity } = {}) {
    let removed = 0;

    for (const { table, column, ttlDays } of TARGETS) {
        const cutoff = ttlDays() * DAY_S;
        for (;;) {
            if (Date.now() >= deadline) return { done: false, removed };
            let deleted;
            try {
                const r = await metaDb.execute({
                    sql: `DELETE FROM ${table} WHERE rowid IN (
                              SELECT rowid FROM ${table} WHERE ${column} < (strftime('%s','now') - ?) LIMIT ?
                          )`,
                    args: [cutoff, BATCH_SIZE]
                });
                deleted = Number(r.rowsAffected) || 0;
            } catch (err) {
                log('error', `[prune-meta] ${table} failed: ${err.message}`);
                break;
            }
            removed += deleted;
            if (deleted < BATCH_SIZE) break;
        }
    }

    if (removed > 0) log('info', `[prune-meta] removed ${removed} stale rows`);
    return { done: true, removed };
}

module.exports = { run, BATCH_SIZE };

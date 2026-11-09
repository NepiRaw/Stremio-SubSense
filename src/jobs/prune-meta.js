'use strict';

/**
 * Retention for the provider metadata caches. These refill lazily from upstream, so old
 * rows are dropped in batches rather than kept indefinitely.
 */

const { metaDb, incrementalVacuum } = require('../infra/db');
const { log } = require('../../src/utils');

const BATCH_SIZE = 1000;
const VACUUM_PAGES = 2000;
const DAY_S = 24 * 60 * 60;

function intEnv(name, fallback) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

const TARGETS = [
    { table: 'at_release_tracks',  column: 'created_at', ttlDays: () => intEnv('META_TTL_AT_DAYS', 90) },
    { table: 'anidb_episodes',     column: 'created_at', ttlDays: () => intEnv('META_TTL_ANIDB_DAYS', 180) },
    { table: 'anidb_anime_meta',   column: 'fetched_at', ttlDays: () => intEnv('META_TTL_ANIDB_DAYS', 180) }
];

// Tables no code reads any more: emptied in batches, since one DROP of a large table locks the file for seconds.
const RETIRED = ['at_torrent_details'];

async function tableExists(table) {
    const r = await metaDb.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", args: [table] });
    return r.rows.length > 0;
}

/** Deletes one batch; returns rows removed, or -1 on error. */
async function deleteBatch(table, where, args) {
    try {
        const r = await metaDb.execute({
            sql: `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} ${where} LIMIT ?)`,
            args: [...args, BATCH_SIZE]
        });
        return Number(r.rowsAffected) || 0;
    } catch (err) {
        log('error', `[prune-meta] ${table} failed: ${err.message}`);
        return -1;
    }
}

async function retire(table, deadline) {
    if (!await tableExists(table)) return { done: true, removed: 0 };
    let removed = 0;
    for (;;) {
        if (Date.now() >= deadline) return { done: false, removed };
        const deleted = await deleteBatch(table, '', []);
        if (deleted < 0) return { done: false, removed };
        removed += deleted;
        if (deleted < BATCH_SIZE) break;
    }
    await metaDb.execute(`DROP TABLE IF EXISTS ${table}`);
    log('info', `[prune-meta] retired table ${table} dropped`);
    return { done: true, removed };
}

/** Hands free pages back to the OS until the free list is empty or the budget runs out. */
async function vacuum(deadline) {
    try {
        while (Date.now() < deadline) {
            const free = Number(Object.values((await metaDb.execute('PRAGMA freelist_count')).rows[0])[0]);
            if (free === 0) return;
            await incrementalVacuum(metaDb, VACUUM_PAGES);
        }
    } catch (err) {
        log('debug', `[prune-meta] incremental_vacuum failed: ${err.message}`);
    }
}

async function run({ deadline = Infinity } = {}) {
    let removed = 0;

    for (const { table, column, ttlDays } of TARGETS) {
        const cutoff = ttlDays() * DAY_S;
        for (;;) {
            if (Date.now() >= deadline) return { done: false, removed };
            const deleted = await deleteBatch(table, `WHERE ${column} < (strftime('%s','now') - ?)`, [cutoff]);
            if (deleted < 0) break;
            removed += deleted;
            if (deleted < BATCH_SIZE) break;
        }
    }

    for (const table of RETIRED) {
        const r = await retire(table, deadline);
        removed += r.removed;
        if (!r.done) {
            log('info', `[prune-meta] removed ${r.removed} rows from retired table ${table}, more left`);
            return { done: false, removed };
        }
    }

    await vacuum(deadline);
    if (removed > 0) log('info', `[prune-meta] removed ${removed} stale rows`);
    return { done: true, removed };
}

module.exports = { run, BATCH_SIZE };

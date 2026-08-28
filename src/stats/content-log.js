'use strict';

/**
 * Seven-day rolling content log across seven tables, one per weekday.
 *
 * Retention is a whole-table delete performed before a table is reused, so expiring a day
 * costs the same whether it holds a thousand rows or a million, and there is never a
 * backlog to walk. The guard is keyed on the date each table currently holds, so it stays
 * correct after arbitrary downtime.
 */

const { statsDb, CONTENT_LOG_TABLES } = require('../infra/db');
const { redis, isHealthy } = require('../infra/redis');
const { log } = require('../../src/utils');
const { K, dateKey } = require('./track');

const DRAIN_BATCH = 500;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Local-midnight day number, so a table maps to one calendar day. */
function dayNumber(date = new Date()) {
    const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.floor(local.getTime() / MS_PER_DAY);
}

function tableFor(date = new Date()) {
    return CONTENT_LOG_TABLES[((dayNumber(date) % 7) + 7) % 7];
}

async function kvGet(key) {
    const r = await statsDb.execute({ sql: 'SELECT value FROM kv WHERE key = ?', args: [key] });
    return r.rows[0]?.value ?? null;
}

async function kvSet(key, value) {
    await statsDb.execute({
        sql: `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        args: [key, value]
    });
}

/**
 * Empty a table before its first reuse for a new day. Returns rows removed.
 */
async function ensureRotated(table, date) {
    const marker = `cl:date:${table}`;
    const today = dateKey(date);
    const held = await kvGet(marker);
    if (held === today) return 0;

    const res = await statsDb.execute(`DELETE FROM ${table}`);
    await kvSet(marker, today);
    const removed = Number(res.rowsAffected) || 0;
    if (removed > 0) log('info', `[content-log] rotated ${table}: cleared ${removed} rows from ${held || 'unknown'}`);
    return removed;
}

async function insertBatch(table, rows) {
    if (rows.length === 0) return 0;
    const placeholders = rows.map(() => '(?,?,?,?,?,?)').join(',');
    const args = [];
    for (const r of rows) args.push(r.u, r.i, r.t, r.s, r.e, r.at);
    await statsDb.execute({
        sql: `INSERT INTO ${table} (user_id, imdb_id, content_type, season, episode, requested_at) VALUES ${placeholders}`,
        args
    });
    return rows.length;
}

/**
 * Move queued rows from Redis into their day's table until the queue empties or the
 * deadline passes. Rows carry their own timestamp, so a batch spanning midnight splits.
 */
async function drain({ deadline = Infinity } = {}) {
    if (!isHealthy()) return { done: true, written: 0, remaining: null };

    let written = 0;
    for (;;) {
        if (Date.now() >= deadline) {
            const remaining = await redis.llen(K.contentQueue).catch(() => null);
            return { done: false, written, remaining };
        }

        let raw;
        try {
            raw = await redis.lpop(K.contentQueue, DRAIN_BATCH);
        } catch (err) {
            log('debug', `[content-log] drain read failed: ${err.message}`);
            return { done: false, written, remaining: null };
        }
        if (!raw || raw.length === 0) return { done: true, written, remaining: 0 };

        const byTable = new Map();
        for (const item of raw) {
            let row;
            try { row = JSON.parse(item); } catch { continue; }
            if (!row || !row.u || !row.i) continue;
            const when = new Date((row.at || Math.floor(Date.now() / 1000)) * 1000);
            const table = tableFor(when);
            if (!byTable.has(table)) byTable.set(table, { date: when, rows: [] });
            byTable.get(table).rows.push({
                u: row.u, i: row.i, t: row.t ?? null,
                s: row.s ?? null, e: row.e ?? null, at: row.at
            });
        }

        for (const [table, { date, rows }] of byTable) {
            try {
                await ensureRotated(table, date);
                written += await insertBatch(table, rows);
            } catch (err) {
                log('error', `[content-log] insert into ${table} failed: ${err.message}`);
            }
        }
    }
}

function unionQuery(inner, outerOrder, outerLimit) {
    const parts = CONTENT_LOG_TABLES.map(t => `SELECT * FROM (${inner(t)})`);
    return `SELECT * FROM (${parts.join(' UNION ALL ')}) ORDER BY ${outerOrder} LIMIT ${outerLimit}`;
}

/** Most recent titles for one user across the retained window. */
async function forUser(userId, limit = 10) {
    const capped = Math.min(100, Math.max(1, limit));
    const sql = unionQuery(
        (t) => `SELECT imdb_id, content_type, season, episode, requested_at FROM ${t} WHERE user_id = ? ORDER BY requested_at DESC LIMIT ${capped}`,
        'requested_at DESC', capped
    );
    try {
        const r = await statsDb.execute({ sql, args: CONTENT_LOG_TABLES.map(() => userId) });
        return r.rows;
    } catch (err) {
        log('error', `[content-log] forUser failed: ${err.message}`);
        return [];
    }
}

/** Most recent activity across all users. */
async function recent(limit = 100) {
    const capped = Math.min(500, Math.max(1, limit));
    const sql = unionQuery(
        (t) => `SELECT user_id, imdb_id, content_type, season, episode, requested_at FROM ${t} ORDER BY requested_at DESC LIMIT ${capped}`,
        'requested_at DESC', capped
    );
    try {
        const r = await statsDb.execute(sql);
        return r.rows;
    } catch (err) {
        log('error', `[content-log] recent failed: ${err.message}`);
        return [];
    }
}

async function totalRows() {
    const sql = CONTENT_LOG_TABLES.map(t => `SELECT COUNT(*) AS n FROM ${t}`).join(' UNION ALL ');
    const r = await statsDb.execute(`SELECT SUM(n) AS total FROM (${sql})`);
    return Number(r.rows[0]?.total) || 0;
}

module.exports = { drain, forUser, recent, totalRows, ensureRotated, tableFor, dayNumber, DRAIN_BATCH };

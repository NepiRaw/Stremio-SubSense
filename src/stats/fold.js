'use strict';

/**
 * Worker-side folding of Redis deltas into stats.db.
 *
 * Every fold reads and clears a hash in one transaction, then applies it additively, so a
 * fold can be repeated or interrupted without rewriting history downward. The cost of a
 * crash between the clear and the write is one interval of analytics, never serving data.
 */

const { statsDb, kvSet, KV } = require('../infra/db');
const { redis, isHealthy } = require('../infra/redis');
const { log } = require('../../src/utils');
const { K, dateKey } = require('./track');

const SCAN_COUNT = 200;
const USER_BATCH = 2000;

async function scanKeys(pattern, limit = 500) {
    const found = [];
    let cursor = '0';
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
        cursor = next;
        for (const k of keys) {
            found.push(k);
            if (found.length >= limit) return found;
        }
    } while (cursor !== '0');
    return found;
}

/** Read and clear a hash atomically so a concurrent writer cannot lose a delta. */
async function takeHash(key) {
    const res = await redis.multi().hgetall(key).del(key).exec();
    const [[err, hash]] = res;
    if (err) throw err;
    return hash || {};
}

function dateFromKey(key) {
    return key.slice(key.lastIndexOf(':') + 1);
}

async function foldCounters() {
    const hash = await takeHash(K.counters);
    const entries = Object.entries(hash);
    if (entries.length === 0) return 0;

    const stmts = entries.map(([key, value]) => ({
        sql: `INSERT INTO stats (stat_key, stat_value, updated_at) VALUES (?, ?, strftime('%s','now'))
              ON CONFLICT(stat_key) DO UPDATE SET
                  stat_value = stat_value + excluded.stat_value,
                  updated_at = excluded.updated_at`,
        args: [key, Number(value) || 0]
    }));
    await statsDb.batch(stmts, 'write');
    return entries.length;
}

const DAILY_FIELDS = ['requests', 'cache_hits', 'cache_misses', 'conversions', 'movies', 'series',
    'subtitles', 'any_pref_found', 'all_pref_found', 'pref_tracked'];

async function foldDaily() {
    const keys = await scanKeys('ss:daily:*');
    let folded = 0;
    for (const key of keys) {
        const hash = await takeHash(key);
        const fields = Object.keys(hash).filter(f => DAILY_FIELDS.includes(f));
        if (fields.length === 0) continue;

        const cols = fields.join(', ');
        const marks = fields.map(() => '?').join(', ');
        const updates = fields.map(f => `${f} = ${f} + excluded.${f}`).join(', ');
        await statsDb.execute({
            sql: `INSERT INTO stats_daily (date, ${cols}) VALUES (?, ${marks})
                  ON CONFLICT(date) DO UPDATE SET ${updates}`,
            args: [dateFromKey(key), ...fields.map(f => Number(hash[f]) || 0)]
        });
        folded++;
    }
    return folded;
}

function groupByPrefix(hash, depth) {
    const out = new Map();
    for (const [field, value] of Object.entries(hash)) {
        const parts = field.split('.');
        if (parts.length < depth + 1) continue;
        const name = parts.slice(0, depth).join('.');
        const metric = parts[depth];
        if (!out.has(name)) out.set(name, {});
        out.get(name)[metric] = Number(value) || 0;
    }
    return out;
}

async function foldProviders() {
    const keys = await scanKeys('ss:pv:*');
    let folded = 0;
    for (const key of keys) {
        const hash = await takeHash(key);
        const date = dateFromKey(key);
        for (const [name, m] of groupByPrefix(hash, 1)) {
            const req = m.req || 0;
            if (req === 0) continue;
            // avg_response_ms stays a true mean by weighting the existing average.
            await statsDb.execute({
                sql: `INSERT INTO provider_stats
                          (provider_name, date, total_requests, successful_requests, failed_requests,
                           avg_response_ms, subtitles_returned, requests_with_results, last_success_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT(provider_name, date) DO UPDATE SET
                          avg_response_ms = (avg_response_ms * total_requests + ?) / (total_requests + ?),
                          total_requests = total_requests + ?,
                          successful_requests = successful_requests + ?,
                          failed_requests = failed_requests + ?,
                          subtitles_returned = subtitles_returned + ?,
                          requests_with_results = COALESCE(requests_with_results, 0) + ?,
                          last_success_at = CASE WHEN ? > 0 THEN ? ELSE last_success_at END`,
                args: [
                    name, date, req, m.ok || 0, m.fail || 0,
                    req > 0 ? Math.round((m.ms || 0) / req) : 0,
                    m.subs || 0, m.withres || 0, (m.withres || 0) > 0 ? new Date().toISOString() : null,
                    m.ms || 0, req,
                    req, m.ok || 0, m.fail || 0, m.subs || 0, m.withres || 0,
                    m.withres || 0, new Date().toISOString()
                ]
            });
            folded++;
        }
    }
    return folded;
}

async function foldLanguages() {
    const keys = await scanKeys('ss:lg:*');
    let folded = 0;
    for (const key of keys) {
        const hash = await takeHash(key);
        const date = dateFromKey(key);
        for (const [nameAndPriority, m] of groupByPrefix(hash, 2)) {
            const dot = nameAndPriority.lastIndexOf('.');
            const code = nameAndPriority.slice(0, dot);
            const priority = nameAndPriority.slice(dot + 1) || 'preferred';
            const req = m.req || 0;
            if (req === 0) continue;
            await statsDb.execute({
                sql: `INSERT INTO language_stats (language_code, date, priority, requests_for, found_count, not_found_count)
                      VALUES (?, ?, ?, ?, ?, ?)
                      ON CONFLICT(language_code, date, priority) DO UPDATE SET
                          requests_for = requests_for + excluded.requests_for,
                          found_count = found_count + excluded.found_count,
                          not_found_count = not_found_count + excluded.not_found_count`,
                args: [code, date, priority, req, m.found || 0, m.notfound || 0]
            });
            folded++;
        }
    }
    return folded;
}

async function foldCombos() {
    const keys = await scanKeys('ss:combo:*');
    let folded = 0;
    for (const key of keys) {
        const hash = await takeHash(key);
        const date = dateFromKey(key);
        const entries = Object.entries(hash);
        if (entries.length === 0) continue;
        await statsDb.batch(entries.map(([combo, count]) => ({
            sql: `INSERT INTO lang_combos (date, combo, count) VALUES (?, ?, ?)
                  ON CONFLICT(date, combo) DO UPDATE SET count = count + excluded.count`,
            args: [date, combo, Number(count) || 0]
        })), 'write');
        folded += entries.length;
    }
    return folded;
}

async function foldDist() {
    const hash = await takeHash(K.dist);
    const entries = Object.entries(hash);
    if (entries.length === 0) return 0;

    const stmts = [];
    for (const [field, value] of entries) {
        const idx = field.indexOf(':');
        if (idx < 0) continue;
        stmts.push({
            sql: `INSERT INTO dist (kind, key, count) VALUES (?, ?, ?)
                  ON CONFLICT(kind, key) DO UPDATE SET count = MAX(0, count + excluded.count)`,
            args: [field.slice(0, idx), field.slice(idx + 1), Number(value) || 0]
        });
    }
    if (stmts.length > 0) await statsDb.batch(stmts, 'write');
    return stmts.length;
}

/** Daily unique users. Past days are counted then dropped; today is counted and kept. */
async function foldDailyUsers() {
    const keys = await scanKeys('ss:du:*');
    const today = dateKey();
    let folded = 0;
    for (const key of keys) {
        const date = dateFromKey(key);
        const count = await redis.scard(key);
        if (count > 0) {
            await statsDb.execute({
                sql: `INSERT INTO stats_daily (date, unique_users) VALUES (?, ?)
                      ON CONFLICT(date) DO UPDATE SET unique_users = excluded.unique_users`,
                args: [date, count]
            });
            folded++;
        }
        if (date < today) await redis.del(key);
    }
    return folded;
}

/** Per-user counters, batched. Dirty ids are claimed with SPOP so two workers cannot collide. */
async function flushUsers({ deadline = Infinity } = {}) {
    if (!isHealthy()) return { done: true, users: 0 };
    let total = 0;

    for (;;) {
        if (Date.now() >= deadline) {
            const remaining = await redis.scard(K.userDirty).catch(() => null);
            return { done: false, users: total, remaining };
        }

        const ids = await redis.spop(K.userDirty, USER_BATCH);
        if (!ids || ids.length === 0) return { done: true, users: total, remaining: 0 };

        const p = redis.pipeline();
        for (const id of ids) { p.hgetall(K.user(id)); p.del(K.user(id)); }
        const replies = await p.exec();

        const stmts = [];
        for (let i = 0; i < ids.length; i++) {
            const [err, hash] = replies[i * 2];
            if (err || !hash || Object.keys(hash).length === 0) continue;
            const langs = hash.languages || '[]';
            stmts.push({
                sql: `INSERT INTO user_tracking
                          (user_id, languages, total_requests, movie_requests, series_requests, first_seen, last_active)
                      VALUES (?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT(user_id) DO UPDATE SET
                          total_requests  = total_requests + excluded.total_requests,
                          movie_requests  = movie_requests + excluded.movie_requests,
                          series_requests = series_requests + excluded.series_requests,
                          languages       = excluded.languages,
                          last_active     = MAX(last_active, excluded.last_active)`,
                args: [
                    ids[i], langs,
                    Number(hash.total) || 0, Number(hash.movie) || 0, Number(hash.series) || 0,
                    Number(hash.last_active) || Math.floor(Date.now() / 1000),
                    Number(hash.last_active) || Math.floor(Date.now() / 1000)
                ]
            });
        }
        if (stmts.length > 0) await statsDb.batch(stmts, 'write');
        total += stmts.length;
    }
}

/** Pending deltas not yet folded, merged into reads so /stats is current between folds. */
async function pendingCounters() {
    if (!isHealthy()) return {};
    try {
        const hash = await redis.hgetall(K.counters);
        const out = {};
        for (const [k, v] of Object.entries(hash || {})) out[k] = Number(v) || 0;
        return out;
    } catch (_) {
        return {};
    }
}

async function foldAll({ deadline = Infinity } = {}) {
    if (!isHealthy()) return { done: true, skipped: 'redis-down' };
    const summary = {};
    const steps = [
        ['counters', foldCounters], ['daily', foldDaily], ['providers', foldProviders],
        ['languages', foldLanguages], ['combos', foldCombos], ['dist', foldDist],
        ['dailyUsers', foldDailyUsers]
    ];
    for (const [name, fn] of steps) {
        if (Date.now() >= deadline) {
            await stampFold();
            return { done: false, ...summary };
        }
        try {
            summary[name] = await fn();
        } catch (err) {
            log('error', `[fold] ${name} failed: ${err.message}`);
        }
    }
    await stampFold();
    return { done: true, ...summary };
}

/** Marks that folding ran, so a stalled worker is visible on /health/deep. */
async function stampFold() {
    try {
        await kvSet(KV.lastFold, String(Date.now()));
    } catch (err) {
        log('warn', `[fold] could not record the fold timestamp: ${err.message}`);
    }
}

module.exports = {
    foldAll, foldCounters, foldDaily, foldProviders, foldLanguages,
    foldCombos, foldDist, foldDailyUsers, flushUsers, pendingCounters
};

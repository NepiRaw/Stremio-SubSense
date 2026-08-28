'use strict';

/**
 * Request-path statistics recording.
 *
 * Nothing here touches SQLite or awaits Redis. Deltas accumulate in plain objects and are
 * pushed to Redis in a single pipeline every few seconds; the maintenance worker folds
 * them into their tables. If Redis is down the buffers keep filling to a cap and then shed,
 * so analytics degrade while serving does not.
 */

const { redis, isHealthy } = require('../infra/redis');
const { log } = require('../../src/utils');

function intEnv(name, fallback) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

const FLUSH_MS = intEnv('TRACK_FLUSH_MS', 5000);
const CONTENT_ROW_CAP = intEnv('TRACK_CONTENT_ROW_CAP', 10000);
const CL_QUEUE_MAX = intEnv('CL_QUEUE_MAX', 50000);
const RT_SAMPLE_CAP = 512;

const K = {
    counters: 'ss:counters',
    daily: (d) => `ss:daily:${d}`,
    provider: (d) => `ss:pv:${d}`,
    language: (d) => `ss:lg:${d}`,
    combo: (d) => `ss:combo:${d}`,
    dailyUsers: (d) => `ss:du:${d}`,
    dist: 'ss:dist:pending',
    user: (id) => `ss:u:${id}`,
    userDirty: 'ss:u:dirty',
    contentQueue: 'ss:cl:q',
    responseTimes: 'ss:rt'
};

const USER_TTL_SECONDS = 7 * 24 * 60 * 60;

function dateKey(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

let buf = emptyBuffer();
let timer = null;
let droppedRows = 0;
let queueFull = false;
let lastQueueCheck = 0;

function emptyBuffer() {
    return {
        counters: Object.create(null),
        daily: Object.create(null),
        provider: Object.create(null),
        language: Object.create(null),
        combo: Object.create(null),
        dist: Object.create(null),
        dailyUsers: Object.create(null),
        users: new Map(),
        contentRows: [],
        responseTimes: []
    };
}

function bump(target, field, amount) {
    if (!amount) return;
    target[field] = (target[field] || 0) + amount;
}

function nested(target, key) {
    if (!target[key]) target[key] = Object.create(null);
    return target[key];
}

/* ------------------------------------------------------------------ */
/*  Recording (synchronous, called from the request path)              */
/* ------------------------------------------------------------------ */

function counter(key, amount = 1) { bump(buf.counters, key, amount); }

function daily(fields, date = dateKey()) {
    const target = nested(buf.daily, date);
    for (const [field, amount] of Object.entries(fields)) bump(target, field, amount);
}

function provider(name, { requests = 0, ok = 0, failed = 0, subtitles = 0, ms = 0, withResults = 0 } = {}) {
    const target = nested(buf.provider, dateKey());
    bump(target, `${name}.req`, requests);
    bump(target, `${name}.ok`, ok);
    bump(target, `${name}.fail`, failed);
    bump(target, `${name}.subs`, subtitles);
    bump(target, `${name}.ms`, ms);
    bump(target, `${name}.withres`, withResults);
}

function language(code, { found = false, priority = 'preferred' } = {}) {
    const target = nested(buf.language, dateKey());
    bump(target, `${code}.${priority}.req`, 1);
    bump(target, `${code}.${priority}.${found ? 'found' : 'notfound'}`, 1);
}

function combo(languages) {
    if (!languages || languages.length === 0) return;
    const key = languages.slice().sort().join(',');
    bump(nested(buf.combo, dateKey()), key, 1);
}

/** Signed: positive when an entry enters the cache, negative when one expires. */
function dist(deltas) {
    for (const [field, amount] of Object.entries(deltas || {})) bump(buf.dist, field, amount);
}

function user(userId, { movie = 0, series = 0, languages = null } = {}) {
    if (!userId) return;
    let u = buf.users.get(userId);
    if (!u) {
        u = { total: 0, movie: 0, series: 0, languages: null };
        buf.users.set(userId, u);
    }
    u.total += 1;
    u.movie += movie;
    u.series += series;
    if (languages) u.languages = languages;

    const set = buf.dailyUsers[dateKey()] || (buf.dailyUsers[dateKey()] = new Set());
    set.add(userId);
}

function content(row) {
    if (!row || !row.userId || !row.imdbId) return;
    if (queueFull || buf.contentRows.length >= CONTENT_ROW_CAP) {
        droppedRows++;
        return;
    }
    buf.contentRows.push(JSON.stringify({
        u: row.userId, i: row.imdbId, t: row.contentType || null,
        s: row.season ?? null, e: row.episode ?? null,
        at: Math.floor(Date.now() / 1000)
    }));
}

function responseTime(ms) {
    if (!Number.isFinite(ms)) return;
    if (buf.responseTimes.length < RT_SAMPLE_CAP) buf.responseTimes.push(ms);
}

/* ------------------------------------------------------------------ */
/*  Flush                                                              */
/* ------------------------------------------------------------------ */

function isEmpty(b) {
    return Object.keys(b.counters).length === 0
        && Object.keys(b.daily).length === 0
        && Object.keys(b.provider).length === 0
        && Object.keys(b.language).length === 0
        && Object.keys(b.combo).length === 0
        && Object.keys(b.dist).length === 0
        && Object.keys(b.dailyUsers).length === 0
        && b.users.size === 0
        && b.contentRows.length === 0
        && b.responseTimes.length === 0;
}

function percentile(sorted, q) {
    if (sorted.length === 0) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/** Merge a failed flush back so deltas are retried rather than lost. */
function restore(pending) {
    for (const [k, v] of Object.entries(pending.counters)) bump(buf.counters, k, v);
    for (const [date, fields] of Object.entries(pending.daily)) {
        const t = nested(buf.daily, date);
        for (const [f, v] of Object.entries(fields)) bump(t, f, v);
    }
    for (const group of ['provider', 'language', 'combo']) {
        for (const [date, fields] of Object.entries(pending[group])) {
            const t = nested(buf[group], date);
            for (const [f, v] of Object.entries(fields)) bump(t, f, v);
        }
    }
    for (const [k, v] of Object.entries(pending.dist)) bump(buf.dist, k, v);
    for (const [date, set] of Object.entries(pending.dailyUsers)) {
        const target = buf.dailyUsers[date] || (buf.dailyUsers[date] = new Set());
        for (const id of set) target.add(id);
    }
    for (const [id, u] of pending.users) {
        const existing = buf.users.get(id);
        if (!existing) { buf.users.set(id, u); continue; }
        existing.total += u.total;
        existing.movie += u.movie;
        existing.series += u.series;
        existing.languages = existing.languages || u.languages;
    }
    const room = CONTENT_ROW_CAP - buf.contentRows.length;
    if (room > 0) buf.contentRows.unshift(...pending.contentRows.slice(0, room));
    droppedRows += Math.max(0, pending.contentRows.length - Math.max(0, room));
}

async function flush() {
    if (isEmpty(buf)) return { flushed: false };
    if (!isHealthy()) {
        if (buf.contentRows.length >= CONTENT_ROW_CAP) {
            droppedRows += buf.contentRows.length - CONTENT_ROW_CAP;
            buf.contentRows.length = CONTENT_ROW_CAP;
        }
        return { flushed: false, reason: 'redis-down' };
    }

    const pending = buf;
    buf = emptyBuffer();

    try {
        const p = redis.pipeline();

        for (const [field, v] of Object.entries(pending.counters)) p.hincrby(K.counters, field, v);
        for (const [date, fields] of Object.entries(pending.daily)) {
            for (const [field, v] of Object.entries(fields)) p.hincrby(K.daily(date), field, v);
        }
        for (const [date, fields] of Object.entries(pending.provider)) {
            for (const [field, v] of Object.entries(fields)) p.hincrby(K.provider(date), field, v);
        }
        for (const [date, fields] of Object.entries(pending.language)) {
            for (const [field, v] of Object.entries(fields)) p.hincrby(K.language(date), field, v);
        }
        for (const [date, fields] of Object.entries(pending.combo)) {
            for (const [field, v] of Object.entries(fields)) p.hincrby(K.combo(date), field, v);
        }
        for (const [field, v] of Object.entries(pending.dist)) p.hincrby(K.dist, field, v);
        for (const [date, set] of Object.entries(pending.dailyUsers)) {
            if (set.size > 0) p.sadd(K.dailyUsers(date), ...set);
        }
        for (const [id, u] of pending.users) {
            p.hincrby(K.user(id), 'total', u.total);
            p.hincrby(K.user(id), 'movie', u.movie);
            p.hincrby(K.user(id), 'series', u.series);
            p.hset(K.user(id), 'last_active', Math.floor(Date.now() / 1000));
            if (u.languages) p.hset(K.user(id), 'languages', JSON.stringify(u.languages));
            p.expire(K.user(id), USER_TTL_SECONDS);
            p.sadd(K.userDirty, id);
        }
        if (pending.contentRows.length > 0) p.rpush(K.contentQueue, ...pending.contentRows);
        if (pending.responseTimes.length > 0) {
            const sorted = pending.responseTimes.slice().sort((a, b) => a - b);
            p.hset(K.responseTimes, String(process.pid), JSON.stringify({
                p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9),
                n: sorted.length, at: Date.now()
            }));
        }

        const replies = await p.exec();
        const failed = replies ? replies.filter(([err]) => err).length : 0;
        if (failed > 0) log('debug', `[track] ${failed} pipeline commands failed`);

        if (droppedRows > 0) {
            log('warn', `[track] dropped ${droppedRows} content rows (buffer or queue full)`);
            droppedRows = 0;
        }
        return { flushed: true, commands: replies ? replies.length : 0 };
    } catch (err) {
        restore(pending);
        log('debug', `[track] flush failed, deltas retained: ${err.message}`);
        return { flushed: false, reason: err.message };
    }
}

/** Shed content rows when the drain job is not keeping up. */
async function checkQueueDepth() {
    if (!isHealthy()) return;
    const now = Date.now();
    if (now - lastQueueCheck < 30_000) return;
    lastQueueCheck = now;
    try {
        const depth = await redis.llen(K.contentQueue);
        queueFull = depth > CL_QUEUE_MAX;
        if (queueFull) log('warn', `[track] content queue at ${depth}, shedding new rows`);
    } catch (_) { /* leave the previous verdict in place */ }
}

function start() {
    if (timer) return;
    timer = setInterval(() => {
        flush().catch(() => {});
        checkQueueDepth().catch(() => {});
    }, FLUSH_MS);
    if (timer.unref) timer.unref();
}

async function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    await flush().catch(() => {});
}

function pending() {
    return {
        counters: Object.keys(buf.counters).length,
        users: buf.users.size,
        contentRows: buf.contentRows.length,
        dropped: droppedRows
    };
}

module.exports = {
    counter, daily, provider, language, combo, dist, user, content, responseTime,
    flush, start, stop, pending, dateKey, K, FLUSH_MS
};

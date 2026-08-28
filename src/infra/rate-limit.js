'use strict';

/**
 * Distributed request spacing.
 *
 * Upstream rate limits apply to the addon as a whole, but a per-process timer only spaces
 * that process's own calls, so N workers issue N times the intended rate. Slots are
 * reserved in Redis instead; without it each process falls back to spacing its own calls.
 */

const { redis, isHealthy } = require('../infra/redis');

const PREFIX = 'ss:rl:';
const SLOT_TTL_MS = 60_000;
const MAX_WAIT_MS = 60_000;

// Reserve the next free slot and return how long the caller must wait for it.
const RESERVE_LUA = `
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local slot = tonumber(redis.call('GET', KEYS[1]) or '0')
if slot < now then slot = now end
redis.call('SET', KEYS[1], slot + interval, 'PX', ttl)
return slot - now
`;

let defined = false;
function ensureCommand() {
    if (defined) return;
    if (typeof redis.reserveSlot !== 'function') {
        redis.defineCommand('reserveSlot', { numberOfKeys: 1, lua: RESERVE_LUA });
    }
    defined = true;
}

const localSlots = new Map();

function localReserve(key, intervalMs) {
    const now = Date.now();
    const slot = Math.max(now, localSlots.get(key) || 0);
    localSlots.set(key, slot + intervalMs);
    return slot - now;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Reserve a slot for `key` and return the milliseconds to wait before using it.
 * Falls back to per-process spacing when Redis is unavailable.
 */
async function reserve(key, intervalMs) {
    if (!(intervalMs > 0)) return 0;
    if (isHealthy()) {
        try {
            ensureCommand();
            const waitMs = await redis.reserveSlot(PREFIX + key, Date.now(), intervalMs, SLOT_TTL_MS + intervalMs);
            return Math.max(0, Math.min(Number(waitMs) || 0, MAX_WAIT_MS));
        } catch (_) { /* fall through to local spacing */ }
    }
    return localReserve(key, intervalMs);
}

/** Reserve a slot and wait for it. */
async function throttle(key, intervalMs) {
    const waitMs = await reserve(key, intervalMs);
    if (waitMs > 0) await sleep(waitMs);
    return waitMs;
}

function resetLocal() { localSlots.clear(); }

module.exports = { reserve, throttle, resetLocal, PREFIX };

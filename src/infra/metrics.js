'use strict';

/**
 * Process metrics for /metrics and /health. Event-loop lag surfaces heap pressure well
 * before a process dies, and request rate makes "serving nothing" distinguishable from healthy.
 */

const { monitorEventLoopDelay } = require('perf_hooks');

const RPM_BUCKETS = 60;

const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

const counters = {
    requests: 0,
    cacheHitL1: 0,
    cacheHitL2: 0,
    cacheMiss: 0,
    errors: 0
};

const buckets = new Array(RPM_BUCKETS).fill(0);
let bucketIndex = Math.floor(Date.now() / 1000) % RPM_BUCKETS;
let bucketSecond = Math.floor(Date.now() / 1000);

const providerLatency = new Map();

function rollBuckets(nowSec) {
    if (nowSec === bucketSecond) return;
    const elapsed = Math.min(nowSec - bucketSecond, RPM_BUCKETS);
    for (let i = 1; i <= elapsed; i++) {
        buckets[(bucketIndex + i) % RPM_BUCKETS] = 0;
    }
    bucketIndex = (bucketIndex + elapsed) % RPM_BUCKETS;
    bucketSecond = nowSec;
}

function recordRequest() {
    rollBuckets(Math.floor(Date.now() / 1000));
    buckets[bucketIndex]++;
    counters.requests++;
}

function recordCache(kind) {
    if (kind === 'l1') counters.cacheHitL1++;
    else if (kind === 'l2') counters.cacheHitL2++;
    else counters.cacheMiss++;
}

function recordError() { counters.errors++; }

/** Moving average of per-provider latency, plus subtitle yield. */
function recordProvider(name, ms, subtitles = 0) {
    const prev = providerLatency.get(name);
    if (!prev) {
        providerLatency.set(name, { avgMs: ms, calls: 1, subtitles });
        return;
    }
    prev.avgMs = prev.avgMs + (ms - prev.avgMs) * 0.1;
    prev.calls++;
    prev.subtitles += subtitles;
}

function requestsPerMinute() {
    rollBuckets(Math.floor(Date.now() / 1000));
    let total = 0;
    for (const n of buckets) total += n;
    return total;
}

function snapshot() {
    const hits = counters.cacheHitL1 + counters.cacheHitL2;
    const lookups = hits + counters.cacheMiss;
    const mem = process.memoryUsage();
    return {
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        requestsPerMinute: requestsPerMinute(),
        eventLoop: {
            p50Ms: +(loopDelay.percentile(50) / 1e6).toFixed(2),
            p99Ms: +(loopDelay.percentile(99) / 1e6).toFixed(2),
            maxMs: +(loopDelay.max / 1e6).toFixed(2)
        },
        memory: {
            rssMb: +(mem.rss / 1048576).toFixed(1),
            heapUsedMb: +(mem.heapUsed / 1048576).toFixed(1)
        },
        cache: {
            l1: counters.cacheHitL1,
            l2: counters.cacheHitL2,
            miss: counters.cacheMiss,
            hitRate: lookups > 0 ? +((hits / lookups) * 100).toFixed(1) : 0
        },
        counters: { requests: counters.requests, errors: counters.errors },
        providers: Object.fromEntries(
            [...providerLatency].map(([n, v]) => [n, {
                avgMs: Math.round(v.avgMs),
                calls: v.calls,
                subtitlesPerCall: +(v.subtitles / v.calls).toFixed(2)
            }])
        )
    };
}

/** Reset the lag histogram so percentiles track recent behaviour, not all of uptime. */
function resetEventLoop() { loopDelay.reset(); }

module.exports = {
    recordRequest, recordCache, recordError, recordProvider,
    requestsPerMinute, snapshot, resetEventLoop, counters
};

/**
 * In-memory request deduplication.
 *
 * Concurrent calls with the same key share a single underlying promise.
 * The slot is released as soon as the promise settles, so subsequent
 * callers trigger a fresh fetch.
 */

const { log } = require('../../src/utils');

class InflightCache {
    constructor() {
        /** @type {Map<string, Promise<*>>} */
        this._inflight = new Map();
    }

    /**
     * Run `fn()` once per `key`. Concurrent callers share the result.
     *
     * @template T
     * @param {string} key
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    getOrFetch(key, fn) {
        const existing = this._inflight.get(key);
        if (existing) {
            log('debug', `[InflightCache] dedup hit: ${key}`);
            return existing;
        }

        const promise = (async () => {
            try {
                return await fn();
            } finally {
                // Always release the slot, even on failure
                this._inflight.delete(key);
            }
        })();

        this._inflight.set(key, promise);
        return promise;
    }

    /** Number of active in-flight requests (mostly for tests / metrics). */
    size() {
        return this._inflight.size;
    }

    /** Remove all in-flight entries. Does NOT cancel underlying promises. */
    clear() {
        this._inflight.clear();
    }
}

module.exports = InflightCache;

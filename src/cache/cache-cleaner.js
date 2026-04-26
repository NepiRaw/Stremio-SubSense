/**
 * CacheCleaner - worker-side batched retention enforcement
 */

const db = require('./database-libsql');
const { log } = require('../../src/utils');

const BATCH_SIZE = 500;
const DAY_S = 24 * 60 * 60;

function intEnv(name, fallback) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

function tick() {
    return new Promise(resolve => setImmediate(resolve));
}

class CacheCleaner {
    constructor(options = {}) {
        this.ttlSeconds = (options.ttlDays ?? intEnv('L2_TTL_DAYS', 7)) * DAY_S;
    }

    /**
     * Run one full cleanup pass. Returns the total rows deleted.
     * Safe to invoke concurrently with normal reads/writes.
     */
    async run() {
        const started = Date.now();
        let totalDeleted = 0;

        // eslint-disable-next-line no-constant-condition
        while (true) {
            let deleted;
            try {
                const result = await db.execute(`
                    DELETE FROM subtitle_cache
                    WHERE rowid IN (
                        SELECT rowid FROM subtitle_cache
                        WHERE updated_at < (strftime('%s','now') - ?)
                        LIMIT ?
                    )
                `, [this.ttlSeconds, BATCH_SIZE]);
                deleted = Number(result.rowsAffected) || 0;
            } catch (err) {
                log('error', `[CacheCleaner] batch failed: ${err.message}`);
                break;
            }

            totalDeleted += deleted;
            if (deleted < BATCH_SIZE) break;

            await tick();
        }

        const elapsed = Date.now() - started;
        if (totalDeleted > 0) {
            log('info', `[CacheCleaner] removed ${totalDeleted} expired rows in ${elapsed}ms`);
        } else {
            log('debug', `[CacheCleaner] nothing to remove (scan ${elapsed}ms)`);
        }
        return totalDeleted;
    }
}

module.exports = CacheCleaner;

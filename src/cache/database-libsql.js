/**
 * LibSQL database client and schema.
 *
 * Both the api and worker processes import this module. Schema creation is
 * idempotent. WAL mode is enabled so reads from the api do not block writes
 * from the worker (and vice versa). Stats schema is owned by the optional
 * stats module and is not declared here.
 */

const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');
const { log } = require('../../src/utils');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/subsense.db');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    log('info', `[DB] Created data directory: ${dataDir}`);
}

const client = createClient({
    url: `file:${DB_PATH}`,
    intMode: 'number'
});

log('info', `[DB] LibSQL client initialized: ${DB_PATH}`);

/**
 * subtitle_cache (JSON blob):
 *   One row per (imdb_id, season, episode, lang_key). The `subtitles` column
 *   is a JSON-encoded array of fully-built subtitle objects already containing
 *   any __SUBSRC_KEY__ placeholders required by the L1 materialize step.
 *
 *   `lang_key` is the sorted-comma-joined language list (e.g. "eng,fre")
 *   matching the L1 cache key suffix. This lets the worker warm L1 with a
 *   single SELECT * scan.
 *
 * response_cache (raw aggregated responses, optional):
 *   Reserved for future use (e.g. caching the exact stremio response payload
 *   including non-language-bucketed metadata). Currently a no-op placeholder
 *   so the schema migration is forward-compatible.
 */
const schema = `
CREATE TABLE IF NOT EXISTS subtitle_cache (
    imdb_id     TEXT    NOT NULL,
    season      INTEGER NOT NULL DEFAULT 0,
    episode     INTEGER NOT NULL DEFAULT 0,
    lang_key    TEXT    NOT NULL,
    subtitles   TEXT    NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (imdb_id, season, episode, lang_key)
);

CREATE INDEX IF NOT EXISTS idx_subtitle_cache_updated
    ON subtitle_cache(updated_at);

`;

const PRAGMAS = [
    'PRAGMA journal_mode = WAL',
    'PRAGMA synchronous = NORMAL',
    'PRAGMA temp_store = MEMORY',
    'PRAGMA mmap_size = 268435456',
    'PRAGMA cache_size = -65536',
    'PRAGMA auto_vacuum = INCREMENTAL',
    'PRAGMA busy_timeout = 5000',
    'PRAGMA journal_size_limit = 67108864'
];

let initialized = false;
let initPromise = null;

async function initializeDatabase() {
    if (initialized) return client;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        await client.executeMultiple(schema);
        for (const pragma of PRAGMAS) {
            try {
                await client.execute(pragma);
            } catch (err) {
                log('warn', `[DB] PRAGMA failed (${pragma}): ${err.message}`);
            }
        }
        initialized = true;
        log('info', '[DB] schema + pragmas applied');
        return client;
    })();

    return initPromise;
}

async function execute(sql, args = []) {
    await initializeDatabase();
    return client.execute({ sql, args });
}

async function executeMultiple(sql) {
    await initializeDatabase();
    return client.executeMultiple(sql);
}

async function batch(statements, mode = 'write') {
    await initializeDatabase();
    return client.batch(statements, mode);
}

async function transaction(mode = 'write') {
    await initializeDatabase();
    return client.transaction(mode);
}

/**
 * Truncate the WAL file after merging it back into the main DB.
 * Intended for the worker process; safe to call periodically and on shutdown.
 */
async function checkpoint() {
    await initializeDatabase();
    try {
        await client.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (err) {
        log('warn', `[DB] checkpoint failed: ${err.message}`);
    }
}

function close() {
    try {
        client.close();
    } catch (err) {
        log('warn', `[DB] close error: ${err.message}`);
    }
    initialized = false;
    initPromise = null;
    log('info', '[DB] LibSQL client closed');
}

module.exports = {
    client,
    initializeDatabase,
    execute,
    executeMultiple,
    batch,
    transaction,
    checkpoint,
    close,
    DB_PATH
};

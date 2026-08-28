'use strict';

/**
 * Three SQLite files with separate lock domains: cache (subtitle cache), stats
 * (analytics, user tracking, rotating content log), meta (provider metadata).
 */

const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');
const { log } = require('../utils');

const DATA_DIR = process.env.DB_DIR || path.join(__dirname, '..', '..', 'data');

const PATHS = {
    cache: process.env.CACHE_DB_PATH || path.join(DATA_DIR, 'subsense-cache.db'),
    stats: process.env.STATS_DB_PATH || path.join(DATA_DIR, 'subsense-stats.db'),
    meta:  process.env.META_DB_PATH  || path.join(DATA_DIR, 'subsense-meta.db')
};

const CONTENT_LOG_DAYS = 7;
const CONTENT_LOG_TABLES = Array.from({ length: CONTENT_LOG_DAYS }, (_, d) => `content_log_${d}`);

const CACHE_SCHEMA = `
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
CREATE INDEX IF NOT EXISTS idx_subtitle_cache_updated ON subtitle_cache(updated_at);
`;

/** Daily rotation deletes these wholesale, so they stay free of foreign keys and triggers. */
function contentLogSchema() {
    return CONTENT_LOG_TABLES.map((t, d) => `
CREATE TABLE IF NOT EXISTS ${t} (
    id           INTEGER PRIMARY KEY,
    user_id      TEXT    NOT NULL,
    imdb_id      TEXT    NOT NULL,
    content_type TEXT,
    season       INTEGER,
    episode      INTEGER,
    requested_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cl${d}_user ON ${t}(user_id);
CREATE INDEX IF NOT EXISTS idx_cl${d}_at ON ${t}(requested_at);
`).join('');
}

const STATS_SCHEMA = `
CREATE TABLE IF NOT EXISTS stats (
    stat_key     TEXT PRIMARY KEY,
    stat_value   INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS stats_daily (
    date            TEXT PRIMARY KEY,
    requests        INTEGER DEFAULT 0,
    cache_hits      INTEGER DEFAULT 0,
    cache_misses    INTEGER DEFAULT 0,
    conversions     INTEGER DEFAULT 0,
    movies          INTEGER DEFAULT 0,
    series          INTEGER DEFAULT 0,
    subtitles       INTEGER DEFAULT 0,
    any_pref_found  INTEGER DEFAULT 0,
    all_pref_found  INTEGER DEFAULT 0,
    unique_users    INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS provider_stats (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_name   TEXT NOT NULL,
    date            TEXT NOT NULL,
    total_requests  INTEGER DEFAULT 0,
    successful_requests INTEGER DEFAULT 0,
    failed_requests INTEGER DEFAULT 0,
    avg_response_ms INTEGER DEFAULT 0,
    subtitles_returned INTEGER DEFAULT 0,
    requests_with_results INTEGER,
    last_success_at TEXT,
    UNIQUE(provider_name, date)
);
CREATE INDEX IF NOT EXISTS idx_provider_stats_date ON provider_stats(date);

CREATE TABLE IF NOT EXISTS language_stats (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    language_code   TEXT NOT NULL,
    date            TEXT NOT NULL,
    priority        TEXT DEFAULT 'preferred',
    requests_for    INTEGER DEFAULT 0,
    found_count     INTEGER DEFAULT 0,
    not_found_count INTEGER DEFAULT 0,
    UNIQUE(language_code, date, priority)
);
CREATE INDEX IF NOT EXISTS idx_language_stats_date ON language_stats(date);

CREATE TABLE IF NOT EXISTS user_tracking (
    user_id      TEXT PRIMARY KEY,
    languages    TEXT NOT NULL DEFAULT '[]',
    total_requests   INTEGER DEFAULT 0,
    movie_requests   INTEGER DEFAULT 0,
    series_requests  INTEGER DEFAULT 0,
    first_seen   INTEGER DEFAULT (strftime('%s','now')),
    last_active  INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_user_tracking_last_active ON user_tracking(last_active);

CREATE TABLE IF NOT EXISTS lang_combos (
    date   TEXT    NOT NULL,
    combo  TEXT    NOT NULL,
    count  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, combo)
);

CREATE TABLE IF NOT EXISTS dist (
    kind   TEXT    NOT NULL,
    key    TEXT    NOT NULL,
    count  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, key)
);

CREATE TABLE IF NOT EXISTS kv (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
);
` + contentLogSchema();

const META_SCHEMA = `
CREATE TABLE IF NOT EXISTS anidb_episodes (
    anidb_id     INTEGER NOT NULL,
    episode_num  INTEGER NOT NULL,
    eid          INTEGER NOT NULL,
    title_en     TEXT,
    created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (anidb_id, episode_num)
);
CREATE INDEX IF NOT EXISTS idx_anidb_episodes_eid ON anidb_episodes(eid);

CREATE TABLE IF NOT EXISTS anidb_anime_meta (
    anidb_id     INTEGER PRIMARY KEY,
    total_eps    INTEGER,
    fetched_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS at_torrent_details (
    torrent_id  INTEGER PRIMARY KEY,
    data        TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
`;

const SCHEMAS = { cache: CACHE_SCHEMA, stats: STATS_SCHEMA, meta: META_SCHEMA };

// foreign_keys is left at the libSQL default (on) so a future FK would actually enforce.
const RUNTIME_PRAGMAS = [
    'PRAGMA synchronous = NORMAL',
    'PRAGMA busy_timeout = 5000',
    'PRAGMA temp_store = MEMORY',
    'PRAGMA cache_size = -16384'
];

function ensureDataDir(file) {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function makeClient(file) {
    ensureDataDir(file);
    return createClient({ url: `file:${file}`, intMode: 'number' });
}

const clients = {
    cache: makeClient(PATHS.cache),
    stats: makeClient(PATHS.stats),
    meta:  makeClient(PATHS.meta)
};

function readPragma(result) {
    const row = result.rows[0];
    if (!row) return null;
    return Array.isArray(row) ? row[0] : Object.values(row)[0];
}

async function applyPragmas(name, client) {
    // Order is load-bearing: auto_vacuum is only accepted on an empty, non-WAL database.
    try {
        await client.execute('PRAGMA auto_vacuum = INCREMENTAL');
    } catch (err) {
        log('warn', `[DB:${name}] auto_vacuum could not be set: ${err.message}`);
    }
    try {
        await client.execute('PRAGMA journal_mode = WAL');
    } catch (err) {
        log('warn', `[DB:${name}] journal_mode could not be set: ${err.message}`);
    }
    for (const pragma of RUNTIME_PRAGMAS) {
        try {
            await client.execute(pragma);
        } catch (err) {
            log('warn', `[DB:${name}] ${pragma} failed: ${err.message}`);
        }
    }
}

/** Effective pragma values. auto_vacuum: 0 NONE, 1 FULL, 2 INCREMENTAL. */
async function verifyPragmas(name) {
    const client = clients[name];
    const [journal, autoVacuum, foreignKeys, pageSize] = await Promise.all([
        client.execute('PRAGMA journal_mode'),
        client.execute('PRAGMA auto_vacuum'),
        client.execute('PRAGMA foreign_keys'),
        client.execute('PRAGMA page_size')
    ]);
    return {
        journal_mode: String(readPragma(journal)).toLowerCase(),
        auto_vacuum: Number(readPragma(autoVacuum)),
        foreign_keys: Number(readPragma(foreignKeys)),
        page_size: Number(readPragma(pageSize))
    };
}

/** Rotating tables that wrongly declare a foreign key. */
async function rotationTablesWithForeignKeys() {
    const offenders = [];
    for (const t of CONTENT_LOG_TABLES) {
        const r = await clients.stats.execute(`PRAGMA foreign_key_list(${t})`);
        if (r.rows.length > 0) offenders.push(t);
    }
    return offenders;
}

let initialized = false;
let initPromise = null;

async function initAll() {
    if (initialized) return clients;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        for (const name of Object.keys(clients)) {
            await applyPragmas(name, clients[name]);
            await clients[name].executeMultiple(SCHEMAS[name]);

            const p = await verifyPragmas(name);
            if (p.journal_mode !== 'wal') {
                log('warn', `[DB:${name}] journal_mode is ${p.journal_mode}, expected wal`);
            }
            if (p.auto_vacuum !== 2) {
                log('warn',
                    `[DB:${name}] auto_vacuum is ${p.auto_vacuum}, expected 2 (INCREMENTAL). ` +
                    'Pre-existing file created without it; a full VACUUM is required to change it.');
            }
            log('info', `[DB:${name}] ready (${p.journal_mode}, auto_vacuum=${p.auto_vacuum}) ${PATHS[name]}`);
        }

        const offenders = await rotationTablesWithForeignKeys();
        if (offenders.length > 0) {
            log('warn', `[DB:stats] rotating tables must not declare foreign keys: ${offenders.join(', ')}`);
        }
        initialized = true;
        return clients;
    })();

    return initPromise;
}

function close() {
    for (const [name, client] of Object.entries(clients)) {
        try { client.close(); }
        catch (err) { log('warn', `[DB:${name}] close error: ${err.message}`); }
    }
    initialized = false;
    initPromise = null;
}

module.exports = {
    cacheDb: clients.cache,
    statsDb: clients.stats,
    metaDb:  clients.meta,
    clients,
    initAll,
    verifyPragmas,
    rotationTablesWithForeignKeys,
    close,
    PATHS,
    CONTENT_LOG_TABLES,
    CONTENT_LOG_DAYS
};

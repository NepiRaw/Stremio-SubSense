'use strict';

/**
 * Stats-owned SQL schema.
 *
 * All stats tables live here so they are created lazily when stats are
 * enabled and never interfere with the core subtitle-cache schema in
 * database-libsql.js.
 *
 * Two table subsets:
 *   FULL  - all tables
 *   MINIMAL - only user_tracking (session counting for /configure)
 */

const MINIMAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS user_tracking (
    user_id      TEXT PRIMARY KEY,
    languages    TEXT NOT NULL DEFAULT '[]',
    total_requests   INTEGER DEFAULT 0,
    movie_requests   INTEGER DEFAULT 0,
    series_requests  INTEGER DEFAULT 0,
    first_seen   INTEGER DEFAULT (strftime('%s','now')),
    last_active  INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_user_tracking_last_active
    ON user_tracking(last_active);
`;

const FULL_SCHEMA = `
${MINIMAL_SCHEMA}

CREATE TABLE IF NOT EXISTS stats (
    stat_key     TEXT PRIMARY KEY,
    stat_value   INTEGER DEFAULT 0,
    updated_at   INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS stats_daily (
    date         TEXT PRIMARY KEY,
    requests     INTEGER DEFAULT 0,
    cache_hits   INTEGER DEFAULT 0,
    cache_misses INTEGER DEFAULT 0,
    conversions  INTEGER DEFAULT 0,
    movies       INTEGER DEFAULT 0,
    series       INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS request_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    imdb_id      TEXT NOT NULL,
    content_type TEXT,
    languages    TEXT,
    result_count INTEGER,
    cache_hit    INTEGER,
    response_time_ms INTEGER,
    any_preferred_found INTEGER DEFAULT 0,
    all_preferred_found INTEGER DEFAULT 0,
    created_at   INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_request_log_created
    ON request_log(created_at);

CREATE TABLE IF NOT EXISTS provider_stats (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_name   TEXT NOT NULL,
    date            TEXT NOT NULL,
    total_requests  INTEGER DEFAULT 0,
    successful_requests INTEGER DEFAULT 0,
    failed_requests INTEGER DEFAULT 0,
    avg_response_ms INTEGER DEFAULT 0,
    subtitles_returned INTEGER DEFAULT 0,
    UNIQUE(provider_name, date)
);

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

CREATE TABLE IF NOT EXISTS user_content_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL,
    imdb_id      TEXT NOT NULL,
    content_type TEXT,
    season       INTEGER,
    episode      INTEGER,
    requested_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (user_id) REFERENCES user_tracking(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_content_log_user
    ON user_content_log(user_id);

CREATE INDEX IF NOT EXISTS idx_user_content_log_requested
    ON user_content_log(requested_at);

CREATE INDEX IF NOT EXISTS idx_language_stats_date
    ON language_stats(date);

CREATE INDEX IF NOT EXISTS idx_provider_stats_date
    ON provider_stats(date);

CREATE INDEX IF NOT EXISTS idx_request_log_imdb
    ON request_log(imdb_id, created_at);

CREATE TABLE IF NOT EXISTS cache_stats_summary (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    total_entries      INTEGER DEFAULT 0,
    unique_content     INTEGER DEFAULT 0,
    unique_languages   INTEGER DEFAULT 0,
    unique_sources     INTEGER DEFAULT 0,
    size_bytes         INTEGER DEFAULT 0,
    source_distribution TEXT DEFAULT '{}',
    language_distribution TEXT DEFAULT '{}',
    oldest_timestamp   INTEGER DEFAULT 0,
    newest_timestamp   INTEGER DEFAULT 0,
    avg_age_seconds    REAL DEFAULT 0,
    cache_hits         INTEGER DEFAULT 0,
    cache_misses       INTEGER DEFAULT 0,
    computed_at        INTEGER DEFAULT (strftime('%s','now')),
    computation_time_ms INTEGER DEFAULT 0
);

INSERT OR IGNORE INTO cache_stats_summary (id) VALUES (1);
`;

module.exports = { MINIMAL_SCHEMA, FULL_SCHEMA };

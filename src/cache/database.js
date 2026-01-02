/**
 * SQLite Database Connection and Initialization
 * Auto-creates database and tables on first import
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Database path - defaults to ./data/subsense.db
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/subsense.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`[Cache] Created data directory: ${dataDir}`);
}

// Create/open database
const db = new Database(DB_PATH);
console.log(`[Cache] Database opened: ${DB_PATH}`);

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');

// Run schema initialization
const schema = `
-- Subtitle cache table
CREATE TABLE IF NOT EXISTS subtitle_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    imdb_id TEXT NOT NULL,
    season INTEGER,
    episode INTEGER,
    language TEXT NOT NULL,
    subtitle_id TEXT,
    title TEXT,
    url TEXT NOT NULL,
    format TEXT,
    needs_conversion INTEGER,
    rating REAL,
    source TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now')),
    UNIQUE(imdb_id, season, episode, language, subtitle_id)
);

CREATE INDEX IF NOT EXISTS idx_cache_lookup 
ON subtitle_cache(imdb_id, season, episode, language);

CREATE INDEX IF NOT EXISTS idx_cache_updated 
ON subtitle_cache(updated_at);

-- Persistent statistics table
CREATE TABLE IF NOT EXISTS stats (
    stat_key TEXT PRIMARY KEY,
    stat_value INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Daily aggregated stats
CREATE TABLE IF NOT EXISTS stats_daily (
    date TEXT NOT NULL,
    requests INTEGER DEFAULT 0,
    cache_hits INTEGER DEFAULT 0,
    cache_misses INTEGER DEFAULT 0,
    conversions INTEGER DEFAULT 0,
    movies INTEGER DEFAULT 0,
    series INTEGER DEFAULT 0,
    PRIMARY KEY (date)
);

-- Request log for analytics
CREATE TABLE IF NOT EXISTS request_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    imdb_id TEXT NOT NULL,
    content_type TEXT,
    languages TEXT,
    result_count INTEGER,
    cache_hit INTEGER,
    response_time_ms INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_request_log_created 
ON request_log(created_at);

-- Provider performance tracking
CREATE TABLE IF NOT EXISTS provider_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_name TEXT NOT NULL,
    date TEXT NOT NULL,
    total_requests INTEGER DEFAULT 0,
    successful_requests INTEGER DEFAULT 0,
    failed_requests INTEGER DEFAULT 0,
    avg_response_ms INTEGER DEFAULT 0,
    subtitles_returned INTEGER DEFAULT 0,
    UNIQUE(provider_name, date)
);

CREATE INDEX IF NOT EXISTS idx_provider_stats_date 
ON provider_stats(date);

-- Language analytics table
-- Updated: Added priority column to distinguish primary vs secondary language requests
CREATE TABLE IF NOT EXISTS language_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    language_code TEXT NOT NULL,
    date TEXT NOT NULL,
    priority TEXT DEFAULT 'primary', -- 'primary' or 'secondary'
    requests_for INTEGER DEFAULT 0,
    found_count INTEGER DEFAULT 0,
    not_found_count INTEGER DEFAULT 0,
    UNIQUE(language_code, date, priority)
);

CREATE INDEX IF NOT EXISTS idx_language_stats_date 
ON language_stats(date);

CREATE INDEX IF NOT EXISTS idx_language_stats_priority 
ON language_stats(priority);

-- Session analytics table
-- Stores anonymized per-session statistics for usage analytics
CREATE TABLE IF NOT EXISTS user_tracking (
    user_id TEXT PRIMARY KEY,
    languages TEXT NOT NULL, -- JSON array of language codes
    total_requests INTEGER DEFAULT 0,
    movie_requests INTEGER DEFAULT 0,
    series_requests INTEGER DEFAULT 0,
    first_seen INTEGER DEFAULT (strftime('%s', 'now')),
    last_active INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_user_tracking_last_active 
ON user_tracking(last_active);

-- Session content log
-- Records content requests per session for analytics
CREATE TABLE IF NOT EXISTS user_content_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    imdb_id TEXT NOT NULL,
    content_type TEXT,
    season INTEGER,
    episode INTEGER,
    requested_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (user_id) REFERENCES user_tracking(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_content_log_user 
ON user_content_log(user_id);

CREATE INDEX IF NOT EXISTS idx_user_content_log_imdb 
ON user_content_log(imdb_id);

-- Content cache summary view
-- For browsing cached content by IMDB ID
CREATE VIEW IF NOT EXISTS content_cache_summary AS
SELECT 
    imdb_id,
    season,
    episode,
    COUNT(DISTINCT language) as languages_cached,
    COUNT(*) as total_subtitles,
    MAX(updated_at) as last_updated,
    GROUP_CONCAT(DISTINCT source) as sources,
    GROUP_CONCAT(DISTINCT language) as language_list
FROM subtitle_cache
GROUP BY imdb_id, season, episode
ORDER BY last_updated DESC;
`;

db.exec(schema);
console.log('[Cache] Database schema initialized');

module.exports = db;

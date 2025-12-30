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
`;

db.exec(schema);
console.log('[Cache] Database schema initialized');

module.exports = db;

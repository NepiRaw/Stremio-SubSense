'use strict';

/**
 * Wyzie Dump DB - read-only lookup for cached paid-source subtitles.
 *
 * Provides subtitle entries from a static dump of previously-cached Wyzie
 * results (subf2m, subdl, addic7ed, podnapisi, jimaku). These entries have
 * direct download URLs that remain accessible without API calls.
 *
 * Tracks dead URLs in-memory so broken links aren't served repeatedly.
 */

const { log } = require('../utils');
const path = require('path');
const fs = require('fs');

const DUMP_DB_PATH = process.env.WYZIE_DUMP_DB_PATH ||
    path.join(__dirname, '../../data/wyzie-dump.db');

const DEAD_RECHECK_MS = 24 * 60 * 60 * 1000; // re-check dead URLs after 24h
const HEAD_TIMEOUT_MS = 4000;
const MAX_CHECKS_PER_REQUEST = 8;
const DEAD_CACHE_MAX = 10000;

let _db = null;
let _available = false;
let _deadLinks = new Map(); // url -> { lastChecked }

/**
 * Initialize the dump DB connection (call once at startup).
 */
async function initDumpDb() {
    if (!fs.existsSync(DUMP_DB_PATH)) {
        log('info', `[WyzieDump] DB not found at ${DUMP_DB_PATH} — disabled`);
        _available = false;
        return false;
    }

    try {
        const { createClient } = require('@libsql/client');
        _db = createClient({
            url: `file:${DUMP_DB_PATH}`,
            intMode: 'number'
        });
        const result = await _db.execute('SELECT COUNT(*) as cnt FROM subtitle_cache');
        const count = result.rows[0]?.cnt || 0;
        _available = count > 0;
        log('info', `[WyzieDump] Initialized: ${count} rows`);
        return _available;
    } catch (err) {
        log('error', `[WyzieDump] Init failed: ${err.message}`);
        _available = false;
        return false;
    }
}

/**
 * Lookup subtitles from the dump for a given content + languages.
 * Returns raw subtitle objects (same shape as stored in cache JSON).
 * Returns [] if dump is unavailable or no match.
 */
async function lookupDump(imdbId, season, episode, languages) {
    if (!_available || !_db) return [];

    try {
        const result = await _db.execute({
            sql: `SELECT subtitles FROM subtitle_cache
                  WHERE imdb_id = ? AND season = ? AND episode = ?`,
            args: [imdbId, season || 0, episode || 0]
        });

        if (result.rows.length === 0) return [];

        const langSet = new Set((languages || []).map(l => l.toLowerCase()));
        const seenIds = new Set();
        const out = [];

        for (const row of result.rows) {
            let subs;
            try { subs = JSON.parse(row.subtitles); } catch { continue; }
            if (!Array.isArray(subs)) continue;

            for (const sub of subs) {
                if (!sub || !sub.id || seenIds.has(sub.id)) continue;
                if (!sub.url) continue;

                // Filter by language if languages provided
                const subLang = (sub.lang || sub.language || '').substring(0, 2).toLowerCase();
                if (langSet.size > 0 && !langSet.has(subLang)) continue;

                // Skip known dead URLs
                if (_isDeadUrl(sub.url)) continue;

                seenIds.add(sub.id);
                out.push(sub);
            }
        }

        return out;
    } catch (err) {
        log('debug', `[WyzieDump] Lookup failed: ${err.message}`);
        return [];
    }
}

/**
 * Background-validate a sample of URLs. Call fire-and-forget after serving.
 */
async function validateUrls(subtitles) {
    const toCheck = subtitles
        .filter(s => s.url && !_deadLinks.has(s.url))
        .slice(0, MAX_CHECKS_PER_REQUEST);

    if (toCheck.length === 0) return;

    const results = await Promise.allSettled(
        toCheck.map(sub => _headCheck(sub.url))
    );

    for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'fulfilled' && !results[i].value) {
            _markDead(toCheck[i].url);
        }
    }
}

function isAvailable() {
    return _available;
}

function getStats() {
    return { available: _available, deadLinks: _deadLinks.size };
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _isDeadUrl(url) {
    const entry = _deadLinks.get(url);
    if (!entry) return false;
    if (Date.now() - entry.lastChecked > DEAD_RECHECK_MS) {
        _deadLinks.delete(url);
        return false;
    }
    return true;
}

function _markDead(url) {
    if (_deadLinks.size >= DEAD_CACHE_MAX) {
        const oldest = _deadLinks.keys().next().value;
        _deadLinks.delete(oldest);
    }
    _deadLinks.set(url, { lastChecked: Date.now() });
    log('debug', `[WyzieDump] Dead: ${url.substring(0, 80)}`);
}

async function _headCheck(url) {
    try {
        const res = await fetch(url, {
            method: 'HEAD',
            signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
            redirect: 'follow'
        });
        return res.status >= 200 && res.status < 400;
    } catch {
        return false;
    }
}

module.exports = { initDumpDb, lookupDump, validateUrls, isAvailable, getStats };

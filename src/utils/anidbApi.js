'use strict';

/**
 * AniDB HTTP API wrapper with libSQL cache.
 *
 * Fetches episode data from AniDB, caches all episodes for an anime
 * in a single call. Subsequent requests for the same anime are served
 * from the database without any API call.
 *
 * Uses the existing libSQL database (shared with SubSense).
 */

const http = require('http');
const zlib = require('zlib');
const { log } = require('../utils');

const ANIDB_URL = 'http://api.anidb.net:9001/httpapi';
const CLIENT = process.env.ANIDB_CLIENT || null;
const CLIENT_VER = process.env.ANIDB_CLIENT_VER ? parseInt(process.env.ANIDB_CLIENT_VER, 10) : null;
const PROTO_VER = 1;

/**
 * Check if AniDB API credentials are configured.
 * Both ANIDB_CLIENT and ANIDB_CLIENT_VER must be set in .env.
 */
function isAnidbConfigured() {
    return !!(CLIENT && CLIENT_VER != null);
}

let db = null;

/**
 * Initialize AniDB cache tables in the shared database.
 */
async function initAnidbCache(database) {
    db = database;
    await db.executeMultiple(`
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
    `);
    log('info', '[AniDB] Cache tables initialized');
}

/**
 * Get the AniDB episode ID (eid) for a specific anime + episode number.
 * Uses libSQL cache first, falls back to AniDB HTTP API.
 */
async function getEpisodeId(anidbId, episodeNum) {
    if (!isAnidbConfigured()) return null;
    if (!db) throw new Error('AniDB cache not initialized');

    const cached = await db.execute(
        'SELECT eid FROM anidb_episodes WHERE anidb_id = ? AND episode_num = ?',
        [anidbId, episodeNum]
    );
    if (cached.rows.length > 0) {
        return cached.rows[0].eid;
    }

    const meta = await db.execute(
        'SELECT fetched_at FROM anidb_anime_meta WHERE anidb_id = ?',
        [anidbId]
    );
    if (meta.rows.length > 0) {
        return null;
    }

    const episodes = await fetchFromAnidb(anidbId);
    if (!episodes) return null;

    if (episodes.length > 0) {
        const stmts = episodes.map(ep => ({
            sql: 'INSERT OR IGNORE INTO anidb_episodes (anidb_id, episode_num, eid, title_en) VALUES (?, ?, ?, ?)',
            args: [anidbId, ep.epno, ep.eid, ep.titleEn || null]
        }));
        await db.batch(stmts);
    }

    await db.execute(
        "INSERT OR REPLACE INTO anidb_anime_meta (anidb_id, total_eps, fetched_at) VALUES (?, ?, strftime('%s','now'))",
        [anidbId, episodes.length]
    );

    log('debug', `[AniDB] Cached ${episodes.length} episodes for aid=${anidbId}`);

    const match = episodes.find(e => e.epno === episodeNum);
    return match ? match.eid : null;
}

/**
 * Fetch anime episode data from AniDB HTTP API.
 * Returns parsed episodes array or null on error.
 */
function fetchFromAnidb(anidbId) {
    return new Promise((resolve) => {
        const url = `${ANIDB_URL}?request=anime&client=${encodeURIComponent(CLIENT)}&clientver=${CLIENT_VER}&protover=${PROTO_VER}&aid=${anidbId}`;

        const req = http.get(url, { headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
            let stream = res;
            if (res.headers['content-encoding'] === 'gzip') {
                stream = res.pipe(zlib.createGunzip());
            }

            let data = '';
            stream.on('data', chunk => data += chunk);
            stream.on('end', () => {
                if (data.includes('<error>')) {
                    const errMatch = data.match(/<error>(.*?)<\/error>/);
                    log('warn', `[AniDB] Error for aid=${anidbId}: ${errMatch?.[1]}`);
                    resolve(null);
                    return;
                }

                const episodes = parseEpisodes(data);
                log('debug', `[AniDB] aid=${anidbId}: ${episodes.length} episodes parsed`);
                resolve(episodes);
            });
            stream.on('error', (err) => {
                log('error', `[AniDB] Stream error for aid=${anidbId}: ${err.message}`);
                resolve(null);
            });
        });

        req.on('error', (err) => {
            log('error', `[AniDB] Request error for aid=${anidbId}: ${err.message}`);
            resolve(null);
        });

        req.setTimeout(15000, () => {
            req.destroy();
            log('warn', `[AniDB] Request timeout for aid=${anidbId}`);
            resolve(null);
        });
    });
}

/**
 * Parse episodes from AniDB XML response.
 * Only extracts regular episodes (type="1"), not specials/credits/etc.
 */
function parseEpisodes(xml) {
    const episodes = [];
    const episodeRegex = /<episode id="(\d+)"[^>]*>[\s\S]*?<epno type="1">(\d+)<\/epno>([\s\S]*?)<\/episode>/g;
    let match;
    while ((match = episodeRegex.exec(xml)) !== null) {
        const eid = parseInt(match[1], 10);
        const epno = parseInt(match[2], 10);
        const inner = match[3];

        const titleMatch = inner.match(/<title xml:lang="en"[^>]*>(.*?)<\/title>/);
        const titleEn = titleMatch ? titleMatch[1] : null;

        episodes.push({ eid, epno, titleEn });
    }
    return episodes;
}

/**
 * Check if an anime's episodes are already cached.
 */
async function isAnimeCached(anidbId) {
    if (!db) return false;
    const result = await db.execute(
        'SELECT 1 FROM anidb_anime_meta WHERE anidb_id = ?',
        [anidbId]
    );
    return result.rows.length > 0;
}

module.exports = { initAnidbCache, getEpisodeId, isAnimeCached, isAnidbConfigured };

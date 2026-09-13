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
            title_main   TEXT,
            fetched_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
        CREATE TABLE IF NOT EXISTS anidb_cache_meta (
            key          TEXT PRIMARY KEY,
            value        TEXT
        );
    `);
    await db.execute('ALTER TABLE anidb_anime_meta ADD COLUMN title_main TEXT').catch(() => {});
    await purgeStaleCache();
    log('info', '[AniDB] Cache tables initialized');
}

const PARSER_VERSION = '3';

async function purgeStaleCache() {
    const r = await db.execute("SELECT value FROM anidb_cache_meta WHERE key = 'parser_version'");
    if (r.rows[0]?.value === PARSER_VERSION) return;
    await db.executeMultiple('DELETE FROM anidb_episodes; DELETE FROM anidb_anime_meta;');
    await db.execute({ sql: "INSERT OR REPLACE INTO anidb_cache_meta (key, value) VALUES ('parser_version', ?)", args: [PARSER_VERSION] });
    log('info', `[AniDB] Episode cache purged for parser v${PARSER_VERSION}`);
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

    const episodes = await loadAnime(anidbId);
    if (!episodes) return null;
    const match = episodes.find(e => e.epno === episodeNum);
    return match ? match.eid : null;
}

/** Regular episode count of an anime, null when AniDB is not configured or the anime is unknown. */
async function getEpisodeCount(anidbId) {
    const meta = await animeMeta(anidbId);
    return meta ? Number(meta.total_eps) || null : null;
}

/** AniDB main title (romaji), null when AniDB is not configured or the anime is unknown. */
async function getAnimeTitle(anidbId) {
    const meta = await animeMeta(anidbId);
    return meta && meta.title_main ? String(meta.title_main) : null;
}

async function animeMeta(anidbId) {
    if (!isAnidbConfigured()) return null;
    if (!db) throw new Error('AniDB cache not initialized');

    const cached = await db.execute('SELECT total_eps, title_main FROM anidb_anime_meta WHERE anidb_id = ?', [anidbId]);
    if (cached.rows.length > 0) return cached.rows[0];

    await loadAnime(anidbId);
    const loaded = await db.execute('SELECT total_eps, title_main FROM anidb_anime_meta WHERE anidb_id = ?', [anidbId]);
    return loaded.rows[0] || null;
}

/** Fetch and cache every regular episode once per anime; null when already attempted or unreachable. */
async function loadAnime(anidbId) {
    const meta = await db.execute('SELECT fetched_at FROM anidb_anime_meta WHERE anidb_id = ?', [anidbId]);
    if (meta.rows.length > 0) return null;

    const anime = await fetchFromAnidb(anidbId);
    if (!anime) return null;
    const { episodes, title } = anime;

    if (episodes.length > 0) {
        const stmts = episodes.map(ep => ({
            sql: 'INSERT OR IGNORE INTO anidb_episodes (anidb_id, episode_num, eid, title_en) VALUES (?, ?, ?, ?)',
            args: [anidbId, ep.epno, ep.eid, ep.titleEn || null]
        }));
        await db.batch(stmts);
    }

    await db.execute(
        "INSERT OR REPLACE INTO anidb_anime_meta (anidb_id, total_eps, title_main, fetched_at) VALUES (?, ?, ?, strftime('%s','now'))",
        [anidbId, episodes.length, title]
    );

    log('debug', `[AniDB] Cached ${episodes.length} episodes for aid=${anidbId}`);
    return episodes;
}

/**
 * Fetch anime data from AniDB HTTP API.
 * Returns { episodes, title } or null on error.
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
                resolve({ episodes, title: parseMainTitle(data) });
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
    const blockRegex = /<episode id="(\d+)"[^>]*>([\s\S]*?)<\/episode>/g;
    let match;
    while ((match = blockRegex.exec(xml || '')) !== null) {
        const inner = match[2];
        const epno = inner.match(/<epno type="1">(\d+)<\/epno>/);
        if (!epno) continue;

        const titleMatch = inner.match(/<title xml:lang="en"[^>]*>(.*?)<\/title>/);
        episodes.push({ eid: parseInt(match[1], 10), epno: parseInt(epno[1], 10), titleEn: titleMatch ? titleMatch[1] : null });
    }
    return episodes;
}

function parseMainTitle(xml) {
    const m = String(xml || '').match(/<title[^>]*type="main"[^>]*>([^<]*)<\/title>/);
    if (!m) return null;
    return m[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim() || null;
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

module.exports = { initAnidbCache, getEpisodeId, getEpisodeCount, getAnimeTitle, isAnimeCached, isAnidbConfigured, parseEpisodes, parseMainTitle };

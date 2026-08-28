'use strict';

require('dotenv').config();

/**
 * One-shot migration from the v2 single-file database into the three v2.4.0 files.
 *
 * Reads `subsense.db` through ATTACH and bulk-copies each surviving table with
 * INSERT INTO ... SELECT. The source file is only ever read, so it stays valid as the
 * rollback target. Every table is count-verified against its source and the process exits
 * nonzero on any mismatch.
 *
 *   node scripts/migrate-db.js --dry-run          report what would be copied, write nothing
 *   node scripts/migrate-db.js                    migrate into fresh target files
 *   node scripts/migrate-db.js --force            delete existing target files first
 *
 * Not copied: request_log and user_content_log, cache_stats_summary
 * (replaced by the dist table and the rotating content log), sqlite_sequence.
 */

const fs = require('fs');
const path = require('path');

const DIST_BATCH = 500;

function parseArgs(argv) {
    const args = { force: false, dryRun: false, allowLive: false, dist: 'scan', old: null };
    for (const a of argv) {
        if (a === '--force') args.force = true;
        else if (a === '--dry-run') args.dryRun = true;
        else if (a === '--allow-live') args.allowLive = true;
        else if (a.startsWith('--dist=')) args.dist = a.slice(7);
        else if (a.startsWith('--old=')) args.old = a.slice(6);
        else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`unknown argument: ${a}`);
    }
    if (!['scan', 'summary', 'none'].includes(args.dist)) {
        throw new Error(`--dist must be scan, summary or none (got ${args.dist})`);
    }
    return args;
}

const USAGE = `
Usage: node scripts/migrate-db.js [options]

  --dry-run        Count the source tables and report the plan. Writes nothing.
  --force          Delete existing target files before migrating.
  --allow-live     Required with --force when the target already carries a live worker marker.
  --old=<path>     Source database (default: DB_PATH, else ./data/subsense.db).
  --dist=<mode>    How to seed the cache composition counters:
                     scan     (default) count sources and languages from the copied rows
                     summary  copy the v2 cache_stats_summary distributions verbatim
                     none     leave the dist table empty
`;

/** Tables to copy, per target file. Columns are listed so a schema that gained columns still works. */
const PLAN = {
    stats: [
        { table: 'user_tracking', columns: ['user_id', 'languages', 'total_requests', 'movie_requests', 'series_requests', 'first_seen', 'last_active'] },
        { table: 'stats', columns: ['stat_key', 'stat_value', 'updated_at'] },
        // v2 stats_daily has no subtitles, any_pref_found, all_pref_found or unique_users columns.
        // They stay at their defaults; those series start at cutover.
        { table: 'stats_daily', columns: ['date', 'requests', 'cache_hits', 'cache_misses', 'conversions', 'movies', 'series'] },
        { table: 'provider_stats', columns: ['provider_name', 'date', 'total_requests', 'successful_requests', 'failed_requests', 'avg_response_ms', 'subtitles_returned', 'requests_with_results', 'last_success_at'] },
        { table: 'language_stats', columns: ['language_code', 'date', 'priority', 'requests_for', 'found_count', 'not_found_count'] }
    ],
    cache: [
        { table: 'subtitle_cache', columns: ['imdb_id', 'season', 'episode', 'lang_key', 'subtitles', 'created_at', 'updated_at'], ttl: true }
    ],
    meta: [
        { table: 'anidb_episodes', columns: ['anidb_id', 'episode_num', 'eid', 'title_en', 'created_at'] },
        { table: 'anidb_anime_meta', columns: ['anidb_id', 'total_eps', 'fetched_at'] },
        { table: 'at_torrent_details', columns: ['torrent_id', 'data', 'created_at'] }
    ]
};

const sqlitePath = (p) => p.replace(/\\/g, '/').replace(/'/g, "''");

async function tableExists(client, name) {
    const r = await client.execute({
        sql: "SELECT 1 FROM old.sqlite_master WHERE type = 'table' AND name = ?",
        args: [name]
    });
    return r.rows.length > 0;
}

async function countRows(client, expr) {
    const r = await client.execute(`SELECT COUNT(*) AS n FROM ${expr}`);
    return Number(r.rows[0].n) || 0;
}

/** Files a libSQL database occupies, so --force removes the WAL and shm too. */
function dbFiles(base) {
    return [base, `${base}-wal`, `${base}-shm`, `${base}-journal`];
}

function fileSizeMb(p) {
    try { return +(fs.statSync(p).size / 1048576).toFixed(1); }
    catch (_) { return null; }
}

function intEnv(name, fallback) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Matches subtitle-store's TTL. Computed here so --dry-run needs no target connection;
// the real run asserts the two agree.
const TTL_SECONDS = intEnv('L2_TTL_DAYS', 7) * 86400;

/** Counts the source tables without opening or creating any target file. */
async function dryRun(oldPath) {
    const { createClient } = require('@libsql/client');
    const c = createClient({ url: `file:${sqlitePath(oldPath)}`, intMode: 'number' });
    const rows = [];
    try {
        const present = new Set(
            (await c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map(r => r.name)
        );
        for (const specs of Object.values(PLAN)) {
            for (const spec of specs) {
                if (!present.has(spec.table)) {
                    console.log(`[migrate] ${spec.table}: absent in source, would be skipped`);
                    continue;
                }
                const total = Number((await c.execute(`SELECT COUNT(*) AS n FROM ${spec.table}`)).rows[0].n) || 0;
                const eligible = spec.ttl
                    ? Number((await c.execute(
                        `SELECT COUNT(*) AS n FROM ${spec.table} WHERE updated_at >= strftime('%s','now') - ${TTL_SECONDS}`
                    )).rows[0].n) || 0
                    : total;
                rows.push({ table: spec.table, sourceTotal: total, eligible, copied: 0, skipped: total - eligible, ms: 0, ok: true });
            }
        }
    } finally {
        try { c.close(); } catch (_) { /* already gone */ }
    }
    return rows;
}

/**
 * Refuse to overwrite a target that a worker has already written to. The marker only
 * exists once the new stack has run, which means the file is live and not a leftover.
 *
 * Probed in a child process: libSQL does not release a Windows file handle on close(), so
 * opening the file here would make the deletion below fail with EBUSY. See lessons L012.
 */
function looksLive(statsPath) {
    if (!fs.existsSync(statsPath)) return false;
    const probe = `
const { createClient } = require('@libsql/client');
(async () => {
  const c = createClient({ url: 'file:' + ${JSON.stringify(sqlitePath(statsPath))}, intMode: 'number' });
  const r = await c.execute("SELECT value FROM kv WHERE key = 'health:worker_at'");
  process.exit(r.rows.length > 0 ? 10 : 0);
})().catch(() => process.exit(0));`;
    const res = require('child_process').spawnSync(process.execPath, ['-e', probe], {
        cwd: path.join(__dirname, '..'), stdio: 'ignore', timeout: 30000
    });
    return res.status === 10;
}

async function copyTable(client, spec, ttlSeconds) {
    const cols = spec.columns.join(', ');
    const where = spec.ttl ? ` WHERE updated_at >= strftime('%s','now') - ${ttlSeconds}` : '';

    const sourceTotal = await countRows(client, `old.${spec.table}`);
    const eligible = spec.ttl
        ? await countRows(client, `old.${spec.table}${where}`)
        : sourceTotal;

    const startedAt = Date.now();
    await client.execute(
        `INSERT INTO ${spec.table} (${cols}) SELECT ${cols} FROM old.${spec.table}${where}`
    );
    const copied = await countRows(client, spec.table);

    return {
        table: spec.table,
        sourceTotal,
        eligible,
        copied,
        skipped: sourceTotal - eligible,
        ms: Date.now() - startedAt,
        ok: copied === eligible
    };
}

/** Cache composition counted from the rows that were actually migrated. Batched by rowid. */
async function distFromScan(cacheClient) {
    const counts = new Map();
    let lastRowId = 0;
    let scanned = 0;

    for (;;) {
        const r = await cacheClient.execute({
            sql: `SELECT rowid AS rid, subtitles FROM subtitle_cache
                  WHERE rowid > ? ORDER BY rowid LIMIT ${DIST_BATCH}`,
            args: [lastRowId]
        });
        if (r.rows.length === 0) break;

        for (const row of r.rows) {
            lastRowId = Number(row.rid);
            scanned++;
            let subs;
            try { subs = JSON.parse(row.subtitles || '[]'); } catch (_) { continue; }
            if (!Array.isArray(subs)) continue;
            for (const s of subs) {
                if (s && s.source) {
                    const k = `source:${s.source}`;
                    counts.set(k, (counts.get(k) || 0) + 1);
                }
                if (s && s.lang) {
                    const k = `lang:${s.lang}`;
                    counts.set(k, (counts.get(k) || 0) + 1);
                }
            }
        }
    }
    return { counts, scanned };
}

/** Cache composition as v2 last computed it. Stale whenever the summary stopped refreshing. */
async function distFromSummary(statsClient) {
    const counts = new Map();
    if (!(await tableExists(statsClient, 'cache_stats_summary'))) return { counts, scanned: 0 };

    const r = await statsClient.execute(
        'SELECT source_distribution, language_distribution FROM old.cache_stats_summary WHERE id = 1'
    );
    const row = r.rows[0];
    if (!row) return { counts, scanned: 0 };

    for (const [column, kind] of [['source_distribution', 'source'], ['language_distribution', 'lang']]) {
        let parsed;
        try { parsed = JSON.parse(row[column] || '{}'); } catch (_) { continue; }
        for (const [key, n] of Object.entries(parsed || {})) {
            const value = Number(n);
            if (Number.isFinite(value) && value > 0) counts.set(`${kind}:${key}`, value);
        }
    }
    return { counts, scanned: 0 };
}

async function writeDist(statsClient, counts) {
    if (counts.size === 0) return 0;
    const stmts = [...counts].map(([field, count]) => {
        const idx = field.indexOf(':');
        return {
            sql: `INSERT INTO dist (kind, key, count) VALUES (?, ?, ?)
                  ON CONFLICT(kind, key) DO UPDATE SET count = excluded.count`,
            args: [field.slice(0, idx), field.slice(idx + 1), count]
        };
    });
    await statsClient.batch(stmts, 'write');
    return stmts.length;
}

function reportTable(rows) {
    const head = ['table', 'source', 'eligible', 'copied', 'skipped', 'ms', ''];
    const body = rows.map(r => [
        r.table, String(r.sourceTotal), String(r.eligible), String(r.copied),
        String(r.skipped), String(r.ms), r.ok ? 'ok' : 'MISMATCH'
    ]);
    const widths = head.map((h, i) => Math.max(h.length, ...body.map(b => b[i].length)));
    const line = (cells) => '  ' + cells.map((c, i) => c.padEnd(widths[i])).join('  ');
    console.log(line(head));
    console.log('  ' + widths.map(w => '-'.repeat(w)).join('  '));
    for (const b of body) console.log(line(b));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { console.log(USAGE); return 0; }

    const oldPath = path.resolve(args.old || process.env.DB_PATH || path.join('data', 'subsense.db'));
    if (!fs.existsSync(oldPath)) {
        console.error(`[migrate] source database not found: ${oldPath}`);
        return 1;
    }

    // Read target paths without requiring infra/db yet, so the guard runs before any file is created.
    const dataDir = process.env.DB_DIR || path.join(__dirname, '..', 'data');
    const targets = {
        cache: process.env.CACHE_DB_PATH || path.join(dataDir, 'subsense-cache.db'),
        stats: process.env.STATS_DB_PATH || path.join(dataDir, 'subsense-stats.db'),
        meta: process.env.META_DB_PATH || path.join(dataDir, 'subsense-meta.db')
    };

    console.log(`[migrate] source: ${oldPath} (${fileSizeMb(oldPath)} MB)`);
    for (const [name, p] of Object.entries(targets)) {
        const mb = fileSizeMb(p);
        console.log(`[migrate] target ${name}: ${p}${mb === null ? '' : ` (exists, ${mb} MB)`}`);
    }

    if (args.dryRun) {
        console.log('\n[migrate] DRY RUN, nothing will be written\n');
        const rows = await dryRun(oldPath);
        reportTable(rows);
        console.log(`\n[migrate] subtitle_cache rows older than the ${Math.round(TTL_SECONDS / 86400)}-day L2 TTL would not be carried over.`);
        console.log('\n[migrate] dry run complete.');
        return 0;
    }

    const existing = Object.entries(targets).filter(([, p]) => fs.existsSync(p));
    if (existing.length > 0) {
        if (!args.force) {
            console.error(`\n[migrate] refusing to run: ${existing.map(([n]) => n).join(', ')} already exist.`);
            console.error('[migrate] re-run with --force to delete them first, or move them aside.');
            return 1;
        }
        if (looksLive(targets.stats) && !args.allowLive) {
            console.error('\n[migrate] refusing --force: the target stats database carries a worker heartbeat,');
            console.error('[migrate] so the new stack has already run against it. Migrating now would destroy');
            console.error('[migrate] post-cutover data. Pass --allow-live only if you are certain.');
            return 1;
        }
        for (const [name, p] of existing) {
            for (const f of dbFiles(p)) {
                try { fs.unlinkSync(f); }
                catch (err) {
                    if (err.code === 'ENOENT') continue;
                    // Continuing here would copy into the surviving file and fail on its primary
                    // keys, which reads like a data problem rather than a locked file.
                    console.error(`[migrate] cannot remove ${name} target ${f}: ${err.message}`);
                    console.error('[migrate] something still holds it open. Stop the api and worker first.');
                    return 1;
                }
            }
        }
        console.log(`[migrate] removed ${existing.length} existing target database(s)`);
    }

    const migrationStartedAt = Date.now();
    const infra = require('../src/infra/db');
    const store = require('../src/cache/subtitle-store');
    if (store.TTL_SECONDS !== TTL_SECONDS) {
        console.error(`[migrate] TTL mismatch: this script computed ${TTL_SECONDS}s, subtitle-store uses ${store.TTL_SECONDS}s.`);
        return 1;
    }
    const ttlDays = Math.round(TTL_SECONDS / 86400);

    await infra.initAll();

    const attach = `ATTACH '${sqlitePath(oldPath)}' AS old`;
    const results = [];
    let failures = 0;

    for (const [name, specs] of Object.entries(PLAN)) {
        const client = infra.clients[name];
        await client.execute(attach);
        try {
            for (const spec of specs) {
                if (!(await tableExists(client, spec.table))) {
                    console.log(`[migrate] ${spec.table}: absent in source, skipped`);
                    continue;
                }
                const r = await copyTable(client, spec, TTL_SECONDS);
                if (!r.ok) failures++;
                results.push(r);
            }
        } finally {
            await client.execute('DETACH old');
        }
    }

    console.log('');
    reportTable(results);
    console.log(`\n[migrate] subtitle_cache rows older than the ${ttlDays}-day L2 TTL are not carried over.`);

    if (args.dist !== 'none') {
        const startedAt = Date.now();
        let seed;
        if (args.dist === 'scan') {
            seed = await distFromScan(infra.clients.cache);
        } else {
            await infra.clients.stats.execute(attach);
            try { seed = await distFromSummary(infra.clients.stats); }
            finally { await infra.clients.stats.execute('DETACH old'); }
        }
        const written = await writeDist(infra.clients.stats, seed.counts);
        const how = args.dist === 'scan'
            ? `scanned ${seed.scanned} migrated rows`
            : 'copied from v2 cache_stats_summary';
        console.log(`[migrate] dist: ${written} counters seeded (${how}) in ${Date.now() - startedAt} ms`);
    }

    for (const [name, client] of Object.entries(infra.clients)) {
        try { await client.execute('PRAGMA wal_checkpoint(TRUNCATE)'); }
        catch (err) { console.log(`[migrate] ${name} checkpoint skipped: ${err.message}`); }
    }

    infra.close();

    const elapsedS = ((Date.now() - migrationStartedAt) / 1000).toFixed(1);
    if (failures > 0) {
        console.error(`\n[migrate] FAILED after ${elapsedS}s: ${failures} table(s) copied a different number of rows than the source held.`);
        return 1;
    }
    console.log(`\n[migrate] complete in ${elapsedS}s, all tables count-verified.`);
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error(`[migrate] failed: ${err.stack || err.message}`);
        process.exit(1);
    });

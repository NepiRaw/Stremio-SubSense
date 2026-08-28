# SubSense Architecture & Low-Level Design

This document provides a complete technical overview of the SubSense Stremio addon. It explains how the addon works, the data flow, component interactions, and implementation details.

---

## Table of Contents

1. [Overview](#1-overview)
2. [System Architecture](#2-system-architecture)
3. [Core Components](#3-core-components)
4. [Request Flow](#4-request-flow)
5. [Configuration System](#5-configuration-system)
6. [Manifest Generation](#6-manifest-generation)
7. [Subtitle Fetching](#7-subtitle-fetching)
8. [Caching System](#8-caching-system)
9. [Statistics & Analytics](#9-statistics--analytics)
10. [Frontend Configuration UI](#10-frontend-configuration-ui)
11. [API Endpoints](#11-api-endpoints)
12. [Environment Variables](#12-environment-variables)
13. [File Structure](#13-file-structure)

---

## 1. Overview

**SubSense** is a Stremio addon that aggregates subtitles from multiple sources and serves them to Stremio clients. Key features:

- **Multi-source aggregation**: Uses multiple providers including Wyzie API (OpenSubtitles, Subf2m, Kitsunekko, Gestdown, YIFY, TVsubtitles), BetaSeries, YIFY, TVsubtitles, OpenSubtitles (direct), and Gestdown (direct)
- **Multi-language support**: Up to 5 languages with equal priority
- **Dual format support**: ASS subtitles converted to VTT (with styling) + SRT (fallback)
- **Configurable limits**: User-selectable max subtitles per language
- **Two-tier caching**: Redis for the hot path, SQLite for durability and cold start
- **Statistics dashboard**: analytics aggregated at write time, never by scanning serving data
- **Three-process architecture**: API cluster + maintenance worker + Redis

### Technology Stack

| Component | Technology |
|-----------|------------|
| Backend Runtime | Node.js 20+ |
| Web Framework | Express.js |
| Subtitle Sources | Wyzie API (sub.wyzie.io) and 8 direct providers |
| Hot cache and delta buffer | Redis 7.2 (`ioredis`), `volatile-lru` |
| Durable storage | SQLite (LibSQL via `@libsql/client`), three files |
| Process model | Node `cluster`, `WEB_CONCURRENCY` request workers |
| Deployment | Docker Compose (api + worker + redis) |
| Frontend | Vanilla HTML/CSS/JS |

### Design rules

Every change is reviewed against these. They exist because each one maps to an outage the addon
actually had:

1. **Bounded by construction**: no query without a `LIMIT`, no background loop without a time budget. A job does what fits in its budget, logs what it left, and returns.
2. **Separate lock domains**: serving, analytics and provider metadata are different SQLite files, so an analytics query can never hold the subtitle lock.
3. **Aggregate at write time**: anything countable is incremented when it happens and folded into rollup tables later. Reading a statistic never scans.
4. **Drop, do not delete**: time-series retention is a whole-table `DELETE FROM` against a rotating table, never a row-walking delete over a backlog.
5. **Loud when idle**: throughput, event-loop lag and worker heartbeat are always exported, so serving nothing is a visible state rather than a silent one.

---

## 2. System Architecture

```
                          Stremio clients
                                 │
                        any reverse proxy
                                 │
                                 ▼
┌───────────────────────────────────────────────────────────────────────┐
│  API container (server.js)                                            │
│  cluster primary  ──forks──►  worker 1 │ worker 2 │ worker 3          │
│  The primary opens no databases and serves no traffic. It forks,      │
│  replaces any worker that dies, and relays SIGTERM.                   │
│                                                                       │
│  Each request worker mounts:                                          │
│    routes/stremio.js      manifest + subtitle search                  │
│    routes/proxy.js        format conversion and provider proxies      │
│    routes/health.js       /health, /health/deep, /metrics             │
│    routes/stats-api.js    /stats data                                 │
│    routes/config-api.js   /api/config, /api/version                   │
└───────────────────────────────────────────────────────────────────────┘
        │                    │                        │
        │ hot path           │ durable                │ upstream
        ▼                    ▼                        ▼
┌───────────────┐   ┌──────────────────┐   ┌──────────────────────────┐
│ Redis 7.2     │   │ cache.db   (L2)  │   │ Cloudflare WARP          │
│ maxmemory 4gb │   │ stats.db         │   │ SOCKS5 127.0.0.1:40000   │
│ volatile-lru  │   │ meta.db          │   │        │                 │
│               │   │                  │   │        ▼                 │
│ L1 responses  │   │ separate lock    │   │  9 subtitle providers    │
│ delta buffers │   │ domains          │   └──────────────────────────┘
│ inflight lock │   └──────────────────┘
│ rate limits   │            ▲
└───────────────┘            │ sole scheduled writer
        ▲                    │
        │                    │
┌───────┴────────────────────┴──────────────────────────────────────────┐
│  Worker container (worker.js)                                         │
│  8 budgeted jobs, each with a deadline it reports against:            │
│    drain-content-log  10s   fold-analytics   60s   flush-users   60s  │
│    cleanup-cache       2h   checkpoint       30m   prune-users    6h  │
│    prune-meta         24h   heartbeat        60s                      │
│  No HTTP listener, and deliberately not on the routable network.      │
└───────────────────────────────────────────────────────────────────────┘
```

**Why three processes.** The API cluster uses the cores; a single Node process was saturating one core at peak. The maintenance worker is the only scheduled writer to SQLite, so background work can never contend with serving. Redis holds everything the request path needs, so a cache hit touches no disk and makes no upstream call.

**What happens when Redis is down.** Serving continues from SQLite: the addon degrades rather than failing. Analytics stop being recorded, `/health/deep` reports `redis`, and the request path keeps answering. Redis is a cache and a delta buffer, never a source of truth.

---

## 3. Core Components

### 3.1 Entry Points

| File | Purpose |
|------|---------|
| `server.js` | Cluster primary and request workers. Forks `WEB_CONCURRENCY` workers, reforks on death, relays shutdown signals |
| `worker.js` | Maintenance worker: 8 budgeted jobs, the only scheduled writer to the databases |
| `manifest.js` | Manifest generation with dynamic descriptions |
| `scripts/migrate-db.js` | One-shot v2 to v2.4.0 migration. Reads the old file, never writes it |

### 3.2 Route Layer (src/routes/)

| File | Purpose |
|------|---------|
| `index.js` | Exports all route modules |
| `stremio.js` | Stremio manifest and subtitle routes with config parsing |
| `proxy.js` | Subtitle format conversion and provider-specific proxies |
| `health.js` | Health check endpoint |
| `config-api.js` | Config/version API endpoints |
| `stats-api.js` | Stats and cache browsing API endpoints |

### 3.3 Handlers (src/handlers/)

| File | Purpose |
|------|---------|
| `subtitles.js` | Main subtitle request handler, response cache warmup |

### 3.4 Source Files (src/)

| File | Purpose |
|------|---------|
| `config.js` | Parse and validate user configuration |
| `languages.js` | Language code mapping (ISO 639-1 ↔ ISO 639-2/B) |
| `utils.js` | Logging and utility functions |
| `health.js` | Deep health probe: every dependency checked concurrently under its own timeout |

### 3.5 Providers (src/providers/)

| File | Purpose |
|------|---------|
| `BaseProvider.js` | Abstract base class for providers |
| `ProviderManager.js` | Provider registry and orchestration |
| `WyzieProvider.js` | Wyzie API integration, key pool |
| `BetaSeriesProvider.js` | BetaSeries API integration for French/English subtitles |
| `SubSourceProvider.js` | SubSource.net API integration (user API key required) |
| `YIFYProvider.js` | YIFY/YTS subtitle provider (movies only) |
| `TVsubtitlesProvider.js` | TVsubtitles.net provider (TV series only) |
| `OpenSubtitlesProvider.js` | Direct OpenSubtitles Legacy API (movies + TV, no key needed) |
| `GestdownProvider.js` | Gestdown REST API for TV subtitles (TVDB/TMDB ID resolution) |
| `index.js` | Provider registration and exports |

### 3.6 Cache (src/cache/)

| File | Purpose |
|------|---------|
| `response-cache.js` | L1 built responses in Redis, shared by every cluster worker |
| `subtitle-store.js` | L2 subtitle cache on `cache.db`. Cold start and durability behind L1 |
| `inflight.js` | Cross-process request dedup via a Redis `SET NX EX` lock |
| `InflightCache.js` | In-process promise dedup, used by the provider manager |


### 3.7 Stats (src/stats/)

| File | Purpose |
|------|---------|
| `index.js` | Stats entry point. One mode; `STATS_ENABLED=false` switches recording off |
| `track.js` | Request-path recording. Plain in-memory counters flushed to Redis every 5s |
| `fold.js` | Worker-side folding of Redis deltas into rollup tables, idempotently |
| `content-log.js` | Seven-day rotating content log, one table per weekday |
| `stats-db.js` | Readers backed by rollup tables, plus user tracking |
| `stats-service.js` | Assembles the `/stats` payload |
| `schema.js` | The v2 schema, kept only for the migration to read |

### 3.8 Utilities (src/utils/)

| File | Purpose |
|------|---------|
| `validators.js` | Input validation (IMDB IDs, languages, pagination) |
| `crypto.js` | AES-256-GCM encryption for user API keys |
| `encoding.js` | Character encoding detection and conversion |
| `filenameMatcher.js` | Subtitle-to-video filename matching logic |
| `format.js` | Subtitle formatting and prioritization for Stremio |
| `archive.js` | ZIP archive extraction utilities |
| `subtitle-converter.js` | ASS/SSA to VTT/SRT conversion with styling preservation |
### 3.9 Infrastructure (src/infra/)

| File | Purpose |
|------|---------|
| `db.js` | The three SQLite files, their DDL, pragmas and `kv` markers |
| `redis.js` | Shared connection. Fails fast while disconnected so callers fall back |
| `metrics.js` | Event-loop lag histogram, request rate, hit split, per-provider latency |
| `rate-limit.js` | Upstream rate limits reserved in Redis, so N workers do not multiply them |

### 3.10 Jobs (src/jobs/)

| File | Purpose |
|------|---------|
| `scheduler.js` | Budgeted job runner. A slow run cannot overlap itself; each job gets a deadline |
| `cleanup-cache.js` | L2 retention, batched, decrementing composition counters as it goes |
| `prune-meta.js` | Retention for the provider metadata caches |

---

## 4. Request Flow

### 4.0 Route Architecture (Express Routing)

SubSense uses a single Express router defined in `src/routes/stremio.js`. All Stremio protocol routes go through `parseConfigParam()` which handles:

1. **UserID extraction**: Regex `^([a-z0-9]{8})-(.+)$` splits the URL parameter into an 8-char userId and the config payload.
2. **Config decoding** (tried in order):
   - URL-decoded JSON (modern client-side encoded config)
   - Base64 JSON (legacy format)
   - AES-256-GCM encrypted blob (when encryption is configured)
3. **Fallback**: Empty config object `{}` if all decoding fails.

**Routes:**
```
GET /manifest.json                                    → Base manifest (no config)
GET /:config/manifest.json                            → Configured manifest
GET /:config/subtitles/:type/:id/:extra?.json         → Subtitle search
```

**Extra Parameter:** The optional `:extra?` carries video metadata from Stremio (filename, videoSize, videoHash) used to improve subtitle matching accuracy. Required for cross-platform compatibility.

---

### 4.1 Subtitle Request Flow

When Stremio requests subtitles:

```
1. Stremio Client sends request:
   GET /{userId}-{config}/subtitles/{type}/{id}/filename=video.mp4&videoSize=123456&videoHash=abc123.json

2. src/routes/stremio.js receives request:
   - parseConfigParam() extracts userId and config
   - Tries URL-decoded JSON → base64 JSON → encrypted decrypt
   - parseConfig() validates languages, maxSubtitles
   - Passes to handleSubtitlesRequest()

3. src/handlers/subtitles.js:
   a. metrics.recordRequest()
   b. Parse Stremio ID (imdbId, season, episode)
   c. Convert 3-letter to Wyzie-mapped 2-letter language codes (eng -> en)
   d. GET the L1 key from Redis

4. If L1 HIT (89% of traffic on production):
   - Materialize and return. Zero SQLite reads, zero upstream HTTP
   - If older than L1_STALE_AFTER_HOURS, kick a background refresh behind a Redis lock

5. If L1 MISS, read L2 (cache.db, 0.2 ms p50):
   - On hit, write back to L1 and return

6. If FULL MISS:
   - SET ss:lock NX EX to dedup across cluster workers
   - ProviderManager.searchAll() fans out to every registered provider
   - Returns at the soft deadline (PROVIDER_DEADLINE_MS, 8s); stragglers keep running
     in the background and warm the cache when they land

7. Format results:
   - prioritizeByLanguage() groups and sorts by quality
   - formatForStremio() generates dual VTT+SRT entries for ASS subs
   - Apply maxSubtitles limit per language

8. Store in L1 and L2, return response:
   { subtitles: [{ id, url, lang, label, source }, ...] }
```

### 4.2 Manifest Request Flow

```
1. Stremio/User requests manifest:
   GET /{userId}-{config}/manifest.json

2. src/routes/stremio.js:
   - parseConfigParam() extracts userId and config
   - generateManifest(config) creates manifest with dynamic description
   - If languages configured: removes configurationRequired hint
   - Logs: [Manifest] {userId} langs=[...] maxSubs=... url=...

3. Return manifest JSON
```

### 4.3 Subtitle Proxy Flow

When Stremio fetches an actual subtitle file:

```
1. Stremio requests:
   GET /api/subtitle/{format}/{originalUrl}

2. src/routes/proxy.js:
   - Fetch original subtitle from source

3. If format=ass:
   - Pass through as-is (no conversion)

4. If format=vtt and content is ASS:
   - Convert ASS to VTT using subtitle-converter
   - Preserves styling (italic, bold, underline)

5. If format=srt and content is ASS:
   - Convert ASS to SRT using subtitle-converter
   - Styling is lost (SRT doesn't support it)

6. Return subtitle content with appropriate Content-Type
```

---

## 5. Configuration System

### 5.1 Config Structure

```javascript
{
  languages: ['eng', 'fra', 'spa'],  // ISO 639-2/B codes
  maxSubtitles: 10,                   // 0 = unlimited
  userId: 'abc12345'                  // 8-char session ID
}
```

### 5.2 URL Encoding

The config is JSON-encoded in the manifest URL. Three encoding methods are supported:

```
1. URL-encoded JSON:
   /abc12def-%7B%22languages%22%3A%5B%22eng%22%5D%7D/manifest.json

2. Base64 JSON (legacy):
   /abc12def-eyJsYW5ndWFnZXMiOlsiZW5nIl19/manifest.json

3. AES-256-GCM encrypted (when SUBSENSE_ENCRYPTION_KEY is set):
   /abc12def-SegHXxPyNSWKl.../manifest.json
```

### 5.3 Validation (src/config.js)

```javascript
parseConfig(config) {
  - Supports legacy format: { primaryLang, secondaryLang }
  - Supports new format: { languages: [...], maxSubtitles: N }
  - Validates language codes against known list
  - Enforces MAX_LANGUAGES = 5
  - Caps maxSubtitles at 100
  - Throws error if no valid languages
}
```

---

## 6. Manifest Generation

### 6.1 Base Manifest (manifest.js)

```javascript
{
  id: 'com.subsense.nepiraw',
  version: '2.0.0',  // from package.json
  name: 'SubSense',
  description: 'Dynamic based on config',
  logo: 'https://i.imgur.com/FaDbQAp.png',
  background: '...',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: {
    configurable: true,
    configurationRequired: true 
  }
}
```

### 6.2 Dynamic Description

```javascript
generateDescription(config) {
  // No languages: Generic description
  // 1 language: "Get subtitles in English from multiple sources."
  // 2 languages: "Get subtitles in English and French from multiple sources."
  // 3+ languages: "Get subtitles in English, French and Spanish from multiple sources."
}
```

---

## 7. Subtitle Fetching

### 7.1 Subtitle Providers

Located in `src/providers/`

**WyzieProvider** (`WyzieProvider.js`):
Uses the Wyzie API (sub.wyzie.io) to aggregate from multiple sources:
- OpenSubtitles (free)
- TVsubtitles (free)
- Subf2m (paid)
- Kitsunekko (paid)
- Gestdown (paid)
- YIFY (paid)

Features a key pool with automatic rotation (`WYZIE_API_KEYS`), dynamic source discovery from `/sources` endpoint.

**BetaSeriesProvider** (`BetaSeriesProvider.js`):
- French TV/Movie tracking service with subtitle support
- Good coverage for French (vf) and English (vo) subtitles
- Requires API key (BETASERIES_API_KEY)
- Supports shows via IMDB/TVDB ID lookup
- Handles ZIP extraction for bundled subtitles

**YIFYProvider** (`YIFYProvider.js`):
- YIFY/YTS subtitle provider
- Supports **movies only** (40+ languages)
- Fetches from yts-subs.com
- Handles Base64-encoded download links

**TVsubtitlesProvider** (`TVsubtitlesProvider.js`):
- TVsubtitles.net provider
- Supports **TV series only** (40+ languages)
- Uses Cinemeta for title lookup
- Parses HTML pages for subtitle links

**SubSourceProvider** (`SubSourceProvider.js`):
- SubSource.net API integration
- Requires user-provided API key (encrypted)
- Supports both movies and TV series
- Returns ZIP archives containing subtitle files

**SubSource Episode Filtering:**
SubSource API returns ALL subtitles for a movie/show without episode pre-filtering. SubSense implements two layers of filtering:

1. **Pre-filtering at search time** (`_shouldIncludeSubtitle()`):
   - Excludes clear episode mismatches based on `releaseInfo` patterns
   - Conservative approach: only excludes when SURE it's wrong
   - Patterns detected: `S01E13`, `E13`, `Ep13`, episode ranges like `S01E01-E12`
   - Supports 4-digit episodes for anime (e.g., One Piece E1050)
   - Season packs without episode numbers pass through (proxy handles)

2. **Proxy validation at download time** (proxy.js):
   - For single-file ZIPs: validates episode pattern in filename
   - Returns 404 if file episode doesn't match requested episode
   - Multi-file ZIPs: selects correct file using episode matching logic

### 7.2 Provider Manager

`ProviderManager.js` orchestrates all registered providers:
- Registers providers at startup via `registerDefaultProviders()`
- `searchAll()` races all providers against a deadline
- Deduplicates results across providers
- Tracks per-provider statistics (success, errors, timeouts)

### 7.3 Dual Format (VTT + SRT)

When an ASS subtitle is found:

```javascript
formatForStremio(subtitles) {
  for (sub of subtitles) {
    if (isAss) {
      // Entry 1: VTT with styling preserved (italic, bold, underline)
      results.push({
        id: 'subsense-0-{subId}-vtt-{source}',
        url: '/api/subtitle/vtt/{originalUrl}'
      });

      // Entry 2: SRT fallback (plain text, no styling)
      results.push({
        id: 'subsense-1-{subId}-srt-{source}',
        url: '/api/subtitle/srt/{originalUrl}'
      });
    }
  }
}
```

---

## 8. Caching System

Two tiers plus a byte-capped body cache. Redis absorbs the traffic; SQLite provides durability and
cold start. All SQLite access uses LibSQL (`@libsql/client`) with async/await.

### 8.1 L1: Redis response cache

`src/cache/response-cache.js`

- Holds fully built responses, so a hit is a single `GET` and a materialize step
- **Shared by every cluster worker**, so one worker's miss warms the others
- TTL `L1_TTL_HOURS` (6). Entries older than `L1_STALE_AFTER_HOURS` (2) are served immediately and   refreshed in the background
- Keys use Wyzie-mapped language codes (`eng` becomes `en`). Map before building a key by hand
- Evicted under memory pressure by `volatile-lru`, which is safe: L2 can always rebuild it

### 8.2 Inflight dedup

`src/cache/inflight.js` takes a Redis `SET NX EX` lock so that three cluster workers receiving the same cold request produce one provider fan-out instead of three. `InflightCache.js` still handles in-process promise sharing inside a single worker.

### 8.3 L2: Subtitle cache (cache.db)

`src/cache/subtitle-store.js`

- Keyed by `imdb_id + season + episode + lang_key`, where `lang_key` is the sorted language list
- TTL `L2_TTL_DAYS` (7), enforced by the worker's cleanup job
- Reads are 0.2 ms p50 on production hardware, and only happen on an L1 miss
- Writes from the request path are fire-and-forget: the response never waits for them

### 8.4 Proxy body cache

`src/routes/proxy.js` keeps converted subtitle bodies in memory, capped by `PROXY_CACHE_MAX_BYTES` (256 MB). Bodies are large and refetchable, so they stay per-worker rather than going in Redis. 
They are Buffers, so they live outside the V8 heap limit.

### 8.5 The three SQLite files

Separate files mean separate lock domains, which is why an analytics query can no longer block serving:

| File | Holds | Written by |
|------|-------|------------|
| `subsense-cache.db` | `subtitle_cache` | API (fire-and-forget) and the cleanup job |
| `subsense-stats.db` | rollups, `user_tracking`, rotating content log, `kv` markers | worker only |
| `subsense-meta.db` | AniDB and AnimeTosho metadata caches | API and the prune job |

All three run `journal_mode=WAL` and `auto_vacuum=INCREMENTAL`. `busy_timeout` is applied as the **first** pragma on every connection: applied later it cannot protect the statements that race during a concurrent cluster boot, which killed two of three workers before it was fixed.

### 8.6 Maintenance worker (worker.js)

Every job runs under a time budget and reports what it left behind, so a backlog is drained across ticks instead of in one unbounded pass.

| Job | Interval | Budget | Purpose |
|-----|----------|--------|---------|
| `drain-content-log` | 10s | 200 ms | Move queued content rows from Redis into today's table |
| `fold-analytics` | 60s | 500 ms | Fold Redis delta hashes into the rollup tables |
| `flush-users` | 60s | 500 ms | Apply buffered per-user counters to `user_tracking` |
| `cleanup-cache` | 2h | 2s | L2 retention, decrementing composition counters as it deletes |
| `checkpoint` | 30m | none | WAL checkpoint: TRUNCATE on stats and meta, PASSIVE on cache |
| `prune-users` | 6h | 500 ms | Drop inactive users |
| `prune-meta` | 24h | 1s | Retention for the provider metadata caches |
| `heartbeat` | 60s | none | Write the health snapshot and the `kv` liveness markers |

### 8.7 Rotating content log

Per-user viewing history lives in seven tables, one per weekday. Expiring a day is a whole-table `DELETE FROM` performed before the table is reused, which costs the same whether it holds a thousand rows or a million. The alternative, walking a backlog with a row-by-row delete, is much slower. Reads `UNION ALL` the seven tables, measured at 0.35 ms p50 for per-user history.

Rotating tables deliberately declare no foreign keys, and `db.rotationTablesWithForeignKeys()` asserts that at startup, because an FK would reintroduce per-row work on the delete.

---

## 9. Statistics & Analytics

> Recording can be switched off entirely with `STATS_ENABLED=false`. There are no other modes:
> the old `STATS_REFRESH_INTERVAL` was removed in v2.4.0.

### 9.1 How a statistic travels

```
request path            every 5s              every 60s            /stats reads
─────────────           ────────              ─────────            ────────────
track.counter()   ──►   one Redis     ──►     worker folds   ──►   SELECT from
in-memory buffer        pipeline              into rollups         rollup tables
(no await, no I/O)      (HINCRBY etc)         (additive)           (no scan)
```

Folding is additive and reads-then-clears each hash in one transaction, so a fold can be repeated or interrupted without rewriting history downward. The cost of a crash between the clear and the write is one interval of analytics, never serving data.

If Redis is down, buffers keep filling to a cap and then shed, so analytics degrade while serving continues unaffected.

### 9.2 Stats module (src/stats/)

- `track.js`, request-path recording, buffered, never awaited
- `fold.js`, worker-side folding, idempotent
- `content-log.js`, the rotating seven-day log
- `stats-db.js`, readers, all backed by rollup tables
- `stats-service.js`, assembles the `/stats` payload

Tracked: total requests, movie/series split, cache hit and miss, provider latency and yield, language availability, daily volumes, unique users per day, and cache composition by source and language.

### 9.4 Stats API endpoints

| Endpoint | Data |
|----------|------|
| `/api/config` | `{statsEnabled, version}`, always available |
| `/api/stats/cache` | Cache entries, hit rate, size |
| `/api/stats/providers` | Per-provider performance |
| `/api/stats/languages` | Language stats |
| `/api/stats/daily` | Daily aggregates |
| `/api/cache/search` | Search by IMDB id |
| `/api/cache/list` | List cached content |
| `/stats/json` | Runtime stats |

---

## 10. Frontend Configuration UI

### 10.1 Configure Page (/configure)

**File**: `public/index.html` + `public/js/configure.js`

**Features**:
- Multi-select language dropdown (up to 5)
- Max subtitles per language selector
- English pre-selected for new users
- Toggle behavior (click selected to deselect)
- Install button with loading animation
- Copy manifest URL option

**State Management**:
```javascript
// LocalStorage keys:
- 'subsense_selected_languages' → ['eng', 'fra']
- 'subsense_max_subtitles' → 10

// On install:
const config = { languages, maxSubtitles };
const userId = generateUserId();  // 8-char random
const url = `stremio://{host}/{userId}-{encodedConfig}/manifest.json`;
window.location.href = url;
```

### 10.2 Stats Dashboard (/stats)

**File**: `public/stats.html` + `public/js/stats.js`

- Real-time metrics with auto-refresh
- Cache performance charts
- Provider breakdown
- Language statistics
- Active sessions count

### 10.3 Cache Browser (/stats/content)

**File**: `public/content.html` + `public/js/content.js`

- Search by IMDB ID
- Browse cached content
- View subtitle details per content

---

## 11. API Endpoints

### 11.1 Stremio Addon Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/manifest.json` | GET | Base manifest |
| `/:config/manifest.json` | GET | Configured manifest |
| `/:config/subtitles/:type/:id/:extra?.json` | GET | Subtitle search |

### 11.2 Proxy Routes

#### 11.2.1 Format Conversion Proxies

These proxies convert subtitle formats (ASS → VTT/SRT) and serve them to Stremio:

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/subtitle/vtt/*` | GET | Convert ASS to VTT (preserves styling) |
| `/api/subtitle/srt/*` | GET | Convert ASS to SRT (plain text) |
| `/api/subtitle/ass/*` | GET | Passthrough ASS (no conversion) |

The `*` path is the original subtitle URL (URL-encoded).

#### 11.2.2 Provider-Specific Proxies

Some providers require server-side processing (ZIP extraction, auth, scraping):

| Provider | Route | Parameters | Purpose |
|----------|-------|------------|---------|
| **SubSource** | `/api/subsource/proxy/:subtitleId` | `key` (required), `episode`, `season` | Downloads ZIP, extracts correct episode file |
| **BetaSeries** | `/api/betaseries/proxy/:subtitleId` | `lang` (optional) | Fetches subtitle from BetaSeries CDN |
| **YIFY** | `/api/yify/proxy/:subtitleId` | None | Scrapes yts-subs.com for download link |
| **TVsubtitles** | `/api/tvsubtitles/proxy/:subtitleId` | `episodeUrl`, `lang` | Scrapes tvsubtitles.net for download |
| **OpenSubtitles** | `/api/opensubtitles/proxy/:subtitleId` | `url` (required) | Downloads from OpenSubtitles, passes through as-is (SRT) |
| **Gestdown** | `/api/gestdown/proxy/:subtitleId` | none | Downloads SRT from Gestdown, passes through as-is |

#### 11.2.3 Subtitle URL Formats

When subtitles are returned to Stremio, they use different URL formats:

```
# Direct URL (no proxy needed - wyzie sources)
https://dl.opensubtitles.org/download/...

# Format conversion proxy (ASS → VTT/SRT)
/api/subtitle/vtt/{encoded-original-url}

# Provider proxy (ZIP extraction, scraping)
/api/subsource/proxy/2607183?key=xxx&episode=2&season=1
/api/betaseries/proxy/12345?lang=vo
/api/yify/proxy/movie-name-subtitle-id
/api/tvsubtitles/proxy/12345?episodeUrl=xxx
/api/opensubtitles/proxy/1951877389?url=https%3A%2F%2Fdl.opensubtitles.org%2F...
/api/gestdown/proxy/abc123-uuid
```

**Subtitle ID format visible to users:**
```
subsense-{index}-{originalId}-{format}-{source}
Example: subsense-0-2607183-vtt-subsource
```

### 11.3 Health and metrics

| Route | Cost | Purpose |
|-------|------|---------|
| `/health` | In-process only, no I/O | The Docker healthcheck. Answers whether this process can serve |
| `/health/deep` | Queries every dependency | For an uptime monitor. 200 when clean, 503 when degraded |
| `/metrics` | In-process only | Request rate, event-loop lag, cache hit rate, per-provider latency |
| `/health/cache` | Redis + in-process | L1 and proxy cache figures |
| `/health/providers` | In-process | Per-provider counters |

`/health/deep` returns a `degraded` array naming each problem: `db:cache`, `db:stats`, `db:meta`, `redis`, `queue-depth`, `worker-heartbeat`, `fold-stale`. Every probe runs concurrently under `HEALTH_DB_TIMEOUT_MS`, so a wedged dependency cannot hold the endpoint open.


The worker heartbeat and last fold time are read from `kv` markers in `stats.db`, not from Redis, so a Redis outage reports `redis` alone instead of also claiming the worker is dead.

Process-level fields (`pid`, `uptimeSeconds`, `requestsPerMinute`, `eventLoopP99Ms`, `rssMb`) describe whichever cluster worker answered the probe. Dependency fields are shared.

### 11.4 Stats API

> **Note:** All stats endpoints except `/api/config` return 403 when `STATS_ENABLED=false`.

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/config` | GET | Returns `{statsEnabled, version}` - always available |
| `/api/version` | GET | Package version |
| `/api/stats/cache` | GET | Cache statistics |
| `/api/stats/providers` | GET | Provider metrics |
| `/api/stats/languages` | GET | Language stats |
| `/api/stats/daily` | GET | Daily aggregates |
| `/api/cache/search` | GET | Search by IMDB |
| `/api/cache/list` | GET | List cached content |
| `/stats/json` | GET | Runtime stats |

### 11.5 Static Routes

| Route | Purpose |
|-------|---------|
| `/configure` | Configuration UI |
| `/stats` | Statistics dashboard |
| `/stats/content` | Cache browser |

---

## 12. Environment Variables

Every variable has a default in code. Only `SUBSENSE_ENCRYPTION_KEY` and `WYZIE_API_KEYS` are genuinely required.

### 12.1 Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3100 | Server port |
| `HOST` | 127.0.0.1 | Bind address. Set to `0.0.0.0` in containers |
| `SUBSENSE_BASE_URL` | `http://127.0.0.1:{PORT}` | Public URL used in proxied subtitle links |
| `LOG_LEVEL` | info | `debug`, `info`, `warn`, `error` |
| `SUBSENSE_ENCRYPTION_KEY` | none | **Required.** AES-256-GCM key for user API keys. 64-char hex or a passphrase (PBKDF2-derived) |
| `SHUTDOWN_TIMEOUT_MS` | 10000 | Force-exit deadline after SIGTERM |

### 12.2 Cluster

| Variable | Default | Description |
|----------|---------|-------------|
| `WEB_CONCURRENCY` | 1 | Request workers to fork. `auto` uses CPU count minus one. Production runs 3 |
| `REFORK_DELAY_MS` | 1000 | Delay before replacing a worker that died |


### 12.3 Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_DIR` | `./data` | Directory holding the three database files |
| `CACHE_DB_PATH` | `{DB_DIR}/subsense-cache.db` | Subtitle cache |
| `STATS_DB_PATH` | `{DB_DIR}/subsense-stats.db` | Analytics, user tracking, content log |
| `META_DB_PATH` | `{DB_DIR}/subsense-meta.db` | Provider metadata caches |
| `L2_TTL_DAYS` | 7 | Subtitle cache retention |
| `META_TTL_ANIDB_DAYS` | 30 | AniDB metadata retention |
| `META_TTL_AT_DAYS` | 30 | AnimeTosho detail retention |

### 12.4 Redis

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://127.0.0.1:6379` | Connection string |
| `REDIS_COMMAND_TIMEOUT_MS` | 250 | Per-command timeout. Commands fail fast so callers fall back |
| `L1_TTL_HOURS` | 6 | Response cache TTL |
| `L1_STALE_AFTER_HOURS` | 2 | Age at which a hit is still served but refreshed in the background |
| `TRACK_FLUSH_MS` | 5000 | How often buffered counters are pipelined to Redis |
| `TRACK_CONTENT_ROW_CAP` | 10000 | Per-flush cap on buffered content rows |
| `CL_QUEUE_MAX` | 50000 | Content-log queue depth at which new rows are shed |

Redis itself is configured on the container command line, not by the app:
`--maxmemory 4gb --maxmemory-policy volatile-lru --save 300 100 --appendonly no`. The eviction policy is deliberate: TTL-bearing cache keys are evictable, while the no-TTL counter hash and the content-log queue survive memory pressure.

### 12.5 Providers

| Variable | Default | Description |
|----------|---------|-------------|
| `SUBTITLE_SOURCES` | all | Comma-separated provider list |
| `WYZIE_API_KEYS` | none | **Required** for the Wyzie provider. Comma-separated for pool rotation |
| `WYZIE_SOURCES` | all | Override the Wyzie sub-sources queried |
| `WYZIE_POOL_MAX` | none | Cap on concurrent Wyzie key usage |
| `WYZIE_VALIDATE_TIMEOUT_MS` | 3000 | URL validation timeout, at cache-write time only |
| `WYZIE_VALIDATE_MEMO_TTL_S` | none | How long a validated URL verdict is remembered |
| `BETASERIES_API_KEY` | none | Enables BetaSeries |
| `TVDB_API_KEY` / `TMDB_API_KEY` | none | IMDB to TVDB resolution for Gestdown |
| `ANIDB_CLIENT` / `ANIDB_CLIENT_VER` | none | Required for AnimeTosho TV episode search |
| `PROVIDER_DEADLINE_MS` | 8000 | Soft fan-out deadline. **A product constraint, not a tuning knob** |
| `PROXY_CACHE_MAX_BYTES` | 268435456 | Byte cap on the in-memory subtitle body cache |
| `PROXY_CACHE_TTL_HOURS` | 24 | Body cache TTL |
| `WARP_ENABLED` | false | Start Cloudflare WARP and expose a SOCKS5 proxy on 40000 |

### 12.6 Statistics

| Variable | Default | Description |
|----------|---------|-------------|
| `STATS_ENABLED` | true | Set to `false` to switch off all recording |

With `STATS_ENABLED=false`, `/api/config` stops returning `userStats`, so the active and total user counts disappear from `/configure` as well. v2's `minimal` mode existed to keep those counts while disabling the expensive parts; there is no equivalent setting now because the expensive parts are gone.

### 12.7 Worker

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_DRAIN_INTERVAL_MS` | 10000 | Content-log drain |
| `WORKER_FOLD_INTERVAL_MS` | 60000 | Analytics fold |
| `WORKER_USERS_INTERVAL_MS` | 60000 | User counter flush |
| `WORKER_CLEANUP_INTERVAL_MS` | 7200000 | L2 cache cleanup |
| `WORKER_CHECKPOINT_INTERVAL_MS` | 1800000 | WAL checkpoint |
| `WORKER_PRUNE_USERS_INTERVAL_MS` | 21600000 | Inactive user prune |
| `WORKER_PRUNE_META_INTERVAL_MS` | 86400000 | Metadata cache prune |
| `WORKER_HEALTH_INTERVAL_MS` | 60000 | Heartbeat and health snapshot |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | 15000 | Force-exit deadline |

### 12.8 Health thresholds

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_HEARTBEAT_MAX_SECONDS` | 300 | Heartbeat age before `worker-heartbeat` is reported |
| `HEALTH_FOLD_MAX_SECONDS` | 300 | Fold age before `fold-stale` is reported |
| `HEALTH_QUEUE_MAX` | 80% of `CL_QUEUE_MAX` | Queue depth before `queue-depth` is reported |
| `HEALTH_DB_TIMEOUT_MS` | 2000 | Per-file budget for the SQLite probe |

### 12.9 Removed in v2.4.0

| Variable | Why |
|----------|-----|
| `STATS_REFRESH_INTERVAL` | One stats mode now. Use `STATS_ENABLED=false` |
| `DB_PATH` | Replaced by the three `*_DB_PATH` variables. Only the migration reads the old file |
| `WORKER_OPTIMIZE_INTERVAL_MS` | The optimize pass folded into the checkpoint job |
| `CACHE_RETENTION_DAYS` | Was documented but never read by any code. `L2_TTL_DAYS` is the real knob |
| `CACHE_REFRESH_INTERVAL` | Superseded by `L1_STALE_AFTER_HOURS` |
| `ENABLE_CACHE` | Caching is no longer optional |

---

## 13. File Structure

```
Stremio-SubSense/
├── server.js                       # Cluster primary + request workers (API process)
├── worker.js                       # Maintenance worker, 8 budgeted jobs
├── manifest.js                     # Dynamic manifest generation
├── package.json                    # Dependencies and scripts
├── .env.example                    # Environment template
├── Dockerfile                      # Container image definition
├── docker-compose.yml              # Docker Compose deployment (api + worker + redis)
│
├── scripts/
│   └── migrate-db.js               # One-shot v2 to v2.4.0 migration
│
├── public/                         # Static frontend files
│   ├── index.html                  # Configure page
│   ├── stats.html                  # Stats dashboard
│   ├── content.html                # Cache browser
│   ├── style.css                   # Shared styles
│   ├── logo.png                    # Addon logo
│   ├── providers/                  # Provider icons (self-hosted)
│   │   ├── animetosho.ico
│   │   ├── betaseries.ico
│   │   ├── gestdown.png
│   │   ├── opensubtitles.ico
│   │   ├── podnapisi.ico
│   │   ├── subdl.png
│   │   ├── subf2m.png
│   │   ├── subsource.png
│   │   ├── tvsubtitles.ico
│   │   └── yify.ico
│   └── js/
│       ├── configure.js            # Configure page logic
│       ├── stats.js                # Stats dashboard logic
│       └── content.js              # Cache browser logic
│
├── src/
│   ├── config.js                   # Configuration parser
│   ├── languages.js                # Language code mapping
│   ├── utils.js                    # Logging utilities
│   ├── health.js                   # Deep health probe
│   │
│   ├── infra/
│   │   ├── db.js                   # Three SQLite files, DDL, pragmas, kv markers
│   │   ├── redis.js                # Shared Redis connection, fail-fast
│   │   ├── metrics.js              # Event-loop lag, request rate, provider latency
│   │   └── rate-limit.js           # Upstream rate limits reserved in Redis
│   │
│   ├── jobs/
│   │   ├── scheduler.js            # Budgeted job runner
│   │   ├── cleanup-cache.js        # L2 retention
│   │   └── prune-meta.js           # Metadata cache retention
│   │
│   ├── routes/
│   │   ├── index.js                # Route module exports
│   │   ├── stremio.js              # Stremio manifest & subtitle routes
│   │   ├── proxy.js                # Subtitle format & provider proxies
│   │   ├── health.js               # Health check endpoint
│   │   ├── config-api.js           # Config/version API
│   │   └── stats-api.js            # Stats & cache browsing API
│   │
│   ├── handlers/
│   │   └── subtitles.js            # Subtitle request handler
│   │
│   ├── providers/
│   │   ├── index.js                # Provider registration
│   │   ├── BaseProvider.js         # Abstract base class
│   │   ├── ProviderManager.js      # Provider orchestration
│   │   ├── WyzieProvider.js        # Wyzie API integration + key pool
│   │   ├── BetaSeriesProvider.js   # BetaSeries API (FR/EN)
│   │   ├── SubSourceProvider.js    # SubSource.net API
│   │   ├── YIFYProvider.js         # YIFY/YTS (movies only)
│   │   ├── TVsubtitlesProvider.js  # TVsubtitles.net (series only)
│   │   ├── OpenSubtitlesProvider.js # OpenSubtitles Legacy API (movies + TV)
│   │   └── GestdownProvider.js     # Gestdown API (TV only, TVDB/TMDB lookup)
│   │
│   ├── cache/
│   │   ├── response-cache.js       # L1 responses in Redis
│   │   ├── subtitle-store.js       # L2 subtitle cache (cache.db)
│   │   ├── inflight.js             # Cross-process dedup via Redis lock
│   │   ├── InflightCache.js        # In-process promise dedup
│   │   └── (v2 modules kept for one release, no runtime consumers:
│   │        index.js, database-libsql.js, subtitle-cache.js,
│   │        ResponseCache.js, cache-cleaner.js)
│   │
│   ├── stats/
│   │   ├── index.js                # Stats entry point
│   │   ├── track.js                # Request-path buffered recording
│   │   ├── fold.js                 # Worker-side folding into rollups
│   │   ├── content-log.js          # Seven-day rotating content log
│   │   ├── stats-db.js             # Rollup-backed readers
│   │   ├── stats-service.js        # /stats payload assembly
│   │   └── schema.js               # v2 schema, read only by the migration
│   │
│   └── utils/
│       ├── validators.js           # Input validation
│       ├── crypto.js               # AES-256-GCM encryption
│       ├── encoding.js             # Character encoding
│       ├── filenameMatcher.js      # Subtitle-video matching
│       ├── format.js               # Subtitle formatting for Stremio
│       ├── archive.js              # ZIP extraction utilities
│       └── subtitle-converter.js   # ASS→VTT/SRT conversion with styling
│
└── docs/                           # Documentation
    ├── ARCHITECTURE.md             # This file
```

---

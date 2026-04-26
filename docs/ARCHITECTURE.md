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

- **Multi-source aggregation**: Uses multiple providers including wyzie-lib (OpenSubtitles, SubDL, Podnapisi, Subf2m, AnimeTosho, Gestdown), BetaSeries, YIFY, and TVsubtitles
- **Multi-language support**: Up to 5 languages with equal priority
- **Dual format support**: ASS subtitles converted to VTT (with styling) + SRT (fallback)
- **Configurable limits**: User-selectable max subtitles per language
- **SQLite caching**: Persistent cache with automatic cleanup via background worker
- **Statistics dashboard**: Real-time analytics on usage and cache performance
- **Two-process architecture**: API server + background worker for separation of concerns

### Technology Stack

| Component | Technology |
|-----------|------------|
| Backend Runtime | Node.js 20+ |
| Web Framework | Express.js |
| Subtitle Sources | wyzie-lib |
| Database | SQLite (LibSQL via @libsql/client) |
| Process Manager | PM2 |
| Frontend | Vanilla HTML/CSS/JS |

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              STREMIO CLIENT                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              EXPRESS SERVER                                  │
│  server.js (API process)                                                     │
│  ├── Static files (/public)                                                 │
│  ├── Configure page (/configure)                                            │
│  ├── Stats pages (/stats, /stats/content)                                   │
│  ├── Stremio routes (src/routes/stremio.js)                                 │
│  │   ├── Manifest route (/:config/manifest.json)                            │
│  │   └── Subtitle route (/:config/subtitles/:type/:id/:extra?.json)        │
│  ├── Proxy routes (src/routes/proxy.js)                                     │
│  │   └── /api/subtitle/:format/*, /api/subsource/*, etc.                   │
│  ├── Config API (src/routes/config-api.js)                                  │
│  ├── Stats API (src/routes/stats-api.js)                                    │
│  └── Health check (src/routes/health.js)                                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
┌───────────────┐          ┌───────────────────┐          ┌─────────────────┐
│  manifest.js  │          │ src/handlers/     │          │   src/cache/    │
│               │          │  subtitles.js     │          │                 │
│ generateManifest()       │                   │          │ ResponseCache   │
│ generateDescription()    │ handleSubtitles() │          │ InflightCache   │
└───────────────┘          │                   │          │ subtitle-cache  │
                           └───────────────────┘          │ cache-cleaner   │
                                      │                   │ database-libsql │
                                      ▼                   └─────────────────┘
                          ┌───────────────────────┐
                          │  src/providers/       │
                          │  ProviderManager.js   │
                          │                       │
                          │  WyzieProvider.js     │
                          │  BetaSeriesProvider   │
                          │  SubSourceProvider    │
                          │  YIFYProvider         │
                          │  TVsubtitlesProvider  │
                          └───────────────────────┘
                                      │
                                      ▼
           ┌──────────────────────────┴──────────────────────────┐
           │                  SUBTITLE SOURCES                    │
           │  OpenSubtitles │ SubDL │ Podnapisi │ Subf2m │ etc.  │
           └─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                           BACKGROUND WORKER                                  │
│  worker.js (separate process)                                                │
│  ├── Cache cleanup (TTL-based DELETE, every 2h)                             │
│  ├── WAL checkpoint (PASSIVE every 30min, TRUNCATE on shutdown)             │
│  ├── PRAGMA optimize + incremental_vacuum (every 6h)                        │
│  ├── Health snapshot (data/worker-health.json every 60s)                    │
│  └── Stats refresh (if enabled)                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Components

### 3.1 Entry Points

| File | Purpose |
|------|---------|
| `server.js` | Express HTTP server, route mounting, bootstrap (API process) |
| `worker.js` | Background worker: cache cleanup, WAL checkpoint, optimize, health |
| `manifest.js` | Manifest generation with dynamic descriptions |

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

### 3.5 Providers (src/providers/)

| File | Purpose |
|------|---------|
| `BaseProvider.js` | Abstract base class for providers |
| `ProviderManager.js` | Provider registry and orchestration |
| `WyzieProvider.js` | wyzie-lib integration, fast-first strategy |
| `BetaSeriesProvider.js` | BetaSeries API integration for French/English subtitles |
| `SubSourceProvider.js` | SubSource.net API integration (user API key required) |
| `YIFYProvider.js` | YIFY/YTS subtitle provider (movies only) |
| `TVsubtitlesProvider.js` | TVsubtitles.net provider (TV series only) |
| `index.js` | Provider registration and exports |

### 3.6 Cache (src/cache/)

| File | Purpose |
|------|---------|
| `database-libsql.js` | LibSQL database connection singleton (async API) |
| `subtitle-cache.js` | Subtitle result caching by content+language |
| `cache-cleaner.js` | Automatic cleanup of old entries |
| `ResponseCache.js` | L1 in-memory LRU cache for fast repeated lookups |
| `InflightCache.js` | Deduplicates concurrent identical requests |
| `index.js` | Exports cache modules |

### 3.7 Stats (src/stats/)

| File | Purpose |
|------|---------|
| `index.js` | Stats initialization and mode detection |
| `schema.js` | Database schema for stats tables |
| `stats-db.js` | SQLite database for analytics and request logs |
| `stats-service.js` | Stats computation and refresh logic |

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
   a. Check L1 ResponseCache (in-memory LRU)
   b. Check InflightCache (dedup concurrent identical requests)
   c. Parse Stremio ID (imdbId, season, episode)
   d. Convert 3-letter to 2-letter language codes
   e. Check L2 SubtitleCache (SQLite)

4. If CACHE HIT:
   - Return cached subtitles immediately
   - If stale, trigger background refresh

5. If CACHE MISS:
   - ProviderManager.searchAll() queries all registered providers
   - Returns when deadline met or all providers respond
   - Background fetch continues for caching

6. Format results:
   - prioritizeByLanguage() groups and sorts by quality
   - formatForStremio() generates dual VTT+SRT entries for ASS subs
   - Apply maxSubtitles limit per language

7. Store in L1 + L2 cache, return response:
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
Uses wyzie-lib to aggregate from multiple sources:
- OpenSubtitles
- SubDL
- Subf2m
- Podnapisi
- AnimeTosho
- Gestdown
- ...

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

All database operations use LibSQL (@libsql/client) with async/await for non-blocking I/O.

### 8.1 L1 — In-Memory Response Cache

Located in `src/cache/ResponseCache.js`

- **LRU eviction** with configurable max size
- **TTL-based expiry** with stale-while-revalidate
- **Per-language capacity** limits to prevent hot languages from evicting others
- **Warmup** from L2 on startup for immediate cache hits
- Keyed by: `{imdbId}:{season}:{episode}:{langList}`

### 8.2 L1 — Inflight Cache

Located in `src/cache/InflightCache.js`

- Deduplicates concurrent identical requests
- Returns a shared Promise for all callers of the same key
- Automatically clears slot on resolve/reject

### 8.3 L2 — Subtitle Cache (SQLite)

Located in `src/cache/subtitle-cache.js`

**Features**:
- Persistent SQLite via LibSQL (async API)
- Keyed by: imdbId + season + episode + language
- TTL: 24 hours default, background refresh when stale
- Caches ALL languages fetched (benefits future users)

**Cache Key Format**:
```
{imdbId}:{season|null}:{episode|null}:{language}
```

### 8.4 Cache Cleaner

Located in `src/cache/cache-cleaner.js`

- Runs in the **worker process** (not the API server)
- TTL-based DELETE in 500-row batches every 2 hours
- Removes entries older than CACHE_RETENTION_DAYS
- Logs cleanup statistics

### 8.5 Background Worker (worker.js)

The worker is a separate process that handles all background maintenance:

| Task | Interval | Purpose |
|------|----------|---------|
| Cache cleanup | Every 2h | Delete expired cache entries |
| WAL checkpoint | Every 30min | PASSIVE checkpoint; TRUNCATE on shutdown |
| PRAGMA optimize | Every 6h | Optimize indexes + incremental vacuum |
| Health snapshot | Every 60s | Write `data/worker-health.json` |
| Stats refresh | Configurable | Recompute stats summaries (if enabled) |

---

## 9. Statistics & Analytics

> **Note:** Stats can be completely disabled by setting `STATS_REFRESH_INTERVAL=0`. See [Environment Variables](#12-environment-variables) for details.

### 9.1 Stats System (src/stats/)

The stats subsystem is modular:
- `index.js` — Initialization and mode detection (full / lite / disabled)
- `schema.js` — Database schema for stats tables
- `stats-db.js` — SQLite database for analytics and request logs
- `stats-service.js` — Stats computation and refresh logic

Tracks:
- Total requests, movie/series counts
- Cache hit/miss rates
- Provider response times and error rates
- Language availability rates
- Daily request volumes
- Active user sessions

### 9.2 Stats API Endpoints

| Endpoint | Data |
|----------|------|
| `/api/config` | Returns `{statsEnabled, version}` — always available |
| `/api/stats/cache` | Cache entries, hit rate, size |
| `/api/stats/providers` | Per-provider performance |
| `/api/stats/languages` | Language stats |
| `/api/stats/daily` | Daily aggregates |
| `/api/cache/search` | Search by IMDB |
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
```

**Subtitle ID format visible to users:**
```
subsense-{index}-{originalId}-{format}-{source}
Example: subsense-0-2607183-vtt-subsource
```

### 11.3 Stats API

> **Note:** All stats endpoints except `/api/config` return 403 when `STATS_REFRESH_INTERVAL=0`.

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

### 11.4 Static Routes

| Route | Purpose |
|-------|---------|
| `/configure` | Configuration UI |
| `/stats` | Statistics dashboard |
| `/stats/content` | Cache browser |

---

## 12. Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3100 | Server port |
| `HOST` | 127.0.0.1 | Server bind address |
| `SUBSENSE_BASE_URL` | `http://127.0.0.1:{PORT}` | Public URL for proxied subtitles |
| `LOG_LEVEL` | info | Logging: debug, info, warn, error |
| `SUBSENSE_ENCRYPTION_KEY` | — | **Required** for SubSource. AES-256-GCM encryption key for user API keys. Accepts 64-char hex or passphrase (PBKDF2-derived) |
| `SUBTITLE_SOURCES` | All sources | Comma-separated provider list (wyzie, betaseries, yify, tvsubtitles, subsource) |
| `WYZIE_API_KEY` | — | **Required** for Wyzie provider. API key from https://sub.wyzie.io/redeem |
| `WYZIE_SOURCES` | All sources | Comma-separated Wyzie sources override |
| `BETASERIES_API_KEY` | — | BetaSeries API key for French/English subtitles |
| `ENABLE_CACHE` | true | Enable/disable caching |
| `DB_PATH` | ./data/subsense.db | SQLite database path |
| `CACHE_RETENTION_DAYS` | 30 | Days before cache cleanup |
| `CACHE_REFRESH_INTERVAL` | 604800 | Seconds before background refresh of stale cache entries |
| `STATS_REFRESH_INTERVAL` | minimal | Stats mode: `minimal` (user tracking, 5min refresh), `0` (disabled), or number in ms for full stats |

### 12.1 Stats Configuration

The stats system has three modes controlled by `STATS_REFRESH_INTERVAL`:

| Value | Mode | Behavior |
|-------|------|----------|
| *not set* or `"minimal"` | **Minimal** (default) | User tracking only (`user_tracking` table), refreshed every 5min |
| `"0"` | **Disabled** | No tables, no tracking, zero CPU overhead |
| Number > 0 (ms) | **Full** | Complete stats dashboard with all tables, refreshed at given interval |

| Example Value | Full Mode Behavior |
|---------------|-------------------|
| `120000` | Refresh stats every 2 minutes |
| `3600000` | Refresh stats every hour |

**When `STATS_REFRESH_INTERVAL=0`:**
- `/stats` and `/stats/content` pages return styled 403 pages
- All `/api/stats/*` and `/api/cache/*` endpoints return 403 Forbidden
- `/api/config` returns `{statsEnabled: false, version: "x.x.x"}`
- Navigation links to stats are hidden in frontend UI
- Zero CPU overhead from stats computation

**Recommended settings by database size:**
| Database Size | Recommended Interval |
|---------------|---------------------|
| < 100K entries | 120000 (2 min) |
| 100K - 1M entries | 300000 (5 min) |
| 1M - 10M entries | 600000 (10 min) |
| > 10M entries | 3600000 (1 hour) or 0 (disabled) |

### 12.2 Worker Configuration

The worker process accepts these optional tuning variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_CLEANUP_INTERVAL_MS` | 7200000 (2h) | Cache cleanup interval |
| `WORKER_CHECKPOINT_INTERVAL_MS` | 1800000 (30min) | WAL checkpoint interval |
| `WORKER_OPTIMIZE_INTERVAL_MS` | 21600000 (6h) | PRAGMA optimize interval |
| `WORKER_HEALTH_INTERVAL_MS` | 60000 (1min) | Health snapshot interval |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | 15000 (15s) | Graceful shutdown timeout |

---

## 13. File Structure

```
Stremio-SubSense/
├── server.js                       # Express server entry point (API process)
├── worker.js                       # Background worker (cache cleanup, WAL, optimize)
├── manifest.js                     # Dynamic manifest generation
├── package.json                    # Dependencies and scripts
├── .env.example                    # Environment template
├── Dockerfile                      # Container image definition
├── docker-compose.yml              # Docker Compose for deployment
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
│   │   ├── WyzieProvider.js        # wyzie-lib integration
│   │   ├── BetaSeriesProvider.js   # BetaSeries API (FR/EN)
│   │   ├── SubSourceProvider.js    # SubSource.net API
│   │   ├── YIFYProvider.js         # YIFY/YTS (movies only)
│   │   └── TVsubtitlesProvider.js  # TVsubtitles.net (series only)
│   │
│   ├── cache/
│   │   ├── index.js                # Cache exports
│   │   ├── database-libsql.js      # LibSQL connection singleton
│   │   ├── subtitle-cache.js       # L2 subtitle cache (SQLite)
│   │   ├── ResponseCache.js        # L1 in-memory LRU cache
│   │   ├── InflightCache.js        # Request deduplication
│   │   └── cache-cleaner.js        # TTL-based cache cleanup
│   │
│   ├── stats/
│   │   ├── index.js                # Stats initialization & mode
│   │   ├── schema.js               # Stats DB schema
│   │   ├── stats-db.js             # Stats database operations
│   │   └── stats-service.js        # Stats computation
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

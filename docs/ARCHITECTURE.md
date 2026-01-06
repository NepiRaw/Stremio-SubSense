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
- **SQLite caching**: Persistent cache with automatic cleanup
- **Statistics dashboard**: Real-time analytics on usage and cache performance

### Technology Stack

| Component | Technology |
|-----------|------------|
| Backend Runtime | Node.js 18+ |
| Web Framework | Express.js |
| Stremio SDK | stremio-addon-sdk |
| Subtitle Sources | wyzie-lib |
| Database | SQLite (better-sqlite3) |
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
│  server.js                                                                   │
│  ├── Static files (/public)                                                 │
│  ├── Configure page (/configure)                                            │
│  ├── Stats pages (/stats, /stats/content)                                   │
│  ├── Manifest route (/:config/manifest.json)                                │
│  ├── Subtitle route (/:config/subtitles/:type/:id.json)                    │
│  ├── Proxy route (/api/subtitle/:format/*)                                  │
│  └── Stats API (/api/stats/*, /api/cache/*)                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
┌───────────────┐          ┌───────────────────┐          ┌─────────────────┐
│  manifest.js  │          │   src/subtitles.js │          │   src/cache/    │
│               │          │                   │          │                 │
│ generateManifest()       │ handleSubtitles() │          │ subtitle-cache  │
│ generateDescription()    │ formatForStremio()│          │ stats-db        │
└───────────────┘          │ prioritizeSubtitlesMulti()   │ cache-cleaner   │
                           └───────────────────┘          └─────────────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │  src/providers/       │
                          │  WyzieProvider.js     │
                          │                       │
                          │ searchFastFirstMulti()│
                          │ Uses: wyzie-lib       │
                          └───────────────────────┘
                                      │
                                      ▼
           ┌──────────────────────────┴──────────────────────────┐
           │                  SUBTITLE SOURCES                    │
           │  OpenSubtitles │ SubDL │ Podnapisi │ Subf2m │ etc.  │
           └─────────────────────────────────────────────────────┘
```

---

## 3. Core Components

### 3.1 Entry Points

| File | Purpose |
|------|---------|
| `server.js` | Express HTTP server, routes, middleware |
| `addon.js` | Stremio SDK integration (backup handler) |
| `manifest.js` | Manifest generation with dynamic descriptions |

### 3.2 Source Files (src/)

| File | Purpose |
|------|---------|
| `config.js` | Parse and validate user configuration |
| `subtitles.js` | Main subtitle request handler |
| `languages.js` | Language code mapping (ISO 639-1 ↔ ISO 639-2/B) |
| `stats.js` | In-memory statistics tracking |
| `utils.js` | Logging and utility functions |

### 3.3 Providers (src/providers/)

| File | Purpose |
|------|---------|
| `BaseProvider.js` | Abstract base class for providers |
| `WyzieProvider.js` | wyzie-lib integration, fast-first strategy |
| `BetaSeriesProvider.js` | BetaSeries API integration for French/English subtitles |
| `YIFYProvider.js` | YIFY/YTS subtitle provider (movies only) |
| `TVsubtitlesProvider.js` | TVsubtitles.net provider (TV series only) |
| `ProviderManager.js` | Provider registry and orchestration |
| `index.js` | Exports all providers |

### 3.4 Cache (src/cache/)

| File | Purpose |
|------|---------|
| `subtitle-cache.js` | Subtitle result caching by content+language |
| `stats-db.js` | SQLite database for analytics and request logs |
| `cache-cleaner.js` | Automatic cleanup of old entries |
| `index.js` | Exports cache modules |

### 3.5 Services (src/services/)

| File | Purpose |
|------|---------|
| `subtitle-converter.js` | ASS/SSA to VTT/SRT conversion with styling preservation |

### 3.6 Utilities (src/utils/)

| File | Purpose |
|------|---------|
| `validators.js` | Input validation (IMDB IDs, pagination) |

---

## 4. Request Flow

### 4.0 Route Architecture (Express Routing)

**Two-Tier Routing System:**

SubSense uses a dual-route approach to support both UserID and standard Stremio protocol:

**1. Custom UserID Route (Priority #1)**
```javascript
app.get('/:userIdConfig([a-z0-9]{8}-.+)/subtitles/:type/:id/:extra?.json', ...)
```
- **Pattern:** `/:userIdConfig([a-z0-9]{8}-.+)/subtitles/:type/:id/:extra?.json`
- **Regex Constraint:** `([a-z0-9]{8}-.+)` matches ONLY URLs with 8-char UserID prefix
- **Purpose:** Extract UserID for analytics
- **Extra Parameter:** Optional `:extra?` handles Stremio Web video metadata
- **Match Examples:**
  - ✅ `/abc12345-{config}/subtitles/movie/tt1254207.json`
  - ✅ `/xyz98765-{config}/subtitles/series/tt0386676:1:1/filename=video.mp4&videoSize=15684012085.json`
- **Does NOT Match:**
  - ❌ `/{config}/subtitles/movie/tt1254207.json` (no UserID → falls to SDK router)

**2. SDK Router (Priority #2 - Fallback)**
```javascript
app.use(getRouter(addonInterface))
```
- **Pattern (SDK-generated):** `/:config?/subtitles/:type/:id/:extra?.json`
- **Purpose:** Standard Stremio protocol compliance for requests without UserID
- **Extra Parameter:** SDK uses `qs.parse()` to decode video metadata from URL
- **Match Examples:**
  - ✅ `/{config}/subtitles/movie/tt1254207.json`
  - ✅ `/subtitles/movie/tt1254207.json` (no config)
  - ✅ `/{config}/subtitles/movie/tt1254207/filename=video.mp4&videoHash=abc123.json`

**Routing Decision Tree:**
```
Request: /{param}/subtitles/{type}/{id}/{extra?}.json
    │
    ├─► Does {param} match [a-z0-9]{8}-.+ pattern?
    │   │
    │   ├─► YES → Custom UserID Route
    │   │         - Extract UserID for analytics
    │   │         - Parse config from URL
    │   │         - Handle :extra parameter
    │   │         - Add user session in DB
    │   │
    │   └─► NO  → SDK Router (fallback)
    │             - Parse config (if present)
    │             - Handle :extra parameter
    │             - Standard protocol flow
    │
    └─► Both routes → handleSubtitles()
```

**Extra Parameter Format (All Stremio Versions):**

When Stremio (Desktop v4.4+, v5, Web, etc.) requests subtitles, it includes video metadata:
```
/config/subtitles/movie/tt1254207/filename=https://alldebrid.com/f/abc.mkv&videoSize=15684012085&videoHash=d78732c9565aeb2d.json
```


**Important:** The `:extra?` parameter is critical for production deployments. Without it, all Stremio versions (Desktop v4.4+, v5, Web) will receive 404 errors when requesting subtitles. This issue was not visible in localhost development.

---

### 4.1 Subtitle Request Flow

When Stremio requests subtitles:

```
1. Stremio Client sends request:
   Desktop v4.4+, v5, Web:
     GET /{userId}-{config}/subtitles/{type}/{id}/filename=video.mp4&videoSize=123456&videoHash=abc123.json

2. server.js receives request:
   - Routes:
     a) Custom UserID route: /:userIdConfig([a-z0-9]{8}-.+)/subtitles/:type/:id/:extra?.json
        - Matches requests with 8-char UserID prefix
        - Handles optional :extra parameter (Stremio Web video metadata)
        - Extracts userId from URL for analytics
     
     b) SDK Router fallback: /:config?/subtitles/:type/:id/:extra?.json
        - Handles requests without UserID prefix
        - Standard Stremio protocol compliance
   
   - Extract userId (8-char alphanumeric) and config from URL
   - Parse JSON config: { languages: [...], maxSubtitles: N }
   - Parse :extra parameter (if present):
       { filename: "video.mp4", videoSize: "15684012085", videoHash: "d78732c9565aeb2d" }
   - Validate config via parseConfig()

3. handleSubtitles() in src/subtitles.js:
   a. Parse Stremio ID (imdbId, season, episode)
   b. Convert 3-letter to 2-letter language codes
   c. Check cache for each requested language
   
4. If CACHE HIT:
   - Return cached subtitles immediately
   - If stale, trigger background refresh
   
5. If CACHE MISS:
   - Call fetchSubtitlesFastFirstMulti()
   - WyzieProvider queries all sources in parallel
   - Returns when minSubtitles threshold met
   - Background fetch continues for caching

6. prioritizeSubtitlesMulti():
   - Group subtitles by language
   - Sort by quality (non-HI preferred)
   - Apply maxSubtitles limit per language

7. formatForStremio():
   - For each subtitle:
     - If ASS format: Return BOTH VTT (styled) + SRT (fallback) entries
     - If SRT format: Return single entry
   - Generate unique IDs: subsense-{index}-{subId}-{format}-{source}
   - Build proxy URLs for subtitle conversion

8. Return response:
   { subtitles: [{ id, url, lang, label, source }, ...] }
```

### 4.2 Manifest Request Flow

```
1. Stremio/User requests manifest:
   GET /{userId}-{config}/manifest.json

2. server.js extracts userId and config

3. generateManifest() creates manifest:
   - If languages configured: Dynamic description
   - Includes: id, version, name, description, resources, types

4. Return manifest JSON
```

### 4.3 Subtitle Proxy Flow

When Stremio fetches an actual subtitle file:

```
1. Stremio requests:
   GET /api/subtitle/{format}/{originalUrl}

2. server.js proxy endpoint:
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

The config is JSON-encoded in the manifest URL:

```
/{userId}-{encodedConfig}/manifest.json
/{userId}-{encodedConfig}/subtitles/{type}/{id}.json

Example:
/abc12def-%7B%22languages%22%3A%5B%22eng%22%5D%7D/manifest.json
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
  version: '1.0.0',  // from package.json
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
    configurationRequired: true  // Removed after valid config
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

### 7.2 Fast-First Strategy

```javascript
searchFastFirstMulti(query, languages) {
  1. Query all sources in parallel for ALL requested languages
  2. Collect subtitles as they arrive
  3. Return immediately when minSubtitles threshold met
  4. Continue background fetch for complete results
  5. Cache complete results for future requests
}
```

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

### 8.1 Subtitle Cache

Located in `src/cache/subtitle-cache.js`

**Features**:
- In-memory cache with SQLite persistence
- Keyed by: imdbId + season + episode + language
- TTL: 24 hours default, background refresh when stale
- Caches ALL languages fetched (benefits future users)

**Cache Key Format**:
```
{imdbId}:{season|null}:{episode|null}:{language}
```

### 8.2 Stats Database

Located in `src/cache/stats-db.js`

**Tables**:
- `subtitle_cache` - Cached subtitle entries
- `request_log` - All subtitle requests
- `daily_stats` - Aggregated daily metrics
- `provider_stats` - Per-provider performance
- `language_stats` - Language availability
- `user_sessions` - Active session tracking

### 8.3 Cache Cleaner

Located in `src/cache/cache-cleaner.js`

- Runs every 6 hours
- Removes entries older than CACHE_RETENTION_DAYS (default: 30)
- Logs cleanup statistics

---

## 9. Statistics & Analytics

### 9.1 In-Memory Stats (src/stats.js)

Tracks real-time metrics:
- Total requests
- Movie/series counts
- Total subtitles served
- Average fetch time
- Uptime

### 9.2 Database Stats (stats-db.js)

Persistent analytics:
- Cache hit/miss rates
- Provider response times
- Language availability rates
- Daily request volumes
- Active user sessions

### 9.3 Stats API Endpoints

| Endpoint | Data |
|----------|------|
| `/api/stats/cache` | Cache entries, hit rate, size |
| `/api/stats/providers` | Per-provider performance |
| `/api/stats/languages` | Language availability |
| `/api/stats/daily` | Daily aggregates |
| `/stats/json` | In-memory runtime stats |

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
| `/:userIdConfig([a-z0-9]{8}-.+)/subtitles/:type/:id/:extra?.json` | GET | Subtitle search (with UserID tracking) |
| `/:config/subtitles/:type/:id/:extra?.json` | GET | Subtitle search (SDK fallback) |

**Note on `:extra?` parameter:**
- Added to support Stremio Web video metadata (filename, videoSize, videoHash)
- Optional parameter parsed by SDK using querystring format
- Improves subtitle matching accuracy (especially for hash-based searches)
- Required for cross-platform compatibility (Desktop/Web/Mobile/TV)

### 11.2 Proxy Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/subtitle/vtt/*` | GET | Convert ASS to VTT (preserves styling) |
| `/api/subtitle/srt/*` | GET | Convert ASS to SRT (plain text) |
| `/api/subtitle/ass/*` | GET | Passthrough ASS (no conversion) |

### 11.3 Stats API

| Route | Method | Purpose |
|-------|--------|---------|
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
| `SUBSENSE_BASE_URL` | `http://127.0.0.1:{PORT}` | Public URL for proxied subtitles |
| `LOG_LEVEL` | info | Logging: debug, info, warn, error |
| `SUBTITLE_SOURCES` | All sources | Comma-separated source list |
| `ENABLE_CACHE` | true | Enable/disable caching |
| `DB_PATH` | ./data/subsense.db | SQLite database path |
| `CACHE_RETENTION_DAYS` | 30 | Days before cache cleanup |
| `MAX_SUBTITLES` | 30 | Fallback max (overridden by user config) |
| `BETASERIES_API_KEY` | *(required)* | BetaSeries API key for provider |

---

## 13. File Structure

```
Stremio-SubSense/
├── server.js                       # Express server entry point
├── addon.js                        # Stremio SDK addon builder
├── manifest.js                     # Dynamic manifest generation
├── package.json                    # Dependencies and scripts
├── .env.example                    # Environment template
│
├── public/                         # Static frontend files
│   ├── index.html                  # Configure page
│   ├── stats.html                  # Stats dashboard
│   ├── content.html                # Cache browser
│   ├── style.css                   # Shared styles
│   ├── logo.png                    # Addon logo
│   └── js/
│       ├── configure.js            # Configure page logic
│       ├── stats.js                # Stats dashboard logic
│       └── content.js              # Cache browser logic
│
├── src/
│   ├── config.js                   # Configuration parser
│   ├── subtitles.js                # Main subtitle handler
│   ├── languages.js                # Language code mapping
│   ├── stats.js                    # In-memory stats
│   ├── utils.js                    # Logging utilities
│   │
│   ├── providers/
│   │   ├── index.js                # Provider exports
│   │   ├── BaseProvider.js         # Abstract base class
│   │   ├── WyzieProvider.js        # wyzie-lib integration
│   │   ├── BetaSeriesProvider.js   # BetaSeries API (FR/EN)
│   │   ├── YIFYProvider.js         # YIFY/YTS (movies only)
│   │   ├── TVsubtitlesProvider.js  # TVsubtitles.net (series only)
│   │   └── ProviderManager.js
│   │
│   ├── cache/
│   │   ├── index.js                # Cache exports
│   │   ├── subtitle-cache.js
│   │   ├── stats-db.js             # SQLite analytics
│   │   └── cache-cleaner.js
│   │
│   ├── services/
│   │   └── subtitle-converter.js  # ASS→VTT/SRT conversion with styling
│   │
│   └── utils/
│       └── validators.js    # Input validation
```

---

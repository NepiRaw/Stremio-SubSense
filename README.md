<div align="center">

# SubSense - Stremio Subtitle Addon

<p>
  <img src="https://img.shields.io/github/v/release/nepiraw/Stremio-SubSense" alt="Version" />
  <img src="https://img.shields.io/badge/Stremio-Addon-purple" alt="Stremio" />
</p>

</div>

---

<p align="center"><b>Subtitle aggregator for Stremio that fetches subtitles from multiple sources.</b></p>

---

## 🎯 Features

- 🔍 **Multi-source aggregation**: fetches subtitles from OpenSubtitles, SubDL, Podnapisi, SubSource, and more
- 🌍 **Multi-language support**: select up to 5 subtitle languages with equal priority
- ⚡ **Fast-first strategy**: returns results as soon as the fastest provider responds
- 🎨 **Easy configuration**: simple web-based configuration interface
- 🗄️ **Two-tier caching**: Redis for the hot path, SQLite for durability and cold start
- 📈 **Scales across cores**: the API runs as a cluster, with a maintenance worker owning all background work
- 🩺 **Real health checks**: `/health/deep` names exactly which dependency is degraded
- 🔐 **Secure API keys**: encrypted storage of provider API keys in manifest URLs

## 📋 Table of Contents

- [⚡ Quick Start](#-quick-start)
- [⚙️ Configuration](#️-configuration)
- [🚀 Self-Hosting](#-self-hosting)
- [🔧 Environment Variables](#-environment-variables)
- [📊 Stats & Monitoring](#-stats--monitoring)
- [⬆️ Upgrading from v2.3.x](#️-upgrading-from-v23x)

## ⚡ Quick Start

1. Navigate to your addon URL (default: `http://localhost:3100`)
2. Select your preferred subtitle languages (up to 5)
3. Click **Install Addon** to add SubSense to Stremio
4. Enjoy automatic subtitles for your movies and series!

## ⚙️ Configuration

### Access Configuration

Open `/configure` in your browser to access the configuration page.

### Options

| Option | Description |
|--------|-------------|
| **Languages** | Select up to 5 subtitle languages (English pre-selected by default) |
| **Max Subtitles** | Limit subtitles per language (Unlimited, 3, 5, 10, 25, 50, 100) |
| **SubDL API Key** | Optional API key for SubDL provider (get one at [subdl.com](https://subdl.com)) |
| **SubSource API Key** | Optional API key for SubSource provider (get one at [subsource.net](https://subsource.net)) |

### Tips

- Set your native language first for best results
- Add English as a fallback for international content

## 🚀 Self-Hosting

### 🐳 Docker Compose (Recommended)

Runs three containers: the API, a maintenance worker, and Redis. The worker is the only process that writes to the databases on a schedule, and Redis holds the hot cache. The addon keeps serving if Redis goes down, in a degraded mode with no analytics.

```yaml
services:
  subsense:
    image: nepiraw/stremio-subsense:latest
    container_name: stremio-subsense
    restart: unless-stopped
    depends_on:
      redis:
        condition: service_healthy
    ports:
      - "3100:3100"
    env_file:
      - .env
    environment:
      # --- Core (mandatory) ---
      - PORT=3100
      - HOST=0.0.0.0
      - SUBSENSE_ENCRYPTION_KEY=               # REQUIRED - encryption key for user API keys

      # --- Core (optional) ---
      - LOG_LEVEL=info
      - WEB_CONCURRENCY=3                      # request workers; match your core count
      - NODE_OPTIONS=--max-old-space-size=768  # per worker process, not for the group

      # --- Storage: three files, separate lock domains ---
      - CACHE_DB_PATH=/app/data/subsense-cache.db
      - STATS_DB_PATH=/app/data/subsense-stats.db
      - META_DB_PATH=/app/data/subsense-meta.db

      # --- Redis ---
      - REDIS_URL=redis://subsense-redis:6379

      # --- Provider API keys ---
      # - WYZIE_API_KEYS=                      # REQUIRED for wyzie provider (comma-separated)
      # - BETASERIES_API_KEY=                  # Optional - BetaSeries (French/English)
      # - TVDB_API_KEY=                        # Optional - Gestdown provider (TVDB lookup)
      # - TMDB_API_KEY=                        # Optional - Gestdown fallback (TMDB lookup)

      # See .env.example for the full list of options
    volumes:
      - subsense-data:/app/data

  worker:
    image: nepiraw/stremio-subsense:latest
    container_name: stremio-subsense-worker
    restart: unless-stopped
    init: true                                 # so SIGTERM reaches node and the drain runs
    command: ["node", "worker.js"]
    healthcheck:
      disable: true                            # no HTTP listener; /health/deep reports on it
    depends_on:
      redis:
        condition: service_healthy
    env_file:
      - .env
    environment:
      - LOG_LEVEL=info
      - NODE_OPTIONS=--max-old-space-size=512
      - CACHE_DB_PATH=/app/data/subsense-cache.db
      - STATS_DB_PATH=/app/data/subsense-stats.db
      - META_DB_PATH=/app/data/subsense-meta.db
      - REDIS_URL=redis://subsense-redis:6379
    volumes:
      - subsense-data:/app/data                # same volume as the API

  redis:
    image: redis:7.2-alpine
    container_name: subsense-redis
    restart: unless-stopped
    command: >
      redis-server
      --maxmemory 512mb
      --maxmemory-policy volatile-lru
      --save 300 100
      --appendonly no
    volumes:
      - subsense-redis:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

volumes:
  subsense-data:
  subsense-redis:
```

```bash
docker compose up -d
```

Raise `--maxmemory` if you serve a lot of traffic; the eviction policy is chosen so that cache entries are evictable while the analytics counters and queues are not.

### 📦 Manual Installation

```bash
git clone https://github.com/NepiRaw/Stremio-SubSense.git
cd Stremio-SubSense
npm install
npm start
```

Access your addon at `http://localhost:3100`


## 🔧 Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | Optional | `3100` | Server port exposed by the addon |
| `SUBSENSE_BASE_URL` | Optional | Auto-detected | Public base URL used in generated proxy links for production deployments |
| `LOG_LEVEL` | Optional | `info` | Logging level: `debug`, `info`, `warn`, `error` |
| `SUBSENSE_ENCRYPTION_KEY` | **Required** | — | Secret used to encrypt/decrypt user-provided provider API keys inside manifest URLs |
| `SUBTITLE_SOURCES` | Optional | `wyzie,betaseries,yify,tvsubtitles,subsource,subdl,animetosho,opensubtitles,gestdown` | Comma-separated list of enabled providers |
| `WYZIE_API_KEYS` | **Required** | — | Wyzie API key(s), comma-separated for pool rotation (get keys at https://sub.wyzie.io/redeem) |
| `WYZIE_SOURCES` | Optional | All available sources | Override the Wyzie sources queried by the `wyzie` provider |
| `BETASERIES_API_KEY` | Optional | — | Server-side BetaSeries API key for BetaSeries subtitle searches |
| `ANIDB_CLIENT` | Optional | — | AniDB HTTP API client name (register at [anidb.net](https://anidb.net)). Required for AnimeTosho TV episode search |
| `ANIDB_CLIENT_VER` | Optional | — | AniDB HTTP API client version. Required alongside `ANIDB_CLIENT` |
| `SUBSOURCE_API_KEY` | Optional | — | Server-side SubSource API key for local testing/admin validation only. End users normally provide their own key through addon configuration |
| `WEB_CONCURRENCY` | Optional | `1` | Request workers to fork. `auto` uses CPU count minus one |
| `REDIS_URL` | Optional | `redis://127.0.0.1:6379` | Redis connection string |
| `CACHE_DB_PATH` | Optional | `./data/subsense-cache.db` | Subtitle cache database |
| `STATS_DB_PATH` | Optional | `./data/subsense-stats.db` | Analytics, user tracking, content log |
| `META_DB_PATH` | Optional | `./data/subsense-meta.db` | Provider metadata caches |
| `L1_TTL_HOURS` | Optional | `6` | Redis response cache TTL |
| `L1_STALE_AFTER_HOURS` | Optional | `2` | Age at which a hit is served but refreshed in the background |
| `L2_TTL_DAYS` | Optional | `7` | Subtitle cache retention |
| `PROVIDER_DEADLINE_MS` | Optional | `8000` | Soft provider fan-out deadline. See the note below |
| `PROXY_CACHE_MAX_BYTES` | Optional | `268435456` | Byte cap on the in-memory subtitle body cache |
| `STATS_ENABLED` | Optional | `true` | Set to `false` to switch off all statistics recording |

> `PROVIDER_DEADLINE_MS` is roughly how long a Stremio client waits before treating a subtitle request as failed. It is a product constraint rather than a performance knob: lowering it returns fewer subtitles for results that would have arrived in time.

The full list, including worker intervals and health thresholds, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#12-environment-variables).

### Available Providers

These are the high-level providers that SubSense can use:

| Provider | Description | Requires API Key |
|----------|-------------|------------------|
| `wyzie` | Aggregates multiple sources (see Wyzie Sources below) | Yes (server-side `WYZIE_API_KEY`) |
| `subdl` | SubDL.com - Community-driven subtitle database | Yes (per-user) |
| `subsource` | SubSource.net - Large subtitle database | Yes (per-user) |
| `yify` | YIFY/YTS movie subtitles | No |
| `tvsubtitles` | TVsubtitles.net for TV series | No |
| `betaseries` | French/English subtitles | Yes (server-side) |
| `animetosho` | Anime subtitles from embedded MKV tracks (AnimeTosho.org) | No (but `ANIDB_CLIENT` needed for TV episodes) |
| `opensubtitles` | Direct OpenSubtitles Legacy API (movies + TV) | No |
| `gestdown` | Gestdown REST API for TV subtitles | Yes (server-side `TVDB_API_KEY` OR `TMDB_API_KEY`) |

### Wyzie Sources

These are the sources queried by the `wyzie` provider (fetched dynamically from the Wyzie API):

`OpenSubtitles`, `Subf2m`, `Kitsunekko`, `Gestdown`, `YIFY`, `TVsubtitles`

Free sources (no paid key needed): `OpenSubtitles`, `TVsubtitles`

## 📊 Stats & Monitoring

Access the stats dashboard at `/stats` to view:
- Request counts and cache hit rates
- Provider performance metrics
- Language availability statistics
- Active user sessions

Browse cached content at `/stats/content`.

### Health Endpoints

| Endpoint | Cost | Use it for |
|----------|------|------------|
| `/health` | In-process only, no I/O | The Docker healthcheck. Answers whether this process can still serve |
| `/health/deep` | Queries every dependency | An uptime monitor. Answers whether the whole addon is working |
| `/metrics` | In-process only | Scraping counters: request rate, event-loop lag, cache hit rate, per-provider latency and yield |

`/health/deep` returns `200` when everything is current and `503` when anything is not, with
a `degraded` array naming each problem:

| Reason | Meaning |
|--------|---------|
| `db:cache` / `db:stats` / `db:meta` | That SQLite file did not answer `SELECT 1` |
| `redis` | Redis is unreachable. Serving continues from SQLite, analytics stop |
| `queue-depth` | The content-log queue is near `CL_QUEUE_MAX`, so the worker is not draining fast enough |
| `worker-heartbeat` | The maintenance worker has not checked in. It is stopped, stuck, or has never run |
| `fold-stale` | Analytics deltas are not being folded, so `/stats` is going stale |


### Disabling Stats


```yaml
environment:
  - STATS_ENABLED=false
```

When disabled:
- `/stats` and `/stats/content` show a styled "disabled" message
- All `/api/stats/*` and `/api/cache/*` endpoints return 403 Forbidden
- Navigation links to stats are hidden in the UI
- The active and total user counts disappear from `/configure`
- No counters are recorded and the worker's fold jobs have nothing to do


---

## ⬆️ Upgrading from v2.3.x

v2.4.0 splits the single `subsense.db` into three files and adds Redis. **Your existing data is not read by the new version until you migrate it**, so run the migration before starting v2.4.0 for the first time.

The old file is only ever read, never written, so it stays valid as a rollback target.

### 1. Stop the old stack

```bash
docker compose down
```

### 2. Migrate

```bash
docker run --rm   -v <your-data-volume>:/app/data   -e CACHE_DB_PATH=/app/data/subsense-cache.db   -e STATS_DB_PATH=/app/data/subsense-stats.db   -e META_DB_PATH=/app/data/subsense-meta.db   nepiraw/stremio-subsense:latest   node scripts/migrate-db.js --old=/app/data/subsense.db
```

If you bind-mount a directory instead of using a named volume, swap the `-v` argument for `-v /path/to/your/data:/app/data`.

It prints a per-table report and exits nonzero if any table copied a different number of rows than the source held. **If it fails, do not start v2.4.0**: delete the partial `subsense-*.db` files and investigate. Nothing has been lost.

Add `--dry-run` first if you want to see the counts without writing anything.

### 3. Start the new stack

Use the three-service compose from [Self-Hosting](#-self-hosting) above.

### What the migration carries over

| Carried | Not carried |
|---------|-------------|
| `user_tracking`, all lifetime and daily stats | `request_log` and `user_content_log` (replaced by a rotating 7-day log) |
| `provider_stats`, `language_stats` | `cache_stats_summary` (replaced by write-time counters) |
| Subtitle cache entries newer than `L2_TTL_DAYS` | Cache entries already past their TTL |
| AniDB and AnimeTosho metadata caches | |

Daily rows migrated from v2 carry `0` for columns v2 never had (`subtitles`, `any_pref_found`,
`all_pref_found`, `unique_users`). Those series start at your cutover date.

### Environment variable changes

| Removed | Replacement |
|---------|-------------|
| `STATS_REFRESH_INTERVAL` | `STATS_ENABLED=false`. There is one stats mode now, and `/stats` is available to everyone |
| `DB_PATH` | `CACHE_DB_PATH`, `STATS_DB_PATH`, `META_DB_PATH` |
| `CACHE_RETENTION_DAYS` | `L2_TTL_DAYS`. The old name was documented but never read by any code |
| `CACHE_REFRESH_INTERVAL` | `L1_STALE_AFTER_HOURS` |
| `ENABLE_CACHE` | Nothing. Caching is no longer optional |
| `WORKER_OPTIMIZE_INTERVAL_MS` | Nothing. The optimize pass folded into the checkpoint job |

New and worth setting: `REDIS_URL`, `WEB_CONCURRENCY`, and a per-process `NODE_OPTIONS` heap cap. With a cluster the cap applies to **each** worker, so a single large value now multiplies.

### Rolling back

Put your old compose back and start it. v2.4.0 never opens `subsense.db`, so it is exactly as v2.3.x left it. Statistics recorded while v2.4.0 was running stay in the new files and do not come back.

---

<div align="center">

**Enjoy! 😊**

[GitHub](https://github.com/NepiRaw/Stremio-SubSense) • [Issues](https://github.com/NepiRaw/Stremio-SubSense/issues)

</div>

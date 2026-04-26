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

- 🔍 **Multi-source aggregation** — Fetches subtitles from OpenSubtitles, SubDL, Podnapisi, SubSource, and more
- 🌍 **Multi-language support** — Select up to 5 subtitle languages with equal priority
- ⚡ **Fast-first strategy** — Returns results as soon as fastest provider responds
- 🎨 **Easy configuration** — Simple web-based configuration interface
- 🗄️ **Smart caching** — SQL caching for faster subsequent requests
- 🔐 **Secure API keys** — Encrypted storage of provider API keys in manifest URLs

## 📋 Table of Contents

- [⚡ Quick Start](#-quick-start)
- [⚙️ Configuration](#️-configuration)
- [🚀 Self-Hosting](#-self-hosting)
- [🔧 Environment Variables](#-environment-variables)

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
| **SubSource API Key** | Optional API key for SubSource provider (get one at [subsource.net](https://subsource.net)) |

### Tips

- Set your native language first for best results
- Add English as a fallback for international content

## 🚀 Self-Hosting

### 🐳 Docker Compose (Recommended)

```yaml
services:
  subsense:
    image: nepiraw/stremio-subsense:latest
    container_name: stremio-subsense
    restart: unless-stopped
    ports:
      - "3100:3100"
    env_file:
      - .env
    environment:
      # --- Core (mandatory) ---
      - PORT=3100
      - SUBSENSE_ENCRYPTION_KEY=               # REQUIRED - encryption key for user API keys

      # --- Core (optional) ---
      - LOG_LEVEL=info
      - DB_PATH=/app/data/subsense.db

      # --- Provider API keys ---
      # - WYZIE_API_KEY=                       # REQUIRED for wyzie provider
      # - BETASERIES_API_KEY=                  # Optional - BetaSeries (French/English)

      # See .env.example for the full list of options
    volumes:
      - ./data:/app/data  # Persist cache database
```

```bash
docker-compose up -d
```

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
| `SUBTITLE_SOURCES` | Optional | `wyzie,betaseries,yify,tvsubtitles,subsource` | Comma-separated list of enabled providers |
| `WYZIE_API_KEY` | **Required** | — | Server-side Wyzie API key. Required because Wyzie now requires a key for search and download requests |
| `WYZIE_SOURCES` | Optional | All available sources | Override the Wyzie sources queried by the `wyzie` provider |
| `BETASERIES_API_KEY` | Optional | — | Server-side BetaSeries API key for BetaSeries subtitle searches |
| `SUBSOURCE_API_KEY` | Optional | — | Server-side SubSource API key for local testing/admin validation only. End users normally provide their own key through addon configuration |
| `ENABLE_CACHE` | Optional | `true` | Enable/disable subtitle result caching |
| `DB_PATH` | Optional | `./data/subsense.db` | SQLite / LibSQL database path for the subtitle cache |
| `CACHE_RETENTION_DAYS` | Optional | `30` | Days before old cache entries are cleaned up |
| `STATS_REFRESH_INTERVAL` | Optional | `minimal` | Stats mode: `minimal` (user tracking only), `0` (disabled), or a number in ms for full stats |

### Available Providers

These are the high-level providers that SubSense can use:

| Provider | Description | Requires API Key |
|----------|-------------|------------------|
| `wyzie` | Aggregates multiple sources (see Wyzie Sources below) | Yes (server-side `WYZIE_API_KEY`) |
| `subsource` | SubSource.net - Large subtitle database | Yes (per-user) |
| `yify` | YIFY/YTS movie subtitles | No |
| `tvsubtitles` | TVsubtitles.net for TV series | No |
| `betaseries` | French/English subtitles | Yes (server-side) |

### Wyzie Sources

These are the sources queried by the `wyzie` provider:

`OpenSubtitles`, `Subdl`, `Subf2m`, `Podnapisi`, `AnimeTosho`, `Gestdown`

## 📊 Stats & Monitoring

Access the stats dashboard at `/stats` to view:
- Request counts and cache hit rates
- Provider performance metrics
- Language availability statistics
- Active user sessions

Browse cached content at `/stats/content`.

### Disabling Stats (Resource Optimization)

The stats system has three modes controlled by `STATS_REFRESH_INTERVAL`:

| Value | Mode | Behavior |
|-------|------|----------|
| *not set* or `minimal` | **Minimal** (default) | User tracking only, 5min refresh, low overhead |
| `0` | **Disabled** | No stats, no tracking, zero CPU overhead |
| `120000`, `3600000`, etc. | **Full** | Complete stats dashboard refreshed at given interval |

```yaml
environment:
  # Minimal mode (default — lightweight user tracking)
  - STATS_REFRESH_INTERVAL=minimal

  # Full mode — refresh every hour
  - STATS_REFRESH_INTERVAL=3600000
  
  # Completely disable stats
  - STATS_REFRESH_INTERVAL=0
```

When disabled (`STATS_REFRESH_INTERVAL=0`):
- `/stats` and `/stats/content` pages show a styled "disabled" message
- All `/api/stats/*` and `/api/cache/*` endpoints return 403 Forbidden
- Navigation links to stats are automatically hidden in the UI
- Zero CPU overhead from stats computation

---

<div align="center">

**Enjoy! 😊**

[GitHub](https://github.com/NepiRaw/Stremio-SubSense) • [Issues](https://github.com/NepiRaw/Stremio-SubSense/issues)

</div>

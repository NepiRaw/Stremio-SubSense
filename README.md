<div align="center">

# SubSense - Stremio Subtitle Addon

<p>
  <img src="https://img.shields.io/github/v/release/nepiraw/Stremio-SubSense" alt="Version" />
  <img src="https://img.shields.io/badge/Stremio-Addon-purple" alt="Stremio" />
  <img src="https://img.shields.io/badge/Node.js-18+-brightgreen" alt="Node.js" />
</p>

</div>

---

<p align="center"><b>Subtitle aggregator for Stremio that fetches subtitles from multiple sources.</b></p>

---

## 🎯 Features

- 🔍 **Multi-source aggregation** — Fetches subtitles from OpenSubtitles, SubDL, Podnapisi, and more
- 🌍 **Multi-language support** — Select up to 5 subtitle languages with equal priority
- ⚡ **Fast-first strategy** — Returns results as soon as fastest provider responds
- 🎨 **Easy configuration** — Simple web-based configuration interface
- 🗄️ **Smart caching** — SQLite-based caching for faster subsequent requests

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

### Tips

- Set your native language first for best results
- Add English as a fallback for international content

## 🚀 Self-Hosting

### 🐳 Docker Compose (Recommended)

```yaml
services:
  subsense:
    image: nepiraw/subsense:latest
    container_name: subsense
    restart: unless-stopped
    ports:
      - "3100:3100"
    environment:
      - PORT=3100
      - LOG_LEVEL=info
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

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3100 | Server port |
| `SUBSENSE_BASE_URL` | Auto-detected | Public URL (for production deployments) |
| `LOG_LEVEL` | info | Logging level: `debug`, `info`, `warn`, `error` |
| `SUBTITLE_SOURCES` | All | Comma-separated list of sources |
| `ENABLE_CACHE` | true | Enable/disable caching |
| `CACHE_RETENTION_DAYS` | 30 | Days before cache cleanup |

### Available Subtitle Sources

`OpenSubtitles`, `Subdl`, `Subf2m`, `Podnapisi`, `AnimeTosho`, `Gestdown`

## 📊 Stats & Monitoring

Access the stats dashboard at `/stats` to view:
- Request counts and cache hit rates
- Provider performance metrics
- Language availability statistics
- Active user sessions

Browse cached content at `/stats/content`.

---

<div align="center">

**Enjoy! 😊**

[GitHub](https://github.com/NepiRaw/Stremio-SubSense) • [Issues](https://github.com/NepiRaw/Stremio-SubSense/issues)

</div>

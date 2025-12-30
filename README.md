<div align="center">

# SubSense - Stremio Subtitle Addon

<p>
  <img src="https://img.shields.io/github/v/release/nepiraw/Stremio-SubSense" alt="Version" />
  <img src="https://img.shields.io/badge/Stremio-Addon-purple" alt="Stremio" />
  <img src="https://img.shields.io/badge/Node.js-18+-brightgreen" alt="Node.js" />
</p>

</div>

---

<p align="center"><b>Subtitle aggregator for Stremio that fetches subtitles from multiple sources and add the preferred language in your Stremio's stream.</b></p>

---

## 🎯 Features

- 🔍 **Multi-source aggregation**: Fetches subtitles from OpenSubtitles, SubDL, Podnapisi, and more
- 🌍 **Multi-language support**: Primary and secondary language selection with priority handling
- 🔄 **ASS/SSA to SRT conversion**: Automatic conversion for maximum player compatibility
- ⚡ **Fast-first parallel strategy**: Returns results as soon as fastest provider responds
- 📊 **Statistics dashboard**: Track usage, cache hits, and performance metrics
- 🎨 **Easy configuration**: Simple web-based configuration interface
- 🏷️ **Smart filtering**: Removes duplicates and prioritizes highest quality subtitles

## 📋 Table of Contents

- [⚡ Quick Start](#-quick-start)
- [⚙️ Configuration](#️-configuration)
- [🚀 Self-Hosting Installation](#-self-hosting-installation)
  - [🐳 Docker Compose (Recommended)](#-docker-compose-recommended)
  - [📦 Manual Installation](#-manual-installation)
- [🔧 Environment Variables](#-environment-variables)
- [❓ FAQs](#-faqs)
- [📚 Documentation](#-documentation)

## ⚡ Quick Start

1. Navigate to your addon URL (default: `http://localhost:3100`)
2. Select your primary and optional secondary subtitle language
3. Click "Install Addon" to add SubSense to Stremio
4. Enjoy automatic subtitles for your movies and series!

## ⚙️ Configuration

### Access Configuration

1. Open the addon URL in your browser
2. Configure your preferred languages:
   - **Primary Language**: Main subtitle language (required)
   - **Secondary Language**: Fallback language (optional)
3. Click "Install Addon" button

### Configuration Options

| Option | Description |
|--------|-------------|
| **Primary Language** | Your preferred subtitle language (e.g., English, French) |
| **Secondary Language** | Optional fallback if primary not available |

### Recommendations

- Set your native language as primary for best results
- Add a secondary language (like English) as fallback for international content
- Install SubSense high in your addon list for faster subtitle loading

## 🚀 Self-Hosting Installation

### 🐳 Docker Compose (Recommended)

1. **Create a `docker-compose.yml` file:**

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
      - MAX_SUBTITLES=10
```

2. **Start the container:**

```bash
docker-compose up -d
```

3. **Access your addon:**

Open `http://localhost:3100` in your browser to configure the addon.

### 📦 Manual Installation

1. **Clone the repository:**

```bash
git clone https://github.com/NepiRaw/Stremio-SubSense.git
cd Stremio-SubSense
```

2. **Install dependencies:**

```bash
npm install
```

3. **Configure environment (optional):**

```bash
cp .env.example .env
# Edit .env with your preferences
```

4. **Start the addon:**

```bash
npm start
```

5. **Access your addon at `http://localhost:3100`**

### 🔺 Vercel Deployment

1. Fork this repository to your GitHub account
2. Deploy to Vercel:
   - Connect your GitHub repository to Vercel
   - Configure environment variables in the Vercel dashboard
   - Vercel will auto-detect and deploy

---

## 🔧 Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | ❌ | 3100 | Server port |
| `LOG_LEVEL` | ❌ | info | Logging level: error, warn, info, debug |
| `MAX_SUBTITLES` | ❌ | 10 | Maximum subtitles returned per language |

---


<div align="center">
<p>Enjoy 😊</p>
</div>

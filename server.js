require('dotenv').config();

const express = require('express');
const path = require('path');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');
const { generateManifest } = require('./manifest');
const statsService = require('./src/stats');
const { log } = require('./src/utils');
const { convertToSrt, isAssFormat } = require('./src/services/subtitle-converter');
const { bufferToUtf8 } = require('./src/utils/encoding');

const app = express();
const PORT = process.env.PORT || 3100;

// Start cache cleaner
if (process.env.ENABLE_CACHE !== 'false') {
    try {
        const { startCleaner } = require('./src/cache');
        startCleaner();
    } catch (error) {
        log('warn', `Cache cleaner not started: ${error.message}`);
    }
}

// Local URL for internal proxy calls (always localhost)
const LOCAL_BASE_URL = `http://127.0.0.1:${PORT}`;

// Public URL for display/manifest purposes (can be a production domain if set)
const PUBLIC_BASE_URL = process.env.SUBSENSE_BASE_URL || LOCAL_BASE_URL;

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Configuration page route
app.get('/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Handle /:config/configure requests (when Stremio tries to reconfigure)
app.get('/:config/configure', (req, res) => {
    // Redirect to the base configure page
    res.redirect('/configure');
});

// Stats dashboard page
app.get('/stats', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'stats.html'));
});

// Health check endpoint for Docker/Kubernetes
app.get('/health', (req, res) => {
    const health = {
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    };
    
    // Check if stats DB is accessible
    try {
        const statsDB = require('./src/cache').statsDB;
        if (statsDB) {
            const userCount = statsDB.getActiveUsersCount(30);
            health.database = { status: 'connected', activeUsers30d: userCount };
        } else {
            health.database = { status: 'not initialized' };
        }
    } catch (error) {
        health.database = { status: 'error', error: error.message };
        health.status = 'degraded';
    }
    
    const statusCode = health.status === 'ok' ? 200 : 503;
    res.status(statusCode).json(health);
});

// Stats JSON API endpoint
app.get('/stats/json', (req, res) => {
    res.json(statsService.getStats());
});

// Version API endpoint (for dynamic version display in UI)
app.get('/api/version', (req, res) => {
    const packageJson = require('./package.json');
    res.json({ version: packageJson.version });
});

// Languages API endpoint (for dynamic language list in configuration UI)
app.get('/api/languages', (req, res) => {
    const { getSupportedLanguages, LANGUAGE_TABLE } = require('./src/languages');
    
    // Support different formats via query param
    const format = req.query.format || 'simple';
    
    if (format === 'full') {
        // Return complete language table with all codes
        res.json(LANGUAGE_TABLE.map(lang => ({
            alpha2: lang.alpha2,
            alpha3B: lang.alpha3B,
            alpha3T: lang.alpha3T,
            name: lang.name,
            nativeName: lang.nativeName,
            providerCodes: lang.providerCodes
        })));
    } else {
        // Simple format for configure.js dropdown (code + name)
        res.json(LANGUAGE_TABLE.map(lang => ({
            code: lang.alpha3B,  // Use alpha3B for Stremio compatibility
            name: lang.name
        })));
    }
});

// =====================================================
// Stats API Endpoints
// =====================================================

// Load cache modules for stats endpoints
let statsDB = null;
try {
    const cache = require('./src/cache');
    statsDB = cache.statsDB;
} catch (error) {
    log('warn', `Stats API: cache module not available: ${error.message}`);
}

// Load validators
const validators = require('./src/utils/validators');

/**
 * Cache statistics API
 * Returns: cache entries, hit rate, size, etc.
 */
app.get('/api/stats/cache', (req, res) => {
    try {
        if (!statsDB) {
            return res.status(503).json({ error: 'Cache system not available' });
        }
        const cacheStats = statsDB.getCacheStats();
        res.json(cacheStats);
    } catch (error) {
        log('error', `API /stats/cache error: ${error.message}`);
        res.status(500).json({ error: 'Failed to get cache stats' });
    }
});

/**
 * Provider statistics API
 * Returns: per-provider performance metrics
 */
app.get('/api/stats/providers', (req, res) => {
    try {
        if (!statsDB) {
            return res.status(503).json({ error: 'Cache system not available' });
        }
        const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
        const providerStats = statsDB.getProviderStats(days);
        res.json(providerStats);
    } catch (error) {
        log('error', `API /stats/providers error: ${error.message}`);
        res.status(500).json({ error: 'Failed to get provider stats' });
    }
});

/**
 * Language statistics API
 * Returns: per-language availability metrics
 */
app.get('/api/stats/languages', (req, res) => {
    try {
        if (!statsDB) {
            return res.status(503).json({ error: 'Cache system not available' });
        }
        const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
        const languageStats = statsDB.getLanguageStats(days);
        res.json(languageStats);
    } catch (error) {
        log('error', `API /stats/languages error: ${error.message}`);
        res.status(500).json({ error: 'Failed to get language stats' });
    }
});

/**
 * Daily statistics API
 * Returns: daily aggregated stats
 */
app.get('/api/stats/daily', (req, res) => {
    try {
        if (!statsDB) {
            return res.status(503).json({ error: 'Cache system not available' });
        }
        const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
        const dailyStats = statsDB.getDailyStats(days);
        res.json(dailyStats);
    } catch (error) {
        log('error', `API /stats/daily error: ${error.message}`);
        res.status(500).json({ error: 'Failed to get daily stats' });
    }
});

/**
 * Active sessions history API
 * Returns: active session counts for different time ranges
 * Shows users active in each time window
 * @param days - Number of days (1, 3, 7, 14, 30, 60)
 */
app.get('/api/stats/sessions', (req, res) => {
    try {
        if (!statsDB) {
            return res.status(503).json({ error: 'Cache system not available' });
        }
        const requestedDays = parseInt(req.query.days, 10) || 30;
        const allowedDays = [1, 3, 7, 14, 30, 60];
        const days = allowedDays.includes(requestedDays) ? requestedDays : 30;
        
        // Get active users count for the specified period (cumulative for header)
        const activeCount = statsDB.getActiveUsersCount(days);
        
        // Helper to format date as "Jan 3" or "Jan 3, 12:00"
        const formatDate = (date, includeTime = false) => {
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const month = months[date.getMonth()];
            const day = date.getDate();
            if (includeTime) {
                const hours = date.getHours().toString().padStart(2, '0');
                return `${month} ${day}, ${hours}:00`;
            }
            return `${month} ${day}`;
        };
        
        // Helper to get midnight of a date (start of day)
        const getMidnight = (date) => {
            const d = new Date(date);
            d.setHours(0, 0, 0, 0);
            return Math.floor(d.getTime() / 1000);
        };
        
        // Breakdown for charting (point-in-time counts for each window)
        const breakdown = {
            days: days,
            activeUsers: activeCount,
            intervals: []
        };
        
        const now = new Date();
        
        // Create interval data points for the chart
        if (days === 1) {
            // For 1 day: every 2 hours windows (rolling), oldest to newest
            const windows = [];
            for (let h = 24; h > 0; h -= 2) {
                windows.push({ start: h, end: h - 2 });
            }
            for (const w of windows) {
                const pointDate = new Date(now.getTime() - w.start * 60 * 60 * 1000);
                breakdown.intervals.push({
                    label: formatDate(pointDate, true),
                    value: statsDB.getActiveUsersInWindow(w.start / 24, w.end / 24)
                });
            }
        } else if (days === 3) {
            // For 3 days: every 6 hours windows (rolling), oldest to newest
            for (let h = 72; h > 0; h -= 6) {
                const pointDate = new Date(now.getTime() - h * 60 * 60 * 1000);
                breakdown.intervals.push({
                    label: formatDate(pointDate, true),
                    value: statsDB.getActiveUsersInWindow(h / 24, (h - 6) / 24)
                });
            }
        } else {
            // For 7/14/30/60 days: use calendar days (midnight to midnight)
            const today = new Date(now);
            today.setHours(0, 0, 0, 0); // Start of today
            
            // Calculate number of days to show
            const daysToShow = days;
            
            // Generate daily points from oldest to today
            for (let d = daysToShow - 1; d >= 0; d--) {
                const dayStart = new Date(today.getTime() - d * 24 * 60 * 60 * 1000);
                const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
                
                const startTs = getMidnight(dayStart);
                const endTs = getMidnight(dayEnd);
                
                const isToday = d === 0;
                breakdown.intervals.push({
                    label: isToday ? formatDate(dayStart) + ' (today)' : formatDate(dayStart),
                    value: statsDB.getActiveUsersOnDay(startTs, endTs)
                });
            }
        }
        
        res.json(breakdown);
    } catch (error) {
        log('error', `API /stats/sessions error: ${error.message}`);
        res.status(500).json({ error: 'Failed to get session stats' });
    }
});

// =====================================================
// Content Cache Browser Endpoints
// =====================================================

/**
 * Search cache by IMDB ID
 * @param imdb - IMDB ID (validated: tt followed by 7-8 digits)
 */
app.get('/api/cache/search', (req, res) => {
    try {
        if (!statsDB) {
            return res.status(503).json({ error: 'Cache system not available' });
        }
        
        // Validate IMDB ID
        const validation = validators.validateImdbId(req.query.imdb);
        if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
        }
        
        const result = statsDB.searchCacheByImdb(validation.value);
        
        if (!result) {
            return res.status(404).json({ 
                error: 'Content not found in cache',
                imdbId: validation.value 
            });
        }
        
        res.json(result);
    } catch (error) {
        log('error', `API /cache/search error: ${error.message}`);
        res.status(500).json({ error: 'Failed to search cache' });
    }
});

/**
 * List cached content (paginated)
 * @param page - Page number (default: 1)
 * @param limit - Items per page (max: 100, default: 20)
 */
app.get('/api/cache/list', (req, res) => {
    try {
        if (!statsDB) {
            return res.status(503).json({ error: 'Cache system not available' });
        }
        
        const pagination = validators.validatePagination({
            page: req.query.page,
            limit: req.query.limit
        });
        
        const result = statsDB.getContentCacheSummary(pagination);
        res.json(result);
    } catch (error) {
        log('error', `API /cache/list error: ${error.message}`);
        res.status(500).json({ error: 'Failed to list cache' });
    }
});

/**
 * Content browser page
 */
app.get('/stats/content', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'content.html'));
});

/**
 * Custom manifest route with dynamic description based on config
 * This must be BEFORE the SDK router to intercept manifest requests
 * 
 * URL formats supported:
 * - /{config}/manifest.json
 * - /{userId}-{config}/manifest.json
 */
app.get('/:config/manifest.json', (req, res) => {
    const { config: configParam } = req.params;
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    
    log('info', `Manifest requested: ${fullUrl}`);
    
    // Extract UserID if present (format: userId-config)
    let userId = null;
    let configString = configParam;
    
    // Check if first 8 chars are alphanumeric followed by hyphen
    const userIdMatch = configParam.match(/^([a-z0-9]{8})-(.+)$/i);
    if (userIdMatch) {
        userId = userIdMatch[1].toLowerCase();
        configString = userIdMatch[2];
        log('debug', `UserID extracted: ${userId}`);
    }
    
    let config = {};
    try {
        config = JSON.parse(decodeURIComponent(configString));
        log('debug', `Parsed config: ${JSON.stringify(config)}`);
    } catch (e) {
        log('warn', `Failed to parse config from URL: ${configString}`);
    }
    
    // Store userId in config for later use in subtitle handler
    if (userId) {
        config.userId = userId;
    }
    
    // Generate manifest with dynamic description
    const manifest = generateManifest(config);
    
    // Remove configurationRequired after valid config is provided
    const hasValidConfig = config.languages && config.languages.length > 0;
    if (hasValidConfig) {
        delete manifest.behaviorHints.configurationRequired;
    }
    
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(manifest);
});

// Base manifest (without config) - still uses SDK default
app.get('/manifest.json', (req, res) => {
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    log('info', `Base manifest requested: ${fullUrl}`);
    
    const manifest = generateManifest();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(manifest);
});

// =====================================================
// BetaSeries Subtitle Proxy Endpoint
// =====================================================

/**
 * BetaSeries subtitle proxy - handles ZIP extraction for BetaSeries subtitles
 * URL format: /api/betaseries/proxy/:subtitleId?lang=vo|vf
 * 
 * This endpoint:
 * 1. Fetches the subtitle from BetaSeries
 * 2. If it's a ZIP file, extracts the SRT matching the requested language
 * 3. Caches the result for subsequent requests
 * 4. Returns the SRT content directly
 */
let AdmZip = null;
try {
    AdmZip = require('adm-zip');
} catch (e) {
    log('warn', 'adm-zip not installed - BetaSeries ZIP extraction disabled');
}

// Simple in-memory cache for extracted subtitles (with TTL)
const betaseriesSubtitleCache = new Map();
const BETASERIES_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function cleanBetaseriesCache() {
    const now = Date.now();
    for (const [key, value] of betaseriesSubtitleCache.entries()) {
        if (now - value.timestamp > BETASERIES_CACHE_TTL) {
            betaseriesSubtitleCache.delete(key);
        }
    }
}
// Clean cache every hour
setInterval(cleanBetaseriesCache, 60 * 60 * 1000);

app.get('/api/betaseries/proxy/:subtitleId', async (req, res) => {
    const { subtitleId } = req.params;
    const lang = req.query.lang || 'vo'; // Default to Original Version (English)
    
    const cacheKey = `${subtitleId}:${lang}`;
    
    log('debug', `[BetaSeries Proxy] Request: subtitleId=${subtitleId}, lang=${lang}`);
    
    try {
        // Check cache first
        const cached = betaseriesSubtitleCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < BETASERIES_CACHE_TTL) {
            log('debug', `[BetaSeries Proxy] Cache HIT for ${cacheKey}`);
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('X-BetaSeries-Cache', 'hit');
            return res.send(cached.content);
        }
        
        // Fetch from BetaSeries
        const betaseriesUrl = `https://www.betaseries.com/srt/${subtitleId}`;
        log('debug', `[BetaSeries Proxy] Fetching: ${betaseriesUrl}`);
        
        const response = await fetch(betaseriesUrl, {
            headers: { 'User-Agent': 'SubSense-Stremio/1.0' }
        });
        
        if (!response.ok) {
            log('error', `[BetaSeries Proxy] Fetch failed: ${response.status}`);
            return res.status(response.status).send('Failed to fetch subtitle');
        }
        
        const buffer = Buffer.from(await response.arrayBuffer());
        let srtContent;
        
        // Check if it's a ZIP file (PK signature)
        const isZip = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
        
        let originalFormat = 'srt';
        
        if (isZip) {
            if (!AdmZip) {
                log('error', '[BetaSeries Proxy] ZIP file received but adm-zip not installed');
                return res.status(500).send('ZIP extraction not available');
            }
            
            log('debug', `[BetaSeries Proxy] Extracting ZIP file (${buffer.length} bytes)`);
            
            try {
                const zip = new AdmZip(buffer);
                const entries = zip.getEntries();
                
                // Define subtitle file extensions we support
                const isSubtitleFile = (name) => {
                    const lower = name.toLowerCase();
                    return (lower.endsWith('.srt') || lower.endsWith('.ass') || lower.endsWith('.ssa')) 
                           && !name.startsWith('._'); // Skip macOS resource forks
                };
                
                // Language patterns for matching
                const langPatterns = {
                    'vf': ['.vf.', '.fr.', 'french', 'fra', '_vf', '-vf'],
                    'vo': ['.vo.', '.en.', 'english', 'eng', '_vo', '-vo', '_en', '-en']
                };
                
                const patterns = langPatterns[lang] || langPatterns['vo'];
                
                // Collect all subtitle files categorized
                const srtFiles = [];
                const assFiles = [];
                
                for (const entry of entries) {
                    const name = entry.entryName.toLowerCase();
                    if (isSubtitleFile(name)) {
                        if (name.endsWith('.srt')) {
                            srtFiles.push(entry);
                        } else if (name.endsWith('.ass') || name.endsWith('.ssa')) {
                            assFiles.push(entry);
                        }
                    }
                }
                
                log('debug', `[BetaSeries Proxy] Found ${srtFiles.length} SRT, ${assFiles.length} ASS files`);
                
                // Priority: Language-matching SRT > Any SRT > Language-matching ASS > Any ASS
                let targetEntry = null;
                
                // 1. Try language-specific SRT
                for (const entry of srtFiles) {
                    const name = entry.entryName.toLowerCase();
                    if (patterns.some(p => name.includes(p))) {
                        targetEntry = entry;
                        originalFormat = 'srt';
                        break;
                    }
                }
                
                // 2. Try any SRT
                if (!targetEntry && srtFiles.length > 0) {
                    targetEntry = srtFiles[0];
                    originalFormat = 'srt';
                }
                
                // 3. Try language-specific ASS
                if (!targetEntry) {
                    for (const entry of assFiles) {
                        const name = entry.entryName.toLowerCase();
                        if (patterns.some(p => name.includes(p))) {
                            targetEntry = entry;
                            originalFormat = 'ass';
                            break;
                        }
                    }
                }
                
                // 4. Try any ASS
                if (!targetEntry && assFiles.length > 0) {
                    targetEntry = assFiles[0];
                    originalFormat = 'ass';
                }
                
                if (!targetEntry) {
                    log('error', '[BetaSeries Proxy] No subtitle file (SRT/ASS) found in ZIP');
                    return res.status(404).send('No subtitle file found in archive');
                }
                
                log('debug', `[BetaSeries Proxy] Extracted: ${targetEntry.entryName} (format: ${originalFormat})`);
                const extractedContent = bufferToUtf8(targetEntry.getData());
                
                // If ASS file, convert to SRT
                if (originalFormat === 'ass') {
                    log('debug', `[BetaSeries Proxy] Converting ASS to SRT...`);
                    const result = convertToSrt(extractedContent);
                    srtContent = result.srt;
                    log('info', `[BetaSeries Proxy] Converted ${result.captionCount} captions from ASS to SRT`);
                } else {
                    srtContent = extractedContent;
                }
                
            } catch (zipError) {
                log('error', `[BetaSeries Proxy] ZIP extraction error: ${zipError.message}`);
                return res.status(500).send('Failed to extract subtitle from archive');
            }
            
        } else {
            // Not a ZIP, check if it's ASS or SRT content
            const rawContent = bufferToUtf8(buffer);
            
            if (isAssFormat(rawContent)) {
                log('debug', `[BetaSeries Proxy] Direct ASS file detected, converting...`);
                originalFormat = 'ass';
                const result = convertToSrt(rawContent);
                srtContent = result.srt;
                log('info', `[BetaSeries Proxy] Converted ${result.captionCount} captions from ASS to SRT`);
            } else {
                originalFormat = 'srt';
                srtContent = rawContent;
                log('debug', `[BetaSeries Proxy] Direct SRT file (${srtContent.length} chars)`);
            }
        }
        
        // Cache the result
        betaseriesSubtitleCache.set(cacheKey, {
            content: srtContent,
            originalFormat: originalFormat,
            timestamp: Date.now()
        });
        log('debug', `[BetaSeries Proxy] Cached: ${cacheKey}`);
        
        // Return the SRT content
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-BetaSeries-Cache', 'miss');
        res.setHeader('X-BetaSeries-Extracted', isZip ? 'yes' : 'no');
        res.setHeader('X-BetaSeries-Original-Format', originalFormat);
        if (originalFormat === 'ass') {
            res.setHeader('X-BetaSeries-Converted', 'yes');
        }
        res.send(srtContent);
        
    } catch (error) {
        log('error', `[BetaSeries Proxy] Error: ${error.message}`);
        res.status(500).send(`BetaSeries proxy error: ${error.message}`);
    }
});

// =====================================================
// YIFY Subtitle Proxy Endpoint
// =====================================================

/**
 * YIFY subtitle proxy - handles ZIP extraction for YIFY/YTS subtitles
 * URL format: /api/yify/proxy/:subtitleId
 * 
 * subtitleId format: {slug} (e.g., "the-matrix-1999-english-yify-383630")
 * 
 * This endpoint:
 * 1. Fetches the subtitle detail page from yts-subs.com
 * 2. Extracts the Base64-encoded download URL
 * 3. Downloads the ZIP file
 * 4. Extracts the SRT from the ZIP
 * 5. Returns the SRT content directly
 */
const yifySubtitleCache = new Map();
const YIFY_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function cleanYifyCache() {
    const now = Date.now();
    for (const [key, value] of yifySubtitleCache.entries()) {
        if (now - value.timestamp > YIFY_CACHE_TTL) {
            yifySubtitleCache.delete(key);
        }
    }
}
// Clean cache every hour
setInterval(cleanYifyCache, 60 * 60 * 1000);

app.get('/api/yify/proxy/:subtitleId', async (req, res) => {
    const { subtitleId } = req.params;
    
    log('debug', `[YIFY Proxy] Request: subtitleId=${subtitleId}`);
    
    try {
        // Check cache first
        const cached = yifySubtitleCache.get(subtitleId);
        if (cached && Date.now() - cached.timestamp < YIFY_CACHE_TTL) {
            log('debug', `[YIFY Proxy] Cache HIT for ${subtitleId}`);
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('X-YIFY-Cache', 'hit');
            return res.send(cached.content);
        }
        
        // Step 1: Fetch the subtitle detail page
        const subtitlePageUrl = `https://yts-subs.com/subtitles/${subtitleId}`;
        log('debug', `[YIFY Proxy] Fetching subtitle page: ${subtitlePageUrl}`);
        
        const pageResponse = await fetch(subtitlePageUrl, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        if (!pageResponse.ok) {
            log('error', `[YIFY Proxy] Page fetch failed: ${pageResponse.status}`);
            return res.status(pageResponse.status).send('Failed to fetch subtitle page');
        }
        
        const pageHtml = await pageResponse.text();
        const cheerio = require('cheerio');
        const $ = cheerio.load(pageHtml);
        
        // Step 2: Extract Base64-encoded download URL
        const downloadBtn = $('a.download-subtitle, a[data-link]').first();
        const dataLink = downloadBtn.attr('data-link');
        
        if (!dataLink) {
            log('error', '[YIFY Proxy] No data-link attribute found');
            return res.status(404).send('Download link not found');
        }
        
        const downloadUrl = Buffer.from(dataLink, 'base64').toString('utf-8');
        log('debug', `[YIFY Proxy] Download URL: ${downloadUrl}`);
        
        // Step 3: Download the ZIP file
        const zipResponse = await fetch(downloadUrl, {
            headers: { 'User-Agent': 'SubSense-Stremio/1.0' }
        });
        
        if (!zipResponse.ok) {
            log('error', `[YIFY Proxy] ZIP download failed: ${zipResponse.status}`);
            return res.status(zipResponse.status).send('Failed to download subtitle');
        }
        
        const buffer = Buffer.from(await zipResponse.arrayBuffer());
        
        // Step 4: Extract SRT from ZIP
        if (!AdmZip) {
            log('error', '[YIFY Proxy] adm-zip not installed');
            return res.status(500).send('ZIP extraction not available');
        }
        
        const zip = new AdmZip(buffer);
        const entries = zip.getEntries();
        
        // Find subtitle file with priority: SRT > ASS/SSA
        let subtitleEntry = null;
        let entryFormat = 'srt';
        
        // First try to find SRT (preferred)
        for (const entry of entries) {
            const name = entry.entryName.toLowerCase();
            if (name.endsWith('.srt') && !name.startsWith('._')) {
                subtitleEntry = entry;
                entryFormat = 'srt';
                break;
            }
        }
        
        // Fallback to ASS/SSA if no SRT found
        if (!subtitleEntry) {
            for (const entry of entries) {
                const name = entry.entryName.toLowerCase();
                if ((name.endsWith('.ass') || name.endsWith('.ssa')) && !name.startsWith('._')) {
                    subtitleEntry = entry;
                    entryFormat = 'ass';
                    break;
                }
            }
        }
        
        if (!subtitleEntry) {
            log('error', '[YIFY Proxy] No subtitle file (SRT/ASS) found in ZIP');
            return res.status(404).send('No subtitle file (SRT/ASS) found in archive');
        }
        
        let srtContent = bufferToUtf8(subtitleEntry.getData());
        log('debug', `[YIFY Proxy] Extracted: ${subtitleEntry.entryName} (format: ${entryFormat}, ${srtContent.length} chars)`);
        
        // Convert ASS to SRT if needed
        if (entryFormat === 'ass') {
            log('debug', '[YIFY Proxy] Converting ASS to SRT...');
            const result = convertToSrt(srtContent);
            srtContent = result.srt;
            log('info', `[YIFY Proxy] Converted ASS to SRT (${result.captionCount} captions)`);
        }
        
        // Cache the result
        yifySubtitleCache.set(subtitleId, {
            content: srtContent,
            originalFormat: entryFormat,
            timestamp: Date.now()
        });
        
        // Return the SRT content
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-YIFY-Cache', 'miss');
        res.setHeader('X-YIFY-Extracted', 'yes');
        res.setHeader('X-YIFY-Original-Format', entryFormat);
        if (entryFormat === 'ass') {
            res.setHeader('X-YIFY-Converted', 'yes');
        }
        res.send(srtContent);
        
    } catch (error) {
        log('error', `[YIFY Proxy] Error: ${error.message}`);
        res.status(500).send(`YIFY proxy error: ${error.message}`);
    }
});

// =====================================================
// TVsubtitles Proxy Endpoint
// =====================================================

/**
 * TVsubtitles subtitle proxy - handles download URL resolution and ZIP extraction
 * URL format: /api/tvsubtitles/proxy/:subtitleId?episodeUrl=xxx&lang=en
 * 
 * This endpoint:
 * 1. If episodeUrl provided, fetches it to get the actual subtitle page
 * 2. Parses the JavaScript download URL
 * 3. Downloads the ZIP file
 * 4. Extracts the SRT
 * 5. Returns the SRT content
 */
const tvsubsSubtitleCache = new Map();
const TVSUBS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function cleanTvsubsCache() {
    const now = Date.now();
    for (const [key, value] of tvsubsSubtitleCache.entries()) {
        if (now - value.timestamp > TVSUBS_CACHE_TTL) {
            tvsubsSubtitleCache.delete(key);
        }
    }
}
setInterval(cleanTvsubsCache, 60 * 60 * 1000);

app.get('/api/tvsubtitles/proxy/:subtitleId', async (req, res) => {
    const { subtitleId } = req.params;
    const { episodeUrl, lang } = req.query;
    
    const cacheKey = `${subtitleId}:${lang || 'en'}`;
    
    log('debug', `[TVsubs Proxy] Request: subtitleId=${subtitleId}, episodeUrl=${episodeUrl}, lang=${lang}`);
    
    try {
        // Check cache first
        const cached = tvsubsSubtitleCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < TVSUBS_CACHE_TTL) {
            log('debug', `[TVsubs Proxy] Cache HIT for ${cacheKey}`);
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('X-TVsubs-Cache', 'hit');
            return res.send(cached.content);
        }
        
        let downloadPageUrl;
        
        // If episodeUrl is provided, we need to find the subtitle link on that page
        if (episodeUrl) {
            log('debug', `[TVsubs Proxy] Fetching episode page: ${episodeUrl}`);
            const episodeResponse = await fetch(episodeUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            });
            
            if (!episodeResponse.ok) {
                return res.status(episodeResponse.status).send('Failed to fetch episode page');
            }
            
            const episodeHtml = await episodeResponse.text();
            const cheerio = require('cheerio');
            const $episode = cheerio.load(episodeHtml);
            
            // Find the subtitle download link
            const subtitleLink = $episode(`a[href*="/subtitle-${subtitleId}.html"]`).first();
            if (subtitleLink.length) {
                const href = subtitleLink.attr('href');
                downloadPageUrl = href.startsWith('http') ? href : `http://www.tvsubtitles.net${href}`;
            }
        }
        
        // If no episodeUrl or couldn't find link, go directly to download page
        // TVsubtitles structure: subtitle-{id}.html is info page, download-{id}.html has the JS with file path
        if (!downloadPageUrl) {
            downloadPageUrl = `http://www.tvsubtitles.net/download-${subtitleId}.html`;
        } else if (downloadPageUrl.includes('subtitle-')) {
            // Convert subtitle-{id}.html to download-{id}.html
            downloadPageUrl = downloadPageUrl.replace('subtitle-', 'download-');
        }
        
        log('debug', `[TVsubs Proxy] Fetching download page: ${downloadPageUrl}`);
        const downloadPageResponse = await fetch(downloadPageUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        
        if (!downloadPageResponse.ok) {
            return res.status(downloadPageResponse.status).send('Failed to fetch download page');
        }
        
        const downloadPageHtml = await downloadPageResponse.text();
        
        // Parse JavaScript for download URL: s1+s2+s3+s4 pattern
        // The page uses single quotes: var s1= 'fil';
        const s1Match = downloadPageHtml.match(/var s1\s*=\s*['"]([^'"]+)['"]/);
        const s2Match = downloadPageHtml.match(/var s2\s*=\s*['"]([^'"]+)['"]/);
        const s3Match = downloadPageHtml.match(/var s3\s*=\s*['"]([^'"]+)['"]/);
        const s4Match = downloadPageHtml.match(/var s4\s*=\s*['"]([^'"]+)['"]/);
        
        if (!s1Match || !s2Match || !s3Match || !s4Match) {
            log('error', '[TVsubs Proxy] Could not parse download URL from JavaScript');
            log('debug', `[TVsubs Proxy] Page content sample: ${downloadPageHtml.substring(0, 500)}`);
            return res.status(404).send('Download URL not found');
        }
        
        // The JavaScript builds the path: s1='fil', s2='es/B', s3='re', s4='aking Bad_1x01_es.zip'
        // Combined: 'files/Breaking Bad_1x01_es.zip' - already includes 'files/' prefix
        const filename = s1Match[1] + s2Match[1] + s3Match[1] + s4Match[1];
        const downloadUrl = `http://www.tvsubtitles.net/${filename}`;
        log('debug', `[TVsubs Proxy] Download URL: ${downloadUrl}`);
        
        // Download the ZIP file
        const zipResponse = await fetch(downloadUrl, {
            headers: { 'User-Agent': 'SubSense-Stremio/1.0' }
        });
        
        if (!zipResponse.ok) {
            return res.status(zipResponse.status).send('Failed to download subtitle');
        }
        
        const buffer = Buffer.from(await zipResponse.arrayBuffer());
        
        // Check if it's a ZIP or raw SRT
        const isZip = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
        
        let srtContent;
        let originalFormat = 'srt';
        
        if (isZip) {
            if (!AdmZip) {
                return res.status(500).send('ZIP extraction not available');
            }
            
            const zip = new AdmZip(buffer);
            const entries = zip.getEntries();
            
            // Find subtitle file with priority: SRT > ASS/SSA
            let subtitleEntry = null;
            
            // First try to find SRT (preferred)
            for (const entry of entries) {
                const name = entry.entryName.toLowerCase();
                if (name.endsWith('.srt') && !name.startsWith('._')) {
                    subtitleEntry = entry;
                    originalFormat = 'srt';
                    break;
                }
            }
            
            // Fallback to ASS/SSA if no SRT found
            if (!subtitleEntry) {
                for (const entry of entries) {
                    const name = entry.entryName.toLowerCase();
                    if ((name.endsWith('.ass') || name.endsWith('.ssa')) && !name.startsWith('._')) {
                        subtitleEntry = entry;
                        originalFormat = 'ass';
                        break;
                    }
                }
            }
            
            if (!subtitleEntry) {
                return res.status(404).send('No subtitle file (SRT/ASS) found in archive');
            }
            
            srtContent = bufferToUtf8(subtitleEntry.getData());
            log('debug', `[TVsubs Proxy] Extracted: ${subtitleEntry.entryName} (format: ${originalFormat})`);
            
            // Convert ASS to SRT if needed
            if (originalFormat === 'ass') {
                log('debug', '[TVsubs Proxy] Converting ASS to SRT...');
                const result = convertToSrt(srtContent);
                srtContent = result.srt;
                log('info', `[TVsubs Proxy] Converted ASS to SRT (${result.captionCount} captions)`);
            }
        } else {
            // Raw content - check if ASS
            srtContent = bufferToUtf8(buffer);
            
            if (isAssFormat(srtContent)) {
                originalFormat = 'ass';
                log('debug', '[TVsubs Proxy] Raw ASS content, converting to SRT...');
                const result = convertToSrt(srtContent);
                srtContent = result.srt;
                log('info', `[TVsubs Proxy] Converted ASS to SRT (${result.captionCount} captions)`);
            } else {
                log('debug', `[TVsubs Proxy] Raw SRT content (${srtContent.length} chars)`);
            }
        }
        
        // Cache the result
        tvsubsSubtitleCache.set(cacheKey, {
            content: srtContent,
            originalFormat: originalFormat,
            timestamp: Date.now()
        });
        
        // Return the SRT content
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-TVsubs-Cache', 'miss');
        res.setHeader('X-TVsubs-Extracted', isZip ? 'yes' : 'no');
        res.setHeader('X-TVsubs-Original-Format', originalFormat);
        if (originalFormat === 'ass') {
            res.setHeader('X-TVsubs-Converted', 'yes');
        }
        res.send(srtContent);
        
    } catch (error) {
        log('error', `[TVsubs Proxy] Error: ${error.message}`);
        res.status(500).send(`TVsubtitles proxy error: ${error.message}`);
    }
});

/**
 * Subtitle proxy endpoint - converts ASS/SSA to SRT on the fly OR passes through as-is
 * URL format: /api/subtitle/:format/{encoded_original_url}
 * 
 * Supported formats:
 * - /api/subtitle/srt/{url} - Convert ASS to SRT, pass through SRT as-is
 * - /api/subtitle/ass/{url} - Pass through original content (no conversion)
 * 
 * This allows Stremio to receive both formats:
 * - Original ASS for devices that support it (better styling)
 * - Converted SRT for devices that don't support ASS
 */
app.get('/api/subtitle/:format/*', async (req, res) => {
    const { format } = req.params;
    const originalUrl = req.params[0]; // Everything after /api/subtitle/:format/
    
    log('debug', `Subtitle proxy request: format=${format}, url=${originalUrl}`);
    
    try {
        // Fetch the original subtitle
        const response = await fetch(originalUrl);
        
        if (!response.ok) {
            log('error', `Failed to fetch subtitle: ${response.status} ${response.statusText}`);
            return res.status(response.status).send('Failed to fetch subtitle');
        }
        
        const content = await response.text();
        
        // ASS format requested - pass through as-is (no conversion)
        if (format === 'ass' || format === 'ssa') {
            log('debug', `Passing through ASS subtitle (${content.length} chars)`);
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('X-SubSense-Format', 'ass-passthrough');
            return res.send(content);
        }
        
        // If SRT format requested and content is ASS, convert it
        if (format === 'srt' && isAssFormat(content)) {
            log('debug', `Converting ASS to SRT (${content.length} chars)`);
            
            const result = convertToSrt(content);
            
            log('info', `Subtitle converted: ${result.originalFormat} → SRT (${result.captionCount} captions)`);
            
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('X-Original-Format', result.originalFormat);
            res.setHeader('X-Caption-Count', result.captionCount);
            res.setHeader('X-SubSense-Format', 'converted-to-srt');
            return res.send(result.srt);
        }
        
        // Otherwise, pass through as-is
        res.setHeader('Content-Type', response.headers.get('content-type') || 'text/plain');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-SubSense-Format', 'passthrough');
        res.send(content);
        
    } catch (error) {
        log('error', `Subtitle proxy error: ${error.message}`);
        res.status(500).send(`Subtitle proxy error: ${error.message}`);
    }
});

// Import handleSubtitles for custom subtitles route
const { handleSubtitles } = require('./src/subtitles');
const { parseConfig } = require('./src/config');

/**
 * Custom subtitles route to handle JSON config format
 * Stremio SDK doesn't parse JSON configs, so we handle it ourselves
 * 
 * URL formats:
 * - /{config}/subtitles/{type}/{id}.json (legacy - no UserID)
 * - /{userId}-{config}/subtitles/{type}/{id}.json (new - with 8-char UserID)
 * - /{config}/subtitles/{type}/{id}/{extra}.json (with video metadata from Stremio web)
 * 
 * The :extra parameter contains video metadata like filename, videoSize, videoHash
 * Example: filename=https://...&videoSize=123456&videoHash=abc123
 */
app.get('/:config/subtitles/:type/:id/:extra?.json', async (req, res) => {
    const { config: configParam, type, id, extra } = req.params;
    
    log('debug', `Subtitle request: config=${configParam}, type=${type}, id=${id}, extra=${extra || 'none'}`);
    
    try {
        // Extract UserID if present (format: userId-config)
        let userId = null;
        let configString = configParam;
        
        const userIdMatch = configParam.match(/^([a-z0-9]{8})-(.+)$/i);
        if (userIdMatch) {
            userId = userIdMatch[1].toLowerCase();
            configString = userIdMatch[2];
            log('debug', `UserID extracted: ${userId}`);
        }
        
        // Parse JSON config from URL
        let config = {};
        try {
            config = JSON.parse(decodeURIComponent(configString));
        } catch (e) {
            log('warn', `Failed to parse config: ${configString}`);
            return res.status(400).json({ subtitles: [], error: 'Invalid config format' });
        }
        
        // Store userId in config for tracking
        if (userId) {
            config.userId = userId;
        }
        
        // Validate config
        const validatedConfig = parseConfig(config);
        
        // Preserve userId after validation
        if (userId) {
            validatedConfig.userId = userId;
        }
        
        // Build args object like Stremio SDK does
        const args = {
            type,
            id,
            config: validatedConfig
        };
        
        // Handle the subtitle request
        const result = await handleSubtitles(args, validatedConfig);
        
        log('debug', `Returning ${result.subtitles.length} subtitles`);
        
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json(result);
        
    } catch (error) {
        log('error', `Subtitle handler error: ${error.message}`);
        res.status(500).json({ subtitles: [], error: error.message });
    }
});

// Mount the Stremio addon routes (for subtitles, etc.)
app.use(getRouter(addonInterface));

// Start server
app.listen(PORT, () => {
    log('info', `[Server] SubSense addon running at ${PUBLIC_BASE_URL}`);
    log('info', `[Server] Configure at ${PUBLIC_BASE_URL}/configure`);
    log('info', `[Server] Stats at ${PUBLIC_BASE_URL}/stats`);
    log('info', `[Server] Manifest at ${PUBLIC_BASE_URL}/manifest.json`);
    if (PUBLIC_BASE_URL !== LOCAL_BASE_URL) {
        log('info', `[Server] Internal proxy URL: ${LOCAL_BASE_URL}`);
    }
});

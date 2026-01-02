require('dotenv').config();

const express = require('express');
const path = require('path');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');
const { generateManifest } = require('./manifest');
const statsService = require('./src/stats');
const { log } = require('./src/utils');
const { convertToSrt, isAssFormat } = require('./src/services/subtitle-converter');

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

// Stats JSON API endpoint
app.get('/stats/json', (req, res) => {
    res.json(statsService.getStats());
});

// Version API endpoint (for dynamic version display in UI)
app.get('/api/version', (req, res) => {
    const packageJson = require('./package.json');
    res.json({ version: packageJson.version });
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
    
    // Remove configurationRequired after config is provided (so addon is installable)
    // Check for new format (languages array) or legacy format (primaryLang)
    const hasValidConfig = (config.languages && config.languages.length > 0) || config.primaryLang;
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

/**
 * Subtitle proxy endpoint - converts ASS/SSA to SRT on the fly
 * URL format: /api/subtitle/srt/{encoded_original_url}
 * 
 * This allows Stremio to receive SRT format which it handles better
 * than ASS format (which can cause "no tracks" errors in some cases)
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
        
        // If SRT format requested and content is ASS, convert it
        if (format === 'srt' && isAssFormat(content)) {
            log('debug', `Converting ASS to SRT (${content.length} chars)`);
            
            const result = convertToSrt(content);
            
            log('info', `Subtitle converted: ${result.originalFormat} → SRT (${result.captionCount} captions)`);
            
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('X-Original-Format', result.originalFormat);
            res.setHeader('X-Caption-Count', result.captionCount);
            return res.send(result.srt);
        }
        
        // Otherwise, pass through as-is
        res.setHeader('Content-Type', response.headers.get('content-type') || 'text/plain');
        res.setHeader('Access-Control-Allow-Origin', '*');
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
 */
app.get('/:config/subtitles/:type/:id.json', async (req, res) => {
    const { config: configParam, type, id } = req.params;
    
    log('debug', `Subtitle request: config=${configParam}, type=${type}, id=${id}`);
    
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
    log('info', `SubSense addon running at ${PUBLIC_BASE_URL}`);
    log('info', `Configure at ${PUBLIC_BASE_URL}/configure`);
    log('info', `Stats at ${PUBLIC_BASE_URL}/stats`);
    log('info', `Manifest at ${PUBLIC_BASE_URL}/manifest.json`);
    if (PUBLIC_BASE_URL !== LOCAL_BASE_URL) {
        log('info', `Internal proxy URL: ${LOCAL_BASE_URL}`);
    }
});

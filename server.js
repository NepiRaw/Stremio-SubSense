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

/**
 * Custom manifest route with dynamic description based on config
 * This must be BEFORE the SDK router to intercept manifest requests
 */
app.get('/:config/manifest.json', (req, res) => {
    const { config: configParam } = req.params;
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    
    log('info', `Manifest requested: ${fullUrl}`);
    
    let config = {};
    try {
        config = JSON.parse(decodeURIComponent(configParam));
        log('debug', `Parsed config: ${JSON.stringify(config)}`);
    } catch (e) {
        log('warn', `Failed to parse config from URL: ${configParam}`);
    }
    
    // Generate manifest with dynamic description
    const manifest = generateManifest(config);
    
    // Remove configurationRequired after config is provided (so addon is installable)
    if (config.primaryLang) {
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

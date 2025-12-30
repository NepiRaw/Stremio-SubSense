const { addonBuilder } = require('stremio-addon-sdk');
const { generateManifest } = require('./manifest');
const { handleSubtitles } = require('./src/subtitles');
const { parseConfig } = require('./src/config');
const { log } = require('./src/utils');

// Create addon with base manifest
const manifest = generateManifest();
const builder = new addonBuilder(manifest);

// Define subtitles handler
builder.defineSubtitlesHandler(async (args) => {
    log('debug', `Subtitle request: type=${args.type}, id=${args.id}`);
    
    try {
        // Parse config from args (when using manifest config) or from URL
        const config = args.config || {};
        
        // Validate config
        const validatedConfig = parseConfig(config);
        
        // Handle the subtitle request
        const result = await handleSubtitles(args, validatedConfig);
        
        log('debug', `Returning ${result.subtitles.length} subtitles`);
        return result;
        
    } catch (error) {
        log('error', `Subtitle handler error: ${error.message}`);
        return { subtitles: [] };
    }
});

module.exports = builder.getInterface();

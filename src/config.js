const { isValidLanguage } = require('./languages');
const { log } = require('./utils');

/**
 * Parse and validate user configuration
 * @param {Object|string} config - Config object or comma-separated string
 * @returns {Object} Validated config with primaryLang and secondaryLang
 * @throws {Error} If primary language is not configured
 */
function parseConfig(config) {
    let primaryLang = null;
    let secondaryLang = 'none';

    // Handle different config formats
    if (typeof config === 'string' && config.length > 0) {
        // Comma-separated format: "eng,fra" (legacy support)
        const parts = config.split(',');
        primaryLang = parts[0] || null;
        secondaryLang = parts[1] || 'none';
    } else if (typeof config === 'object' && config !== null) {
        // Object format from Stremio SDK
        primaryLang = config.primaryLang || null;
        secondaryLang = config.secondaryLang || 'none';
    }

    // Require primary language - no defaults
    if (!primaryLang) {
        log('error', 'Primary language not configured. User must configure addon via /configure page.');
        throw new Error('Primary language not configured. Please configure the addon first.');
    }

    // Validate primary language
    if (!isValidLanguage(primaryLang)) {
        log('error', `Invalid primary language: ${primaryLang}`);
        throw new Error(`Invalid primary language: ${primaryLang}`);
    }

    // Validate secondary language
    if (secondaryLang !== 'none' && !isValidLanguage(secondaryLang)) {
        log('warn', `Invalid secondary language: ${secondaryLang}, defaulting to 'none'`);
        secondaryLang = 'none';
    }

    // Ensure secondary is different from primary
    if (secondaryLang !== 'none' && secondaryLang === primaryLang) {
        log('warn', `Secondary language same as primary, setting to 'none'`);
        secondaryLang = 'none';
    }

    log('debug', `Config parsed: primary=${primaryLang}, secondary=${secondaryLang}`);

    return {
        primaryLang,
        secondaryLang
    };
}

/**
 * Encode config to URL-safe string
 * @param {Object} config - Config object
 * @returns {string} URL-safe config string
 */
function encodeConfig(config) {
    const { primaryLang, secondaryLang } = config;
    if (secondaryLang === 'none') {
        return primaryLang;
    }
    return `${primaryLang},${secondaryLang}`;
}

module.exports = {
    parseConfig
};

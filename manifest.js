const { getSupportedLanguages, getLanguageName } = require('./src/languages');
const { log } = require('./src/utils');

/**
 * Generate a dynamic description based on user configuration
 * @param {Object} config - User configuration with primaryLang and secondaryLang
 * @returns {string} Description string
 */
function generateDescription(config = {}) {
    const { primaryLang, secondaryLang } = config;
    
    if (!primaryLang) {
        return 'Subtitle aggregator that fetches subtitles in your selected languages from multiple sources including OpenSubtitles, SubDL, Podnapisi, and more.';
    }

    const primaryName = getLanguageName(primaryLang);
    
    if (secondaryLang && secondaryLang !== 'none') {
        const secondaryName = getLanguageName(secondaryLang);
        return `Get subtitles in your selected languages (${primaryName} and ${secondaryName}) from various sources.`;
    }
    
    return `Get subtitles in your selected language (${primaryName}) from various sources.`;
}

/**
 * Generate a dynamic manifest based on user configuration
 * @param {Object} config - User configuration
 * @returns {Object} Stremio manifest
 */
function generateManifest(config = {}) {
    const languages = getSupportedLanguages();
    const languageOptions = languages.map(lang => lang.code);
    const description = generateDescription(config);

    log('debug', `Generating manifest with description: "${description}"`);

    return {
        id: 'com.subsense.addon',
        version: '1.0.0',
        name: 'SubSense',
        description: description,
        logo: 'https://raw.githubusercontent.com/your-repo/subsense/main/logo.png',
        resources: ['subtitles'],
        types: ['movie', 'series'],
        idPrefixes: ['tt'],
        catalogs: [],
        behaviorHints: {
            configurable: true,
            configurationRequired: true
        },
        config: [
            {
                key: 'primaryLang',
                type: 'select',
                title: 'Primary Language',
                required: true
            },
            {
                key: 'secondaryLang',
                type: 'select',
                title: 'Secondary Language (Optional)',
                default: 'none',
                required: false
            }
        ]
    };
}

module.exports = { generateManifest, generateDescription };

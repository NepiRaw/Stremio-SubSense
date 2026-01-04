const { getSupportedLanguages, getLanguageName } = require('./src/languages');
const { log } = require('./src/utils');
const packageJson = require('./package.json');

/**
 * Generate a dynamic description based on user configuration
 * @param {Object} config - User configuration with languages array
 * @returns {string} Description string
 */
function generateDescription(config = {}) {
    // Require languages array
    if (!config.languages || config.languages.length === 0) {
        return 'Subtitle aggregator that fetches subtitles in your selected languages from multiple sources including OpenSubtitles, SubDL, Podnapisi, and more.';
    }
    
    const languageNames = config.languages.map(code => getLanguageName(code)).filter(Boolean);
    
    if (languageNames.length === 1) {
        return `Get subtitles in ${languageNames[0]} from multiple sources.`;
    } else if (languageNames.length === 2) {
        return `Get subtitles in ${languageNames.join(' and ')} from multiple sources.`;
    } else {
        const names = [...languageNames];
        const lastLang = names.pop();
        return `Get subtitles in ${names.join(', ')} and ${lastLang} from multiple sources.`;
    }
}

/**
 * Generate a dynamic manifest based on user configuration
 * @param {Object} config - User configuration
 * @returns {Object} Stremio manifest
 */
function generateManifest(config = {}) {
    const description = generateDescription(config);

    log('debug', `Generating manifest with description: "${description}"`);

    return {
        id: 'com.subsense.nepiraw',
        version: packageJson.version,
        name: 'SubSense',
        description: description,
        logo: 'https://i.imgur.com/FaDbQAp.png',
        background: 'https://images.unsplash.com/photo-1570284613060-766c33850e00?q=80&w=1470&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D',
        resources: ['subtitles'],
        types: ['movie', 'series'],
        idPrefixes: ['tt'],
        catalogs: [],
        behaviorHints: {
            configurable: true,
            configurationRequired: true
        }
    };
}

module.exports = { generateManifest, generateDescription };

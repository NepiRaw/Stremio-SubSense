const languages = require('@cospired/i18n-iso-languages');

// Register English locale for language names
languages.registerLocale(require('@cospired/i18n-iso-languages/langs/en.json'));

/**
 * Common subtitle languages (ISO 639-2/B codes as used by Stremio)
 * We curate a list of common languages rather than all 185+
 */
const COMMON_LANGUAGE_CODES = [
    'eng', // English
    'spa', // Spanish
    'fra', // French
    'ger', // German
    'por', // Portuguese
    'ita', // Italian
    'rus', // Russian
    'jpn', // Japanese
    'kor', // Korean
    'chi', // Chinese
    'ara', // Arabic
    'hin', // Hindi
    'tur', // Turkish
    'pol', // Polish
    'dut', // Dutch
    'swe', // Swedish
    'nor', // Norwegian
    'dan', // Danish
    'fin', // Finnish
    'gre', // Greek
    'heb', // Hebrew
    'cze', // Czech
    'hun', // Hungarian
    'rum', // Romanian
    'bul', // Bulgarian
    'ukr', // Ukrainian
    'tha', // Thai
    'vie', // Vietnamese
    'ind', // Indonesian
    'may', // Malay
];

/**
 * Get list of supported languages with code and name
 * @returns {Array<{code: string, name: string}>}
 */
function getSupportedLanguages() {
    return COMMON_LANGUAGE_CODES.map(code => {
        // Try to get the name from the library
        const name = languages.getName(code, 'en') || code.toUpperCase();
        return { code, name };
    });
}

/**
 * Get language name from ISO 639-2/B code
 * @param {string} code - ISO 639-2/B language code (e.g., 'eng')
 * @returns {string} Language name
 */
function getLanguageName(code) {
    if (!code || code === 'none') return 'None';
    return languages.getName(code, 'en') || code.toUpperCase();
}

/**
 * Validate if a language code is supported
 * @param {string} code - Language code to validate
 * @returns {boolean}
 */
function isValidLanguage(code) {
    return code === 'none' || COMMON_LANGUAGE_CODES.includes(code);
}

/**
 * Map wyzie-lib language format to ISO 639-2
 * wyzie-lib uses ISO 639-1 (2-letter), Stremio uses ISO 639-2 (3-letter)
 * @param {string} wyzieCode - 2-letter code from wyzie
 * @returns {string} 3-letter ISO 639-2/B code
 */
function mapWyzieToStremio(wyzieCode) {
    if (!wyzieCode) return 'und'; // undefined
    
    // Try to convert 2-letter to 3-letter (using B variant for Stremio)
    const alpha3 = languages.alpha2ToAlpha3B(wyzieCode.toLowerCase());
    return alpha3 || wyzieCode;
}

/**
 * Map ISO 639-2 to wyzie-lib format (ISO 639-1)
 * @param {string} stremioCode - 3-letter ISO 639-2/B code
 * @returns {string} 2-letter code for wyzie
 */
function mapStremioToWyzie(stremioCode) {
    if (!stremioCode || stremioCode === 'none') return null;
    
    const code = stremioCode.toLowerCase();
    
    // Note: The @cospired/i18n-iso-languages library has B/T codes swapped for some languages
    // (e.g., it treats 'fra' as T-code when it's actually B-code in ISO 639-2)
    // So we try BOTH alpha3T and alpha3B lookups to handle all cases correctly
    const alpha2 = languages.alpha3TToAlpha2(code) || languages.alpha3BToAlpha2(code);
    
    return alpha2 || code;
}

module.exports = {
    getSupportedLanguages,
    getLanguageName,
    isValidLanguage,
    mapWyzieToStremio,
    mapStremioToWyzie
};

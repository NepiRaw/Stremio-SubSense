/**
 * Encoding utilities for subtitle files
 * Detect and convert encodings to UTF-8.
 * 
 * Subtitle files are encoded in various formats (Latin-1, Windows-1252, UTF-8, etc.)
 */

const chardet = require('chardet');
const iconv = require('iconv-lite');

/**
 * Detect encoding of a buffer and convert to UTF-8 string
 */
function bufferToUtf8(buffer) {
    if (!buffer || buffer.length === 0) return '';

    if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
        return buffer.toString('utf-8').slice(1); // Remove BOM
    }
    if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
        return iconv.decode(buffer, 'utf-16le');
    }
    if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
        return iconv.decode(buffer, 'utf-16be');
    }
    
    const detected = chardet.detect(buffer);
    
    if (!detected) {
        try {
            const utf8 = buffer.toString('utf-8');
            if (!utf8.includes('\uFFFD')) {
                return utf8;
            }
        } catch (e) {
            // Ignore
        }
        
        return iconv.decode(buffer, 'iso-8859-1');
    }
    const resolvedEncoding = resolveAmbiguousEncoding(buffer, detected);

    const encodingMap = {
        'ISO-8859-1': 'iso-8859-1',
        'ISO-8859-2': 'iso-8859-2',
        'ISO-8859-9': 'iso-8859-9',
        'ISO-8859-15': 'iso-8859-15',
        'ISO-8859-16': 'iso-8859-16',
        'windows-1250': 'windows-1250',
        'windows-1251': 'windows-1251',
        'windows-1252': 'windows-1252',
        'windows-1253': 'windows-1253',
        'windows-1254': 'windows-1254',
        'windows-1255': 'windows-1255',
        'windows-1256': 'windows-1256',
        'UTF-8': 'utf-8',
        'ascii': 'utf-8',
        'Big5': 'big5',
        'GB2312': 'gb2312',
        'GBK': 'gbk',
        'GB18030': 'gb18030',
        'EUC-KR': 'euc-kr',
        'Shift_JIS': 'shift-jis',
        'EUC-JP': 'euc-jp',
        'ISO-2022-JP': 'iso-2022-jp',
        'KOI8-R': 'koi8-r',
        'KOI8-U': 'koi8-u',
        'TIS-620': 'tis-620'
    };
    
    const normalizedEncoding = encodingMap[resolvedEncoding] || resolvedEncoding.toLowerCase();
    
    if (!iconv.encodingExists(normalizedEncoding)) {
        console.warn(`[Encoding] Unknown encoding: ${resolvedEncoding}, falling back to Latin-1`);
        return iconv.decode(buffer, 'iso-8859-1');
    }
    
    return iconv.decode(buffer, normalizedEncoding);
}

/**
 * Resolve ambiguous encoding detection between windows-1250 and windows-1252.
 */
function resolveAmbiguousEncoding(buffer, detected) {
    if (detected !== 'windows-1252') return detected;
    
    let hasSlavicMarkers = false;
    let hasDifferentiatingBytes = false;
    
    for (let i = 0; i < buffer.length; i++) {
        const b = buffer[i];
        if (b === 0x8A || b === 0x9A || b === 0x8E || b === 0x9E) {
            hasSlavicMarkers = true;
        }
        if (b === 0xC8 || b === 0xE8 || b === 0xC6 || b === 0xE6 ||
            b === 0xD0 || b === 0xF0 || b === 0xD8 || b === 0xF8) {
            hasDifferentiatingBytes = true;
        }
        if (hasSlavicMarkers && hasDifferentiatingBytes) {
            return 'windows-1250';
        }
    }
    
    return detected;
}

/**
 * Convert a buffer to UTF-8 and get encoding info
 */
function bufferToUtf8WithInfo(buffer) {
    const detected = chardet.detect(buffer) || 'unknown';
    const content = bufferToUtf8(buffer);
    
    return {
        content,
        detectedEncoding: detected
    };
}

module.exports = {
    bufferToUtf8,
    bufferToUtf8WithInfo
};

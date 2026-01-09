/**
 * Filename Similarity Matching Utilities (v2)
 * Uses @ctrl/video-filename-parser for rich filename parsing.
 */

const { log } = require('../utils');

const parseCache = new Map();
const CACHE_MAX_SIZE = 1000;
let filenameParse = null;

/** Initialize ESM parser */
async function getParser() {
    if (!filenameParse) {
        const module = await import('@ctrl/video-filename-parser');
        filenameParse = module.filenameParse;
    }
    return filenameParse;
}

/** Check if string is a real filename (not URL or empty) */
function isRealFilename(filename) {
    if (!filename || typeof filename !== 'string') return false;
    if (filename.startsWith('http://') || filename.startsWith('https://')) return false;
    const hasMediaExtension = /\.(mkv|mp4|avi|mov|webm|wmv|flv|m4v|srt|sub|ass|ssa|vtt)$/i.test(filename);
    const hasReleaseParts = /[\.\-_]/.test(filename) && filename.length > 10;
    return hasMediaExtension || hasReleaseParts;
}

/** Parse filename with caching */
function parseFilename(filename, isTv = true) {
    if (!filename || !filenameParse) return null;
    
    const cacheKey = `${filename}:${isTv}`;
    if (parseCache.has(cacheKey)) return parseCache.get(cacheKey);
    
    try {
        const parsed = filenameParse(filename, isTv);
        if (parseCache.size >= CACHE_MAX_SIZE) {
            const firstKey = parseCache.keys().next().value;
            parseCache.delete(firstKey);
        }
        parseCache.set(cacheKey, parsed);
        return parsed;
    } catch (error) {
        log('debug', `[Filename Matching] Parse error: ${error.message}`);
        return null;
    }
}

/** Sync parse using cache or fallback regex */
function parseFilenameSync(filename) {
    if (!filename) return {};
    
    const cacheKey = `${filename}:true`;
    if (parseCache.has(cacheKey)) return parseCache.get(cacheKey);
    
    const fallback = {
        group: extractReleaseGroupSimple(filename),
        resolution: extractResolutionSimple(filename),
        sources: extractSourcesSimple(filename),
        videoCodec: extractCodecSimple(filename),
        seasons: [],
        episodeNumbers: []
    };
    
    const seMatch = filename.match(/[Ss](\d+)[Ee](\d+)/);
    if (seMatch) {
        fallback.seasons = [parseInt(seMatch[1], 10)];
        fallback.episodeNumbers = [parseInt(seMatch[2], 10)];
    }
    return fallback;
}

// Simple extraction fallbacks
function extractReleaseGroupSimple(filename) {
    if (!filename) return null;
    const withoutExt = filename.replace(/\.[a-z0-9]{2,4}$/i, '');
    const match = withoutExt.match(/-([A-Za-z0-9]+)$/);
    return match ? match[1] : null;
}

function extractResolutionSimple(filename) {
    if (!filename) return null;
    const match = filename.match(/\b(2160p|1440p|1080p|720p|480p|4k)\b/i);
    if (match) {
        const res = match[1].toUpperCase();
        return res === '4K' ? '2160P' : res;
    }
    return null;
}

function extractSourcesSimple(filename) {
    if (!filename) return [];
    const sources = [];
    const lower = filename.toLowerCase();
    if (/blu-?ray|bdremux|bdrip/i.test(lower)) sources.push('BLURAY');
    if (/web-?dl/i.test(lower)) sources.push('WEBDL');
    if (/webrip/i.test(lower)) sources.push('WEBRIP');
    if (/hdtv/i.test(lower)) sources.push('TV');
    if (/dvdrip|dvd/i.test(lower)) sources.push('DVD');
    return sources;
}

function extractCodecSimple(filename) {
    if (!filename) return null;
    if (/x265|hevc|h\.?265/i.test(filename)) return 'x265';
    if (/x264|h\.?264|avc/i.test(filename)) return 'x264';
    if (/xvid/i.test(filename)) return 'xvid';
    if (/av1/i.test(filename)) return 'AV1';
    return null;
}

/**
 * Calculate similarity score (0-100+)
 * Scoring: S/E match (50pts), Title (5/-50), Group (30/50), Source (10), Resolution (5), Codec (5)
 */
function calculateParsedSimilarity(videoParsed, subtitleParsed, contentType = 'series') {
    if (!videoParsed || !subtitleParsed) return 0;
    
    let score = 0;
    
    // Series: Season/Episode match is CRITICAL
    if (contentType === 'series') {
        const vSeasons = videoParsed.seasons || [];
        const sSeasons = subtitleParsed.seasons || [];
        const vEpisodes = videoParsed.episodeNumbers || [];
        const sEpisodes = subtitleParsed.episodeNumbers || [];
        
        if (vEpisodes.length > 0 && sEpisodes.length > 0) {
            const episodeMatch = vEpisodes.some(e => sEpisodes.includes(e));
            const seasonMatch = vSeasons.length === 0 || sSeasons.length === 0 || 
                               vSeasons.some(s => sSeasons.includes(s));
            
            score += (seasonMatch && episodeMatch) ? 50 : -30;
        }
    }
    
    // Title match (penalize different shows)
    if (videoParsed.title && subtitleParsed.title) {
        const vTitle = videoParsed.title.toLowerCase().replace(/[^a-z0-9]/g, '');
        const sTitle = subtitleParsed.title.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (vTitle === sTitle) {
            score += 5;
        } else if (vTitle && sTitle && !vTitle.includes(sTitle) && !sTitle.includes(vTitle)) {
            score -= 50;
        }
    }
    
    // Release Group match (30 for series, 50 for movies)
    const groupWeight = contentType === 'series' ? 30 : 50;
    if (videoParsed.group && subtitleParsed.group) {
        const vGroup = videoParsed.group.toLowerCase();
        const sGroup = subtitleParsed.group.toLowerCase();
        if (vGroup === sGroup) {
            score += groupWeight;
        } else if (vGroup.includes(sGroup) || sGroup.includes(vGroup)) {
            score += Math.floor(groupWeight * 0.5);
        }
    }
    
    // Source match (10 pts)
    if (videoParsed.sources && subtitleParsed.sources) {
        if (videoParsed.sources.some(s => subtitleParsed.sources.includes(s))) {
            score += 10;
        }
    }
    
    // Resolution match (5 pts)
    if (videoParsed.resolution && subtitleParsed.resolution) {
        if (videoParsed.resolution === subtitleParsed.resolution) score += 5;
    }
    
    // Codec match (5 pts)
    if (videoParsed.videoCodec && subtitleParsed.videoCodec) {
        if (videoParsed.videoCodec.toLowerCase() === subtitleParsed.videoCodec.toLowerCase()) score += 5;
    }
    
    return Math.max(0, score);
}

/** Sort subtitles by filename similarity (async - uses full parser) */
async function sortByFilenameSimilarityAsync(subtitles, videoFilename, contentType = 'series') {
    if (!Array.isArray(subtitles) || subtitles.length === 0) return subtitles;
    if (!isRealFilename(videoFilename)) return subtitles;
    
    await getParser();
    const isTv = contentType === 'series';
    const startTime = Date.now();
    
    const videoParsed = parseFilename(videoFilename, isTv);
    if (!videoParsed) return subtitles;
    
    const scored = subtitles.map((sub, originalIndex) => {
        const releaseName = sub.releaseInfo || sub.releaseName || sub.release || sub.id || sub.SubFileName || '';
        const subtitleParsed = parseFilename(releaseName, isTv);
        const score = subtitleParsed ? calculateParsedSimilarity(videoParsed, subtitleParsed, contentType) : 0;
        return { subtitle: sub, score, originalIndex };
    });
    
    scored.sort((a, b) => (b.score - a.score) || (a.originalIndex - b.originalIndex));
    
    const elapsed = Date.now() - startTime;
    log('debug', `[Filename Matching] Sorted ${subtitles.length} subs in ${elapsed}ms`);
    
    return scored.map(s => s.subtitle);
}

/** Sync version (uses cache or fallback) */
function sortByFilenameSimilarity(subtitles, videoFilename, contentType = 'series') {
    if (!Array.isArray(subtitles) || subtitles.length === 0) return subtitles;
    if (!isRealFilename(videoFilename)) return subtitles;
    
    const isTv = contentType === 'series';
    const videoParsed = filenameParse ? parseFilename(videoFilename, isTv) : parseFilenameSync(videoFilename);
    if (!videoParsed) return subtitles;
    
    const scored = subtitles.map((sub, originalIndex) => {
        const releaseName = sub.releaseInfo || sub.releaseName || sub.release || sub.id || sub.SubFileName || '';
        const subtitleParsed = filenameParse ? parseFilename(releaseName, isTv) : parseFilenameSync(releaseName);
        const score = subtitleParsed ? calculateParsedSimilarity(videoParsed, subtitleParsed, contentType) : 0;
        return { subtitle: sub, score, originalIndex };
    });
    
    scored.sort((a, b) => (b.score - a.score) || (a.originalIndex - b.originalIndex));
    return scored.map(s => s.subtitle);
}

/** Preload parser on server startup */
async function preloadParser() {
    try {
        await getParser();
        parseFilename('Sample.Show.S01E01.720p.BluRay.x264-GROUP.mkv', true);
        log('info', '[Filename Matching] Parser preloaded successfully');
    } catch (error) {
        log('warn', `[Filename Matching] Failed to preload parser: ${error.message}`);
    }
}

// Legacy exports
function extractReleaseGroup(filename) {
    return extractReleaseGroupSimple(filename);
}

function extractQualityTags(filename) {
    if (!filename) return [];
    const tags = [];
    if (extractResolutionSimple(filename)) tags.push(extractResolutionSimple(filename).toLowerCase());
    tags.push(...extractSourcesSimple(filename).map(s => s.toLowerCase()));
    const codec = extractCodecSimple(filename);
    if (codec) tags.push(codec.toLowerCase());
    return tags;
}

function extractSeasonEpisode(filename) {
    if (!filename) return null;
    const match = filename.match(/[Ss](\d+)[Ee](\d+)/);
    if (match) {
        return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
    }
    return null;
}

// Simple score calculation for legacy compatibility
function calculateSimilarityScore(videoFilename, subtitleReleaseName, contentType = 'series') {
    const videoParsed = parseFilenameSync(videoFilename);
    const subtitleParsed = parseFilenameSync(subtitleReleaseName);
    const score = calculateParsedSimilarity(videoParsed, subtitleParsed, contentType);
    return score / 100; // Normalize to 0-1 range for legacy compatibility
}

module.exports = {
    // Main functions
    isRealFilename,
    sortByFilenameSimilarity,
    sortByFilenameSimilarityAsync,
    preloadParser,
    
    // Utility functions
    parseFilename,
    parseFilenameSync,
    calculateParsedSimilarity,
    
    // Legacy exports (for backwards compatibility)
    extractReleaseGroup,
    extractQualityTags,
    extractSeasonEpisode,
    calculateSimilarityScore
};

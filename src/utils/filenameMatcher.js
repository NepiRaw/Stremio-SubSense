/**
 * Filename Similarity Matching Utilities
 * Scores subtitle candidates against the user's video filename. The parser is parsium, reached
 * through src/utils/mediaParser.js, which owns the LRU.
 */

const { log } = require('../utils');
const { adaptForMatcher } = require('./mediaParser');

/** Check if string is a real filename (not URL or empty) */
function isRealFilename(filename) {
    if (!filename || typeof filename !== 'string') return false;
    if (filename.startsWith('http://') || filename.startsWith('https://')) return false;
    const hasMediaExtension = /\.(mkv|mp4|avi|mov|webm|wmv|flv|m4v|srt|sub|ass|ssa|vtt)$/i.test(filename);
    const hasReleaseParts = /[\.\-_]/.test(filename) && filename.length > 10;
    return hasMediaExtension || hasReleaseParts;
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
    
    // Title match (penalize different shows/movies)
    if (videoParsed.title && subtitleParsed.title) {
        const vTitle = videoParsed.title.toLowerCase().replace(/[^a-z0-9]/g, '');
        const sTitle = subtitleParsed.title.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (vTitle === sTitle) {
            score += 5;
        } else if (vTitle && sTitle && !vTitle.includes(sTitle) && !sTitle.includes(vTitle)) {
            if (contentType === 'movie') return -1;
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

// Minimum filename match score to be considered meaningful.
// Below this threshold, filename matching is not useful and
// downloadCount becomes the primary sort signal
const MIN_FILENAME_SCORE = 10;

/** Sort subtitles by how well their names match the video filename. */
function sortByFilenameSimilarity(subtitles, videoFilename, contentType = 'series') {
    if (!Array.isArray(subtitles) || subtitles.length === 0) return subtitles;
    if (!isRealFilename(videoFilename)) return subtitles;

    const startTime = Date.now();
    const videoParsed = adaptForMatcher(videoFilename);

    const scored = subtitles.map((sub, originalIndex) => {
        const candidates = [
            sub.fileName,
            sub.releaseName,
            ...(sub.releases || [])
        ].filter(c => c && typeof c === 'string' && c.length > 0);

        let score = 0;
        if (candidates.length > 0) {
            score = Math.max(...candidates.map(c =>
                calculateParsedSimilarity(videoParsed, adaptForMatcher(c), contentType)));
        } else {
            const matchString = sub.releaseInfo || sub.release || sub.id || sub.SubFileName || '';
            score = calculateParsedSimilarity(videoParsed, adaptForMatcher(matchString), contentType);
        }

        return { subtitle: sub, score, originalIndex };
    });

    scored.sort((a, b) => {
        // 3-tier scoring: >=MIN -> real match, 0..MIN -> no match (DL fallback), <0 -> wrong content (last)
        const scoreA = a.score < 0 ? -1 : (a.score >= MIN_FILENAME_SCORE ? a.score : 0);
        const scoreB = b.score < 0 ? -1 : (b.score >= MIN_FILENAME_SCORE ? b.score : 0);

        if (scoreB !== scoreA) return scoreB - scoreA;
        const dlA = a.subtitle.downloadCount || 0;
        const dlB = b.subtitle.downloadCount || 0;
        if (dlA !== dlB) return dlB - dlA;
        return a.originalIndex - b.originalIndex;
    });

    log('debug', `[Filename Matching] Sorted ${subtitles.length} subs in ${Date.now() - startTime}ms`);
    return scored.map(s => s.subtitle);
}

module.exports = {
    isRealFilename,
    sortByFilenameSimilarity,
    calculateParsedSimilarity
};
'use strict';

const { normalizeImdbId } = require('./episodeIdentity');

function isOpenSubtitles(entry) {
    const sources = Array.isArray(entry?.source) ? entry.source : [entry?.source];
    return sources.some(source => String(source || '').toLowerCase() === 'opensubtitles');
}

/**
 * Remove only OpenSubtitles series rows that were not produced for the exact,
 * currently resolved episode IMDb id. Rows from every other provider pass
 * through untouched, and movie caches retain their historical behavior.
 */
function filterCachedEpisodeSubtitles(subtitles, contentType, identity) {
    const input = Array.isArray(subtitles) ? subtitles : [];
    if (String(contentType || '').toLowerCase() !== 'series') {
        return { subtitles: input, unsafeCount: 0 };
    }

    const expectedId = identity?.status === 'resolved'
        ? normalizeImdbId(identity.episodeImdbId)
        : null;
    let unsafeCount = 0;
    const safe = input.filter(entry => {
        if (!isOpenSubtitles(entry)) return true;
        const marker = normalizeImdbId(entry?.verifiedEpisodeImdbId || entry?.e);
        const verified = Boolean(expectedId && marker === expectedId);
        if (!verified) unsafeCount++;
        return verified;
    });

    return { subtitles: safe, unsafeCount };
}

module.exports = { filterCachedEpisodeSubtitles, isOpenSubtitles };

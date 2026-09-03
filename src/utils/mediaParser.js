'use strict';

/**
 * The single entry point to parsium-media, so the parser, its LRU and any field mapping stay in
 * one place.
 */

const { createCachedParser } = require('parsium-media');

const CACHE_SIZE = 2000;
const MAX_SEASON_RANGE = 20;

const parser = createCachedParser(CACHE_SIZE);

/** Never throws: an unreadable name is an empty result, not a failed request. */
function parse(name) {
    if (!name) return {};
    try { return parser.parse(String(name)) || {}; } catch (_) { return {}; }
}

/**
 * Seasons a title names, read as tokens. A range needs S on both sides, the word Season, or no
 * spaces with both sides padded, so an absolute-numbered episode is not read as a range.
 */
function tokenSeasons(title) {
    const out = new Set();
    const addRange = (lo, hi) => {
        if (hi > lo && hi - lo <= MAX_SEASON_RANGE) for (let i = lo; i <= hi; i++) out.add(i);
    };
    for (const m of title.matchAll(/\bS(\d{1,2})\s*[-~]\s*S(\d{1,2})\b/gi)) addRange(+m[1], +m[2]);
    for (const m of title.matchAll(/\bSeasons?\s*(\d{1,2})\s*[-~]\s*(\d{1,2})\b/gi)) addRange(+m[1], +m[2]);
    for (const m of title.matchAll(/\bS(\d{2})-(\d{2})\b/g)) addRange(+m[1], +m[2]);
    for (const m of title.matchAll(/\bS(\d{1,2})(?![0-9E])/gi)) out.add(+m[1]);
    for (const m of title.matchAll(/\bS(\d{1,2})E\d{1,4}\b/gi)) out.add(+m[1]);
    for (const m of title.matchAll(/\bSeasons?\s*(\d{1,2}(?:\s*\+\s*\d{1,2})+)/gi)) {
        for (const n of m[1].split('+')) out.add(+n.trim());
    }
    for (const m of title.matchAll(/\bSeasons?\s*(\d{1,2})\b/gi)) out.add(+m[1]);
    return out;
}

/**
 * Seasons a title covers, unioned from both readers. Each reads cases the other misses, and a
 * release is only dropped on a known season set, so a wider union can only turn a drop into a keep.
 */
function seasonsOf(title) {
    const text = String(title || '');
    if (!text) return new Set();
    return new Set([...(parse(text).seasons || []), ...tokenSeasons(text)]);
}

/** 2 = covers the wanted season, 1 = names no season so keep but rank lower, 0 = another season. */
function scoreReleaseSeason(title, wantedSeason) {
    const text = String(title || '');
    if (!text || wantedSeason == null) return 1;
    if (parse(text).isCompleteSeries) return 2;

    const seasons = seasonsOf(text);
    if (!seasons.size) return 1;
    return seasons.has(wantedSeason) ? 2 : 0;
}

/**
 * A parsed name under the field names the filename matcher scores on. `source` is one string
 * here and a list there, so it is wrapped rather than dropped.
 */
function adaptForMatcher(name) {
    const p = parse(name);
    return {
        title: p.title || null,
        seasons: p.seasons || [],
        episodeNumbers: p.episodes || [],
        group: p.releaseGroup || null,
        sources: p.source ? [p.source] : [],
        videoCodec: p.codec || null,
        resolution: p.resolution || null
    };
}

module.exports = { parse, adaptForMatcher, tokenSeasons, seasonsOf, scoreReleaseSeason };

'use strict';

const { mapStremioToWyzie, mapWyzieToStremio } = require('../../src/languages');
const { log } = require('../../src/utils');
const { SUBSRC_KEY_PLACEHOLDER } = require('../cache/ResponseCache');

const PROXY_BASE_URL = process.env.SUBSENSE_BASE_URL ||
    `http://127.0.0.1:${process.env.PORT || 3100}`;

/**
 * Group/sort raw provider subtitles by user's preferred languages, applying
 * the per-language max if requested.
 *
 * Returns:
 *   {
 *     subtitles: SubtitleResult[],   // ordered: lang1, lang2, ..., others
 *     languageMatch: {
 *       byLanguage: { [code]: { found, count } },
 *       selectedCount, othersCount
 *     }
 *   }
 */
function prioritizeByLanguage(subtitles, languages, maxPerLang = 0) {
    const wantedPairs = languages
        .map((stremio) => ({ stremio, wyzie: (mapStremioToWyzie(stremio) || '').toLowerCase() }))
        .filter((p) => p.wyzie);

    const byLanguage = Object.create(null);
    for (const lang of languages) byLanguage[lang] = [];
    const others = [];

    for (const sub of subtitles) {
        const subLang = (sub.lang || sub.language || '').toLowerCase().substring(0, 2);
        const matched = wantedPairs.find((p) => p.wyzie === subLang);
        if (matched) byLanguage[matched.stremio].push(sub);
        else others.push(sub);
    }

    for (const lang of languages) byLanguage[lang].sort(qualityRank);
    others.sort(qualityRank);

    const out = [];
    for (const lang of languages) {
        const langSubs = byLanguage[lang];
        out.push(...(maxPerLang > 0 ? langSubs.slice(0, maxPerLang) : langSubs));
    }

    const languageMatch = {
        byLanguage: {},
        selectedCount: out.length,
        othersCount: others.length
    };
    for (const lang of languages) {
        languageMatch.byLanguage[lang] = {
            found: byLanguage[lang].length > 0,
            count: byLanguage[lang].length
        };
    }
    return { subtitles: out, languageMatch };
}

/**
 * Format provider subtitles
 *
 * ASS sources emit two entries: VTT (styling preserved) + SRT (plain fallback).
 */
function formatForStremio(subtitles) {
    const out = [];
    let idx = 0;

    for (const sub of subtitles) {
        const subLang = sub.lang || sub.language || 'und';
        const lang = mapWyzieToStremio(subLang.substring(0, 2));
        const display = sub.display || lang;
        const source = Array.isArray(sub.source) ? sub.source[0] : (sub.source || 'Unknown');
        const hi = (sub.hearingImpaired || sub.isHearingImpaired || sub.hi) ? ' [HI]' : '';
        const release = sub.releaseName || sub.release || sub.media || '';
        const baseLabel = release
            ? `${display} | ${source} - ${release}${hi}`
            : `${display} | ${source}${hi}`;

        const format = (sub.format || '').toLowerCase();
        const isAss = format === 'ass' || format === 'ssa' || sub.needsConversion === true;
        const subIdBase = sub.id || Date.now();
        const sourceUrl = withSubsourcePlaceholder(sub.url);

        if (isAss) {
            out.push({
                id: `subsense-${idx++}-${subIdBase}-vtt-${source}`,
                url: `${PROXY_BASE_URL}/api/subtitle/vtt/${sourceUrl}`,
                lang,
                label: baseLabel,
                source
            });
            out.push({
                id: `subsense-${idx++}-${subIdBase}-srt-${source}`,
                url: `${PROXY_BASE_URL}/api/subtitle/srt/${sourceUrl}`,
                lang,
                label: baseLabel,
                source
            });
        } else {
            const url = sub.needsConversion === false
                ? sourceUrl
                : `${PROXY_BASE_URL}/api/subtitle/vtt/${sourceUrl}`;
            out.push({
                id: `subsense-${idx++}-${subIdBase}-${format || 'srt'}-${source}`,
                url,
                lang,
                label: baseLabel,
                source
            });
        }
    }

    const valid = out.filter((s) => !!s.url);
    log('debug', `[format] ${subtitles.length} provider subs -> ${valid.length} stremio entries`);
    return valid;
}

function withSubsourcePlaceholder(url) {
    if (!url || url.indexOf('/subsource/') === -1) return url;
    return url
        .replace(/([?&]key=)[^&]+/i, `$1${SUBSRC_KEY_PLACEHOLDER}`);
}

function qualityRank(a, b) {
    const dlA = scoreDownload(a);
    const dlB = scoreDownload(b);
    if (dlA !== dlB) return dlB - dlA;
    const rA = scoreRating(a);
    const rB = scoreRating(b);
    if (rA !== rB) return rB - rA;
    return 0;
}

function scoreDownload(sub) {
    const c = sub.downloadCount;
    if (c == null || c <= 0) return 0;
    return Math.min(1, Math.log10(c) / 4);
}

function scoreRating(sub) {
    const r = sub.rating;
    if (r == null || r <= 0) return 0;
    if (sub.provider === 'betaseries') return Math.min(1, r / 10);
    if (sub.provider === 'yify') return Math.min(1, Math.log10(r + 1) / 2);
    return Math.min(1, r / 100);
}

module.exports = {
    prioritizeByLanguage,
    formatForStremio,
    PROXY_BASE_URL
};

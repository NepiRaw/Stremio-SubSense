'use strict';

const { mapStremioToWyzie, mapWyzieToStremio, toCanonical } = require('../../src/languages');
const { log } = require('../../src/utils');
const { SUBSRC_KEY_PLACEHOLDER } = require('../cache/response-cache');
const { getSourceDisplayName } = require('../providers/WyzieProvider');

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
        .map((stremio) => ({
            stremio,
            tag: stremio.toLowerCase(),
            wyzie: (mapStremioToWyzie(stremio) || '').toLowerCase()
        }))
        .filter((p) => p.wyzie);

    const byLanguage = Object.create(null);
    for (const lang of languages) byLanguage[lang] = [];
    const others = [];
    const exactMatches = new Set();

    for (const sub of subtitles) {
        const subLang = (sub.lang || sub.language || '').toLowerCase();
        const subBase = subLang.split('-')[0];
        const exact = wantedPairs.find((p) => p.tag === subLang);
        const matched = exact || wantedPairs.find((p) => p.wyzie === subBase);
        if (matched) {
            byLanguage[matched.stremio].push(sub);
            if (exact) exactMatches.add(sub);
        } else others.push(sub);
    }

    const rankExactFirst = (a, b) =>
        (exactMatches.has(b) ? 1 : 0) - (exactMatches.has(a) ? 1 : 0) || qualityRank(a, b);
    for (const lang of languages) byLanguage[lang].sort(rankExactFirst);
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
 * Stremio wants a 3-letter code, and a regional variant has no 3-letter form,
 * so the tag is emitted as-is for those.
 */
function toStremioLang(code) {
    const canonical = toCanonical(code);
    if (!canonical) return mapWyzieToStremio(String(code).substring(0, 2));
    return canonical.includes('-') ? canonical : mapWyzieToStremio(canonical);
}

/**
 * Format provider subtitles for Stremio.
 *
 * For ASS/SSA sources we emit two entries per subtitle so the user can pick:
 *   - opts.keepAss=true  →  ASS (original styling) + VTT fallback
 *   - opts.keepAss=false →  VTT + SRT (both plain text, current default)
 *
 * Provider-proxy URLs (which extract+convert server-side) get a `?fmt=ass|vtt`
 * query so the proxy serves the right format for each emitted entry.
 */
function formatForStremio(subtitles, opts = {}) {
    const keepAss = !!opts.keepAss;
    const out = [];
    let idx = 0;

    for (const sub of subtitles) {
        const subLang = sub.lang || sub.language || 'und';
        const lang = toStremioLang(subLang);
        const source = Array.isArray(sub.source) ? sub.source[0] : (sub.source || 'Unknown');
        const isHI = !!(sub.hearingImpaired || sub.isHearingImpaired || sub.hi);
        const release = sub.releaseName || sub.release || sub.media || '';
        let nameForLabel = sub.fileName || release || '';
        if (sub.trackName) nameForLabel = nameForLabel ? `${nameForLabel} · ${sub.trackName}` : sub.trackName;

        const format = (sub.format || '').toLowerCase();
        const isAss = format === 'ass' || format === 'ssa' || sub.needsConversion === true;
        const sourceUrl = withSubsourcePlaceholder(sub.url);

        const matchMeta = {};
        if (sub.fileName) matchMeta.fileName = sub.fileName;
        if (release) matchMeta.releaseName = release;
        if (Array.isArray(sub.releases) && sub.releases.length > 0) matchMeta.releases = sub.releases;

        const emit = (fmt, url) => {
            out.push({
                id: buildId(idx++, fmt, source, lang),
                url,
                lang,
                label: buildLabel(source, fmt, nameForLabel, isHI),
                source,
                ...matchMeta
            });
        };

        if (isAss) {
            if (sub.needsConversion === false) {
                emit(format, sourceUrl);
            } else if (keepAss) {
                emit('ass', assProxyUrl(sourceUrl));
                emit('vtt', vttProxyUrl(sourceUrl));
            } else {
                emit('vtt', vttProxyUrl(sourceUrl));
                emit('srt', `${PROXY_BASE_URL}/api/subtitle/srt/${sourceUrl}`);
            }
        } else {
            const url = sub.needsConversion === false
                ? sourceUrl
                : `${PROXY_BASE_URL}/api/subtitle/vtt/${sourceUrl}`;
            emit(format || 'srt', url);
        }
    }

    const valid = out.filter((s) => !!s.url);
    log('debug', `[format] ${subtitles.length} provider subs -> ${valid.length} stremio entries${keepAss ? ' (keepAss)' : ''}`);
    return valid;
}

// Provider-proxy paths that perform server-side extraction+conversion and
// honor a `?fmt=ass|vtt` hint so we can request the original ASS bytes.
const PROVIDER_PROXY_RE = /\/api\/(yify|tvsubtitles|subsource|betaseries|opensubtitles|gestdown|animetosho|animetosho-xyz|subdl)\/proxy\//;

// Build the user-facing label: "Provider · [FORMAT] · <name> · [HI]"
function buildLabel(provider, fmt, name, isHI) {
    const parts = [displayProvider(provider), `[${(fmt || 'srt').toUpperCase()}]`];
    if (name) parts.push(name);
    let label = parts.join(' · ');
    if (isHI) label += ' · HI';
    return label;
}

// Build a stable, predictable Stremio entry id
function buildId(idx, fmt, provider, lang) {
    return `subsense-${(fmt || 'srt').toLowerCase()}-${slugProvider(provider)}-${lang || 'und'}-${idx}`;
}

function displayProvider(src) {
    return getSourceDisplayName(src || 'Unknown');
}

function slugProvider(src) {
    return String(src || 'unknown').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function vttProxyUrl(sourceUrl) {
    if (PROVIDER_PROXY_RE.test(sourceUrl)) return appendQuery(sourceUrl, 'fmt', 'vtt');
    return `${PROXY_BASE_URL}/api/subtitle/vtt/${sourceUrl}`;
}

function assProxyUrl(sourceUrl) {
    if (PROVIDER_PROXY_RE.test(sourceUrl)) return appendQuery(sourceUrl, 'fmt', 'ass');
    return `${PROXY_BASE_URL}/api/subtitle/ass/${sourceUrl}`;
}

function appendQuery(url, key, value) {
    const encoded = encodeURIComponent(value);
    const re = new RegExp(`([?&])${key}=[^&]*`);
    if (re.test(url)) return url.replace(re, `$1${key}=${encoded}`);
    return url + (url.includes('?') ? '&' : '?') + `${key}=${encoded}`;
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

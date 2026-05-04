'use strict';

/**
 * Unified subtitle proxy.
 *
 * Endpoints:
 *   GET /api/subtitle/:format/*          — generic URL proxy + ASS conversion
 *   GET /api/yify/proxy/:subtitleId      — resolve YIFY ZIP and extract subtitle
 *   GET /api/tvsubtitles/proxy/:subtitleId
 *   GET /api/subsource/proxy/:subtitleId/:releaseName?
 *   GET /api/subdl/proxy/*                              — SubDL ZIP proxy (public, no API key)
 *   GET /api/betaseries/proxy/:subtitleId
 *
 * All proxy results are cached in a single bounded LRU keyed by
 * `${provider}:${id}:${variant}`. Conversion runs at most once per cache entry.
 */

const express = require('express');
const cheerio = require('cheerio');

const { log } = require('../../src/utils');
const {
    extractSubtitleEntries,
    selectSubtitleEntry,
    detectEntryFormat,
    convertForOutput,
    bufferToText,
    contentTypeFor
} = require('../utils/archive');

let decryptConfig = null;
try { decryptConfig = require('../../src/utils/crypto').decryptConfig; }
catch (_) { log('warn', '[proxy] crypto unavailable; SubSource downloads will be limited'); }

const PROXY_CACHE_MAX = parseInt(process.env.PROXY_CACHE_MAX, 10) || 500;
const PROXY_CACHE_TTL_MS = (parseInt(process.env.PROXY_CACHE_TTL_HOURS, 10) || 24) * 60 * 60 * 1000;

const proxyCache = new Map(); // key -> { content, contentType, headers, storedAt }
const inflight = new Map();   // key -> Promise<entry>

function cacheGet(key) {
    const e = proxyCache.get(key);
    if (!e) return null;
    if (Date.now() - e.storedAt > PROXY_CACHE_TTL_MS) {
        proxyCache.delete(key);
        return null;
    }
    proxyCache.delete(key);
    proxyCache.set(key, e);
    return e;
}

function cacheSet(key, entry) {
    while (proxyCache.size >= PROXY_CACHE_MAX) {
        const oldest = proxyCache.keys().next().value;
        if (oldest === undefined) break;
        proxyCache.delete(oldest);
    }
    proxyCache.set(key, { ...entry, storedAt: Date.now() });
}

function dedupe(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

function sendCached(res, entry, cacheState) {
    res.setHeader('Content-Type', entry.contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Proxy-Cache', cacheState);
    if (entry.headers) {
        for (const [k, v] of Object.entries(entry.headers)) res.setHeader(k, v);
    }
    res.send(entry.content);
}

/**
 * Sanitize HTTP header value by encoding non-ASCII characters.
 */
function safeHeader(value) {
    if (value == null) return '';
    return String(value).replace(/[^\x20-\x7E]/g, (ch) => encodeURIComponent(ch));
}

function resolveEntry(cacheKey, build) {
    return dedupe(cacheKey, async () => {
        const cached = cacheGet(cacheKey);
        if (cached) return { entry: cached, hit: true };
        const fresh = await build();
        cacheSet(cacheKey, fresh);
        return { entry: fresh, hit: false };
    });
}

const router = express.Router();

router.get('/subtitle/:format/*', async (req, res) => {
    const { format } = req.params;
    const prefix = `/api/subtitle/${format}/`;
    const pIdx = req.originalUrl.indexOf(prefix);
    let originalUrl = pIdx >= 0
        ? req.originalUrl.slice(pIdx + prefix.length)
        : (req.params[0] || '');
    const qIdx = originalUrl.indexOf('?');
    if (qIdx >= 0) originalUrl = originalUrl.slice(0, qIdx);
    if (!originalUrl) return res.status(400).send('Missing subtitle URL');

    const cacheKey = `subtitle:${format}:${originalUrl}`;

    try {
        const { entry, hit } = await resolveEntry(cacheKey, async () => {
            const proxiedUrl = new URL(originalUrl);
            for (const [k, v] of Object.entries(req.query || {})) {
                if (v == null || proxiedUrl.searchParams.has(k)) continue;
                if (Array.isArray(v)) v.forEach((vv) => vv != null && proxiedUrl.searchParams.append(k, vv));
                else proxiedUrl.searchParams.set(k, v);
            }
            if (proxiedUrl.hostname === 'sub.wyzie.io') {
                const wyzieKey = process.env.WYZIE_API_KEY;
                if (wyzieKey && !proxiedUrl.searchParams.has('key')) {
                    proxiedUrl.searchParams.set('key', wyzieKey);
                }
            }

            const response = await fetch(proxiedUrl.toString());
            if (!response.ok) {
                const err = new Error(`upstream ${response.status}`);
                err.status = response.status;
                throw err;
            }
            const text = await response.text();
            const conv = convertForOutput(text, format);
            return {
                content: conv.content,
                contentType: contentTypeFor(conv.outputFormat),
                headers: {
                    'X-SubSense-Original-Format': conv.originalFormat,
                    'X-SubSense-Output-Format': conv.outputFormat
                }
            };
        });
        sendCached(res, entry, hit ? 'hit' : 'miss');
    } catch (err) {
        log('error', `[proxy/subtitle] ${err.message}`);
        res.status(err.status || 500).send(`Subtitle proxy error: ${err.message}`);
    }
});

function pickFmt(req) {
    return (req && req.query && req.query.fmt === 'ass') ? 'ass' : 'vtt';
}

router.get('/yify/proxy/:subtitleId', async (req, res) => {
    const { subtitleId } = req.params;
    const fmt = pickFmt(req);
    const cacheKey = `yify:${subtitleId}:${fmt}`;
    try {
        const { entry, hit } = await resolveEntry(cacheKey, () => fetchYify(subtitleId, fmt));
        sendCached(res, entry, hit ? 'hit' : 'miss');
    } catch (err) {
        log('error', `[proxy/yify] ${err.message}`);
        res.status(err.status || 500).send(`YIFY proxy error: ${err.message}`);
    }
});

async function fetchYify(subtitleId, fmt = 'vtt') {
    const pageUrl = `https://yts-subs.com/subtitles/${subtitleId}`;
    const pageRes = await fetch(pageUrl, { headers: BROWSER_UA });
    if (!pageRes.ok) {
        const err = new Error(`detail page ${pageRes.status}`);
        err.status = pageRes.status;
        throw err;
    }
    const $ = cheerio.load(await pageRes.text());
    const dataLink = $('a.download-subtitle, a[data-link]').first().attr('data-link');
    if (!dataLink) throw new Error('YIFY download link not found');
    const downloadUrl = Buffer.from(dataLink, 'base64').toString('utf-8');

    const zipRes = await fetch(downloadUrl, { headers: { 'User-Agent': 'SubSense/2.0' } });
    if (!zipRes.ok) {
        const err = new Error(`download ${zipRes.status}`);
        err.status = zipRes.status;
        throw err;
    }
    const buffer = Buffer.from(await zipRes.arrayBuffer());
    const entries = await extractSubtitleEntries(buffer);
    if (!entries || entries.length === 0) throw new Error('No subtitle in YIFY archive');

    const selected = entries.find((e) => e.name.toLowerCase().endsWith('.srt')) || entries[0];
    const original = detectEntryFormat(selected.name);
    const target = (fmt === 'ass' && original === 'ass') ? 'ass' : 'vtt';
    const conv = convertForOutput(bufferToText(selected.getData()), target);
    return {
        content: conv.content,
        contentType: contentTypeFor(conv.outputFormat),
        headers: {
            'X-YIFY-Original-Format': conv.originalFormat,
            'X-YIFY-Output-Format': conv.outputFormat,
            'X-YIFY-Selected-File': safeHeader(selected.name)
        }
    };
}

router.get('/tvsubtitles/proxy/:subtitleId', async (req, res) => {
    const { subtitleId } = req.params;
    const { episodeUrl, lang } = req.query;
    const fmt = pickFmt(req);
    const cacheKey = `tvsubs:${subtitleId}:${lang || 'en'}:${fmt}`;
    try {
        const { entry, hit } = await resolveEntry(cacheKey, () => fetchTvsubs(subtitleId, episodeUrl, fmt));
        sendCached(res, entry, hit ? 'hit' : 'miss');
    } catch (err) {
        log('error', `[proxy/tvsubs] ${err.message}`);
        res.status(err.status || 500).send(`TVsubtitles proxy error: ${err.message}`);
    }
});

async function fetchTvsubs(subtitleId, episodeUrl, fmt = 'vtt') {
    let downloadPageUrl = null;
    if (episodeUrl) {
        const epRes = await fetch(episodeUrl, { headers: BROWSER_UA });
        if (epRes.ok) {
            const $ = cheerio.load(await epRes.text());
            const link = $(`a[href*="/subtitle-${subtitleId}.html"]`).first().attr('href');
            if (link) downloadPageUrl = link.startsWith('http') ? link : `http://www.tvsubtitles.net${link}`;
        }
    }
    if (!downloadPageUrl) downloadPageUrl = `http://www.tvsubtitles.net/download-${subtitleId}.html`;
    else if (downloadPageUrl.includes('subtitle-')) downloadPageUrl = downloadPageUrl.replace('subtitle-', 'download-');

    const dpRes = await fetch(downloadPageUrl, { headers: BROWSER_UA });
    if (!dpRes.ok) {
        const err = new Error(`download page ${dpRes.status}`);
        err.status = dpRes.status;
        throw err;
    }
    const html = await dpRes.text();
    const m = html.match(/var s1\s*=\s*['"]([^'"]+)['"][\s\S]*?var s2\s*=\s*['"]([^'"]+)['"][\s\S]*?var s3\s*=\s*['"]([^'"]+)['"][\s\S]*?var s4\s*=\s*['"]([^'"]+)['"]/);
    if (!m) throw new Error('TVsubs download URL parse failed');
    const filename = m[1] + m[2] + m[3] + m[4];

    const zipRes = await fetch(`http://www.tvsubtitles.net/${filename}`, { headers: { 'User-Agent': 'SubSense/2.0' } });
    if (!zipRes.ok) {
        const err = new Error(`download ${zipRes.status}`);
        err.status = zipRes.status;
        throw err;
    }
    const buffer = Buffer.from(await zipRes.arrayBuffer());
    return materializeFromBuffer(buffer, { headerPrefix: 'X-TVsubs', fmt });
}

router.get('/subsource/proxy/:subtitleId/:releaseName?', async (req, res) => {
    const { subtitleId } = req.params;
    const { key, season, episode, filename } = req.query;
    const fmt = pickFmt(req);
    const fileHint = (typeof filename === 'string' && filename.trim()) ? filename.trim().toLowerCase() : 'nofilename';
    const cacheKey = `subsource:${subtitleId}:${season || 'all'}:${episode || 'all'}:${fileHint}:${fmt}`;

    if (!key) return res.status(401).send('SubSource API key required');
    if (!decryptConfig) return res.status(500).send('Encryption not configured');

    let apiKey;
    try {
        const cfg = decryptConfig(key);
        apiKey = cfg.apiKey || cfg;
    } catch (err) {
        return res.status(401).send('Invalid API key');
    }

    try {
        const { entry, hit } = await resolveEntry(cacheKey, () => fetchSubsource(subtitleId, apiKey, { season, episode, filename, fmt }));
        sendCached(res, entry, hit ? 'hit' : 'miss');
    } catch (err) {
        log('error', `[proxy/subsource] ${err.message}`);
        res.status(err.status || 500).send(`SubSource proxy error: ${err.message}`);
    }
});

async function fetchSubsource(subtitleId, apiKey, { season, episode, filename, fmt = 'vtt' }) {
    const url = `https://api.subsource.net/api/v1/subtitles/${subtitleId}/download`;
    const dlRes = await fetch(url, {
        headers: {
            'X-API-Key': apiKey,
            'User-Agent': 'SubSense/2.0',
            'Accept': 'application/zip'
        }
    });
    if (!dlRes.ok) {
        const err = new Error(`subsource ${dlRes.status}`);
        err.status = dlRes.status;
        throw err;
    }
    const buffer = Buffer.from(await dlRes.arrayBuffer());
    const entries = await extractSubtitleEntries(buffer);
    if (!entries || entries.length === 0) {
        const err = new Error('No subtitle file in SubSource archive');
        err.status = 404;
        throw err;
    }

    const selected = selectSubtitleEntry(entries, { season, episode, filename });
    if (!selected) {
        const err = new Error(`Episode ${episode} not found in this pack`);
        err.status = 404;
        throw err;
    }

    const format = detectEntryFormat(selected.name);
    const text = bufferToText(selected.getData());
    const target = (format === 'ass') ? (fmt === 'ass' ? 'ass' : 'vtt') : format;
    const conv = convertForOutput(text, target);
    return {
        content: conv.content,
        contentType: contentTypeFor(conv.outputFormat),
        headers: {
            'X-SubSource-Original-Format': conv.originalFormat,
            'X-SubSource-Output-Format': conv.outputFormat,
            'X-SubSource-Selected-File': safeHeader(selected.name)
        }
    };
}

router.get('/betaseries/proxy/:subtitleId', async (req, res) => {
    const { subtitleId } = req.params;
    const lang = req.query.lang || 'vo';
    const fmt = pickFmt(req);
    const cacheKey = `betaseries:${subtitleId}:${lang}:${fmt}`;
    try {
        const { entry, hit } = await resolveEntry(cacheKey, () => fetchBetaseries(subtitleId, lang, fmt));
        sendCached(res, entry, hit ? 'hit' : 'miss');
    } catch (err) {
        log('error', `[proxy/betaseries] ${err.message}`);
        res.status(err.status || 500).send(`BetaSeries proxy error: ${err.message}`);
    }
});

const BETASERIES_LANG_PATTERNS = {
    vf: ['.vf.', '.fr.', 'french', 'fra', '_vf', '-vf'],
    vo: ['.vo.', '.en.', 'english', 'eng', '_vo', '-vo', '_en', '-en']
};

async function fetchBetaseries(subtitleId, lang, fmt = 'vtt') {
    const url = `https://www.betaseries.com/srt/${subtitleId}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'SubSense/2.0' } });
    if (!r.ok) {
        const err = new Error(`betaseries ${r.status}`);
        err.status = r.status;
        throw err;
    }
    const buffer = Buffer.from(await r.arrayBuffer());
    const entries = await extractSubtitleEntries(buffer);

    if (!entries || entries.length === 0) {
        const text = bufferToText(buffer);
        const conv = convertForOutput(text, 'vtt');
        return {
            content: conv.content,
            contentType: contentTypeFor(conv.outputFormat),
            headers: {
                'X-BetaSeries-Original-Format': conv.originalFormat,
                'X-BetaSeries-Output-Format': conv.outputFormat,
                'X-BetaSeries-Extracted': 'no'
            }
        };
    }

    const langPatterns = BETASERIES_LANG_PATTERNS[lang] || BETASERIES_LANG_PATTERNS.vo;
    const selected = selectSubtitleEntry(entries, { langPatterns })
        || entries.find((e) => e.name.toLowerCase().endsWith('.srt'))
        || entries[0];

    const format = detectEntryFormat(selected.name);
    const target = (format === 'ass') ? (fmt === 'ass' ? 'ass' : 'vtt') : format;
    const conv = convertForOutput(bufferToText(selected.getData()), target);
    return {
        content: conv.content,
        contentType: contentTypeFor(conv.outputFormat),
        headers: {
            'X-BetaSeries-Original-Format': conv.originalFormat,
            'X-BetaSeries-Output-Format': conv.outputFormat,
            'X-BetaSeries-Extracted': 'yes',
            'X-BetaSeries-Selected-File': safeHeader(selected.name)
        }
    };
}

function materializeFromBuffer(buffer, { headerPrefix, fmt = 'vtt' }) {
    return Promise.resolve(extractSubtitleEntries(buffer)).then((entries) => {
        if (!entries || entries.length === 0) {
            const text = bufferToText(buffer);
            const conv = convertForOutput(text, 'vtt');
            return {
                content: conv.content,
                contentType: contentTypeFor(conv.outputFormat),
                headers: {
                    [`${headerPrefix}-Original-Format`]: conv.originalFormat,
                    [`${headerPrefix}-Output-Format`]: conv.outputFormat,
                    [`${headerPrefix}-Extracted`]: 'no'
                }
            };
        }
        const selected = entries.find((e) => e.name.toLowerCase().endsWith('.srt')) || entries[0];
        const format = detectEntryFormat(selected.name);
        const target = (format === 'ass') ? (fmt === 'ass' ? 'ass' : 'vtt') : format;
        const conv = convertForOutput(bufferToText(selected.getData()), target);
        return {
            content: conv.content,
            contentType: contentTypeFor(conv.outputFormat),
            headers: {
                [`${headerPrefix}-Original-Format`]: conv.originalFormat,
                [`${headerPrefix}-Output-Format`]: conv.outputFormat,
                [`${headerPrefix}-Extracted`]: 'yes',
                [`${headerPrefix}-Selected-File`]: safeHeader(selected.name)
            }
        };
    });
}

const BROWSER_UA = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
};

function getProxyCacheStats() {
    return {
        size: proxyCache.size,
        maxEntries: PROXY_CACHE_MAX,
        ttlMs: PROXY_CACHE_TTL_MS,
        inflight: inflight.size
    };
}

// SubDL proxy (public downloads, no API key needed)
router.get('/subdl/proxy/*', async (req, res) => {
    const prefix = '/api/subdl/proxy/';
    const pIdx = req.originalUrl.indexOf(prefix);
    let subdlPath = pIdx >= 0
        ? req.originalUrl.slice(pIdx + prefix.length)
        : (req.params[0] || '');
    const qIdx = subdlPath.indexOf('?');
    if (qIdx >= 0) subdlPath = subdlPath.slice(0, qIdx);

    subdlPath = decodeURIComponent(subdlPath).replace(/^\/+/, '');
    if (!subdlPath) return res.status(400).send('Missing subtitle path');

    const { season, episode, filename } = req.query;
    const fmt = pickFmt(req);
    const fileHint = (typeof filename === 'string' && filename.trim())
        ? filename.trim().toLowerCase() : 'nofilename';
    const cacheKey = `subdl:${subdlPath}:${season || 'all'}:${episode || 'all'}:${fileHint}:${fmt}`;

    try {
        const { entry, hit } = await resolveEntry(cacheKey,
            () => fetchSubdl(subdlPath, { season, episode, filename, fmt }));
        sendCached(res, entry, hit ? 'hit' : 'miss');
    } catch (err) {
        log('error', `[proxy/subdl] ${err.message}`);
        res.status(err.status || 500).send(`SubDL proxy error: ${err.message}`);
    }
});

async function fetchSubdl(subdlPath, { season, episode, filename, fmt = 'vtt' }) {
    const downloadUrl = `https://dl.subdl.com/${subdlPath}`;
    const dlRes = await fetch(downloadUrl, {
        headers: { 'User-Agent': 'SubSense/2.0' }
    });
    if (!dlRes.ok) {
        const err = new Error(`subdl download ${dlRes.status}`);
        err.status = dlRes.status;
        throw err;
    }

    const buffer = Buffer.from(await dlRes.arrayBuffer());
    const entries = await extractSubtitleEntries(buffer);
    if (!entries || entries.length === 0) {
        const text = bufferToText(buffer);
        const conv = convertForOutput(text, 'vtt');
        return {
            content: conv.content,
            contentType: contentTypeFor(conv.outputFormat),
            headers: {
                'X-SubDL-Original-Format': conv.originalFormat,
                'X-SubDL-Output-Format': conv.outputFormat,
                'X-SubDL-Extracted': 'no'
            }
        };
    }

    const selected = selectSubtitleEntry(entries, { season, episode, filename });
    if (!selected) {
        const err = new Error('No matching subtitle in SubDL archive');
        err.status = 404;
        throw err;
    }

    const format = detectEntryFormat(selected.name);
    const text = bufferToText(selected.getData());
    const target = (format === 'ass') ? (fmt === 'ass' ? 'ass' : 'vtt') : format;
    const conv = convertForOutput(text, target);
    return {
        content: conv.content,
        contentType: contentTypeFor(conv.outputFormat),
        headers: {
            'X-SubDL-Original-Format': conv.originalFormat,
            'X-SubDL-Output-Format': conv.outputFormat,
            'X-SubDL-Extracted': 'yes',
            'X-SubDL-Selected-File': safeHeader(selected.name)
        }
    };
}

module.exports = router;
module.exports.getProxyCacheStats = getProxyCacheStats;

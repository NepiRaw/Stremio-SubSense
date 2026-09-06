'use strict';

/**
 * Unified subtitle proxy.
 *
 * Endpoints:
 *   GET /api/subtitle/:format/*            generic URL proxy + ASS conversion
 *   GET /api/yify/proxy/:subtitleId        resolve YIFY ZIP and extract subtitle
 *   GET /api/tvsubtitles/proxy/:subtitleId
 *   GET /api/subsource/proxy/:subtitleId/:releaseName?
 *   GET /api/subdl/proxy/*                 SubDL ZIP proxy (public, no API key)
 *   GET /api/betaseries/proxy/:subtitleId
 *
 * Proxy results are cached in two tiers keyed by `${provider}:${id}:${variant}`: a bounded
 * per-worker LRU, and a Redis tier shared by every worker that survives a restart. Without
 * the shared tier each worker re-downloads what its siblings already hold, which is the
 * volume that gets our exit IP throttled upstream. Conversion runs at most once per entry.
 */

const dns = require('dns');
const net = require('net');
const express = require('express');
const cheerio = require('cheerio');
const { Agent, buildConnector, setGlobalDispatcher } = require('undici');

const { log } = require('../../src/utils');
const { warpFetch } = require('../utils/warpFetch');
const { subdlFetch } = require('../utils/subdlFetch');
const { redis, isHealthy, safe } = require('../infra/redis');
const {
    extractSubtitleEntries,
    selectSubtitleEntry,
    detectEntryFormat,
    convertForOutput,
    bufferToText,
    contentTypeFor
} = require('../utils/archive');

/**
 * SSRF guard, two layers.
 *  1. Blocks any connection to a non-public address
 *  2. Pins the generic subtitle proxy to the hosts we actually download subtitles from
 */
const PRIVATE_V4 = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
];

// Subtitle-source domains allowed in the proxy route
const SUBTITLE_DOMAINS = [
    'wyzie.io', 'betaseries.com', 'opensubtitles.org', 'opensubtitles.com',
    'subdl.com', 'subsource.net', 'yts-subs.com', 'tvsubtitles.net',
    'gestdown.info', 'animetosho.org', 'animetosho.xyz', 'subf2m.co',
    'addic7ed.com', 'podnapisi.com', 'jimaku.cc', 'kitsunekko.net', 'indexsubtitle.cc'
];

const SELF_ORIGIN = (() => {
    try {
        return new URL(process.env.SUBSENSE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3100}`).origin;
    } catch (_) { return null; }
})();

const isSubtitleDomain = (host) => SUBTITLE_DOMAINS.some(d => host === d || host.endsWith('.' + d));

const ipv4ToInt = (ip) => ip.split('.').reduce((n, o) => (n << 8) + (+o), 0) >>> 0;

function isPublicIp(ip) {
    const family = net.isIP(ip);
    if (family === 4) {
        const addr = ipv4ToInt(ip);
        return !PRIVATE_V4.some(([base, bits]) => (addr >>> (32 - bits)) === (ipv4ToInt(base) >>> (32 - bits)));
    }
    if (family !== 6) return false;
    const a = ip.toLowerCase().split('%')[0];
    const mapped = a.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPublicIp(mapped[1]);
    if (a === '::' || a === '::1') return false;
    return !/^(f[cd]|fe[89ab]|ff)/.test(a.split(':')[0]);
}

function ipLiteral(hostname) {
    const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    return net.isIP(bare) ? bare : null;
}

function guardedLookup(hostname, options, cb) {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return cb(err);
        const list = Array.isArray(addresses) ? addresses : [addresses];
        const bad = list.find(a => !isPublicIp(a.address));
        if (bad) return cb(new Error(`blocked non-public address ${bad.address}`));
        if (options && options.all) return cb(null, list);
        return cb(null, list[0].address, list[0].family);
    });
}

const baseConnector = buildConnector({ lookup: guardedLookup });
const plainConnector = buildConnector({});

function isSelfTarget(hostname, port) {
    if (!SELF_ORIGIN) return false;
    const self = new URL(SELF_ORIGIN);
    return self.hostname === hostname && (self.port || (self.protocol === 'https:' ? '443' : '80')) === port;
}

// undici skips `lookup` when the hostname is already an address, so literals are checked here.
function guardedConnector(restrictToSubtitleHosts) {
    return (options, callback) => {
        const hostname = options.hostname || '';
        const port = String(options.port || (options.protocol === 'https:' ? 443 : 80));
        if (restrictToSubtitleHosts) {
            if (isSelfTarget(hostname, port)) return plainConnector(options, callback);
            if (!isSubtitleDomain(hostname)) return callback(new Error(`host not allowed (${hostname})`));
        }
        const literal = ipLiteral(hostname);
        if (literal && !isPublicIp(literal)) {
            return callback(new Error(`blocked non-public address ${literal}`));
        }
        return baseConnector(options, callback);
    };
}

setGlobalDispatcher(new Agent({ connect: guardedConnector(false) }));

const subtitleDispatcher = new Agent({ connect: guardedConnector(true) });

/** Layer 2 at the URL, so a rejected target is a 403 instead of a socket error. */
function assertAllowedSubtitleUrl(rawUrl) {
    let url;
    try { url = new URL(rawUrl); } catch (_) { throw proxyError(400, 'invalid URL'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw proxyError(403, 'scheme not allowed');
    }
    if (url.origin === SELF_ORIGIN) return url;
    if (!isSubtitleDomain(url.hostname)) throw proxyError(403, `host not allowed (${url.hostname})`);
    return url;
}

function proxyError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

/**
 * Fetch with WARP SOCKS5 proxy
 */
function proxyFetch(url, options = {}) {
    return warpFetch(url, options);
}

let decryptConfig = null;
try { decryptConfig = require('../../src/utils/crypto').decryptConfig; }
catch (_) { log('warn', '[proxy] crypto unavailable; SubSource downloads will be limited'); }

const PROXY_CACHE_MAX = parseInt(process.env.PROXY_CACHE_MAX, 10) || 5000;
const PROXY_CACHE_MAX_BYTES = parseInt(process.env.PROXY_CACHE_MAX_BYTES, 10) || 256 * 1024 * 1024;
const PROXY_CACHE_TTL_MS = (parseInt(process.env.PROXY_CACHE_TTL_HOURS, 10) || 24) * 60 * 60 * 1000;

const PROXY_REDIS_PREFIX = 'ss:px:';
const PROXY_REDIS_TTL_S = Math.floor(PROXY_CACHE_TTL_MS / 1000);
const PROXY_REDIS_MAX_BYTES = parseInt(process.env.PROXY_REDIS_MAX_BYTES, 10) || 4 * 1024 * 1024;

const proxyCache = new Map(); // key -> { content, contentType, headers, storedAt, bytes }
const inflight = new Map();   // key -> Promise<entry>
let cacheBytes = 0;

/** Subtitle bodies vary by orders of magnitude, so the cache is capped by size, not count. */
function entryBytes(entry) {
    const c = entry && entry.content;
    if (!c) return 0;
    return Buffer.isBuffer(c) ? c.length : Buffer.byteLength(String(c));
}

function cacheDelete(key) {
    const e = proxyCache.get(key);
    if (!e) return;
    cacheBytes -= e.bytes || 0;
    proxyCache.delete(key);
}

function cacheGet(key) {
    const e = proxyCache.get(key);
    if (!e) return null;
    if (Date.now() - e.storedAt > PROXY_CACHE_TTL_MS) {
        cacheDelete(key);
        return null;
    }
    proxyCache.delete(key);
    proxyCache.set(key, e);
    return e;
}

function cacheSet(key, entry) {
    if (entry && typeof entry.content === 'string') {
        entry = { ...entry, content: Buffer.from(entry.content, 'utf8') };
    }
    const bytes = entryBytes(entry);
    if (bytes > PROXY_CACHE_MAX_BYTES) return;

    cacheDelete(key);
    while (proxyCache.size > 0 && (proxyCache.size >= PROXY_CACHE_MAX || cacheBytes + bytes > PROXY_CACHE_MAX_BYTES)) {
        const oldest = proxyCache.keys().next().value;
        if (oldest === undefined) break;
        cacheDelete(oldest);
    }
    proxyCache.set(key, { ...entry, storedAt: Date.now(), bytes });
    cacheBytes += bytes;
}

/** Bodies are stored as raw bytes in a hash, so nothing pays a base64 tax. */
async function sharedGet(key) {
    if (!isHealthy()) return null;
    const raw = await safe(r => r.hgetallBuffer(PROXY_REDIS_PREFIX + key));
    if (!raw || !raw.c) return null;
    let headers = {};
    if (raw.h) { try { headers = JSON.parse(raw.h.toString('utf8')); } catch (_) { /* drop unreadable headers */ } }
    return { content: raw.c, contentType: raw.t ? raw.t.toString('utf8') : 'text/plain', headers };
}

function sharedSet(key, entry) {
    if (!isHealthy()) return;
    const body = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content));
    if (body.length === 0 || body.length > PROXY_REDIS_MAX_BYTES) return;
    const k = PROXY_REDIS_PREFIX + key;
    safe(async r => {
        await r.hset(k, 'c', body, 't', entry.contentType || 'text/plain',
                     'h', JSON.stringify(entry.headers || {}));
        await r.expire(k, PROXY_REDIS_TTL_S);
    });
}

function getSharedCacheStats() {
    return { enabled: isHealthy(), prefix: PROXY_REDIS_PREFIX, ttlSeconds: PROXY_REDIS_TTL_S };
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

        const shared = await sharedGet(cacheKey);
        if (shared) {
            cacheSet(cacheKey, shared);
            return { entry: shared, hit: true };
        }

        const fresh = await build();
        cacheSet(cacheKey, fresh);
        sharedSet(cacheKey, fresh);
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
        assertAllowedSubtitleUrl(originalUrl);

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

            const fetchHeaders = {};
            const response = await proxyFetch(proxiedUrl.toString(), {
                headers: Object.keys(fetchHeaders).length > 0 ? fetchHeaders : undefined,
                dispatcher: subtitleDispatcher,
                guard: assertAllowedSubtitleUrl
            });
            if (!response.ok) {
                const err = new Error(`upstream ${response.status}`);
                err.status = response.status;
                throw err;
            }
            const buffer = Buffer.from(await response.arrayBuffer());

            const text = bufferToText(buffer);
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
    const fmt = req && req.query && req.query.fmt;
    if (Array.isArray(fmt)) return fmt.includes('ass') ? 'ass' : 'vtt';
    return fmt === 'ass' ? 'ass' : 'vtt';
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
    const { key, season, episode, filename, track } = req.query;
    const fmt = pickFmt(req);
    const fileHint = (typeof filename === 'string' && filename.trim()) ? filename.trim().toLowerCase() : 'nofilename';
    const cacheKey = `subsource:${subtitleId}:${season || 'all'}:${episode || 'all'}:${fileHint}:${track || 'plain'}:${fmt}`;

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
        const { entry, hit } = await resolveEntry(cacheKey, () => fetchSubsource(subtitleId, apiKey, { season, episode, filename, track, fmt }));
        sendCached(res, entry, hit ? 'hit' : 'miss');
    } catch (err) {
        log('error', `[proxy/subsource] ${err.message}`);
        res.status(err.status || 500).send(`SubSource proxy error: ${err.message}`);
    }
});

async function fetchSubsource(subtitleId, apiKey, { season, episode, filename, track, fmt = 'vtt' }) {
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

    const selected = selectSubtitleEntry(entries, { season, episode, filename, track });
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
        bytes: cacheBytes,
        maxBytes: PROXY_CACHE_MAX_BYTES,
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

    const { season, episode, filename, track } = req.query;
    const fmt = pickFmt(req);
    const fileHint = (typeof filename === 'string' && filename.trim())
        ? filename.trim().toLowerCase() : 'nofilename';
    const cacheKey = `subdl:${subdlPath}:${season || 'all'}:${episode || 'all'}:${fileHint}:${track || 'plain'}:${fmt}`;

    try {
        const { entry, hit } = await resolveEntry(cacheKey,
            () => fetchSubdl(subdlPath, { season, episode, filename, track, fmt }));
        sendCached(res, entry, hit ? 'hit' : 'miss');
    } catch (err) {
        log('error', `[proxy/subdl] ${err.message}`);
        res.status(err.status || 500).send(`SubDL proxy error: ${err.message}`);
    }
});

async function fetchSubdl(subdlPath, { season, episode, filename, track, fmt = 'vtt' }) {
    const downloadUrl = `https://dl.subdl.com/${subdlPath}`;
    const dlRes = await subdlFetch(downloadUrl, {
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

    const selected = selectSubtitleEntry(entries, { season, episode, filename, track });
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

// =====================================================
// AnimeTosho subtitle proxy
// =====================================================

let xz = null;
try { xz = require('@napi-rs/lzma').xz; }
catch (_) { log('warn', '[proxy] @napi-rs/lzma unavailable; AnimeTosho downloads disabled'); }

/**
 * AnimeTosho subtitle proxy.
 * Downloads XZ-compressed subtitle from AT storage, decompresses, converts format.
 *
 * GET /api/animetosho/proxy/:hexId?fmt=vtt|ass|srt
 */
router.get('/animetosho/proxy/:hexId', async (req, res) => {
    const { hexId } = req.params;
    const fmt = pickFmt(req);

    // Validate hex ID format (8 hex chars)
    if (!/^[0-9a-f]{8}$/i.test(hexId)) {
        return res.status(400).send('Invalid attachment ID');
    }

    if (!xz) {
        return res.status(500).send('XZ decompression not available');
    }

    const cacheKey = `animetosho:${hexId}:${fmt}`;

    try {
        const { entry, hit } = await resolveEntry(cacheKey, () => fetchAnimetosho(hexId, fmt));
        sendCached(res, entry, hit ? 'hit' : 'miss');
    } catch (err) {
        log('error', `[proxy/animetosho] ${hexId}: ${err.message}`);
        res.status(err.status || 500).send(`AnimeTosho proxy error: ${err.message}`);
    }
});

async function fetchAnimetosho(hexId, fmt = 'vtt') {
    const url = `https://storage.animetosho.org/attach/${hexId}/file.xz`;

    const response = await fetch(url, {
        headers: { 'User-Agent': 'SubSense-Stremio/2.0' },
        signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
        const err = new Error(`AT storage returned ${response.status}`);
        err.status = response.status === 404 ? 404 : 502;
        throw err;
    }

    const compressed = Buffer.from(await response.arrayBuffer());

    let decompressed;
    try {
        decompressed = await xz.decompress(compressed);
    } catch (e) {
        throw new Error(`XZ decompression failed: ${e.message}`);
    }

    const text = decompressed.toString('utf8');

    // Detect original format
    const originalFormat = text.includes('[Script Info]') ? 'ass' :
                          /^\d+\s*\r?\n\d{2}:\d{2}/.test(text) ? 'srt' :
                          text.includes('WEBVTT') ? 'vtt' : 'unknown';

    // Convert if needed
    const target = (fmt === 'ass' && originalFormat === 'ass') ? 'ass' : fmt;
    const conv = convertForOutput(text, target);

    return {
        content: conv.content,
        contentType: contentTypeFor(conv.outputFormat),
        headers: {
            'X-SubSense-Original-Format': originalFormat,
            'X-SubSense-Output-Format': conv.outputFormat,
            'X-SubSense-Source': 'animetosho'
        }
    };
}

// =====================================================
// AnimeTosho XYZ subtitle proxy (storage.animetosho.xyz)
// =====================================================

const { decodeProxyToken, storageUrlForPath } = require('../utils/animetoshoXyzApi');

/**
 * AnimeTosho XYZ subtitle proxy.
 * Downloads XZ-compressed subtitle from storage.animetosho.xyz, decompresses, converts.
 * The token encodes the attachment id and the storage path the feed payload gave us.
 *
 * GET /api/animetosho-xyz/proxy/:token?fmt=vtt|ass|srt
 */
router.get('/animetosho-xyz/proxy/:token', async (req, res) => {
    const { token } = req.params;
    const fmt = pickFmt(req);

    if (!xz) {
        return res.status(500).send('XZ decompression not available');
    }

    const decoded = decodeProxyToken(token);
    const url = decoded && storageUrlForPath(decoded.p);
    if (!url || decoded.i == null) {
        return res.status(400).send('Invalid proxy token');
    }

    const cacheKey = `animetosho-xyz:${decoded.i}:${fmt}`;

    try {
        const { entry, hit } = await resolveEntry(cacheKey, () => fetchAnimetoshoXyz(url, fmt));
        sendCached(res, entry, hit ? 'hit' : 'miss');
    } catch (err) {
        log('error', `[proxy/animetosho-xyz] attachment ${decoded.i}: ${err.message}`);
        res.status(err.status || 500).send(`AnimeTosho XYZ proxy error: ${err.message}`);
    }
});

async function fetchAnimetoshoXyz(url, fmt = 'vtt') {
    const response = await fetch(url, {
        headers: { 'User-Agent': 'SubSense-Stremio/2.0' },
        signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
        const err = new Error(`AT-XYZ storage returned ${response.status}`);
        err.status = response.status === 404 ? 404 : 502;
        throw err;
    }

    const compressed = Buffer.from(await response.arrayBuffer());

    let decompressed;
    try {
        decompressed = await xz.decompress(compressed);
    } catch (e) {
        throw new Error(`XZ decompression failed: ${e.message}`);
    }

    const text = decompressed.toString('utf8');

    const originalFormat = text.includes('[Script Info]') ? 'ass' :
                          /^\d+\s*\r?\n\d{2}:\d{2}/.test(text) ? 'srt' :
                          text.includes('WEBVTT') ? 'vtt' : 'unknown';

    const target = (fmt === 'ass' && originalFormat === 'ass') ? 'ass' : fmt;
    const conv = convertForOutput(text, target);

    return {
        content: conv.content,
        contentType: contentTypeFor(conv.outputFormat),
        headers: {
            'X-SubSense-Original-Format': originalFormat,
            'X-SubSense-Output-Format': conv.outputFormat,
            'X-SubSense-Source': 'animetosho-xyz'
        }
    };
}

// =====================================================
// Gestdown proxy (direct SRT download)
// =====================================================

router.get('/gestdown/proxy/:subtitleId', async (req, res) => {
    const { subtitleId } = req.params;
    const fmt = pickFmt(req);
    const cacheKey = `gestdown:${subtitleId}:${fmt}`;

    try {
        const { entry, hit } = await resolveEntry(cacheKey, () => fetchGestdown(subtitleId, fmt));
        sendCached(res, entry, hit ? 'hit' : 'miss');
    } catch (err) {
        log('error', `[proxy/gestdown] ${err.message}`);
        res.status(err.status || 500).send(`Gestdown proxy error: ${err.message}`);
    }
});

async function fetchGestdown(subtitleId, fmt = 'vtt') {
    const downloadUrl = `https://api.gestdown.info/subtitles/download/${subtitleId}`;
    const dlRes = await fetch(downloadUrl, {
        headers: { 'Accept': 'text/srt, text/plain, */*' }
    });
    if (!dlRes.ok) {
        const err = new Error(`gestdown download ${dlRes.status}`);
        err.status = dlRes.status;
        throw err;
    }

    const buffer = Buffer.from(await dlRes.arrayBuffer());
    const text = bufferToText(buffer);
    const conv = convertForOutput(text, fmt);
    return {
        content: conv.content,
        contentType: contentTypeFor(conv.outputFormat),
        headers: {
            'X-Gestdown-Original-Format': conv.originalFormat,
            'X-Gestdown-Output-Format': conv.outputFormat
        }
    };
}

module.exports = router;
module.exports._cache = { cacheGet, cacheSet, sharedGet, sharedSet, getProxyCacheStats, getSharedCacheStats, PROXY_CACHE_MAX_BYTES };
module.exports.getProxyCacheStats = getProxyCacheStats;

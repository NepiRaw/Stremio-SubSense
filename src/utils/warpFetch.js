'use strict';

const http = require('http');
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { log } = require('../utils');

const WARP_PROXY_URL = process.env.WARP_PROXY_URL || '';
let warpAgent = null;

if (WARP_PROXY_URL) {
    try {
        warpAgent = new SocksProxyAgent(WARP_PROXY_URL);
        log('info', `[warpFetch] WARP proxy configured: ${WARP_PROXY_URL}`);
    } catch (e) {
        log('warn', `[warpFetch] Failed to configure WARP proxy: ${e.message}`);
    }
}

const WARP_DOMAINS = new Set((process.env.WARP_DOMAINS || 'dl.subdl.com').split(',').map(d => d.trim()).filter(Boolean));

function warpFetch(url, options = {}) {
    if (!warpAgent) return fetch(url, options);
    const hostname = new URL(url).hostname;
    if (!WARP_DOMAINS.has(hostname)) return fetch(url, options);

    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const mod = parsed.protocol === 'https:' ? https : http;
        const reqOpts = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: options.method || 'GET',
            headers: options.headers || {},
            agent: warpAgent,
            timeout: options.timeout || 30000
        };

        const req = mod.request(reqOpts, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                const redirectUrl = new URL(res.headers.location, url).toString();
                warpFetch(redirectUrl, options).then(resolve).catch(reject);
                res.resume();
                return;
            }

            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks);
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    headers: new Headers(
                        Object.entries(res.headers)
                            .filter(([, v]) => v != null)
                            .map(([k, v]) => [k, String(v)])
                    ),
                    arrayBuffer: () => Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
                    text: () => Promise.resolve(body.toString('utf8')),
                    json: () => Promise.resolve(JSON.parse(body.toString('utf8')))
                });
            });
            res.on('error', reject);
        });

        if (options.signal) {
            options.signal.addEventListener('abort', () => req.destroy(new Error('aborted')));
        }
        req.on('timeout', () => {
            req.destroy(new Error('WARP fetch timeout'));
        });
        req.on('error', reject);
        req.end();
    });
}

function isWarpAvailable() {
    return !!warpAgent;
}

function forceWarpFetch(url, options = {}) {
    if (!warpAgent) return fetch(url, options);

    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const mod = parsed.protocol === 'https:' ? https : http;
        const reqOpts = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: options.method || 'GET',
            headers: options.headers || {},
            agent: warpAgent,
            timeout: options.timeout || 30000
        };

        const req = mod.request(reqOpts, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                const redirectUrl = new URL(res.headers.location, url).toString();
                forceWarpFetch(redirectUrl, options).then(resolve).catch(reject);
                res.resume();
                return;
            }

            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks);
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    headers: new Headers(
                        Object.entries(res.headers)
                            .filter(([, v]) => v != null)
                            .map(([k, v]) => [k, String(v)])
                    ),
                    arrayBuffer: () => Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
                    text: () => Promise.resolve(body.toString('utf8')),
                    json: () => Promise.resolve(JSON.parse(body.toString('utf8')))
                });
            });
            res.on('error', reject);
        });

        if (options.signal) {
            options.signal.addEventListener('abort', () => req.destroy(new Error('aborted')));
        }
        req.on('timeout', () => {
            req.destroy(new Error('WARP fetch timeout'));
        });
        req.on('error', reject);
        req.end();
    });
}

function getWarpDomains() {
    return WARP_DOMAINS;
}

module.exports = { warpFetch, forceWarpFetch, isWarpAvailable, getWarpDomains, WARP_DOMAINS };

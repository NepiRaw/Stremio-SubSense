'use strict';

/**
 * Pre-validates Wyzie subtitle URLs before returning them to Stremio.
 * Makes parallel GET requests and filters out URLs that return errors (502/503/404).
 * Only applies to sub.wyzie.io URLs - other providers are passed through unchanged.
 */

const { log } = require('../../src/utils');

const VALIDATE_TIMEOUT_MS = parseInt(process.env.WYZIE_VALIDATE_TIMEOUT_MS, 10) || 3000;
const WYZIE_HOST = 'sub.wyzie.io/';

/**
 * Extract the raw Wyzie URL from a subtitle's URL field
 */
function extractWyzieUrl(url) {
    if (!url) return null;
    if (url.startsWith('https://sub.wyzie.io/')) return url;
    const idx = url.indexOf('https://sub.wyzie.io/');
    if (idx >= 0) return url.slice(idx);
    return null;
}

/**
 * Validate Wyzie URLs in parallel. Returns only subtitles whose URLs respond OK.
 */
async function validateWyzieUrls(subtitles, timeoutMs = VALIDATE_TIMEOUT_MS) {
    if (!subtitles || subtitles.length === 0) return subtitles;

    const wyzieEntries = []; // { idx, rawUrl }
    for (let i = 0; i < subtitles.length; i++) {
        const rawUrl = extractWyzieUrl(subtitles[i].url);
        if (rawUrl) {
            wyzieEntries.push({ idx: i, rawUrl });
        }
    }

    if (wyzieEntries.length === 0) return subtitles;

    const uniqueUrls = [...new Set(wyzieEntries.map(e => e.rawUrl))];
    const urlStatus = new Map(); // rawUrl → boolean (alive)

    const checks = uniqueUrls.map(async (rawUrl) => {
        try {
            const response = await fetch(rawUrl, {
                method: 'GET',
                signal: AbortSignal.timeout(timeoutMs)
            });
            if (response.body) response.body.cancel().catch(() => {});
            return { rawUrl, ok: response.ok };
        } catch (err) {
            return { rawUrl, ok: false };
        }
    });

    const results = await Promise.allSettled(checks);
    for (const result of results) {
        if (result.status === 'fulfilled') {
            urlStatus.set(result.value.rawUrl, result.value.ok);
        }
    }

    const deadCount = [...urlStatus.values()].filter(ok => !ok).length;
    if (deadCount > 0) {
        log('info', `[validateWyzie] Filtered ${deadCount}/${uniqueUrls.length} dead Wyzie URLs`);
    }

    const deadIndices = new Set();
    for (const { idx, rawUrl } of wyzieEntries) {
        if (urlStatus.get(rawUrl) === false) {
            deadIndices.add(idx);
        }
    }

    return subtitles.filter((_, i) => !deadIndices.has(i));
}

module.exports = { validateWyzieUrls };

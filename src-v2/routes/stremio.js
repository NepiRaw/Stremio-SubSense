'use strict';

const express = require('express');
const { log } = require('../../src/utils');
const { generateManifest } = require('../../manifest');
const { parseConfig } = require('../../src/config');
const { handleSubtitlesRequest } = require('../handlers/subtitles');

let decryptConfig = null;
let isEncryptionConfigured = () => false;
try {
    const crypto = require('../../src/utils/crypto');
    decryptConfig = crypto.decryptConfig;
    isEncryptionConfigured = crypto.isEncryptionConfigured;
} catch (_) {
    log('warn', '[routes/stremio] crypto unavailable; only plaintext configs accepted');
}

const router = express.Router();

router.get('/manifest.json', (_req, res) => {
    const manifest = generateManifest();
    setStremioHeaders(res);
    res.json(manifest);
});

router.get('/:config/manifest.json', (req, res) => {
    const { config } = parseConfigParam(req.params.config);
    const manifest = generateManifest(config);
    if (config && Array.isArray(config.languages) && config.languages.length > 0) {
        delete manifest.behaviorHints.configurationRequired;
    }
    setStremioHeaders(res);
    res.json(manifest);
});

router.get('/:config/subtitles/:type/:id/:extra?.json', async (req, res) => {
    setStremioHeaders(res);
    try {
        const { config: rawConfig } = parseConfigParam(req.params.config);
        const validatedConfig = parseConfig(rawConfig || {});
        const args = {
            type: req.params.type,
            id: req.params.id,
            extra: parseExtra(req.params.extra)
        };
        const result = await handleSubtitlesRequest(args, validatedConfig);
        res.json(result);
    } catch (err) {
        log('error', `[routes/stremio] subtitles error: ${err.message}`);
        res.json({ subtitles: [] });
    }
});

function parseConfigParam(raw) {
    if (!raw) return { userId: null, config: {} };
    let userId = null;
    let configString = raw;
    const userIdMatch = raw.match(/^([a-z0-9]{8})-(.+)$/i);
    if (userIdMatch) {
        userId = userIdMatch[1].toLowerCase();
        configString = userIdMatch[2];
    }

    let config = null;
    try {
        config = JSON.parse(decodeURIComponent(configString));
    } catch (_) {
        if (decryptConfig && isEncryptionConfigured()) {
            try {
                config = decryptConfig(configString);
            } catch (decryptErr) {
                log('warn', `[routes/stremio] config parse failed: ${decryptErr.message}`);
            }
        }
    }
    if (!config || typeof config !== 'object') config = {};
    if (userId) config.userId = userId;
    return { userId, config };
}

function parseExtra(extra) {
    if (!extra) return {};
    const out = {};
    for (const part of extra.split('&')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const k = decodeURIComponent(part.slice(0, eq));
        const v = decodeURIComponent(part.slice(eq + 1));
        out[k] = v;
    }
    return out;
}

function setStremioHeaders(res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
}

module.exports = router;

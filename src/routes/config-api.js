'use strict';

const express = require('express');
const { log } = require('../../src/utils');
const { providerManager } = require('../providers');
const { isFullStats, isMinimalStats, isStatsEnabled, statsDB } = require('../stats');

let encryptConfig = null;
let isEncryptionConfigured = () => false;
try {
    const crypto = require('../../src/utils/crypto');
    encryptConfig = crypto.encryptConfig;
    isEncryptionConfigured = crypto.isEncryptionConfigured;
} catch (_) {
    log('warn', '[routes/config-api] crypto unavailable');
}

const router = express.Router();

router.post('/config/encrypt', (req, res) => {
    if (!isEncryptionConfigured()) {
        return res.status(500).json({ error: 'Encryption not configured' });
    }
    const { config } = req.body || {};
    if (!config || typeof config !== 'object') {
        return res.status(400).json({ error: 'Config object required' });
    }
    try {
        const encrypted = encryptConfig(config);
        res.json({ encrypted });
    } catch (err) {
        log('error', `[routes/config-api] encrypt failed: ${err.message}`);
        res.status(500).json({ error: 'Encryption failed' });
    }
});

router.get('/version', (_req, res) => {
    const packageJson = require('../../package.json');
    res.json({ version: packageJson.version });
});

router.get('/config', async (req, res) => {
    const packageJson = require('../../package.json');
    const config = {
        statsEnabled: isFullStats(),
        version: packageJson.version
    };

    if (isStatsEnabled()) {
        try {
            config.userStats = await statsDB.getUserCounts(15);
        } catch (err) {
            log('debug', `[routes/config-api] userStats error: ${err.message}`);
            config.userStats = { totalUsers: 0, activeUsers: 0 };
        }
    }

    res.json(config);
});

router.get('/languages', (req, res) => {
    const { getSupportedLanguages, LANGUAGE_TABLE, SPECIAL_CODE_MAPPINGS, getByAnyCode } = require('../../src/languages');

    const format = req.query.format || 'simple';

    if (format === 'full') {
        res.json(LANGUAGE_TABLE.map(lang => ({
            alpha2: lang.alpha2,
            alpha3B: lang.alpha3B,
            alpha3T: lang.alpha3T,
            name: lang.name,
            nativeName: lang.nativeName,
            providerCodes: lang.providerCodes
        })));
    } else if (format === 'lookup') {
        const lookup = {};
        LANGUAGE_TABLE.forEach(lang => {
            const name = lang.name;
            if (lang.alpha2) lookup[lang.alpha2.toLowerCase()] = name;
            if (lang.alpha3B) lookup[lang.alpha3B.toLowerCase()] = name;
            if (lang.alpha3T) lookup[lang.alpha3T.toLowerCase()] = name;
        });
        Object.entries(SPECIAL_CODE_MAPPINGS).forEach(([code, mappedCode]) => {
            const lang = getByAnyCode(mappedCode);
            if (lang) {
                lookup[code.toLowerCase()] = lang.name;
            }
        });
        res.json(lookup);
    } else {
        res.json(LANGUAGE_TABLE.map(lang => ({
            code: lang.alpha2,
            name: lang.name
        })));
    }
});

router.post('/subsource/validate', async (req, res) => {
    const provider = providerManager.get('subsource');
    if (!provider) {
        return res.status(503).json({ valid: false, error: 'SubSource provider not available' });
    }
    const { apiKey } = req.body || {};
    if (!apiKey) {
        return res.status(400).json({ valid: false, error: 'API key required' });
    }
    try {
        const result = await provider.validateApiKey(apiKey);
        res.json(result);
    } catch (err) {
        log('error', `[routes/config-api] subsource validate error: ${err.message}`);
        res.status(500).json({ valid: false, error: err.message });
    }
});

module.exports = router;

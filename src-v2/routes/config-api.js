'use strict';

const express = require('express');
const { log } = require('../../src/utils');
const { providerManager } = require('../providers');

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

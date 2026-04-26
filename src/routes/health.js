'use strict';

const express = require('express');
const { providerManager } = require('../providers');
const { getCacheStats } = require('../handlers/subtitles');
const { getProxyCacheStats } = require('./proxy');

const router = express.Router();
const startedAt = Date.now();

router.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        timestamp: new Date().toISOString(),
        cache: getCacheStats(),
        proxyCache: getProxyCacheStats(),
        providers: Object.keys(providerManager.getStats())
    });
});

router.get('/health/providers', (_req, res) => {
    res.json(providerManager.getStats());
});

module.exports = router;

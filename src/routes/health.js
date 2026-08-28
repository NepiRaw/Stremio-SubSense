'use strict';

const express = require('express');
const { providerManager } = require('../providers');
const { getCacheStats } = require('../handlers/subtitles');
const { getProxyCacheStats } = require('./proxy');
const { isHealthy } = require('../infra/redis');
const metrics = require('../infra/metrics');

const router = express.Router();
const startedAt = Date.now();

router.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        timestamp: new Date().toISOString(),
        redis: isHealthy(),
        proxyCache: getProxyCacheStats(),
        providers: Object.keys(providerManager.getStats()),
        metrics: metrics.snapshot()
    });
});

router.get('/metrics', (_req, res) => res.json(metrics.snapshot()));

router.get('/health/cache', async (_req, res) => {
    res.json({ l1: await getCacheStats(), proxy: getProxyCacheStats() });
});

router.get('/health/providers', (_req, res) => {
    res.json(providerManager.getStats());
});

module.exports = router;

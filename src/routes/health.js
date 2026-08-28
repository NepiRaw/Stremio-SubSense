'use strict';

const express = require('express');
const { providerManager } = require('../providers');
const { getCacheStats } = require('../handlers/subtitles');
const { getProxyCacheStats } = require('./proxy');
const { isHealthy } = require('../infra/redis');
const metrics = require('../infra/metrics');
const { deepHealth } = require('../health');

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

/**
 * Dependency-level health, for a monitor to watch and a human to read. 503 marks degraded
 * so an uptime check alerts by default. The docker healthcheck stays on `/health`: this
 * endpoint reports upstream problems that a container restart cannot fix.
 */
router.get('/health/deep', async (_req, res) => {
    try {
        const report = await deepHealth();
        res.status(report.status === 'ok' ? 200 : 503).json(report);
    } catch (err) {
        res.status(503).json({ status: 'degraded', degraded: ['probe-failed'], error: err.message });
    }
});

router.get('/health/cache', async (_req, res) => {
    res.json({ l1: await getCacheStats(), proxy: getProxyCacheStats() });
});

router.get('/health/providers', (_req, res) => {
    res.json(providerManager.getStats());
});

module.exports = router;

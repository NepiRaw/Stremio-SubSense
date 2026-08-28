'use strict';

require('dotenv').config();

/**
 * SubSense API server.
 */

const path = require('path');
const cluster = require('cluster');
const os = require('os');
const express = require('express');

const { log } = require('./src/utils');
const { preloadParser } = require('./src/utils/filenameMatcher');
const { initWyzieSources } = require('./src/providers/WyzieProvider');
const { init: initAnimeLists } = require('./src/utils/animeLists');
const { initAnidbCache, isAnidbConfigured } = require('./src/utils/anidbApi');
const { initDetailCache } = require('./src/utils/animetoshoApi');

const { registerDefaultProviders } = require('./src/providers');
const routes = require('./src/routes');
const infra = require('./src/infra/db');
const redis = require('./src/infra/redis');
const { initStats, getStatsMode, flushWrites } = require('./src/stats');

const PORT = parseInt(process.env.PORT, 10) || 3100;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 10000;

function resolveConcurrency() {
    const raw = (process.env.WEB_CONCURRENCY || '').trim();
    if (raw === 'auto') return Math.max(1, os.cpus().length - 1);
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
}

const WEB_CONCURRENCY = resolveConcurrency();
const REFORK_DELAY_MS = parseInt(process.env.REFORK_DELAY_MS, 10) || 1000;

async function bootstrap() {
    const app = express();

    app.disable('x-powered-by');
    app.use(express.json({ limit: '64kb' }));
    app.use(corsMiddleware);

    app.use(express.static(PUBLIC_DIR, { fallthrough: true, maxAge: '1h' }));
    app.get(['/configure', '/:config/configure'], (_req, res) => {
        res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    });

    app.use('/api', routes.configApi);
    app.use('/api', routes.proxy);
    app.use(routes.health);
    app.use(routes.statsApi);
    app.use(routes.stremio);

    app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));
    app.use((err, _req, res, _next) => {
        log('error', `[server] unhandled: ${err.stack || err.message}`);
        if (res.headersSent) return;
        res.status(500).json({ error: 'Internal error' });
    });

    await infra.initAll();
    await redis.connect();
    await initStats();
    log('info', `[server] stats mode: ${getStatsMode()}`);

    registerDefaultProviders();

    const { providerManager } = require('./src/providers');
    const wyzieProvider = providerManager.get('wyzie');

    const initTasks = [
        initWyzieSources().catch((err) => log('warn', `[server] Wyzie init failed: ${err.message}`)),
        wyzieProvider ? wyzieProvider.initialize().catch((err) => log('warn', `[server] Wyzie key pool init failed: ${err.message}`)) : Promise.resolve(),
        initAnimeLists().catch((err) => log('warn', `[server] AnimeLists init failed: ${err.message}`)),
        preloadParser().catch((err) => log('warn', `[server] parser preload failed: ${err.message}`))
    ];

    if (isAnidbConfigured()) {
        initTasks.push(
            initAnidbCache(infra.metaDb).catch((err) => log('warn', `[server] AniDB cache init failed: ${err.message}`))
        );
    } else {
        log('info', '[server] AniDB not configured (ANIDB_CLIENT / ANIDB_CLIENT_VER not set) — AnimeTosho TV episode search disabled, movies still available');
    }

    initTasks.push(
        initDetailCache(infra.metaDb).catch((err) => log('warn', `[server] AT detail cache init failed: ${err.message}`))
    );

    await Promise.allSettled(initTasks);

    const server = app.listen(PORT, HOST, () => {
        const tag = cluster.isWorker ? `worker ${process.pid}` : 'server';
        log('info', `[${tag}] listening on http://${HOST}:${PORT}`);
        log('info', `[server] static dir: ${PUBLIC_DIR}`);
    });

    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;

    installShutdownHandlers(server);
    return server;
}

function corsMiddleware(req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
}

function installShutdownHandlers(server) {
    let shuttingDown = false;
    const shutdown = (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        log('info', `[server] ${signal} received; draining...`);

        const forceTimer = setTimeout(() => {
            log('warn', `[server] force-exit after ${SHUTDOWN_TIMEOUT_MS}ms`);
            process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS);
        forceTimer.unref();

        server.close(async (err) => {
            if (err) log('warn', `[server] close error: ${err.message}`);
            try {
                await flushWrites();
                await redis.close();
                infra.close();
            } catch (closeErr) {
                log('warn', `[server] close error: ${closeErr.message}`);
            }
            log('info', '[server] shutdown complete');
            process.exit(0);
        });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('uncaughtException', (err) => {
        log('error', `[server] uncaughtException: ${err.stack || err.message}`);
    });
    process.on('unhandledRejection', (reason) => {
        log('error', `[server] unhandledRejection: ${reason && reason.stack || reason}`);
    });
}

/**
 * Cluster primary. Forks the request workers, replaces any that die, and relays signals.
 * It opens no databases and serves no traffic itself.
 */
function runPrimary() {
    log('info', `[primary] starting ${WEB_CONCURRENCY} workers on pid ${process.pid}`);
    for (let i = 0; i < WEB_CONCURRENCY; i++) cluster.fork();

    let shuttingDown = false;

    cluster.on('exit', (worker, code, signal) => {
        if (shuttingDown) return;
        log('warn', `[primary] worker ${worker.process.pid} exited (${signal || 'code ' + code}), replacing in ${REFORK_DELAY_MS}ms`);
        setTimeout(() => { if (!shuttingDown) cluster.fork(); }, REFORK_DELAY_MS).unref();
    });

    cluster.on('online', (worker) => log('debug', `[primary] worker ${worker.process.pid} online`));

    const relay = (signal) => () => {
        if (shuttingDown) return;
        shuttingDown = true;
        log('info', `[primary] ${signal} received; stopping ${Object.keys(cluster.workers).length} workers`);
        for (const worker of Object.values(cluster.workers)) {
            try { worker.process.kill(signal); } catch (_) { /* already gone */ }
        }
        const force = setTimeout(() => {
            log('warn', '[primary] force-exit after shutdown timeout');
            process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS + 2000);
        force.unref();

        const check = setInterval(() => {
            if (Object.keys(cluster.workers).length === 0) {
                clearInterval(check);
                clearTimeout(force);
                log('info', '[primary] all workers stopped');
                process.exit(0);
            }
        }, 200);
        check.unref();
    };

    process.on('SIGTERM', relay('SIGTERM'));
    process.on('SIGINT', relay('SIGINT'));
}

if (require.main === module) {
    if (cluster.isPrimary && WEB_CONCURRENCY > 1) {
        runPrimary();
    } else {
        bootstrap().catch((err) => {
            log('error', `[server] bootstrap failed: ${err.stack || err.message}`);
            process.exit(1);
        });
    }
}

module.exports = { bootstrap, runPrimary, WEB_CONCURRENCY };

'use strict';

/**
 * SubSense API server.
 */

const path = require('path');
const express = require('express');

const { log } = require('../src/utils');
const { preloadParser } = require('../src/utils/filenameMatcher');
const { initWyzieSources } = require('../src/providers/WyzieProvider');

const { registerDefaultProviders } = require('./providers');
const { warmupResponseCache } = require('./handlers/subtitles');
const routes = require('./routes');
const db = require('./cache/database-libsql');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 10000;

async function bootstrap() {
    const app = express();

    app.disable('x-powered-by');
    app.use(express.json({ limit: '64kb' }));
    app.use(corsMiddleware);

    app.use(express.static(PUBLIC_DIR, { fallthrough: true, maxAge: '1h' }));
    app.get(['/configure', '/:config/configure'], (_req, res) => {
        res.sendFile(path.join(PUBLIC_DIR, 'configure.html'));
    });

    app.use('/api', routes.configApi);
    app.use(routes.health);
    app.use(routes.stremio);

    app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));
    app.use((err, _req, res, _next) => {
        log('error', `[server] unhandled: ${err.stack || err.message}`);
        if (res.headersSent) return;
        res.status(500).json({ error: 'Internal error' });
    });

    await db.initializeDatabase();

    registerDefaultProviders();
    await Promise.allSettled([
        initWyzieSources().catch((err) => log('warn', `[server] Wyzie init failed: ${err.message}`)),
        preloadParser().catch((err) => log('warn', `[server] parser preload failed: ${err.message}`)),
        warmupResponseCache().catch((err) => log('warn', `[server] cache warmup failed: ${err.message}`))
    ]);

    const server = app.listen(PORT, HOST, () => {
        log('info', `[server] listening on http://${HOST}:${PORT}`);
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

        server.close((err) => {
            if (err) log('warn', `[server] close error: ${err.message}`);
            db.close()
                .catch((dbErr) => log('warn', `[server] db close error: ${dbErr.message}`))
                .finally(() => {
                    log('info', '[server] shutdown complete');
                    process.exit(0);
                });
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

if (require.main === module) {
    bootstrap().catch((err) => {
        log('error', `[server] bootstrap failed: ${err.stack || err.message}`);
        process.exit(1);
    });
}

module.exports = { bootstrap };

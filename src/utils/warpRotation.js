'use strict';

/**
 * Cluster-wide WARP IP rotation.
 *
 * `warp-cli disconnect` / `connect` takes the SOCKS listener away for a few seconds, and every
 * cluster worker shares the one warp-svc. Rotation therefore belongs to the primary, and every
 * worker holds its WARP requests behind a gate while a rotation runs. A request that arrives
 * mid-rotation waits instead of failing with ECONNREFUSED.
 */

const cluster = require('cluster');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { log } = require('../utils');

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function intEnv(name, fallback) {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

const WARP_PROXY_URL = process.env.WARP_PROXY_URL || 'socks5h://127.0.0.1:40000';
const COOLDOWN_MS = intEnv('WARP_ROTATION_COOLDOWN_MS', 30000);
const MAX_ATTEMPTS = intEnv('WARP_ROTATION_MAX_ATTEMPTS', 3);
const DRAIN_TIMEOUT_MS = intEnv('WARP_DRAIN_TIMEOUT_MS', 3000);
const GATE_TIMEOUT_MS = intEnv('WARP_GATE_TIMEOUT_MS', 15000);
const ROTATE_REPLY_TIMEOUT_MS = intEnv('WARP_ROTATE_REPLY_TIMEOUT_MS', 60000);

const DISCONNECT_SETTLE_MS = 2000;
const CONNECT_SETTLE_MS = 3000;

/**
 * A gate one process holds its WARP requests behind
 */
function createGate({ drainTimeoutMs = DRAIN_TIMEOUT_MS, gateTimeoutMs = GATE_TIMEOUT_MS } = {}) {
    let closed = false;
    let active = 0;
    let waiters = [];
    let drainWaiters = [];

    function onceWithTimeout(list, timeoutMs, resolve) {
        let done = false;
        const fire = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(fire, timeoutMs);
        list.push(fire);
    }

    function flush(list) {
        const pending = list.splice(0, list.length);
        for (const fire of pending) fire();
    }

    return {
        wait() {
            if (!closed) return Promise.resolve();
            return new Promise((resolve) => onceWithTimeout(waiters, gateTimeoutMs, resolve));
        },
        begin() { active++; },
        end() {
            if (active > 0) active--;
            if (active === 0) flush(drainWaiters);
        },
        inFlight() { return active; },
        isClosed() { return closed; },
        close() {
            closed = true;
            if (active === 0) return Promise.resolve();
            return new Promise((resolve) => onceWithTimeout(drainWaiters, drainTimeoutMs, resolve));
        },
        open() {
            closed = false;
            flush(waiters);
        }
    };
}

/**
 * Serialises rotations and owns the cooldown
 */
function createRotationCoordinator({
    rotateOnce,
    getExitIp,
    closeGates,
    openGates,
    cooldownMs = COOLDOWN_MS,
    maxAttempts = MAX_ATTEMPTS
} = {}) {
    let rotating = false;
    let lastRotation = 0;
    let currentIp = null;

    async function exitIpOrNull() {
        try {
            return await getExitIp();
        } catch (_) {
            return null;
        }
    }

    return {
        isRotating() { return rotating; },
        currentIp() { return currentIp; },
        async rotate() {
            if (rotating) return { rotated: false, reason: 'in-flight' };
            if (cooldownMs > 0 && Date.now() - lastRotation < cooldownMs) {
                return { rotated: false, reason: 'cooldown' };
            }

            rotating = true;
            try {
                await closeGates();
                const oldIp = currentIp || await exitIpOrNull();

                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    await rotateOnce();
                    const newIp = await exitIpOrNull();
                    if (newIp && newIp !== oldIp) {
                        currentIp = newIp;
                        lastRotation = Date.now();
                        log('info', `[warpRotation] IP rotated: ${oldIp} -> ${newIp} (attempt ${attempt})`);
                        return { rotated: true, ip: newIp, attempt };
                    }
                    log('warn', `[warpRotation] IP unchanged after attempt ${attempt} (${newIp})`);
                }

                lastRotation = Date.now();
                return { rotated: false, reason: 'unchanged' };
            } catch (err) {
                lastRotation = Date.now();
                log('warn', `[warpRotation] rotation error: ${err.message}`);
                return { rotated: false, reason: 'error', error: err.message };
            } finally {
                openGates();
                rotating = false;
            }
        }
    };
}

// ── The real warp-cli side ───────────────────────────────────────────

async function warpCli(...args) {
    await execFileAsync('warp-cli', ['--accept-tos', ...args], { timeout: 10000 });
}

async function realRotateOnce() {
    await warpCli('disconnect');
    await sleep(DISCONNECT_SETTLE_MS);
    await warpCli('connect');
    await sleep(CONNECT_SETTLE_MS);
}

async function realGetExitIp() {
    const endpoint = WARP_PROXY_URL.replace(/^socks5h?:\/\//, '');
    const { stdout } = await execFileAsync(
        'curl',
        ['-s', '--max-time', '5', '--socks5-hostname', endpoint, 'https://ifconfig.me'],
        { timeout: 8000 }
    );
    return stdout.trim() || null;
}

// ── Process-local gate, used by every WARP request in this process ───

const gate = createGate();

const awaitWarpGate = () => gate.wait();
const beginWarpRequest = () => gate.begin();
const endWarpRequest = () => gate.end();

// ── Cluster wiring ───────────────────────────────────────────────────

const MSG = {
    rotate: 'warp:rotate',
    rotateDone: 'warp:rotate-done',
    gateClose: 'warp:gate-close',
    gateClosed: 'warp:gate-closed',
    gateOpen: 'warp:gate-open'
};

let coordinator = null;

/** Standalone fallback: no cluster, so this process owns warp-svc and its own gate. */
function localCoordinator() {
    if (!coordinator) {
        coordinator = createRotationCoordinator({
            rotateOnce: realRotateOnce,
            getExitIp: realGetExitIp,
            closeGates: () => gate.close(),
            openGates: () => gate.open()
        });
    }
    return coordinator;
}

/**
 * Called by the cluster primary. The primary serves no traffic, so it holds no gate of its own;
 * it closes every worker's gate, waits for the acknowledgements, then runs warp-cli.
 */
function installWarpRotationHost({ rotateOnce = realRotateOnce, getExitIp = realGetExitIp } = {}) {
    let gateToken = 0;

    function liveWorkers() {
        return Object.values(cluster.workers || {}).filter(w => w && w.isConnected());
    }

    function closeGates() {
        const workers = liveWorkers();
        if (workers.length === 0) return Promise.resolve();

        const token = ++gateToken;
        return new Promise((resolve) => {
            const pending = new Set(workers.map(w => w.id));
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                cluster.off('message', onAck);
                resolve();
            };
            const onAck = (worker, msg) => {
                if (!msg || msg.type !== MSG.gateClosed || msg.token !== token) return;
                pending.delete(worker.id);
                if (pending.size === 0) finish();
            };

            cluster.on('message', onAck);
            // Longer than a worker's own drain, so a slow worker acknowledges rather than times out.
            const timer = setTimeout(finish, DRAIN_TIMEOUT_MS + 1000);
            for (const w of workers) {
                try { w.send({ type: MSG.gateClose, token }); } catch (_) { pending.delete(w.id); }
            }
            if (pending.size === 0) finish();
        });
    }

    function openGates() {
        for (const w of liveWorkers()) {
            try { w.send({ type: MSG.gateOpen }); } catch (_) { /* worker is going away */ }
        }
    }

    coordinator = createRotationCoordinator({ rotateOnce, getExitIp, closeGates, openGates });

    cluster.on('message', (worker, msg) => {
        if (!msg || msg.type !== MSG.rotate) return;
        coordinator.rotate().then((result) => {
            try { worker.send({ type: MSG.rotateDone, id: msg.id, result }); } catch (_) { /* gone */ }
        });
    });

    log('info', '[warpRotation] host installed on the cluster primary');
}

/** Worker side: obey the primary's gate messages. */
if (cluster.isWorker && typeof process.send === 'function') {
    process.on('message', (msg) => {
        if (!msg || !msg.type) return;
        if (msg.type === MSG.gateClose) {
            gate.close().then(() => {
                try { process.send({ type: MSG.gateClosed, token: msg.token }); } catch (_) { /* gone */ }
            });
        } else if (msg.type === MSG.gateOpen) {
            gate.open();
        }
    });
}

const pendingRotations = new Map();
let rotationId = 0;

if (cluster.isWorker && typeof process.send === 'function') {
    process.on('message', (msg) => {
        if (!msg || msg.type !== MSG.rotateDone) return;
        const settle = pendingRotations.get(msg.id);
        if (!settle) return;
        pendingRotations.delete(msg.id);
        settle(msg.result || { rotated: false, reason: 'no-result' });
    });
}

/**
 * Ask for a WARP IP rotation. In a cluster worker this hands the job to the primary, which is the
 * only process allowed to touch warp-cli; anywhere else it rotates locally.
 */
function requestWarpRotation() {
    if (!cluster.isWorker || typeof process.send !== 'function') {
        return localCoordinator().rotate();
    }

    const id = `${process.pid}-${++rotationId}`;
    return new Promise((resolve) => {
        let done = false;
        const settle = (result) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            pendingRotations.delete(id);
            resolve(result);
        };
        const timer = setTimeout(() => settle({ rotated: false, reason: 'timeout' }), ROTATE_REPLY_TIMEOUT_MS);

        pendingRotations.set(id, settle);
        try {
            process.send({ type: MSG.rotate, id });
        } catch (err) {
            settle({ rotated: false, reason: 'error', error: err.message });
        }
    });
}

function getWarpRotationStats() {
    return {
        gateClosed: gate.isClosed(),
        inFlight: gate.inFlight(),
        rotating: coordinator ? coordinator.isRotating() : false,
        currentIp: coordinator ? coordinator.currentIp() : null
    };
}

module.exports = {
    createGate,
    createRotationCoordinator,
    installWarpRotationHost,
    requestWarpRotation,
    awaitWarpGate,
    beginWarpRequest,
    endWarpRequest,
    getWarpRotationStats
};

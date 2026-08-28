'use strict';

/**
 * Budgeted job runner. Each job gets a deadline it is expected to stop at, reporting what
 * it left behind, and is armed with a setTimeout chain so a slow run cannot overlap itself.
 */

const { log: defaultLog } = require('../utils');

const JITTER_RATIO = 0.1;
const EXHAUSTION_WARN_STREAK = 3;

function createScheduler(options = {}) {
    const logger = options.log || defaultLog;
    const jobs = new Map();
    let stopped = false;

    function jitter(ms) {
        const spread = ms * JITTER_RATIO;
        return Math.max(0, Math.round(ms - spread + Math.random() * spread * 2));
    }

    function arm(job, delayMs) {
        if (stopped) return;
        job.timer = setTimeout(() => { run(job).catch(() => {}); }, delayMs);
        if (job.timer.unref) job.timer.unref();
    }

    async function run(job) {
        if (stopped || job.running) return;
        job.running = true;
        job.timer = null;

        const startedAt = Date.now();
        const deadline = job.budgetMs > 0 ? startedAt + job.budgetMs : Infinity;

        try {
            const result = await job.fn({ deadline, name: job.name });
            const elapsed = Date.now() - startedAt;
            job.runs++;
            job.lastMs = elapsed;
            job.lastResult = result || null;
            job.lastError = null;

            const saidIncomplete = result && result.done === false;
            const usedBudget = job.budgetMs > 0 && elapsed >= job.budgetMs;
            if (saidIncomplete || usedBudget) {
                job.exhaustedStreak++;
                if (job.exhaustedStreak >= EXHAUSTION_WARN_STREAK) {
                    logger('warn',
                        `[jobs] ${job.name} hit its ${job.budgetMs}ms budget ${job.exhaustedStreak} runs in a row` +
                        (result && result.remaining != null ? `, ${result.remaining} remaining` : ''));
                }
            } else {
                job.exhaustedStreak = 0;
            }

            logger('debug', `[jobs] ${job.name} ok in ${elapsed}ms` +
                (result && result.remaining != null ? ` (remaining=${result.remaining})` : ''));
        } catch (err) {
            job.errors++;
            job.lastError = err.message;
            logger('error', `[jobs] ${job.name} failed: ${err.message}`);
        } finally {
            job.running = false;
            arm(job, jitter(job.everyMs));
        }
    }

    /**
     * @param {object} spec
     * @param {string} spec.name
     * @param {number} spec.everyMs      interval between the end of one run and the next
     * @param {number} [spec.budgetMs]   soft deadline handed to fn; 0 disables
     * @param {number} [spec.delayMs]    initial delay, used to stagger startup
     * @param {(ctx: {deadline:number,name:string}) => any} spec.fn
     */
    function schedule({ name, everyMs, budgetMs = 0, delayMs = 0, fn }) {
        if (jobs.has(name)) throw new Error(`job already scheduled: ${name}`);
        if (typeof fn !== 'function') throw new Error(`job ${name} needs a fn`);
        if (!(everyMs > 0)) throw new Error(`job ${name} needs a positive everyMs`);

        const job = {
            name, everyMs, budgetMs, fn,
            timer: null, running: false,
            runs: 0, errors: 0, lastMs: null, lastResult: null, lastError: null,
            exhaustedStreak: 0
        };
        jobs.set(name, job);
        arm(job, delayMs);
        return job;
    }

    /** Run a job immediately, outside its schedule. */
    async function runNow(name) {
        const job = jobs.get(name);
        if (!job) throw new Error(`unknown job: ${name}`);
        if (job.timer) { clearTimeout(job.timer); job.timer = null; }
        await run(job);
        return job;
    }

    function stopAll() {
        stopped = true;
        for (const job of jobs.values()) {
            if (job.timer) { clearTimeout(job.timer); job.timer = null; }
        }
    }

    function list() {
        return [...jobs.values()].map(j => ({
            name: j.name, everyMs: j.everyMs, budgetMs: j.budgetMs,
            runs: j.runs, errors: j.errors, lastMs: j.lastMs,
            running: j.running, exhaustedStreak: j.exhaustedStreak, lastError: j.lastError
        }));
    }

    function isStopped() { return stopped; }

    return { schedule, runNow, stopAll, list, isStopped, jobs };
}

module.exports = { createScheduler, EXHAUSTION_WARN_STREAK };

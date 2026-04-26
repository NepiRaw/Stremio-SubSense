'use strict';

/**
 * Stats API routes - v1-equivalent endpoints for full mode.
 *
 * All routes return 403 when stats are disabled.
 * In minimal mode, only /api/stats/users is accessible.
 */

const express = require('express');
const path = require('path');
const { log } = require('../../src/utils');
const {
    statsDB, statsService,
    isFullStats, isMinimalStats, isStatsEnabled,
    getCachedStats
} = require('../stats');

const router = express.Router();

/* ---------- guard middleware ---------- */

function requireFull(req, res, next) {
    if (!isFullStats()) {
        return res.status(403).json({ error: 'Statistics are disabled on this instance' });
    }
    next();
}

/* ---------- HTML pages ---------- */

router.get('/stats', (req, res) => {
    if (!isFullStats()) {
        return res.status(403).send(disabledPage('Statistics Disabled', 'The administrator has disabled statistics on this instance.'));
    }
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'stats.html'));
});

router.get('/stats/content', (req, res) => {
    if (!isFullStats()) {
        return res.status(403).send(disabledPage('Cache Browser Disabled', 'The administrator has disabled statistics on this instance.'));
    }
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'content.html'));
});

router.get('/stats/json', requireFull, async (req, res) => {
    try {
        res.json(await getCachedStats());
    } catch (err) {
        log('error', `[stats-api] /stats/json error: ${err.message}`);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

/* ---------- JSON API ---------- */

router.get('/api/stats/cache', requireFull, async (req, res) => {
    try {
        res.json(await statsDB.getCacheStats());
    } catch (err) {
        log('error', `[stats-api] /api/stats/cache error: ${err.message}`);
        res.status(500).json({ error: 'Failed to get cache stats' });
    }
});

router.get('/api/stats/providers', requireFull, async (req, res) => {
    try {
        const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
        res.json(await statsDB.getProviderStats(days));
    } catch (err) {
        log('error', `[stats-api] /api/stats/providers error: ${err.message}`);
        res.status(500).json({ error: 'Failed to get provider stats' });
    }
});

router.get('/api/stats/languages', requireFull, async (req, res) => {
    try {
        const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
        res.json(await statsDB.getLanguageStats(days));
    } catch (err) {
        log('error', `[stats-api] /api/stats/languages error: ${err.message}`);
        res.status(500).json({ error: 'Failed to get language stats' });
    }
});

router.get('/api/stats/daily', requireFull, async (req, res) => {
    try {
        const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
        res.json(await statsDB.getDailyStats(days));
    } catch (err) {
        log('error', `[stats-api] /api/stats/daily error: ${err.message}`);
        res.status(500).json({ error: 'Failed to get daily stats' });
    }
});

router.get('/api/stats/sessions', requireFull, async (req, res) => {
    try {
        const requestedDays = parseInt(req.query.days, 10) || 30;
        const allowed = [1, 3, 7, 14, 30, 60];
        const days = allowed.includes(requestedDays) ? requestedDays : 30;

        const activeCount = await statsDB.getActiveUsersCount(days);

        const formatDate = (date, includeTime = false) => {
            const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            const month = months[date.getMonth()];
            const day = date.getDate();
            if (includeTime) return `${month} ${day}, ${date.getHours().toString().padStart(2,'0')}:00`;
            return `${month} ${day}`;
        };

        const getMidnight = (date) => {
            const d = new Date(date);
            d.setHours(0,0,0,0);
            return Math.floor(d.getTime() / 1000);
        };

        const breakdown = { days, activeUsers: activeCount, intervals: [] };
        const now = new Date();

        if (days === 1) {
            for (let h = 24; h > 0; h -= 2) {
                const pt = new Date(now.getTime() - h * 3600000);
                breakdown.intervals.push({
                    label: formatDate(pt, true),
                    value: await statsDB.getActiveUsersInWindow(h / 24, (h - 2) / 24)
                });
            }
        } else if (days === 3) {
            for (let h = 72; h > 0; h -= 6) {
                const pt = new Date(now.getTime() - h * 3600000);
                breakdown.intervals.push({
                    label: formatDate(pt, true),
                    value: await statsDB.getActiveUsersInWindow(h / 24, (h - 6) / 24)
                });
            }
        } else {
            const today = new Date(now);
            today.setHours(0,0,0,0);
            const nowTs = Math.floor(now.getTime() / 1000);
            for (let d = days - 1; d >= 0; d--) {
                const dayStart = new Date(today.getTime() - d * 86400000);
                const dayEnd   = new Date(dayStart.getTime() + 86400000);
                const startTs  = getMidnight(dayStart);
                const endTs    = getMidnight(dayEnd);
                const isToday  = d === 0;
                breakdown.intervals.push({
                    label: isToday ? formatDate(dayStart) + ' (today)' : formatDate(dayStart),
                    value: await statsDB.getActiveUsersOnDay(startTs, isToday ? nowTs : endTs)
                });
            }
        }

        res.json(breakdown);
    } catch (err) {
        log('error', `[stats-api] /api/stats/sessions error: ${err.message}`);
        res.status(500).json({ error: 'Failed to get session stats' });
    }
});

/* ---------- Cache browser ---------- */

router.get('/api/cache/search', requireFull, async (req, res) => {
    try {
        const imdb = (req.query.imdb || '').trim();
        if (!/^tt\d{7,8}$/.test(imdb)) {
            return res.status(400).json({ error: 'Invalid IMDB ID format' });
        }
        const result = await statsDB.searchCacheByImdb(imdb);
        if (!result) return res.status(404).json({ error: 'Content not found in cache', imdbId: imdb });
        res.json(result);
    } catch (err) {
        log('error', `[stats-api] /api/cache/search error: ${err.message}`);
        res.status(500).json({ error: 'Failed to search cache' });
    }
});

router.get('/api/cache/list', requireFull, async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        res.json(await statsDB.getContentCacheSummary({ page, limit }));
    } catch (err) {
        log('error', `[stats-api] /api/cache/list error: ${err.message}`);
        res.status(500).json({ error: 'Failed to list cache' });
    }
});

/* ---------- Minimal-mode user counts (also available in full mode) ---------- */

router.get('/api/stats/users', async (req, res) => {
    if (!isStatsEnabled()) {
        return res.status(403).json({ error: 'Statistics are disabled' });
    }
    try {
        const windowMin = Math.max(1, Math.min(1440, parseInt(req.query.window, 10) || 15));
        res.json(await statsDB.getUserCounts(windowMin));
    } catch (err) {
        log('error', `[stats-api] /api/stats/users error: ${err.message}`);
        res.status(500).json({ error: 'Failed to get user counts' });
    }
});

/* ---------- helpers ---------- */

function disabledPage(title, message) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>body{font-family:Inter,sans-serif;background:#0a0a0a;color:#e0e0e0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.c{text-align:center;padding:2rem;max-width:500px}.c h1{font-size:1.5rem;margin-bottom:1rem;color:#ff6b6b}
.c p{color:#999;line-height:1.6}.c a{color:#6c5ce7;text-decoration:none}.c a:hover{text-decoration:underline}</style>
</head><body><div class="c"><h1>${title}</h1><p>${message}</p><p><a href="/configure">← Back to Configure</a></p></div></body></html>`;
}

module.exports = router;

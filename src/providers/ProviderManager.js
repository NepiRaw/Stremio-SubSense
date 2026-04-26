'use strict';

const { log } = require('../../src/utils');
const InflightCache = require('../cache/InflightCache');

const DEFAULT_DEADLINE_MS = parseInt(process.env.PROVIDER_DEADLINE_MS, 10) || 8000;

/**
 * Per-request orchestrator.
 *
 *   searchAll(query, options) ->
 *     {
 *       subtitles: SubtitleResult[],          // deduped, all providers merged
 *       backgroundPromises: Promise[],        // background work to be awaited
 *                                             //   by the caller off-band for
 *                                             //   cache warming
 *       providerResults: { [name]: number }   // per-provider counts (logging)
 *     }
 *
 * Two layers of safety:
 *   1. InflightCache dedupes concurrent identical requests.
 *   2. Per-provider deadline (PROVIDER_DEADLINE_MS) ensures one slow provider
 *      cannot hold the response.
 */
class ProviderManager {
    constructor() {
        this.providers = new Map();
        this.inflight = new InflightCache();
    }

    register(provider) {
        if (this.providers.has(provider.name)) {
            log('warn', `[ProviderManager] Replacing provider "${provider.name}"`);
        }
        this.providers.set(provider.name, provider);
        log('info', `[ProviderManager] Registered: ${provider.name}`);
    }

    unregister(name) {
        if (this.providers.delete(name)) {
            log('info', `[ProviderManager] Unregistered: ${name}`);
        }
    }

    get(name) {
        return this.providers.get(name);
    }

    getAll() {
        return Array.from(this.providers.values());
    }

    getEnabled() {
        return this.getAll().filter((p) => p.enabled);
    }

    /**
     * @param {Object} query - Standardized query (see BaseProvider doc).
     * @param {Object} [options]
     * @param {number} [options.deadlineMs] - Per-provider deadline override.
     * @param {string} [options.dedupeKey] - InflightCache key.
     */
    async searchAll(query, options = {}) {
        const deadlineMs = options.deadlineMs || DEFAULT_DEADLINE_MS;
        const key = options.dedupeKey || this._dedupeKey(query);

        return this.inflight.getOrFetch(key, () => this._doSearch(query, deadlineMs));
    }

    async _doSearch(query, deadlineMs) {
        const providers = this.getEnabled();
        if (providers.length === 0) {
            log('warn', '[ProviderManager] No enabled providers');
            return { subtitles: [], backgroundPromises: [], providerResults: {} };
        }

        const startedAt = Date.now();
        const results = await Promise.all(
            providers.map((p) => this._raceWithDeadline(p, query, deadlineMs))
        );
        const totalMs = Date.now() - startedAt;

        const allSubtitles = [];
        const backgroundPromises = [];
        const providerResults = {};
        const summary = [];

        for (let i = 0; i < providers.length; i++) {
            const p = providers[i];
            const r = results[i];
            providerResults[p.name] = r.subtitles.length;
            summary.push(`${p.name}:${r.timedOut ? 'TO+' : ''}${r.subtitles.length}`);
            if (r.subtitles.length > 0) allSubtitles.push(...r.subtitles);
            if (r.backgroundPromise) backgroundPromises.push(r.backgroundPromise);
        }

        log('info', `[Providers] ${queryTag(query)} ${providers.length} providers in ${totalMs}ms - ${summary.join(', ')}`);

        return {
            subtitles: dedupe(allSubtitles),
            backgroundPromises,
            providerResults
        };
    }

    /**
     * Race the provider against the deadline. If the deadline wins, the
     * provider's pending search becomes the backgroundPromise so its results
     * can warm the cache when they eventually arrive.
     */
    _raceWithDeadline(provider, query, deadlineMs) {
        return new Promise((resolve) => {
            let settled = false;
            let timer = null;

            const searchPromise = (async () => {
                try {
                    return await provider.search(query);
                } catch (err) {
                    log('error', `[ProviderManager] ${provider.name} threw: ${err.message}`);
                    return { subtitles: [] };
                }
            })();

            timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                log('warn', `[ProviderManager] ${provider.name} exceeded ${deadlineMs}ms; deferring to background`);
                resolve({
                    subtitles: [],
                    backgroundPromise: searchPromise,
                    timedOut: true
                });
            }, deadlineMs);

            searchPromise.then((res) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                const subs = (res && res.subtitles) || [];
                resolve({
                    subtitles: subs,
                    backgroundPromise: (res && res.backgroundPromise) || null,
                    timedOut: false
                });
            });
        });
    }

    _dedupeKey(query) {
        const langs = Array.isArray(query.languages) ? [...query.languages].sort().join(',') : '';
        const apiHint = query.apiKeys && query.apiKeys.subsource ? 'k1' : 'k0';
        return `${query.imdbId}:${query.season || 0}:${query.episode || 0}:${langs}:${apiHint}`;
    }

    getStats() {
        const out = {};
        for (const [name, provider] of this.providers) {
            out[name] = provider.getStats();
        }
        return out;
    }

    resetStats() {
        for (const provider of this.providers.values()) {
            provider.resetStats();
        }
    }
}

function dedupe(list) {
    const seen = new Set();
    const out = [];
    for (const sub of list) {
        const key = sub.url || sub.id;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        out.push(sub);
    }
    return out;
}

function queryTag(query) {
    if (!query) return '';
    const parts = [];
    if (query.imdbId) parts.push(`imdb=${query.imdbId}`);
    if (query.season != null) parts.push(`s=${query.season}`);
    if (query.episode != null) parts.push(`e=${query.episode}`);
    if (Array.isArray(query.languages) && query.languages.length > 0) parts.push(`langs=${query.languages.join(',')}`);
    return parts.join(' ');
}

const providerManager = new ProviderManager();

module.exports = { ProviderManager, providerManager };

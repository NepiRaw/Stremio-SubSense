'use strict';

/**
 * Standardized provider contract.
 *
 *   async search(query) -> { subtitles: SubtitleResult[], backgroundPromise?: Promise }
 *
 * query shape:
 *   {
 *     imdbId: string,
 *     season: number|null,
 *     episode: number|null,
 *     languages: string[],          // ISO 639-1 lowercase, sorted
 *     filename?: string,
 *     apiKeys?: { subsource?: string },
 *     encryptedApiKeys?: { subsource?: string }
 *   }
 */

class BaseProvider {
    constructor(name, options = {}) {
        if (this.constructor === BaseProvider) {
            throw new Error('BaseProvider is abstract');
        }
        this.name = name;
        this.options = options;
        this.enabled = options.enabled !== false;

        this.stats = {
            requests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            totalSubtitlesReturned: 0,
            totalFetchTimeMs: 0,
            avgFetchTimeMs: 0,
            lastError: null,
            lastRequestAt: null
        };
    }

    async search(_query) {
        throw new Error(`${this.name}.search() not implemented`);
    }

    getSources() {
        return [this.name];
    }

    getStats() {
        return { name: this.name, enabled: this.enabled, ...this.stats };
    }

    resetStats() {
        this.stats.requests = 0;
        this.stats.successfulRequests = 0;
        this.stats.failedRequests = 0;
        this.stats.totalSubtitlesReturned = 0;
        this.stats.totalFetchTimeMs = 0;
        this.stats.avgFetchTimeMs = 0;
        this.stats.lastError = null;
        this.stats.lastRequestAt = null;
    }

    _recordRequest(success, fetchTimeMs, subtitleCount, error = null) {
        this.stats.requests++;
        this.stats.lastRequestAt = new Date().toISOString();
        if (success) {
            this.stats.successfulRequests++;
            this.stats.totalSubtitlesReturned += subtitleCount;
            this.stats.totalFetchTimeMs += fetchTimeMs;
            this.stats.avgFetchTimeMs = Math.round(
                this.stats.totalFetchTimeMs / this.stats.successfulRequests
            );
        } else {
            this.stats.failedRequests++;
            this.stats.lastError = error ? error.message : 'Unknown error';
        }

        this._recordToDatabase(success, fetchTimeMs, subtitleCount);
    }

    _recordToDatabase(success, responseMs, subtitlesCount) {
        try {
            if (!this._statsDB) {
                try {
                    const { statsDB, isFullStats, queueWrite } = require('../stats');
                    if (!isFullStats()) return;
                    this._statsDB = statsDB;
                    this._queueWrite = queueWrite;
                } catch (_) { return; }
            }
            if (this._statsDB && this._statsDB.recordProviderStats) {
                const fn = () => this._statsDB.recordProviderStats({
                    providerName: this.name,
                    success,
                    responseMs: responseMs || 0,
                    subtitlesCount: subtitlesCount || 0
                });
                if (this._queueWrite) this._queueWrite(fn);
                else fn().catch(() => {});
            }
        } catch (_) { /* never fail the request path */ }
    }
}

class SubtitleResult {
    constructor({
        id,
        url,
        language,        // ISO 639-1 (2-letter) or full language name
        languageCode,    // ISO 639-2 (3-letter) for Stremio
        source,          // Source name (e.g., 'opensubtitles', 'subdl')
        provider,        // Provider name (e.g., 'wyzie')
        releaseName = '',
        fileName = null, // Original subtitle filename
        releases = [],   // All release names for multi-candidate matching (Wyzie releases[])
        hearingImpaired = false,
        rating = null,
        downloadCount = null,
        display = '',    // Display name (e.g., 'English', 'French')

        // Format hints - provider indicates what format the subtitle is in
        format = null,          // Detected/assumed format: 'srt', 'ass', 'ssa', 'vtt', 'unknown'
        needsConversion = null  // true/false/null - null means "needs inspection"
    }) {
        this.id = id;
        this.url = url;
        this.language = language;
        this.languageCode = languageCode;
        this.source = source;
        this.provider = provider;
        this.releaseName = releaseName;
        this.fileName = fileName;
        this.releases = releases;
        this.hearingImpaired = hearingImpaired;
        this.rating = rating;
        this.downloadCount = downloadCount;
        this.display = display;

        this.format = format;
        this.needsConversion = needsConversion;
    }
}

module.exports = { BaseProvider, SubtitleResult };

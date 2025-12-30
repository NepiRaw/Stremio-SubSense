/**
 * ProviderManager - Manages multiple subtitle providers
 * 
 * Responsibilities:
 * - Register/unregister providers
 * - Query all enabled providers
 * - Aggregate results from multiple providers
 * - Per-provider statistics
 * - Handle provider failures gracefully
 */

const { log } = require('../utils');

class ProviderManager {
    constructor() {
        /** @type {Map<string, import('./BaseProvider').BaseProvider>} */
        this.providers = new Map();
    }

    /**
     * Register a subtitle provider
     * @param {import('./BaseProvider').BaseProvider} provider
     */
    register(provider) {
        if (this.providers.has(provider.name)) {
            log('warn', `[ProviderManager] Provider "${provider.name}" already registered, replacing...`);
        }
        this.providers.set(provider.name, provider);
        log('info', `[ProviderManager] Registered provider: ${provider.name}`);
    }

    /**
     * Unregister a provider
     * @param {string} name - Provider name
     */
    unregister(name) {
        if (this.providers.delete(name)) {
            log('info', `[ProviderManager] Unregistered provider: ${name}`);
        }
    }

    /**
     * Get a specific provider
     * @param {string} name
     * @returns {import('./BaseProvider').BaseProvider|undefined}
     */
    get(name) {
        return this.providers.get(name);
    }

    /**
     * Get all registered providers
     * @returns {Array<import('./BaseProvider').BaseProvider>}
     */
    getAll() {
        return Array.from(this.providers.values());
    }

    /**
     * Get all enabled providers
     * @returns {Array<import('./BaseProvider').BaseProvider>}
     */
    getEnabled() {
        return this.getAll().filter(p => p.enabled);
    }

    /**
     * Search all enabled providers for subtitles
     * @param {Object} query - Search parameters
     * @returns {Promise<Array<import('./BaseProvider').SubtitleResult>>}
     */
    async searchAll(query) {
        const enabledProviders = this.getEnabled();
        
        if (enabledProviders.length === 0) {
            log('warn', '[ProviderManager] No enabled providers');
            return [];
        }

        log('debug', `[ProviderManager] Searching ${enabledProviders.length} provider(s): ${enabledProviders.map(p => p.name).join(', ')}`);

        // Query all providers in parallel
        const results = await Promise.allSettled(
            enabledProviders.map(provider => provider.search(query))
        );

        // Aggregate results from all providers
        const allSubtitles = [];
        
        results.forEach((result, index) => {
            const provider = enabledProviders[index];
            
            if (result.status === 'fulfilled') {
                allSubtitles.push(...result.value);
                log('debug', `[ProviderManager] ${provider.name}: ${result.value.length} subtitles`);
            } else {
                log('error', `[ProviderManager] ${provider.name} failed: ${result.reason?.message || 'Unknown error'}`);
            }
        });

        log('debug', `[ProviderManager] Total aggregated: ${allSubtitles.length} subtitles`);
        
        return allSubtitles;
    }

    /**
     * Search all providers with specific language filter
     * @param {Object} query - Search parameters
     * @param {Array<string>} languages - Language codes to filter
     * @returns {Promise<Array<import('./BaseProvider').SubtitleResult>>}
     */
    async searchByLanguages(query, languages) {
        const enabledProviders = this.getEnabled();
        
        if (enabledProviders.length === 0) {
            return [];
        }

        // Use searchByLanguages if provider supports it, otherwise regular search
        const results = await Promise.allSettled(
            enabledProviders.map(provider => {
                if (typeof provider.searchByLanguages === 'function') {
                    return provider.searchByLanguages(query, languages);
                }
                return provider.search(query);
            })
        );

        const allSubtitles = [];
        
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                allSubtitles.push(...result.value);
            }
        });

        return allSubtitles;
    }

    /**
     * Get statistics for all providers
     * @returns {Object} Provider stats by name
     */
    getStats() {
        const stats = {};
        
        for (const [name, provider] of this.providers) {
            stats[name] = provider.getStats();
        }

        return stats;
    }

    /**
     * Reset stats for all providers
     */
    resetStats() {
        for (const provider of this.providers.values()) {
            provider.resetStats();
        }
        log('info', '[ProviderManager] Reset all provider stats');
    }
}

// Singleton instance
const providerManager = new ProviderManager();

module.exports = {
    ProviderManager,
    providerManager
};

/**
 * Subtitle Providers Module
 * 
 * This module provides a provider abstraction layer for subtitle fetching.
 * It allows adding multiple providers independently and decouples the
 * subtitle logic from any specific provider implementation.
 * 
 * Usage:
 * ```javascript
 * const { providerManager, WyzieProvider } = require('./providers');
 * 
 * // Register providers
 * providerManager.register(new WyzieProvider());
 * 
 * // Search all providers
 * const subtitles = await providerManager.searchAll({
 *   imdbId: 'tt1234567',
 *   season: 1,
 *   episode: 5
 * });
 * ```
 * 
 * Adding a new provider:
 * 1. Create a new file (e.g., OpenSubtitlesProvider.js)
 * 2. Extend BaseProvider and implement search()
 * 3. Register in the manager
 */

const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { ProviderManager, providerManager } = require('./ProviderManager');
const WyzieProvider = require('./WyzieProvider');

// Initialize default providers
function initializeDefaultProviders() {
    // Only register if not already registered
    if (!providerManager.get('wyzie')) {
        providerManager.register(new WyzieProvider());
    }
}

// Auto-initialize on module load
initializeDefaultProviders();

module.exports = {
    providerManager,
    WyzieProvider
};

'use strict';

const { BaseProvider, SubtitleResult } = require('./BaseProvider');
const { ProviderManager, providerManager } = require('./ProviderManager');
const WyzieProvider = require('./WyzieProvider');
const BetaSeriesProvider = require('./BetaSeriesProvider');
const YIFYProvider = require('./YIFYProvider');
const SubSourceProvider = require('./SubSourceProvider');
const TVsubtitlesProvider = require('./TVsubtitlesProvider');

function isEnabled(name) {
    const sources = process.env.SUBTITLE_SOURCES;
    if (!sources) return true;
    const list = sources.split(',').map((s) => s.trim().toLowerCase());
    return list.includes(name.toLowerCase());
}

function registerDefaultProviders(manager = providerManager) {
    if (!manager.get('wyzie') && isEnabled('wyzie')) {
        manager.register(new WyzieProvider());
    }
    if (!manager.get('betaseries') && isEnabled('betaseries') && process.env.BETASERIES_API_KEY) {
        manager.register(new BetaSeriesProvider());
    }
    if (!manager.get('yify') && isEnabled('yify')) {
        manager.register(new YIFYProvider());
    }
    if (!manager.get('tvsubtitles') && isEnabled('tvsubtitles')) {
        manager.register(new TVsubtitlesProvider());
    }
    if (!manager.get('subsource') && isEnabled('subsource')) {
        manager.register(new SubSourceProvider());
    }
    return manager;
}

module.exports = {
    BaseProvider,
    SubtitleResult,
    ProviderManager,
    providerManager,
    WyzieProvider,
    BetaSeriesProvider,
    YIFYProvider,
    SubSourceProvider,
    TVsubtitlesProvider,
    registerDefaultProviders
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(path, exports) {
    const resolved = require.resolve(path);
    const previous = require.cache[resolved];
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    return () => {
        if (previous) require.cache[resolved] = previous;
        else delete require.cache[resolved];
    };
}

function loadHandler({ l1Hit, l2Hit = null, identity }) {
    const calls = { resolver: 0, l1Del: 0, l1Set: 0, refresh: 0, l2: 0 };
    const l1 = {
        SUBSRC_KEY_PLACEHOLDER: '__SUBSRC_KEY__',
        SUBSRC_HOST_MARKER: '/subsource/',
        buildKey: () => 'cache-key',
        get: async () => l1Hit,
        del: async () => { calls.l1Del++; return 1; },
        set: async () => { calls.l1Set++; return true; },
        materialize: subtitles => subtitles,
        stats: async () => ({ available: true })
    };
    const restores = [
        stubModule('../../src/cache/response-cache', l1),
        stubModule('../../src/cache/subtitle-store', {
            getByContent: async () => { calls.l2++; return l2Hit; },
            set: async () => null
        }),
        stubModule('../../src/cache/inflight', {
            acquire: async () => true,
            release: async () => {},
            pollFor: async () => null
        }),
        stubModule('../../src/providers', {
            providerManager: {
                searchAll: async () => {
                    calls.refresh++;
                    return { subtitles: [], backgroundPromises: [] };
                }
            }
        }),
        stubModule('../../src/infra/metrics', {
            recordRequest: () => {},
            recordCache: () => {}
        }),
        stubModule('../../src/utils/validateWyzie', {
            validateWyzieUrls: async subtitles => subtitles
        }),
        stubModule('../../src/stats', {
            statsService: { trackRequest: () => {} },
            track: { dist: () => {} }
        }),
        stubModule('../../src/utils/episodeIdentity', {
            resolveEpisodeIdentity: async () => {
                calls.resolver++;
                return identity;
            },
            normalizeImdbId: value => {
                const match = String(value || '').match(/^(?:tt)?(\d+)$/i);
                return match ? `tt${match[1].padStart(7, '0')}` : null;
            }
        })
    ];

    const handlerPath = require.resolve('../../src/handlers/subtitles');
    delete require.cache[handlerPath];
    const handler = require(handlerPath);
    return {
        handler,
        calls,
        cleanup() {
            delete require.cache[handlerPath];
            for (const restore of restores.reverse()) restore();
        }
    };
}

const resolvedIdentity = {
    status: 'resolved',
    seriesImdbId: 'tt9335498',
    episodeImdbId: 'tt17337688'
};

test('mixed L1 series hit drops legacy OS, preserves SubDL, and schedules refresh', async (t) => {
    const fixture = loadHandler({
        identity: resolvedIdentity,
        l1Hit: {
            status: 'fresh',
            subtitles: [
                { id: 'legacy-os', source: 'opensubtitles', url: 'https://dl.opensubtitles.org/wrong.srt' },
                { id: 'safe-subdl', source: 'subdl', url: 'https://example.com/right.srt' }
            ]
        }
    });
    t.after(fixture.cleanup);

    const result = await fixture.handler.handleSubtitlesRequest(
        { id: 'tt9335498:3:9', extra: {} },
        { languages: ['por'] }
    );
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(result.subtitles.map(sub => sub.id), ['safe-subdl']);
    assert.equal(fixture.calls.resolver, 1);
    assert.equal(fixture.calls.l1Del, 1);
    assert.equal(fixture.calls.refresh, 1);
    assert.equal(fixture.calls.l2, 0);
});

test('movie L1 hit preserves legacy OS rows without resolving episode identity', async (t) => {
    const fixture = loadHandler({
        identity: { status: 'unresolved' },
        l1Hit: {
            status: 'fresh',
            subtitles: [
                { id: 'movie-os', source: 'opensubtitles', url: 'https://dl.opensubtitles.org/movie.srt' }
            ]
        }
    });
    t.after(fixture.cleanup);

    const result = await fixture.handler.handleSubtitlesRequest(
        { id: 'tt1234567', extra: {} },
        { languages: ['eng'] }
    );

    assert.deepEqual(result.subtitles.map(sub => sub.id), ['movie-os']);
    assert.equal(fixture.calls.resolver, 0);
    assert.equal(fixture.calls.l1Del, 0);
    assert.equal(fixture.calls.refresh, 0);
    assert.equal(fixture.calls.l2, 0);
});

test('mixed L2 series hit filters legacy OS before warming L1 and refreshes it', async (t) => {
    const fixture = loadHandler({
        identity: resolvedIdentity,
        l1Hit: null,
        l2Hit: {
            subtitles: [
                { source: 'opensubtitles', url: 'https://dl.opensubtitles.org/wrong.srt', lang: 'por' },
                { source: 'wyzie', url: 'https://example.com/right.srt', lang: 'por' }
            ]
        }
    });
    t.after(fixture.cleanup);

    const result = await fixture.handler.handleSubtitlesRequest(
        { id: 'tt9335498:3:9', extra: {} },
        { languages: ['por'] }
    );
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(result.subtitles.map(sub => sub.url), ['https://example.com/right.srt']);
    assert.equal(fixture.calls.resolver, 1);
    assert.equal(fixture.calls.l1Set, 1);
    assert.equal(fixture.calls.refresh, 1);
    assert.equal(fixture.calls.l2, 1);
});

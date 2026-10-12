'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const OpenSubtitlesProvider = require('../../src/providers/OpenSubtitlesProvider');
const { buildEntries, renderEntries } = require('../../src/utils/format');
const { filterCachedEpisodeSubtitles } = require('../../src/utils/episodeCache');

const identity = {
    status: 'resolved',
    seriesImdbId: 'tt9335498',
    episodeImdbId: 'tt17337688',
    expectedSeriesTitle: 'Demon Slayer: Kimetsu no Yaiba',
    expectedTitle: 'Defeating an Upper Rank Demon',
    expectedTitles: ['Defeating an Upper Rank Demon'],
    catalogSeason: 2,
    catalogEpisode: 16
};

function response(body) {
    return { ok: true, async json() { return body; } };
}

function osRow(overrides = {}) {
    return {
        IDSubtitleFile: '123',
        IDMovieImdb: '17337688',
        SeriesIMDBParent: '9335498',
        MovieKind: 'episode',
        MovieName: '"Demon Slayer: Kimetsu no Yaiba" Defeating an Upper Rank Demon',
        ISO639: 'pob',
        SubFormat: 'srt',
        SubDownloadLink: 'https://dl.opensubtitles.org/file/123.gz',
        ...overrides
    };
}

test('provider searches the resolved episode IMDb id and rejects malformed identity rows', async (t) => {
    const calls = [];
    const rows = [
        osRow(),
        osRow({ IDSubtitleFile: 'wrong-id', IDMovieImdb: '27880399' }),
        osRow({ IDSubtitleFile: 'wrong-parent', SeriesIMDBParent: '9999999' }),
        osRow({ IDSubtitleFile: 'wrong-title', MovieName: '"Demon Slayer: Kimetsu no Yaiba" Mist Hashira Muichiro Tokito' }),
        osRow({ IDSubtitleFile: 'missing-kind', MovieKind: undefined }),
        osRow({ IDSubtitleFile: 'missing-parent', SeriesIMDBParent: undefined })
    ];
    const priorFetch = global.fetch;
    global.fetch = async (url) => { calls.push(url); return response(rows); };
    t.after(() => { global.fetch = priorFetch; });

    const provider = new OpenSubtitlesProvider();
    provider._throttle = async () => {};
    const subtitles = await provider._searchSubtitles({
        imdbId: 'tt9335498', season: 3, episode: 9, languages: ['pt-br'], episodeIdentity: identity
    });

    assert.deepEqual(calls, [
        'https://rest.opensubtitles.org/search/imdbid-17337688/sublanguageid-pob'
    ]);
    assert.equal(subtitles.length, 1);
    assert.equal(subtitles[0].id, 'os-123');
    assert.equal(subtitles[0].verifiedEpisodeImdbId, 'tt17337688');
});

test('provider fails closed before network access when series identity is unresolved', async (t) => {
    let calls = 0;
    const priorFetch = global.fetch;
    global.fetch = async () => { calls++; return response([]); };
    t.after(() => { global.fetch = priorFetch; });

    const provider = new OpenSubtitlesProvider();
    provider._throttle = async () => {};
    const subtitles = await provider._searchSubtitles({
        imdbId: 'tt9335498', season: 3, episode: 9, languages: [],
        episodeIdentity: { status: 'unresolved', reason: 'no-exact-os-match' }
    });

    assert.deepEqual(subtitles, []);
    assert.equal(calls, 0);
});

test('provider accepts an exact alternate Cinemeta episode title', async (t) => {
    const priorFetch = global.fetch;
    global.fetch = async () => response([
        osRow({ MovieName: '"Demon Slayer: Kimetsu no Yaiba" The Alternate Title' })
    ]);
    t.after(() => { global.fetch = priorFetch; });

    const provider = new OpenSubtitlesProvider();
    provider._throttle = async () => {};
    const subtitles = await provider._searchSubtitles({
        imdbId: 'tt9335498', season: 3, episode: 9, languages: [],
        episodeIdentity: {
            ...identity,
            expectedTitles: [identity.expectedTitle, 'The Alternate Title']
        }
    });

    assert.equal(subtitles.length, 1);
    assert.equal(subtitles[0].verifiedEpisodeImdbId, 'tt17337688');
});

test('movie lookup keeps the existing IMDb search and row behavior', async (t) => {
    const calls = [];
    const priorFetch = global.fetch;
    global.fetch = async (url) => {
        calls.push(url);
        return response([
            osRow({ IDSubtitleFile: 'movie-1', IDMovieImdb: '1234567', MovieKind: 'movie' }),
            osRow({ IDSubtitleFile: 'movie-2', IDMovieImdb: undefined, MovieKind: undefined })
        ]);
    };
    t.after(() => { global.fetch = priorFetch; });

    const provider = new OpenSubtitlesProvider();
    provider._throttle = async () => {};
    const subtitles = await provider._searchSubtitles({ imdbId: 'tt1234567', languages: [] });

    assert.deepEqual(calls, ['https://rest.opensubtitles.org/search/imdbid-1234567']);
    assert.equal(subtitles.length, 2);
    assert.equal(subtitles[0].verifiedEpisodeImdbId, null);
});

test('cache filter removes legacy and mismatched OS series rows but preserves other providers', () => {
    const entries = [
        { source: 'opensubtitles', url: 'legacy' },
        { source: 'OpenSubtitles', url: 'wrong', verifiedEpisodeImdbId: 'tt27880399' },
        { source: 'opensubtitles', url: 'safe', verifiedEpisodeImdbId: 'tt17337688' },
        { source: 'subdl', url: 'other-provider' }
    ];

    const result = filterCachedEpisodeSubtitles(entries, 'series', identity);
    assert.equal(result.unsafeCount, 2);
    assert.deepEqual(result.subtitles.map(entry => entry.url), ['safe', 'other-provider']);
});

test('cache filter fails closed for OS series rows when identity cannot resolve', () => {
    const result = filterCachedEpisodeSubtitles([
        { source: 'opensubtitles', url: 'previously-safe', verifiedEpisodeImdbId: 'tt17337688' },
        { source: 'wyzie', url: 'other-provider' }
    ], 'series', { status: 'unresolved' });

    assert.equal(result.unsafeCount, 1);
    assert.deepEqual(result.subtitles.map(entry => entry.url), ['other-provider']);
});

test('movie caches bypass episode identity filtering', () => {
    const entries = [{ source: 'opensubtitles', url: 'movie-legacy' }];
    const result = filterCachedEpisodeSubtitles(entries, 'movie', { status: 'unresolved' });
    assert.equal(result.unsafeCount, 0);
    assert.equal(result.subtitles, entries);
});

test('formatting carries the verified episode marker through the lean cache shape', () => {
    const entries = buildEntries([{
        url: 'https://dl.opensubtitles.org/file/123.srt',
        language: 'pt-br',
        source: 'opensubtitles',
        format: 'srt',
        needsConversion: false,
        verifiedEpisodeImdbId: 'tt17337688'
    }]);

    assert.equal(entries[0].e, 'tt17337688');
    assert.equal(renderEntries(entries)[0].verifiedEpisodeImdbId, 'tt17337688');
});

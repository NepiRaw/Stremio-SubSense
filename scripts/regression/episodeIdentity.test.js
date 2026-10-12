'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    resolveEpisodeIdentity,
    resetCache
} = require('../../src/utils/episodeIdentity');

const SERIES_ID = 'tt9335498';

function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() { return body; }
    };
}

function fakeFetch(routes, { delayMs = 0 } = {}) {
    const calls = [];
    const fetch = async (url, options = {}) => {
        calls.push({ url, options });
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));

        const path = decodeURIComponent(new URL(url).pathname);
        for (const [matcher, result] of routes) {
            if (!path.includes(matcher)) continue;
            if (result instanceof Error) throw result;
            if (typeof result === 'function') return result({ url, path, options });
            return jsonResponse(result);
        }
        return jsonResponse([]);
    };
    fetch.calls = calls;
    return fetch;
}

function metadata(seriesName, name, season, episode, extra = {}) {
    return {
        meta: {
            name: seriesName,
            videos: [{ season, episode, name, ...extra }]
        }
    };
}

function osEpisode({ id, parent = SERIES_ID, name, movieNameEng, season, episode }) {
    const result = {
        IDMovieImdb: id,
        SeriesIMDBParent: parent.replace(/^tt/i, ''),
        MovieName: name,
        SeriesSeason: season,
        SeriesEpisode: episode
    };
    if (movieNameEng !== undefined) result.MovieNameEng = movieNameEng;
    return result;
}

function exactName(seriesName, episodeName) {
    return `"${seriesName}" ${episodeName}`;
}

test.beforeEach(() => resetCache());
test.afterEach(() => resetCache());

test('repeated catalog episode titles cannot establish a unique identity', async () => {
    const fetch = fakeFetch([[`/meta/series/${SERIES_ID}.json`, { meta: {
        name: 'Example Series', videos: [
            { season: 1, episode: 1, name: 'A New Beginning' },
            { season: 2, episode: 1, name: 'A New Beginning' }
        ]
    } }]]);
    const result = await resolveEpisodeIdentity({ imdbId: SERIES_ID, season: 1, episode: 1 }, { fetch });
    assert.equal(result.status, 'unresolved');
    assert.equal(fetch.calls.length, 1);
});

test('repairs Demon Slayer S3E9 with title lookup and returns the OS S2E16 coordinates', async () => {
    const seriesName = 'Demon Slayer: Kimetsu no Yaiba';
    const episodeName = 'Defeating an Upper Rank Demon';
    const fetch = fakeFetch([
        [`/meta/series/${SERIES_ID}.json`, metadata(seriesName, episodeName, 3, 9)],
        ['/search/episode-9/imdbid-9335498/season-3', [
            osEpisode({
                id: 'tt27880399',
                name: exactName(seriesName, 'Mist Hashira Muichiro Tokito'),
                season: 3,
                episode: 9
            })
        ]],
        ['/search/query-defeating an upper rank demon', [
            osEpisode({
                id: '17337688',
                name: exactName(seriesName, episodeName),
                season: '2',
                episode: '16'
            })
        ]]
    ]);

    const result = await resolveEpisodeIdentity({
        imdbId: SERIES_ID,
        season: 3,
        episode: 9
    }, { fetch });

    assert.deepEqual(result, {
        status: 'resolved',
        seriesImdbId: SERIES_ID,
        episodeImdbId: 'tt17337688',
        season: 3,
        episode: 9,
        expectedTitle: episodeName,
        expectedTitles: [episodeName],
        expectedSeriesTitle: seriesName,
        catalogSeason: 2,
        catalogEpisode: 16
    });

    const osCalls = fetch.calls.filter(call => call.url.includes('rest.opensubtitles.org'));
    assert.equal(osCalls.length, 2);
    assert.equal(osCalls[0].options.headers['X-User-Agent'], 'VLSub 0.10.3');
    assert.match(osCalls[1].url, /query-defeating%20an%20upper%20rank%20demon$/);
});

test('repairs Demon Slayer S4E1 to the OpenSubtitles S3E1 identity', async () => {
    const seriesName = 'Demon Slayer: Kimetsu no Yaiba';
    const episodeName = "Someone’s Dream";
    const fetch = fakeFetch([
        [`/meta/series/${SERIES_ID}.json`, metadata(seriesName, episodeName, '4', '1')],
        ['/search/episode-1/imdbid-9335498/season-4', [
            osEpisode({
                id: 'tt3333333',
                name: exactName(seriesName, 'An Older Wrong Title'),
                season: 4,
                episode: 1
            })
        ]],
        ['/search/query/Someone', []],
        ["/search/query-someone’s dream", [
            osEpisode({
                id: '4444444',
                name: exactName(seriesName, "Someone's Dream"),
                season: 3,
                episode: 1
            })
        ]]
    ]);

    const result = await resolveEpisodeIdentity({ imdbId: '9335498', season: '4', episode: '1' }, { fetch });

    assert.equal(result.status, 'resolved');
    assert.equal(result.seriesImdbId, SERIES_ID);
    assert.equal(result.episodeImdbId, 'tt4444444');
    assert.equal(result.catalogSeason, 3);
    assert.equal(result.catalogEpisode, 1);
    assert.equal(result.expectedTitle, episodeName);
    assert.equal(result.expectedSeriesTitle, seriesName);
});

test('leaves a regular show unchanged when canonical parent and title agree', async () => {
    const seriesName = "Bob’s Burgers";
    const episodeName = 'The Frond Files';
    const fetch = fakeFetch([
        ['/meta/series/tt1234567.json', metadata(seriesName, episodeName, 1, 2)],
        ['/search/episode-2/imdbid-1234567/season-1', [
            osEpisode({
                id: '7654321',
                parent: 'tt1234567',
                name: exactName('Bobs Burgers', episodeName),
                season: 1,
                episode: 2
            })
        ]]
    ]);

    const result = await resolveEpisodeIdentity({ imdbId: 'tt1234567', season: 1, episode: 2 }, { fetch });

    assert.deepEqual(result, {
        status: 'resolved',
        seriesImdbId: 'tt1234567',
        episodeImdbId: 'tt7654321',
        season: 1,
        episode: 2,
        expectedTitle: episodeName,
        expectedTitles: [episodeName],
        expectedSeriesTitle: seriesName,
        catalogSeason: 1,
        catalogEpisode: 2
    });
    assert.equal(fetch.calls.filter(call => call.url.includes('search/query-')).length, 0);
});

test('preserves the canonical Game of Thrones IMDb id and pads numeric parents', async () => {
    const seriesName = 'Game of Thrones';
    const episodeName = 'Winter Is Coming';
    const fetch = fakeFetch([
        ['/meta/series/tt0944947.json', metadata(seriesName, episodeName, 1, 1)],
        ['/search/episode-1/imdbid-0944947/season-1', [
            osEpisode({
                id: 'tt0944948',
                parent: 'tt0944947',
                name: exactName(seriesName, episodeName),
                season: 1,
                episode: 1
            })
        ]]
    ]);

    const result = await resolveEpisodeIdentity({ imdbId: '944947', season: '1', episode: '1' }, { fetch });

    assert.equal(result.status, 'resolved');
    assert.equal(result.seriesImdbId, 'tt0944947');
    assert.equal(result.expectedSeriesTitle, seriesName);
    assert.match(fetch.calls[0].url, /\/meta\/series\/tt0944947\.json$/);
    assert.match(fetch.calls[1].url, /imdbid-0944947\/season-1$/);
});

test('accepts an exact English MovieNameEng when MovieName is translated', async () => {
    const seriesName = 'Translated Show';
    const episodeName = 'The English Episode';
    const fetch = fakeFetch([
        ['/meta/series/tt3333333.json', metadata(seriesName, episodeName, 1, 3)],
        ['/search/episode-3/imdbid-3333333/season-1', [
            osEpisode({
                id: 'tt3333334',
                parent: 'tt3333333',
                name: exactName(seriesName, 'O Episódio Traduzido'),
                movieNameEng: exactName(seriesName, episodeName),
                season: 1,
                episode: 3
            })
        ]]
    ]);

    const result = await resolveEpisodeIdentity({ imdbId: 'tt3333333', season: 1, episode: 3 }, { fetch });

    assert.equal(result.status, 'resolved');
    assert.equal(result.episodeImdbId, 'tt3333334');
    assert.equal(fetch.calls.filter(call => call.url.includes('/search/query-')).length, 0);
});

test('fails closed for generic episode titles instead of trusting canonical coordinates', async () => {
    for (const title of ['Episode 1', 'Episode #2.1', 'Chapter 1', 'Untitled', 'Unknown']) {
        resetCache();
        const fetch = fakeFetch([
            ['/meta/series/tt4444444.json', metadata('Generic Arc Show', title, 2, 1)],
            ['/search/episode-1/imdbid-4444444/season-2', [
                osEpisode({
                    id: 'tt4444445',
                    parent: 'tt4444444',
                    name: exactName('Generic Arc Show', title),
                    season: 2,
                    episode: 1
                })
            ]]
        ]);

        const result = await resolveEpisodeIdentity({ imdbId: 'tt4444444', season: 2, episode: 1 }, { fetch });

        assert.equal(result.status, 'unresolved', title);
        assert.equal(result.reason, 'episode-name-not-distinguishing', title);
        assert.equal(fetch.calls.length, 1, title);
    }
});

test('rejects a title collision from another series parent', async () => {
    const seriesName = 'The Parent Show';
    const episodeName = 'The Collision';
    const fetch = fakeFetch([
        ['/meta/series/tt5555555.json', metadata(seriesName, episodeName, 1, 1)],
        ['/search/episode-1/imdbid-5555555/season-1', []],
        ['/search/query-the collision', [
            osEpisode({
                id: 'tt8888888',
                parent: 'tt9999999',
                name: exactName(seriesName, episodeName),
                season: 1,
                episode: 1
            })
        ]]
    ]);

    const result = await resolveEpisodeIdentity({ imdbId: 'tt5555555', season: 1, episode: 1 }, { fetch });

    assert.equal(result.status, 'unresolved');
    assert.equal(result.reason, 'no-exact-os-match');
});

test('fails closed when two matching episode IMDb ids remain', async () => {
    const seriesName = 'Ambiguous Show';
    const episodeName = 'A Shared Name';
    const fetch = fakeFetch([
        ['/meta/series/tt6666666.json', metadata(seriesName, episodeName, 2, 4)],
        ['/search/episode-4/imdbid-6666666/season-2', []],
        ['/search/query-a shared name', [
            osEpisode({ id: 'tt1010101', parent: 'tt6666666', name: exactName(seriesName, episodeName), season: 2, episode: 4 }),
            osEpisode({ id: 'tt2020202', parent: 'tt6666666', name: exactName(seriesName, episodeName), season: 2, episode: 4 })
        ]]
    ]);

    const result = await resolveEpisodeIdentity({ imdbId: 'tt6666666', season: 2, episode: 4 }, { fetch });

    assert.equal(result.status, 'unresolved');
    assert.equal(result.reason, 'ambiguous-episode-imdb-id');
});

test('accepts duplicate provider rows when they agree on one id and coordinates', async () => {
    const seriesName = 'Duplicate Provider Show';
    const episodeName = 'One Exact Episode';
    const fetch = fakeFetch([
        ['/meta/series/tt7777777.json', metadata(seriesName, episodeName, 3, 1)],
        ['/search/episode-1/imdbid-7777777/season-3', []],
        ['/search/query-one exact episode', [
            osEpisode({ id: '9090909', parent: 'tt7777777', name: exactName(seriesName, episodeName), season: 3, episode: 1 }),
            osEpisode({ id: 'tt9090909', parent: 'tt7777777', name: exactName(seriesName, episodeName), season: '3', episode: '1' })
        ]]
    ]);

    const result = await resolveEpisodeIdentity({ imdbId: 'tt7777777', season: 3, episode: 1 }, { fetch });

    assert.equal(result.status, 'resolved');
    assert.equal(result.episodeImdbId, 'tt9090909');
    assert.equal(result.catalogSeason, 3);
    assert.equal(result.catalogEpisode, 1);
});

test('does not perform a global title fallback without a distinguishing series name', async () => {
    const fetch = fakeFetch([
        ['/meta/series/tt8888888.json', { meta: { videos: [{ season: 1, episode: 1, name: 'Pilot' }] } }]
    ]);

    const result = await resolveEpisodeIdentity({ imdbId: 'tt8888888', season: 1, episode: 1 }, { fetch });

    assert.equal(result.status, 'unresolved');
    assert.equal(result.reason, 'episode-name-not-distinguishing');
    assert.equal(fetch.calls.length, 1);
});

test('returns unresolved when Cinemeta metadata or network is unavailable', async () => {
    const fetch = fakeFetch([
        ['/meta/series/tt9999999.json', new Error('network unavailable')]
    ]);

    const result = await resolveEpisodeIdentity({ imdbId: 'tt9999999', season: 1, episode: 1 }, { fetch });

    assert.equal(result.status, 'unresolved');
    assert.equal(result.reason, 'episode-metadata-unavailable');
    assert.equal(fetch.calls.length, 1);
});

test('returns unresolved instead of throwing for malformed Cinemeta video rows', async () => {
    const fetch = fakeFetch([
        ['/meta/series/tt9999998.json', { meta: {
            name: 'Malformed Series',
            videos: [{ season: 1, episode: 1, name: 'Valid Episode' }, null]
        } }],
        ['/search/episode-1/imdbid-9999998/season-1', []],
        ['/search/query-valid episode', []]
    ]);

    const result = await resolveEpisodeIdentity({ imdbId: 'tt9999998', season: 1, episode: 1 }, { fetch });

    assert.equal(result.status, 'unresolved');
    assert.equal(result.reason, 'no-exact-os-match');
});

test('bounds a hanging upstream request with the injected timeout', async () => {
    const fetch = async (_url, { signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });

    const started = Date.now();
    const result = await resolveEpisodeIdentity({ imdbId: 'tt1010101', season: 1, episode: 1 }, {
        fetch,
        timeoutMs: 5
    });

    assert.equal(result.status, 'unresolved');
    assert.equal(result.reason, 'episode-metadata-unavailable');
    assert.ok(Date.now() - started < 500);
});

test('shares in-flight work and caches negative results', async () => {
    const fetch = fakeFetch([
        ['/meta/series/tt1212121.json', { meta: { videos: [{ season: 1, episode: 1, name: 'Missing Episode' }] } }]
    ], { delayMs: 10 });

    const requests = await Promise.all([
        resolveEpisodeIdentity({ imdbId: 'tt1212121', season: 1, episode: 1 }, { fetch }),
        resolveEpisodeIdentity({ imdbId: 'tt1212121', season: 1, episode: 1 }, { fetch })
    ]);
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(fetch.calls.length, 1);

    const cached = await resolveEpisodeIdentity({ imdbId: 'tt1212121', season: 1, episode: 1 }, { fetch });
    assert.deepEqual(cached, requests[0]);
    assert.equal(fetch.calls.length, 1);
});

test('bypasses movies without touching the network', async () => {
    let calls = 0;
    const fetch = async () => { calls++; return jsonResponse({}); };

    const result = await resolveEpisodeIdentity({ imdbId: 'tt1234567', type: 'movie' }, { fetch });

    assert.deepEqual(result, { status: 'bypassed', reason: 'movie' });
    assert.equal(calls, 0);
});

'use strict';
/**
 * Plain-query ranking: a word that only matches an owner is not a match; a title match outranks a
 * summary match, which outranks a body match; a site a query names puts its own records first; a
 * thin username-titled VOD with no real summary loses a score tie; and one page never repeats a
 * title for the same owner. Seeded index, no vectors: this is the keyword order the hybrid page
 * re-applies after RRF (test/hybrid.test.js covers that side).
 */
const assert = require('assert');
const { boot, request, doc, suite } = require('./helpers');
const { isThin, dedupeKey, docTier, siteHosts } = require('../server/ranking');

const t = suite('ranking');
let svc;
const AT = '2026-11-01T00:00:00Z';

const put = (overrides) => svc.store.apply(doc({
    published_at: AT, updated_at: AT, summary: '', body: '', ...overrides,
}));
const ids = (r) => r.body.results.map((x) => x.id);
const indexOf = (r, id) => ids(r).indexOf(id);

t('boot and seed', async () => {
    svc = await boot();
    try {
        // Field order: same query word in title, summary, body, and only in the owner.
        await put({ owner: 'wiki', type: 'page', id: 'aurora-title', title: 'Aurora guide', summary: 'A guide to the lights.', body: 'aurora', canonical_url: 'https://openvibe.wiki/p/aurora-title' });
        await put({ owner: 'wiki', type: 'page', id: 'aurora-summary', title: 'Weekly notes', summary: 'Aurora was bright this week.', body: 'aurora', canonical_url: 'https://openvibe.wiki/p/aurora-summary' });
        await put({ owner: 'wiki', type: 'page', id: 'aurora-body', title: 'Picnic plans', summary: 'Sunny afternoon.', body: 'aurora', canonical_url: 'https://openvibe.wiki/p/aurora-body' });
        await put({ owner: 'aurora', type: 'page', id: 'aurora-owner', title: 'Quiet notes', summary: 'Nothing to see.', body: 'nothing at all', canonical_url: 'https://openvibe.wiki/p/aurora-owner' });

        // Thin: a username title and no summary. Real: a long summary; the same title/body match.
        await put({ owner: 'live', type: 'vod', id: 'zephyr-thin', title: 'zephyr', summary: '', body: 'zephyr', canonical_url: 'https://openvibe.video/v/9001' });
        await put({ owner: 'live', type: 'vod', id: 'zephyr-real', title: 'zephyr report', summary: 'A full report on the channel, its schedule, its recent streams, and everything that happened this week.', body: 'zephyr', canonical_url: 'https://openvibe.video/v/9002' });

        // The Live page's own records: help articles (the old openre.stream name too) and a channel.
        await put({ owner: 'help', type: 'article', id: 'help-live-default', title: 'Is OpenVibe Live on by default?', summary: 'Yes. Every channel streams with OpenVibe.Live on by default.', canonical_url: 'https://openvibe.help/a/openre.stream/is-openvibe-live-on-by-default' });
        await put({ owner: 'help', type: 'article', id: 'help-stream-obs', title: 'Can I stream without OBS?', summary: 'Yes. Go live from your browser on OpenVibe.Live: press Go Live and you are live.', canonical_url: 'https://openvibe.help/a/openre.stream/can-i-stream-without-obs' });
        await put({ owner: 'help', type: 'article', id: 'help-go-live', title: 'Can I go live without OBS?', summary: 'Yes. Go live straight from your browser, camera or screen on OpenVibe.Live, with no software to install.', canonical_url: 'https://openvibe.help/a/openvibe.live/can-i-go-live-without-obs' });
        await put({ owner: 'live', type: 'channel', id: 'channel-arman', title: 'Arman (@Arman)', summary: 'Arman streams on OpenVibe.Live.', canonical_url: 'https://openvibe.live/@Arman' });

        // Thin VODs, two of each title: the page keeps one.
        await put({ owner: 'live', type: 'vod', id: 'vod-omar-a', title: 'Omar', summary: 'Recorded live stream by omar on OpenVibe.Live.', canonical_url: 'https://openvibe.video/v/9003' });
        await put({ owner: 'live', type: 'vod', id: 'vod-omar-b', title: 'Omar', summary: 'Recorded live stream by omar on OpenVibe.Live.', canonical_url: 'https://openvibe.video/v/9004' });
        await put({ owner: 'live', type: 'vod', id: 'vod-seattle-a', title: 'Seattle Maybe 🤔', summary: 'Recorded live stream by goosely on OpenVibe.Live.', canonical_url: 'https://openvibe.video/v/9005' });
        await put({ owner: 'live', type: 'vod', id: 'vod-seattle-b', title: 'Seattle Maybe 🤔', summary: 'Recorded live stream by goosely on OpenVibe.Live.', canonical_url: 'https://openvibe.video/v/9006' });
        await put({ owner: 'live', type: 'vod', id: 'vod-real', title: 'Allahhuma labbaik (Part 3)', summary: 'Recorded live stream by Arman on OpenVibe.Live.', canonical_url: 'https://openvibe.video/v/9007' });
        await put({ owner: 'wiki', type: 'page', id: 'omar-summary', title: 'Weekly notes', summary: 'Omar was seen at the market.', body: 'omar', canonical_url: 'https://openvibe.wiki/p/omar-summary' });

        // The Tools site: a tool page (a subdomain of openvibe.tools), its help article, a community thread.
        await put({ owner: 'tools', type: 'tool', id: 'tool-json', title: 'JSON Formatter', summary: 'Paste messy JSON to pretty-print it. Part of OpenVibe.Tools.', body: 'json formatter', canonical_url: 'https://json.openvibe.tools' });
        await put({ owner: 'tools', type: 'tool', id: 'tool-min', title: 'JSON Minifier', summary: 'Minify JSON in the browser. Part of OpenVibe.Tools.', body: 'json minifier', canonical_url: 'https://json-minifier.openvibe.tools' });
        // The site's own record even when no field repeats "openvibe" or "tools".
        await put({ owner: 'tools', type: 'tool', id: 'tool-silent', title: 'Silent Tool', summary: 'Does one small thing.', body: 'nothing about the name', canonical_url: 'https://silent.openvibe.tools' });
        await put({ owner: 'help', type: 'article', id: 'help-tools', title: 'What kinds of tools are there?', summary: 'OpenVibe.Tools holds generators, converters and small utilities.', canonical_url: 'https://openvibe.help/a/openvibe.tools/what-kinds-of-tools-are-there' });
        await put({ owner: 'community', type: 'thread', id: 'community-tools', title: 'Favourite tools on every device', summary: 'A thread about OpenVibe tools people use every day.', canonical_url: 'https://openvibe.community/s/roadmap/t/favourite-tools' });
        await put({ owner: 'community', type: 'paste', id: 'snippet-json', title: 'Pastebin snippet', summary: 'A pasted file.', body: 'json formatter json formatter', canonical_url: 'https://openvibe.community/p/snippet' });
    } catch (e) {
        await svc.stop();
        throw e;
    }
});

t('an owner word is not a text match; title beats summary beats body', async () => {
    const r = await request(svc.base, 'GET', '/api/v1/search?q=aurora&limit=10');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(ids(r), ['aurora-title', 'aurora-summary', 'aurora-body'], 'title > summary > body, owner-only absent');
});

t('a site query puts that site\'s own records first', async () => {
    const r = await request(svc.base, 'GET', '/api/v1/search?q=openvibe%20live&limit=10');
    assert.strictEqual(r.status, 200, r.text);
    const first = r.body.results[0];
    assert.ok(['help-live-default', 'help-stream-obs', 'help-go-live', 'channel-arman'].includes(first.id), `first is a Live record: ${first.id}`);
    const site = ['help-live-default', 'help-stream-obs', 'help-go-live', 'channel-arman'];
    const lastSite = Math.max(...site.map((id) => indexOf(r, id)).filter((i) => i >= 0));
    const firstVod = Math.min(...['vod-omar-a', 'vod-seattle-a', 'vod-real'].map((id) => indexOf(r, id)).filter((i) => i >= 0));
    assert.ok(lastSite < firstVod, 'every Live record precedes the first VOD');

    // A precise title query is still first, even with body noise for both words.
    const json = await request(svc.base, 'GET', '/api/v1/search?q=json%20formatter&limit=10');
    assert.deepStrictEqual(ids(json)[0], 'tool-json');

    // The Tools site's own records come before a community thread whose title matches "tools".
    const tools = await request(svc.base, 'GET', '/api/v1/search?q=openvibe%20tools&limit=10');
    assert.ok(indexOf(tools, 'help-tools') < indexOf(tools, 'community-tools'), 'tools help article first');
    assert.ok(indexOf(tools, 'tool-json') < indexOf(tools, 'community-tools'), 'tool page before the thread');
    assert.ok(indexOf(tools, 'tool-silent') >= 0 && indexOf(tools, 'tool-silent') < indexOf(tools, 'community-tools'), 'a site page without the words is still a site record');
});

t('a title match outranks a summary-only match (not just a site)', async () => {
    const r = await request(svc.base, 'GET', '/api/v1/search?q=omar&limit=10');
    assert.strictEqual(r.status, 200, r.text);
    // "Omar" is the VOD title; the wiki page only mentions Omar in its summary.
    assert.ok(indexOf(r, 'vod-omar-a') >= 0 && indexOf(r, 'vod-omar-a') < indexOf(r, 'omar-summary'), 'title before summary-only');

    // And the plain "go live in a browser" question puts the help article first.
    const go = await request(svc.base, 'GET', '/api/v1/search?q=go%20live%20browser&limit=10');
    assert.deepStrictEqual(ids(go)[0], 'help-go-live');
});

t('a thin username title loses the score tie to a real title and summary', async () => {
    const r = await request(svc.base, 'GET', '/api/v1/search?q=zephyr&limit=10');
    assert.deepStrictEqual(ids(r), ['zephyr-real', 'zephyr-thin'], 'the long summary wins the tie');
    const thin = await svc.store.get('live', 'vod', 'zephyr-thin');
    const real = await svc.store.get('live', 'vod', 'zephyr-real');
    assert.strictEqual(isThin(thin.doc), true);
    assert.strictEqual(isThin(real.doc), false);
});

t('one page keeps one result per title and owner', async () => {
    const r = await request(svc.base, 'GET', '/api/v1/search?q=openvibe%20live&limit=10');
    const keys = r.body.results.map(dedupeKey);
    assert.strictEqual(new Set(keys).size, keys.length, 'no repeated title+owner');
    assert.strictEqual(r.body.results.filter((x) => x.title === 'Omar').length, 1);
    assert.strictEqual(r.body.results.filter((x) => x.title === 'Seattle Maybe 🤔').length, 1);
});

t('helper tiers and dedupe agree with the SQL order', () => {
    const match = { words: ['openvibe', 'live'], prefix: false, column: null };
    const hosts = siteHosts(match);
    assert.deepStrictEqual(hosts.sort(), ['openre.stream', 'openvibe.live']);
    assert.strictEqual(docTier({ title: 'Is OpenVibe Live on?', summary: '', body: '', canonical_url: 'https://openvibe.help/a/openre.stream/x' }, match, hosts), 13);
    assert.strictEqual(docTier({ title: 'Omar', summary: 'Recorded on OpenVibe.Live.', body: '', canonical_url: 'https://openvibe.video/v/1' }, match, hosts), 2);
    assert.strictEqual(dedupeKey({ owner: 'live', title: ' Omar ' }), dedupeKey({ owner: 'LIVE', title: 'omar' }));
});

t('close', async () => { await svc.stop(); });

t.run();

'use strict';
/**
 * Several words that find little: "sony headphones" found nothing on production (2026-11-02) while "headphones" found
 * deals, because every word had to match. A query of several words whose first page finds fewer than five documents
 * answers with the documents holding any of the words instead, ranked by the same tiers (a title with a word before a
 * body that mentions one); one with every word still comes first. Its next page continues the relaxed query (the
 * cursor's x). A query whose every word finds enough is answered exactly as before.
 */
const assert = require('assert');
const { boot, request, doc, suite } = require('./helpers');

const t = suite('relaxed words');
let svc;
const AT = '2026-11-01T00:00:00Z';
const put = (overrides) => svc.store.apply(doc({ published_at: AT, updated_at: AT, summary: '', body: '', ...overrides }));
const ids = (r) => r.body.results.map((x) => x.id);
const q = (text, extra = '') => request(svc.base, 'GET', `/api/v1/search?q=${encodeURIComponent(text)}${extra}`);

t('boot and seed', async () => {
    svc = await boot();
    for (let i = 1; i <= 7; i++) {
        await put({ owner: 'deals', type: 'offer', id: `phones-${i}`, title: `Wireless headphones model ${i}`, summary: 'Over-ear, 30 hours of battery.', canonical_url: `https://openvibe.deals/d/phones-${i}` });
    }
    await put({ owner: 'deals', type: 'offer', id: 'sony-phones', title: 'Sony WH-1000XM5 wireless noise cancelling headphones', summary: 'Noise cancelling, 30 hours of battery.', canonical_url: 'https://openvibe.deals/d/sony-phones' });
    await put({ owner: 'live', type: 'vod', id: 'vod-mentions', title: 'Evening stream', summary: 'We talked about cheap tickets.', body: 'cheap', canonical_url: 'https://openvibe.video/v/7001' });
    for (let i = 1; i <= 6; i++) {
        await put({ owner: 'wiki', type: 'page', id: `garden-${i}`, title: `Garden notes ${i}`, summary: 'Tomato and basil, side by side.', canonical_url: `https://openvibe.wiki/p/garden-${i}` });
    }
});

t('several words that find little answer with any of the words, every word first, titles before bodies', async () => {
    const r = await q('sony headphones', '&limit=5');
    assert.strictEqual(r.status, 200);
    const got = ids(r);
    assert.strictEqual(got.length, 5, 'a full page');
    assert.strictEqual(got[0], 'sony-phones', 'the one with both words first');
    assert.ok(got.every((id) => id.includes('phones')), 'then headphones by their titles');
    assert.ok(r.body.next_cursor, 'there is more');
    const cursor = JSON.parse(Buffer.from(r.body.next_cursor, 'base64url').toString('utf8'));
    assert.strictEqual(cursor.x, 1, 'the cursor says the answer was relaxed');
    const page2 = await q('sony headphones', `&limit=5&cursor=${r.body.next_cursor}`);
    assert.strictEqual(page2.status, 200, JSON.stringify(page2.body));
    const all = [...got, ...ids(page2)];
    assert.strictEqual(new Set(all).size, all.length, 'no document twice across pages');
    assert.ok(all.includes('phones-7'), 'the second page continues the relaxed query');
});

t('a word that only a body mentions ranks after the titles that hold the other', async () => {
    const r = await q('cheap headphones', '&limit=20');
    const got = ids(r);
    assert.ok(got.length >= 8, `headphones are found (${got.length})`);
    assert.ok(got.indexOf('vod-mentions') > got.indexOf('phones-1'), 'a body mention ranks after a title');
});

t('a query whose every word finds enough is answered exactly as before', async () => {
    const r = await q('garden notes', '&limit=10');
    const got = ids(r);
    assert.strictEqual(got.length, 6);
    assert.ok(got.every((id) => id.startsWith('garden-')), 'only documents with both words');
    const none = await q('garden tomato basil quantum');
    assert.ok(ids(none).every((id) => id.startsWith('garden-')), 'relaxed, the garden pages still answer');
});

t('relaxed, a query keeps its content words: "do" alone does not answer "things to do chongqing"', async () => {
    for (let i = 1; i <= 7; i++) {
        await put({ owner: 'help', type: 'article', id: `do-${i}`, title: `Do I need thing number ${i}?`, summary: 'An answer.', canonical_url: `https://openvibe.help/a/do-${i}` });
    }
    await put({ owner: 'tours', type: 'city', id: 'chongqing', title: 'Chongqing, China', summary: 'A city on the Yangtze. 24 places to see on OpenVibe.Tours.',
        body: 'Chongqing\nThings to do, places to see, walks, stays and flights.', canonical_url: 'https://openvibe.tours/city/chongqing' });
    const r = await q('things to do chongqing', '&limit=10');
    const got = ids(r);
    assert.strictEqual(got[0], 'chongqing', `the city first: ${got.join(', ')}`);
    assert.ok(!got.some((id) => id.startsWith('do-')), 'no answer for "do" alone');
});

t('relaxed, a rare word outweighs a common one, and the field it is in counts (ranking.js coverage)', async () => {
    const { coverage, contentWords } = require('../server/ranking');
    const { wordWeight } = require('../server/engine/pg');
    assert.ok(wordWeight(30) > wordWeight(1000), 'rarer weighs more');
    const match = { words: ['chongqing', 'walk'], any: true, weights: { chongqing: wordWeight(30), walk: wordWeight(1000) } };
    const place = { title: '洪崖洞', summary: 'Attraction in Chongqing, China.', body: '' };
    const shoe = { title: 'Go Walk Max Cushioning Flex', summary: 'A slip-on.', body: '' };
    const route = { title: 'Old town walk', summary: 'A self-guided walk in Chongqing, China.', body: '' };
    assert.ok(coverage(place, match) > coverage(shoe, match), `a place in Chongqing (${coverage(place, match)}) before a shoe called Walk (${coverage(shoe, match)})`);
    assert.ok(coverage(route, match) > coverage(place, match), 'a walk in Chongqing before both');
    assert.strictEqual(coverage(place, { ...match, any: false }), 0, 'only a relaxed query has a cover');
    assert.deepStrictEqual(contentWords({ words: ['things', 'to', 'do', 'chongqing'], prefix: false }).words, ['things', 'chongqing']);
    assert.deepStrictEqual(contentWords({ words: ['to', 'do'], prefix: false }).words, ['to', 'do'], 'all function words: kept');
});

t('a single word that finds nothing still finds nothing', async () => {
    assert.deepStrictEqual(ids(await q('zzzunknownword')), []);
});

t('close', async () => { await svc.stop(); });

t.run();

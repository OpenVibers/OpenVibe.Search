'use strict';
// Trending searches (plan 2026-11-13 §AD.13 (1); server/trending.js, migration 0010), on the real app:
//   - a search box's beacon counts a search under its site (the Origin, one of the network's own domains), as JSON or as
//     sendBeacon's text/plain; an unknown site, Do Not Track, Global Privacy Control, and anything personal or explicit
//     count nothing; a visitor counts at most 20 a minute; the beacon always answers 204;
//   - a query trends only once 5 distinct visitors searched it; the rising ones lead; a site's own come first, the
//     network's fill the rest; the list and the stats answer any origin;
//   - counts go after 8 days, visitors after 2.
//
//   node test/trending.test.js
const assert = require('assert');
const { boot, request } = require('./helpers');
const { normalize } = require('../server/trending');

const T0 = Date.UTC(2026, 10, 15, 21, 30);

(async () => {
    // What may be counted, first.
    assert.deepStrictEqual(normalize('  Synthesizers  for  beginners! '), { query: 'synthesizers for beginners', shown: 'Synthesizers  for  beginners'.replace(/\s+/g, ' ') });
    for (const bad of ['a', 'mail me at ada@example.com', 'call 555 123 4567', 'order 12345678', 'https://example.com/x', 'www.example.com', 'tok_abcdefghijklmnopqrstuvwxyz123456', 'free porn', 'nsfw art', 'one two three four five six seven eight nine', 'x'.repeat(81)]) {
        assert.strictEqual(normalize(bad), null, `not counted: ${bad}`);
    }

    let clock = T0;
    const h = await boot({ now: () => clock });
    try {
        const beacon = async (q, { origin = 'https://openvibe.exchange', ip = '10.0.0.1', ua = 'ua', text = false, headers = {}, site } = {}) => {
            const res = await fetch(`${h.base}/api/v1/searched`, {
                method: 'POST',
                headers: { 'Content-Type': text ? 'text/plain;charset=UTF-8' : 'application/json', Origin: origin, 'User-Agent': ua, 'X-Forwarded-For': ip, ...headers },
                body: JSON.stringify({ q, ...(site ? { site } : {}) }),
            });
            assert.strictEqual(res.status, 204);
            return res;
        };
        // Five people search "synthesizers" on Exchange; two search "drum machines"; one types an email.
        for (let i = 1; i <= 5; i++) await beacon('Synthesizers', { ua: `person-${i}` });
        await beacon('synthesizers', { ua: 'person-1', text: true });
        for (let i = 1; i <= 2; i++) await beacon('drum machines', { ua: `person-${i}` });
        await beacon('ada@example.com', { ua: 'person-9' });
        // Live: "go live from a browser" by six people.
        for (let i = 1; i <= 6; i++) await beacon('go live from a browser', { origin: 'https://openvibe.live', ua: `viewer-${i}` });
        // Not counted: an unknown site, Do Not Track, Global Privacy Control.
        await beacon('stolen search', { origin: 'https://evil.example', ua: 'x1' });
        await beacon('do not track me', { ua: 'x2', headers: { DNT: '1' } });
        await beacon('do not sell', { ua: 'x3', headers: { 'Sec-GPC': '1' } });

        const t = await request(h.base, 'GET', '/api/v1/trending?site=openvibe.exchange&limit=5');
        assert.strictEqual(t.status, 200);
        assert.strictEqual(t.headers.get('access-control-allow-origin'), '*', 'any site\'s box reads it');
        assert.deepStrictEqual(t.body.trending.map((x) => x.query), ['Synthesizers', 'go live from a browser'], 'the site\'s own first, the network\'s after; two people are not enough; an email never');
        assert.deepStrictEqual([t.body.trending[0].searches, t.body.trending[0].rising], [6, true]);
        const all = await request(h.base, 'GET', '/api/v1/trending');
        assert.deepStrictEqual(all.body.trending.map((x) => x.query).sort(), ['Synthesizers', 'go live from a browser'].sort());
        assert.ok(!JSON.stringify(all.body).includes('stolen') && !JSON.stringify(all.body).includes('track me') && !JSON.stringify(all.body).includes('do not sell'));

        // A busy visitor: 20 a minute.
        for (let i = 0; i < 25; i++) await beacon(`busy search ${i % 3}`, { ua: 'busy', ip: '10.9.9.9' });
        const rows = await h.db.prepare("SELECT sum(count) AS n FROM search_trends WHERE query LIKE 'busy search%'").get();
        assert.strictEqual(Number(rows.n), 20, 'twenty a minute from one visitor');

        // Report's stats: by day, by site, the top searches.
        const s = await request(h.base, 'GET', '/api/v1/trending/stats?days=7');
        assert.strictEqual(s.status, 200);
        assert.ok(s.body.by_site.some((x) => x.site === 'openvibe.exchange') && s.body.by_site.some((x) => x.site === 'openvibe.live'));
        assert.ok(s.body.by_day.length >= 1 && s.body.top.length === 2);
        // No visitor or address anywhere in the database's trend rows.
        const vis = await h.db.prepare('SELECT visitor FROM search_trend_visitors LIMIT 1').get();
        assert.match(vis.visitor, /^[0-9a-f]{24}$/, 'a visitor is a salted hash, never an address');

        // Three days on: the visitors are gone, so nothing trends; eight days on, the counts too.
        clock = T0 + 3 * 86_400_000;
        await h.app.locals.trending.prune();
        assert.strictEqual(Number((await h.db.prepare('SELECT count(*) AS n FROM search_trend_visitors').get()).n), 0, 'visitors after two days');
        clock = T0 + 9 * 86_400_000;
        await h.app.locals.trending.prune();
        assert.strictEqual(Number((await h.db.prepare('SELECT count(*) AS n FROM search_trends').get()).n), 0, 'counts after eight');
    } finally {
        await h.stop();
    }
    console.log('trending: beacons counted by site (JSON and text), personal, explicit, unknown, DNT and GPC refused, 20 a minute; trends at 5 people, the site first; stats; pruned');
})().catch((err) => { console.error(err); process.exit(1); });

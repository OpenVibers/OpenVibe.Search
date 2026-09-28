'use strict';
/**
 * Per-actor rate limits (server/actor-limits.js, roadmap WS-R task 4): past its limit one caller gets
 * 429 problem+json `rate_limited` with Retry-After, before the route does any work, while another
 * caller still passes; the window reopens on the clock. Owner routes count the service principal,
 * queries the person (their own token or the X-OV-Subject a service vouches for), signed-out callers
 * their address; a service querying for its signed-out visitors is not counted. Indexing has its own
 * numbers. The Events webhook, health, ready, release.json and metrics are never limited.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, request, serviceToken, userToken, doc, indexEvent, deliver, suite } = require('./helpers');
const { actor } = require('../server/actor-limits');

const t = suite('actor-limits');
// 15 s into a minute, so the minute window has 45 s left.
let clock = Date.UTC(2026, 8, 27, 12, 0, 15);
const now = () => clock;
const WIKI = serviceToken('wiki', ['search.document.write']);
const BLOG = serviceToken('blog', ['search.document.write']);
const DELEGATE = serviceToken('live', ['search.query.delegate']);
const alice = ids.newId('user');
const bob = ids.newId('user');
const as = (subjectId) => ({ token: userToken({ subjectId, aud: ['openvibe.search'] }) });

let svc;
const call = (method, p, opts = {}) => request(svc.base, method, p, opts);

t('boot (SEARCH_LIMITS_MINUTE=3)', async () => {
    svc = await boot({ now, env: { SEARCH_LIMITS_MINUTE: '3', SEARCH_LIMITS_HOUR: '100', SEARCH_EVENT_OWNERS: 'wiki' } });
});

t('a query: 3 a minute per person, then 429 rate_limited with Retry-After; another person passes', async () => {
    for (let i = 0; i < 3; i++) assert.strictEqual((await call('GET', '/api/v1/search?q=zebra', as(alice))).status, 200);
    const r = await call('GET', '/api/v1/search?q=zebra', as(alice));
    assert.strictEqual(r.status, 429, r.text);
    assert.strictEqual(r.headers.get('retry-after'), '45');
    assert.ok(/^application\/problem\+json/.test(r.headers.get('content-type')));
    assert.deepStrictEqual([r.body.code, r.body.status, r.body.retry_after_seconds], ['rate_limited', 429, 45]);
    assert.ok(r.body.detail.includes('search.query'), r.body.detail);
    assert.strictEqual((await call('GET', '/api/v1/search?q=zebra', as(bob))).status, 200, 'another person still passes');
    // A service vouching for alice counts against alice; for its signed-out visitors it is not counted.
    const vouched = await call('GET', '/api/v1/search?q=zebra', { token: DELEGATE, headers: { 'X-OV-Subject': alice } });
    assert.deepStrictEqual([vouched.status, vouched.body.code], [429, 'rate_limited']);
    for (let i = 0; i < 6; i++) assert.strictEqual((await call('GET', '/api/v1/search?q=zebra', { token: DELEGATE })).status, 200);
    // Signed out: counted by address (127.0.0.1 here).
    for (let i = 0; i < 3; i++) assert.strictEqual((await call('GET', '/api/v1/search?q=zebra')).status, 200);
    assert.strictEqual((await call('GET', '/api/v1/search?q=zebra')).status, 429);
    assert.strictEqual((await call('GET', '/api/v1/search?q=zebra', { token: 'not.a.token' })).status, 401, 'a bad token: 401 from auth, never a 429');
    clock += 45 * 1000;
    assert.strictEqual((await call('GET', '/api/v1/search?q=zebra', as(alice))).status, 200, 'the next minute opens the window again');
});

t('indexing: 120 a minute per service principal, refused before the store is touched', async () => {
    clock = Date.UTC(2026, 8, 27, 12, 5, 0);
    for (let i = 0; i < 120; i++) {
        const d = doc({ id: `pg_${i}` });
        assert.strictEqual((await call('PUT', `/api/v1/documents/wiki/page/${d.id}`, { token: WIKI, body: d })).status, 200);
    }
    const d = doc({ id: 'pg_over' });
    const r = await call('PUT', `/api/v1/documents/wiki/page/${d.id}`, { token: WIKI, body: d });
    assert.deepStrictEqual([r.status, r.body.code, r.headers.get('retry-after')], [429, 'rate_limited', '60']);
    assert.strictEqual(svc.store.get('wiki', 'page', 'pg_over'), null, 'nothing stored');
    const b = doc({ owner: 'blog', type: 'post', id: 'post_1', canonical_url: 'https://openvibe.blog/p/1' });
    assert.strictEqual((await call('PUT', '/api/v1/documents/blog/post/post_1', { token: BLOG, body: b })).status, 200, 'another service still indexes');
});

t('the signed Events deliveries, health, ready, release.json and metrics are never limited', async () => {
    for (let i = 0; i < 6; i++) {
        const r = await deliver(svc.base, indexEvent(doc({ id: `ev_${i}`, canonical_url: `https://openvibe.wiki/p/ev${i}` })), { seq: i + 1 });
        assert.ok(r.status < 300, `delivery ${i + 1}: ${r.status} ${r.text}`);
        assert.strictEqual((await call('GET', '/api/health')).status, 200);
        assert.notStrictEqual((await call('GET', '/api/ready')).status, 429);
        assert.strictEqual((await call('GET', '/release.json')).status, 200);
        assert.strictEqual((await call('GET', '/metrics')).status, 200);
    }
});

t('refusals are counted in search_rate_limited_total', async () => {
    const m = (await call('GET', '/metrics')).text;
    assert.ok(/search_rate_limited_total\{limit="search.query",window="minute"\} 3/.test(m), m.split('\n').filter((l) => l.includes('rate_limited')).join('\n'));
    assert.ok(/search_rate_limited_total\{limit="search.document.index",window="minute"\} 1/.test(m));
});

t('who is counted', () => {
    assert.strictEqual(actor({ principal: { sub: 'svc:wiki' } }), 'svc:wiki');
    assert.strictEqual(actor({ viewer: { kind: 'user', subject: alice } }), `user:${alice}`);
    assert.strictEqual(actor({ viewer: { kind: 'service', service: 'svc:live', subject: alice } }), `user:${alice}`);
    assert.strictEqual(actor({ viewer: { kind: 'service', service: 'svc:live', subject: null } }), null);
    assert.strictEqual(actor({ viewer: { kind: 'anonymous', subject: null }, ip: '203.0.113.9' }), 'ip:203.0.113.9');
});

t('stop', async () => { await svc.stop(); });

t.run();

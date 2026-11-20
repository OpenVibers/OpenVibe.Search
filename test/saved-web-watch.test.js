'use strict';
/**
 * Watching the web (plan AD.34 item 6): a saved search with scope "web" runs once a day through the fabric's web scope
 * (Exchange search v2) as its owner. The first run records what is there; after that, results it has not shown before
 * make ONE notification naming the newest; the same results make none; a failed run stays due. Web watches are capped
 * per person, take words and no network filters, run on demand like any saved search, and never enter the network
 * notifier's queue.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, request, userToken, suite } = require('./helpers');

const t = suite('saved-web-watch');
const ORIGIN = 'https://search.openvibe.network';
const AI_ENV = { BASE_URL: ORIGIN, OV_AI_INTERNAL_URL: 'http://ai.test', OV_OAUTH_CLIENT_SECRET: 'test-ai-secret', SEARCH_WEB_DAILY: '500' };
const alice = ids.newId('user');
const as = { token: userToken({ subjectId: alice, aud: ['openvibe.search'] }) };
const DAY = 24 * 3600 * 1000;

let clock = Date.parse('2026-11-20T12:00:00Z');
const pushes = [];
const network = { async push(subject, notification) { pushes.push({ subject, notification }); return { sent: true }; } };
const page = (n) => ({ title: `Nebula museum page ${n}`, url: `https://nebula${n}.example/hours?utm_source=x`, snippet: `hours ${n}`, engines: ['deepseek'] });
let web = [page(1), page(2), page(3)];
let aiDown = false;
const v2Calls = [];

function response(status, json) { return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } }); }
async function fetchImpl(url, opts = {}) {
    const u = String(url);
    if (u.includes('/oauth/token')) return response(200, { access_token: 'svc', token_type: 'Bearer', expires_in: 300 });
    if (u.endsWith('/v1/search')) {
        v2Calls.push(JSON.parse(opts.body));
        if (aiDown) return response(503, { code: 'search.unavailable' });
        return response(200, { results: web, receipt: { engine: 'multi', cost_usd: 0.00075, engines: ['deepseek'], calls: [] } });
    }
    if (u.includes('/api/v1/research')) return response(200, { run: { status: 'succeeded', output: { sources: [], providers: {} } } });
    throw new Error(`unexpected fetch ${u}`);
}

let svc;
let watch;
const call = (method, p, opts = {}) => request(svc.base, method, p, { ...opts, headers: { Origin: ORIGIN, ...(opts.headers || {}) } });

t('boot', async () => {
    svc = await boot({ env: AI_ENV, fetchImpl, now: () => clock, networkPush: network });
});

t('a web watch takes words, no network filters, and is its own saved search', async () => {
    const r = await call('POST', '/api/v1/saved-searches', { ...as, body: { q: 'nebula museum hours', scope: 'web', name: 'Nebula hours' } });
    assert.strictEqual(r.status, 201, r.text);
    watch = r.body.saved_search;
    assert.strictEqual(watch.scope, 'web');
    assert.strictEqual(watch.web_checked_at, null);
    const same = await call('POST', '/api/v1/saved-searches', { ...as, body: { q: 'nebula museum hours', scope: 'web' } });
    assert.strictEqual(same.status, 200, 'the same watch again is the same row');
    const network = await call('POST', '/api/v1/saved-searches', { ...as, body: { q: 'nebula museum hours' } });
    assert.strictEqual(network.status, 201, 'the same words searched in the network are another saved search');
    assert.strictEqual(network.body.saved_search.scope, 'network');
    for (const body of [{ q: 'x', scope: 'everything' }, { scope: 'web', owner: 'wiki' }, { q: 'nebula', scope: 'web', owner: 'wiki' }]) {
        const bad = await call('POST', '/api/v1/saved-searches', { ...as, body });
        assert.strictEqual(bad.status, 400, JSON.stringify(body));
    }
    assert.ok(!(await svc.saved.due(100)).some((s) => s.id === watch.id), 'the network notifier never takes a web watch');
});

t('the first run records what is there and tells nobody', async () => {
    const out = await svc.notifier.tick();
    assert.deepStrictEqual([out.web.checked, out.web.baseline, out.web.notified], [1, 1, 0]);
    assert.strictEqual(pushes.length, 0);
    assert.strictEqual(v2Calls[v2Calls.length - 1].q, 'nebula museum hours');
    const again = await svc.notifier.tick();
    assert.strictEqual(again.web, undefined, 'not due again within the day (no web watch ran)');
});

t('a day later, a result it has not shown makes one notification naming it; the same results make none', async () => {
    clock += DAY + 60_000;
    web = [page(4), page(1), page(2), page(3)];
    const out = await svc.notifier.tick();
    assert.deepStrictEqual([out.web.checked, out.web.notified], [1, 1]);
    assert.strictEqual(pushes.length, 1);
    const n = pushes[0];
    assert.strictEqual(n.subject, alice);
    assert.strictEqual(n.notification.type, 'SEARCH_WEB_WATCH');
    assert.match(n.notification.title, /New on the web for “Nebula hours”/);
    assert.strictEqual(n.notification.message, 'Nebula museum page 4');
    assert.match(n.notification.url, /^https:\/\/nebula4\.example\/hours/);
    assert.strictEqual(n.notification.rich_content.count, 1);
    clock += DAY + 60_000;
    web = [page(1), page(4), page(2)];
    const same = await svc.notifier.tick();
    assert.deepStrictEqual([same.web.checked, same.web.unchanged, same.web.notified], [1, 1, 0]);
    assert.strictEqual(pushes.length, 1, 'what it showed is never announced twice');
});

t('a failed run stays due and is retried on the next tick', async () => {
    clock += DAY + 60_000;
    aiDown = true;
    web = [page(5), page(1), page(2), page(3)];
    const failed = await svc.notifier.tick();
    assert.strictEqual(failed.web.checked, 1);
    aiDown = false;
    const retried = await svc.notifier.tick();
    assert.deepStrictEqual([retried.web.checked, retried.web.notified], [1, 1], 'still due after the failure');
    assert.strictEqual(pushes[pushes.length - 1].notification.message, 'Nebula museum page 5');
});

t('run now: the web results, as the person', async () => {
    const r = await call('GET', `/api/v1/saved-searches/${watch.id}/results`, as);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.saved_search.scope, 'web');
    assert.ok(r.body.results.some((x) => /nebula1\.example/.test(x.url)));
});

t('at most ten web watches a person', async () => {
    const made = [];
    for (let i = 0; made.length < 12; i++) made.push((await call('POST', '/api/v1/saved-searches', { ...as, body: { q: `watch number ${i}`, scope: 'web' } })).status);
    assert.deepStrictEqual(made.slice(0, 9), Array(9).fill(201), 'nine more beside the first');
    assert.deepStrictEqual(made.slice(9), [409, 409, 409]);
});

t('stop', async () => { await svc.stop(); });

t.run();

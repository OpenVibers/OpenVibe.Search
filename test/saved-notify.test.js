'use strict';
/**
 * Saved-search notifications: the engine's internal `since` filter (ranked and listed search) keeps
 * documents indexed after a watermark; the notifier pushes ONE notification per saved search with new
 * hits (as its owner: the ACL applies), advances the watermark only after a push went out, retries a
 * failed push on the next tick, never notifies a delivered batch twice, and stays off (reported in
 * readiness, not failing) without SEARCH_SAVED_NOTIFY=1 and the `search` client's secret.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { load } = require('../server/config');
const { createSavedNotifier } = require('../server/saved-notifier');
const { boot, request, doc, suite } = require('./helpers');

const t = suite('saved-notify');
const ORIGIN = 'https://search.openvibe.network';
const alice = ids.newId('user');
const bob = ids.newId('user');

let clock = Date.parse('2026-10-01T00:00:00Z');
const tickClock = (ms = 1000) => { clock += ms; return clock; };

// The Network client stub: records pushes; `fail` makes the next push throw, `unknown` answers "no such person".
const pushes = [];
const network = {
    fail: false,
    unknown: false,
    async push(subject, notification) {
        if (network.fail) { const e = new Error('notification push: Network answered 503'); e.status = 503; throw e; }
        pushes.push({ subject, notification });
        return network.unknown ? { sent: false, reason: 'unknown_subject' } : { sent: true, skipped: false };
    },
};

let svc;
let zebras;
let giraffes;
let t0;
const watermark = async (id) => (await svc.saved.due(100)).find(s => s.id === id).watermark;

t('boot (notifier off: the test drives tick())', async () => {
    svc = await boot({ env: { BASE_URL: ORIGIN }, now: () => clock, networkPush: network });
    assert.strictEqual(svc.notifier.running(), false);
    t0 = clock;
    await svc.store.apply(doc({ id: 'old', title: 'Zebra old news', canonical_url: 'https://openvibe.wiki/p/old' }));
    tickClock();
});

t('since keeps only documents indexed after it, in ranked and listed search', async () => {
    const mark = clock;
    tickClock();
    await svc.store.apply(doc({ id: 'fresh', title: 'Zebra fresh arrival', canonical_url: 'https://openvibe.wiki/p/fresh' }));
    const viewer = { subject: null };
    const ranked = await svc.searcher.run({ text: 'zebra', viewer, since: mark });
    assert.deepStrictEqual(ranked.results.map(r => r.id), ['fresh']);
    const listed = await svc.searcher.run({ text: '', viewer, since: mark });
    assert.deepStrictEqual(listed.results.map(r => r.id), ['fresh']);
    assert.deepStrictEqual((await svc.searcher.run({ text: 'zebra', viewer, since: t0 - 1 })).results.map(r => r.id).sort(), ['fresh', 'old']);
    assert.deepStrictEqual((await svc.searcher.run({ text: 'zebra', viewer })).results.length, 2, 'no since: everything');
    assert.deepStrictEqual((await svc.searcher.run({ text: 'zebra', viewer, since: clock })).results, []);
    // A new revision is indexed again: it is new to a watermark before it.
    tickClock();
    const before = clock;
    tickClock();
    await svc.store.apply(doc({ id: 'old', revision: 2, title: 'Zebra old news, revised', canonical_url: 'https://openvibe.wiki/p/old' }));
    assert.deepStrictEqual((await svc.searcher.run({ text: 'zebra', viewer, since: before })).results.map(r => r.id), ['old']);
    // The public query API has no `since`: an unknown parameter is ignored.
    const api = await request(svc.base, 'GET', `/api/v1/search?q=zebra&since=${clock}`);
    assert.strictEqual(api.status, 200, api.text);
    assert.strictEqual(api.body.results.length, 2);
    tickClock();
});

t('a saved search with nothing new since it was saved: no push, watermark advanced', async () => {
    zebras = (await svc.saved.save(alice, { name: 'Zebras', q: 'zebra', filters: { owner: 'wiki' } })).saved;
    giraffes = (await svc.saved.save(bob, { name: 'Giraffes', q: 'giraffe', filters: {} })).saved;
    assert.strictEqual(await watermark(zebras.id), clock, 'never run: the watermark is created_at');
    const at = tickClock();
    const out = await svc.notifier.tick();
    assert.deepStrictEqual(out, { checked: 2, notified: 0, unchanged: 2, unknown: 0, failed: 0 });
    assert.strictEqual(pushes.length, 0);
    assert.strictEqual(await watermark(zebras.id), at);
    assert.strictEqual(await watermark(giraffes.id), at);
});

t('new hits: ONE push to the owner, the restricted document of someone else is not announced', async () => {
    tickClock();
    await svc.store.apply(doc({ id: 'z1', title: 'Zebra herd spotted', canonical_url: 'https://openvibe.wiki/p/z1' }));
    await svc.store.apply(doc({ id: 'z2', title: 'Zebra stripes explained', canonical_url: 'https://openvibe.wiki/p/z2' }));
    await svc.store.apply(doc({ id: 'zp', visibility: 'private', acl: { subjects: [bob] }, title: 'Zebra secret of bob' }));
    await svc.store.apply(doc({ owner: 'blog', type: 'post', id: 'zb', title: 'Zebra blog post', canonical_url: 'https://openvibe.blog/p/zb' }));
    const at = tickClock();
    const out = await svc.notifier.tick();
    assert.strictEqual(out.notified, 1);
    assert.strictEqual(pushes.length, 1);
    const [{ subject, notification: n }] = pushes;
    assert.strictEqual(subject, alice);
    assert.strictEqual(n.service, 'search');
    assert.strictEqual(n.type, 'SEARCH_SAVED_MATCH');
    assert.strictEqual(n.category, 'service');
    assert.strictEqual(n.priority, 'normal');
    assert.strictEqual(n.title, 'New results for “Zebras”');
    assert.match(n.message, /^2 new results, including “Zebra (herd spotted|stripes explained)”$/);
    assert.strictEqual(n.url, `${ORIGIN}/?q=zebra&owner=wiki`);
    assert.deepStrictEqual(n.rich_content, { saved_search_id: zebras.id, count: 2, more: false });
    assert.strictEqual(await watermark(zebras.id), at);
});

t('a second tick with nothing newer pushes nothing (a delivered batch is never notified twice)', async () => {
    tickClock();
    const out = await svc.notifier.tick();
    assert.strictEqual(out.notified, 0);
    assert.strictEqual(pushes.length, 1);
});

t('a failed push leaves the watermark; the next tick retries the same hits once', async () => {
    tickClock();
    await svc.store.apply(doc({ id: 'z3', title: 'Zebra crossing', canonical_url: 'https://openvibe.wiki/p/z3' }));
    const before = await watermark(zebras.id);
    tickClock();
    network.fail = true;
    const failed = await svc.notifier.tick();
    assert.strictEqual(failed.failed, 1);
    assert.strictEqual(pushes.length, 1);
    assert.strictEqual(await watermark(zebras.id), before, 'not advanced');
    network.fail = false;
    const at = tickClock();
    const retried = await svc.notifier.tick();
    assert.strictEqual(retried.notified, 1);
    assert.strictEqual(pushes.length, 2);
    assert.strictEqual(pushes[1].notification.message, 'Zebra crossing');
    assert.strictEqual(await watermark(zebras.id), at);
    tickClock();
    await svc.notifier.tick();
    assert.strictEqual(pushes.length, 2);
});

t('a person Network no longer knows: no notification, watermark advanced', async () => {
    tickClock();
    await svc.store.apply(doc({ id: 'g1', title: 'Giraffe neck facts', canonical_url: 'https://openvibe.wiki/p/g1' }));
    network.unknown = true;
    const at = tickClock();
    const out = await svc.notifier.tick();
    network.unknown = false;
    assert.strictEqual(out.unknown, 1);
    assert.strictEqual(await watermark(giraffes.id), at);
});

t('opening the results moves the watermark; a notifier tick never moves it back', async () => {
    const at = tickClock();
    const r = await svc.saved.advance(zebras.id, at);
    assert.ok(r);
    tickClock(5000);
    await svc.saved.markRun(zebras.id);
    const opened = clock;
    await svc.saved.advance(zebras.id, at);
    assert.strictEqual(await watermark(zebras.id), opened);
});

t('the batch bound: one tick runs at most notifyBatch saved searches, longest waiting first', async () => {
    const config = { ...svc.config, savedSearches: { ...svc.config.savedSearches, notifyBatch: 1 } };
    const runs = [];
    const searcher = { run: async (q) => { runs.push(q); return { results: [], next_cursor: null }; } };
    const n = createSavedNotifier({ config, saved: svc.saved, searcher, network, now: () => clock });
    tickClock();
    await n.tick();
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].text, 'giraffe', 'the oldest watermark first');
    assert.deepStrictEqual(runs[0].viewer, { subject: bob });
});

t('readiness reports the notifier as off, not failing', async () => {
    const ready = await request(svc.base, 'GET', '/api/ready');
    assert.strictEqual(ready.body.saved_notify, 'off (SEARCH_SAVED_NOTIFY unset)');
});

t('disabled config: not started without the flag, or with the flag but no client secret', async () => {
    const make = (env) => createSavedNotifier({ config: load({ NODE_ENV: 'test', ...env }), saved: svc.saved, searcher: svc.searcher, network });
    for (const [env, state] of [
        [{}, 'off (SEARCH_SAVED_NOTIFY unset)'],
        [{ SEARCH_SAVED_NOTIFY: '1' }, 'off (OV_OAUTH_CLIENT_SECRET unset)'],
        [{ SEARCH_SAVED_NOTIFY: 'yes', OV_OAUTH_CLIENT_SECRET: 's' }, 'off (SEARCH_SAVED_NOTIFY unset)'],
    ]) {
        const n = make(env);
        n.start();
        assert.strictEqual(n.running(), false);
        assert.strictEqual(n.state(), state);
        await n.stop();
    }
    const on = make({ SEARCH_SAVED_NOTIFY: '1', OV_OAUTH_CLIENT_SECRET: 's' });
    on.start();
    assert.strictEqual(on.state(), 'running');
    await on.stop();
    assert.strictEqual(on.state(), 'stopped');
});

t('with the flag and the secret, start() runs it and close() stops it', async () => {
    const other = await boot({ env: { SEARCH_SAVED_NOTIFY: '1', OV_OAUTH_CLIENT_SECRET: 'test-secret' }, networkPush: network });
    try {
        assert.strictEqual(other.notifier.running(), true);
        assert.strictEqual((await request(other.base, 'GET', '/api/ready')).body.saved_notify, 'running');
    } finally {
        await other.stop();
    }
    assert.strictEqual(other.notifier.running(), false);
});

t('shutdown', async () => { await svc.stop(); });

t.run();

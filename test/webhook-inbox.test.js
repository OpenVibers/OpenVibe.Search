'use strict';
/** Events consumer: signatures, inbox dedupe, revision order across deliveries, tombstones, refusals. */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, request, serviceToken, doc, indexEvent, deliver, suite } = require('./helpers');

const t = suite('webhook-inbox');
let svc;
const search = async (q) => (await request(svc.base, 'GET', `/api/v1/search?q=${encodeURIComponent(q)}`)).body.results;
const receipts = () => svc.db.prepare('SELECT COUNT(*) AS n FROM idempotency_receipts').get().n;

t('boot', async () => { svc = await boot(); });

t('an unsigned or wrongly signed delivery is refused and changes nothing', async () => {
    const e = indexEvent(doc({ title: 'Unsigned muword' }));
    const r = await deliver(svc.base, e, { badSignature: true });
    assert.strictEqual(r.status, 401);
    const r2 = await request(svc.base, 'POST', '/internal/events', { raw: JSON.stringify({ event: e }), headers: { 'Content-Type': 'application/json' } });
    assert.strictEqual(r2.status, 401);
    assert.strictEqual((await search('muword')).length, 0);
    assert.strictEqual(receipts(), 0);
});

t('signature v2 is required: a v1-only delivery and a stale v2 timestamp are refused', async () => {
    const e = indexEvent(doc({ title: 'Replayed omiword' }));
    const v1 = await deliver(svc.base, e, { v1Only: true });
    assert.strictEqual(v1.status, 401, 'v1 only (v2 stripped): refused');
    const stale = await deliver(svc.base, e, { now: Date.now() - 301000 });
    assert.strictEqual(stale.status, 401, 'stale v2 (outside the 300 s window): refused');
    const future = await deliver(svc.base, e, { now: Date.now() + 301000 });
    assert.strictEqual(future.status, 401, 'v2 from too far in the future: refused');
    assert.strictEqual((await search('omiword')).length, 0);
    assert.strictEqual(receipts(), 0);
    const ok = await deliver(svc.base, e);
    assert.strictEqual(ok.status, 200, 'a fresh v2 delivery of the same event is accepted');
    assert.strictEqual((await search('omiword')).length, 1);
});

t('a delivered upsert is indexed; the same event again is a no-op', async () => {
    const d = doc({ title: 'Delivered nuword' });
    const e = indexEvent(d);
    const r = await deliver(svc.base, e);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual([r.body.duplicate, r.body.outcome], [false, 'applied']);
    const again = await deliver(svc.base, e, { seq: 2 });
    assert.deepStrictEqual([again.status, again.body.duplicate], [200, true]);
    assert.strictEqual((await search('nuword')).length, 1);
    const events = svc.outbox.all().filter(x => x.payload.id === d.id && x.event_type === 'search.document.indexed');
    assert.strictEqual(events.length, 1, 'one effect, one event');
});

t('out-of-order deliveries converge on the newest revision', async () => {
    const d = doc({ title: 'Order xiword v1' });
    const v3 = indexEvent({ ...d, revision: 3, title: 'Order xiword v3 final' });
    const v1 = indexEvent({ ...d, revision: 1 });
    const v2 = indexEvent({ ...d, revision: 2, title: 'Order xiword v2 stale' });
    assert.strictEqual((await deliver(svc.base, v3)).body.outcome, 'applied');
    assert.strictEqual((await deliver(svc.base, v1)).body.outcome, 'stale');
    assert.strictEqual((await deliver(svc.base, v2)).body.outcome, 'stale');
    const hits = await search('xiword');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].revision, 3);
    assert.strictEqual(hits[0].title, 'Order xiword v3 final');
});

t('a deletion event tombstones and wins over upserts delivered after it', async () => {
    const d = doc({ title: 'Deleted omicronword', revision: 4 });
    await deliver(svc.base, indexEvent(d));
    assert.strictEqual((await search('omicronword')).length, 1);
    assert.strictEqual((await deliver(svc.base, indexEvent({ ...d, revision: 5 }, { action: 'deleted' }))).body.outcome, 'applied');
    assert.strictEqual((await search('omicronword')).length, 0);
    // a retried older upsert and a same-revision upsert arrive late
    assert.strictEqual((await deliver(svc.base, indexEvent(d))).body.outcome, 'stale');
    assert.strictEqual((await deliver(svc.base, indexEvent({ ...d, revision: 5 }))).body.outcome, 'stale');
    assert.strictEqual((await search('omicronword')).length, 0);
    const removed = svc.outbox.all().filter(x => x.event_type === 'search.document.removed' && x.payload.id === d.id);
    assert.deepStrictEqual(removed.map(x => x.payload.reason), ['deleted']);
});

t('the events path and the direct API share one revision order', async () => {
    const d = doc({ title: 'Shared piword', revision: 2 });
    await deliver(svc.base, indexEvent(d));
    const token = serviceToken('wiki', ['search.document.write']);
    const r = await request(svc.base, 'PUT', `/api/v1/documents/wiki/page/${d.id}`, { token, body: { ...d, revision: 1 } });
    assert.strictEqual(r.status, 409);
    const del = await request(svc.base, 'DELETE', `/api/v1/documents/wiki/page/${d.id}?revision=3`, { token });
    assert.strictEqual(del.body.outcome, 'applied');
    assert.strictEqual((await deliver(svc.base, indexEvent({ ...d, revision: 2 }))).body.outcome, 'stale');
});

t('a source cannot write another owner\'s documents; refusals are recorded once and visible to that owner', async () => {
    const d = doc({ owner: 'wiki', title: 'Forged rhoword' });
    // blog publishes an event claiming a wiki document
    const forged = indexEvent({ ...d }, { source: 'blog', eventType: 'blog.index_document.upserted' });
    const r = await deliver(svc.base, forged);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.outcome, 'rejected:owner_mismatch');
    assert.strictEqual((await deliver(svc.base, forged)).body.duplicate, true);
    // a prefix that is not the source
    const prefix = indexEvent({ ...d, owner: undefined }, { source: 'blog', eventType: 'wiki.index_document.upserted' });
    assert.strictEqual((await deliver(svc.base, prefix)).body.outcome, 'rejected:owner_mismatch');
    assert.strictEqual((await search('rhoword')).length, 0);

    const blogToken = serviceToken('blog', ['search.document.write']);
    const rej = await request(svc.base, 'GET', '/api/v1/owners/blog/rejections', { token: blogToken });
    assert.strictEqual(rej.status, 200);
    assert.deepStrictEqual(rej.body.rejections.map(x => x.code), ['owner_mismatch', 'owner_mismatch']);
});

t('unknown owners, subject mismatches and invalid documents are refused', async () => {
    const stranger = doc({ owner: 'nobody', title: 'Stranger sigmaword' });
    assert.strictEqual((await deliver(svc.base, indexEvent(stranger))).body.outcome, 'rejected:owner_not_accepted');
    const d = doc({ title: 'Mismatch sigmaword' });
    const mismatch = indexEvent(d, { subject: { type: 'page', id: 'someone_else', revision: 1 } });
    assert.strictEqual((await deliver(svc.base, mismatch)).body.outcome, 'rejected:subject_mismatch');
    const badRev = indexEvent(d, { subject: { type: 'page', id: d.id, revision: 9 } });
    assert.strictEqual((await deliver(svc.base, badRev)).body.outcome, 'rejected:subject_mismatch');
    const invalid = indexEvent({ ...d, visibility: 'world' });
    assert.strictEqual((await deliver(svc.base, invalid)).body.outcome, 'rejected:invalid_document');
    assert.strictEqual((await search('sigmaword')).length, 0);
});

t('events that are not index documents are acknowledged and ignored', async () => {
    const e = { ...indexEvent(doc()), event_type: 'wiki.page.published' };
    const r = await deliver(svc.base, e);
    assert.deepStrictEqual([r.status, r.body.outcome], [200, 'ignored']);
});

t('a failure while applying leaves no receipt, so the redelivery applies exactly once', async () => {
    const d = doc({ title: 'Crash tauword' });
    const e = indexEvent(d);
    const original = svc.store.apply;
    let calls = 0;
    svc.store.apply = (...args) => { calls++; if (calls === 1) throw new Error('disk on fire'); return original(...args); };
    try {
        const r1 = await deliver(svc.base, e);
        assert.strictEqual(r1.status, 500);
        assert.strictEqual((await search('tauword')).length, 0);
        assert.strictEqual(svc.db.prepare('SELECT COUNT(*) AS n FROM idempotency_receipts WHERE event_id = ?').get(e.event_id).n, 0);
        const r2 = await deliver(svc.base, e, { seq: 2 });
        assert.deepStrictEqual([r2.status, r2.body.outcome], [200, 'applied']);
        const r3 = await deliver(svc.base, e, { seq: 3 });
        assert.strictEqual(r3.body.duplicate, true);
    } finally {
        svc.store.apply = original;
    }
    assert.strictEqual((await search('tauword')).length, 1);
    assert.strictEqual(svc.outbox.all().filter(x => x.payload.id === d.id).length, 1);
});

t('OpenVibe.Sources item documents (the first real producer) index for staff only', async () => {
    // exactly the shape OpenVibe.Sources server/items.js indexDocument() emits
    const item = {
        owner: 'sources', type: 'item', id: 'itm_01K5ZQ8T3B9V2W7X6Y5Z4A3B2C', revision: 1,
        visibility: 'members', acl: { groups: ['role:admin', 'role:global_mod'] },
        title: 'Telescope sees upsilonword first light', summary: 'The new telescope saw first light.', body: '',
        facets: { category: 'news', source: 'nasa-news-releases', kind: 'article' },
        authorship: 'imported',
        provenance: [{ service: 'sources', type: 'item', id: 'itm_01K5ZQ8T3B9V2W7X6Y5Z4A3B2C', revision: 1, url: 'https://www.nasa.gov/x', retrieved_at: '2026-09-22T12:00:00.000Z' }],
        publication_state: 'published', published_at: '2026-09-21T14:30:00.000Z', updated_at: null,
        indexability: { decision: 'noindex', reasons: ['third_party_content'] },
        canonical_url: 'https://www.nasa.gov/x',
    };
    const r = await deliver(svc.base, indexEvent(item));
    assert.strictEqual(r.body.outcome, 'applied');
    assert.strictEqual((await search('upsilonword')).length, 0, 'anonymous: nothing');
    const { userToken } = require('./helpers');
    const asAdmin = await request(svc.base, 'GET', '/api/v1/search?q=upsilonword', { token: userToken({ role: 'admin' }) });
    assert.deepStrictEqual(asAdmin.body.results.map(x => [x.owner, x.type, x.indexable]), [['sources', 'item', false]]);
    const asUser = await request(svc.base, 'GET', '/api/v1/search?q=upsilonword', { token: userToken({ role: 'user' }) });
    assert.strictEqual(asUser.body.results.length, 0);
    assert.strictEqual((await deliver(svc.base, indexEvent({ ...item, revision: 2 }, { action: 'deleted' }))).body.outcome, 'applied');
    assert.strictEqual((await request(svc.base, 'GET', '/api/v1/search?q=upsilonword', { token: userToken({ role: 'admin' }) })).body.results.length, 0);
});

t('without SEARCH_EVENTS_SECRET the webhook is off', async () => {
    const off = await boot({ env: { SEARCH_EVENTS_SECRET: '' } });
    try {
        const r = await deliver(off.base, indexEvent(doc()));
        assert.strictEqual(r.status, 503);
    } finally {
        await off.stop();
    }
});

t('secret rotation: both configured secrets verify', async () => {
    const other = 'whsec_rotated_' + 'z'.repeat(40);
    const svc2 = await boot({ env: { SEARCH_EVENTS_SECRET: `${other},whsec_test_${'x'.repeat(40)}` } });
    try {
        assert.strictEqual((await deliver(svc2.base, indexEvent(doc()), { secret: other })).status, 200);
        assert.strictEqual((await deliver(svc2.base, indexEvent(doc()))).status, 200);
    } finally {
        await svc2.stop();
    }
});

t('done', async () => { await svc.stop(); void ids; });

t.run();

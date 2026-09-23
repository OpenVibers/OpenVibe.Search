'use strict';
/** Owner API: capability and ownership, validation, revision ordering, tombstones, reconciliation. */
const assert = require('assert');
const { boot, request, serviceToken, doc, suite } = require('./helpers');

const t = suite('documents');
let svc;
const WIKI = serviceToken('wiki', ['search.document.write']);
const BLOG = serviceToken('blog', ['search.document.write']);

const put = (d, token = WIKI) => request(svc.base, 'PUT', `/api/v1/documents/${d.owner}/${d.type}/${d.id}`, { token, body: d });
const del = (d, rev, token = WIKI) => request(svc.base, 'DELETE', `/api/v1/documents/${d.owner}/${d.type}/${d.id}${rev === undefined ? '' : `?revision=${rev}`}`, { token });
const search = (q) => request(svc.base, 'GET', `/api/v1/search?q=${encodeURIComponent(q)}`);

t('boot', async () => { svc = await boot(); });

t('writing needs a service token with search.document.write', async () => {
    const d = doc();
    assert.strictEqual((await put(d, null)).status, 401);
    const noCap = serviceToken('wiki', ['search.query.delegate']);
    const r = await put(d, noCap);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'capability.denied');
    const wrongAud = serviceToken('wiki', ['search.document.write'], { aud: 'openvibe.events' });
    assert.strictEqual((await put(d, wrongAud)).status, 401);
    assert.strictEqual((await put(d)).status, 200);
});

t('a service writes only its own documents', async () => {
    const d = doc();
    const r = await put(d, BLOG);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'search.not_owner');
    const r2 = await request(svc.base, 'PUT', `/api/v1/documents/wiki/page/${d.id}`, { token: WIKI, body: { ...d, owner: 'blog' } });
    assert.strictEqual(r2.status, 422);
});

t('invalid documents are refused with the schema errors', async () => {
    const r = await put(doc({ visibility: 'everyone' }));
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.code, 'search.bad_document');
    assert.ok(r.body.errors.length);
    assert.strictEqual((await put(doc({ acl: { subjects: ['57'] } }))).status, 422, 'integer user ids are not subjects');
    assert.strictEqual((await put(doc({ canonical_url: 'javascript:alert(1)' }))).status, 422);
    const noTitle = doc();
    delete noTitle.title;
    assert.strictEqual((await put(noTitle)).status, 422);
});

t('an older revision never overwrites a newer one', async () => {
    const d = doc({ title: 'Revision ordering alphaone', revision: 5 });
    assert.strictEqual((await put(d)).body.outcome, 'applied');
    const older = await put({ ...d, revision: 4, title: 'Revision ordering betatwo' });
    assert.strictEqual(older.status, 409);
    assert.strictEqual(older.body.code, 'search.stale_revision');
    assert.strictEqual(older.body.stored_revision, 5);
    assert.strictEqual((await search('alphaone')).body.results.length, 1);
    assert.strictEqual((await search('betatwo')).body.results.length, 0);
});

t('the same revision again is unchanged; different content at that revision is a conflict', async () => {
    const d = doc({ revision: 3 });
    await put(d);
    const again = await put(d);
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.outcome, 'unchanged');
    const other = await put({ ...d, title: 'Something else' });
    assert.strictEqual(other.status, 409);
    assert.strictEqual(other.body.code, 'search.revision_conflict');
});

t('a newer revision replaces the document and its search terms', async () => {
    const d = doc({ title: 'Gammaword original', revision: 1 });
    await put(d);
    assert.strictEqual((await put({ ...d, revision: 2, title: 'Deltaword replacement' })).body.outcome, 'applied');
    assert.strictEqual((await search('gammaword')).body.results.length, 0);
    const r = await search('deltaword');
    assert.strictEqual(r.body.results.length, 1);
    assert.strictEqual(r.body.results[0].revision, 2);
});

t('a tombstone removes the document and wins over the same and older revisions', async () => {
    const d = doc({ title: 'Tombstoned epsilonword', revision: 7 });
    await put(d);
    assert.strictEqual((await search('epsilonword')).body.results.length, 1);
    const r = await del(d, 7);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.outcome, 'applied');
    assert.strictEqual((await search('epsilonword')).body.results.length, 0);
    // a late upsert with the same revision, or an older one, cannot resurrect it
    assert.strictEqual((await put(d)).status, 409);
    assert.strictEqual((await put({ ...d, revision: 6 })).status, 409);
    assert.strictEqual((await search('epsilonword')).body.results.length, 0);
    assert.strictEqual((await request(svc.base, 'GET', `/api/v1/documents/wiki/page/${d.id}`)).status, 404);
    // a newer revision is a deliberate restore
    assert.strictEqual((await put({ ...d, revision: 8 })).body.outcome, 'applied');
    assert.strictEqual((await search('epsilonword')).body.results.length, 1);
});

t('a deletion at the stored revision wins the tie; an older deletion is stale', async () => {
    const d = doc({ title: 'Tie zetaword', revision: 3 });
    await put(d);
    assert.strictEqual((await del(d, 2)).status, 409);
    assert.strictEqual((await search('zetaword')).body.results.length, 1);
    assert.strictEqual((await del(d)).body.outcome, 'applied', 'no revision = the stored revision');
    assert.strictEqual((await search('zetaword')).body.results.length, 0);
    assert.strictEqual((await del(d)).body.outcome, 'unchanged');
});

t('deleting a document Search never saw leaves a tombstone that refuses late upserts', async () => {
    const d = doc({ title: 'Never seen etaword', revision: 4 });
    assert.strictEqual((await del(d, 4)).body.outcome, 'applied');
    assert.strictEqual((await put(d)).status, 409);
    assert.strictEqual((await search('etaword')).body.results.length, 0);
});

t('reconciliation lists the owner\'s (id, revision) pairs, tombstones included, with paging', async () => {
    const own = serviceToken('recon', ['search.document.write']);
    const made = [];
    for (let i = 0; i < 5; i++) {
        const d = doc({ owner: 'recon', type: 'item', id: `it_${i}`, revision: i + 1 });
        await put(d, own);
        made.push(d);
    }
    await del(made[2], 3, own);
    const p1 = await request(svc.base, 'GET', '/api/v1/owners/recon/documents?limit=3', { token: own });
    assert.strictEqual(p1.status, 200);
    assert.strictEqual(p1.body.documents.length, 3);
    assert.ok(p1.body.next_after);
    const p2 = await request(svc.base, 'GET', `/api/v1/owners/recon/documents?limit=3&after=${p1.body.next_after}`, { token: own });
    const all = [...p1.body.documents, ...p2.body.documents];
    assert.deepStrictEqual(all.map(x => [x.id, x.revision, x.deleted]), [
        ['it_0', 1, false], ['it_1', 2, false], ['it_2', 3, true], ['it_3', 4, false], ['it_4', 5, false],
    ]);
    assert.strictEqual(p2.body.next_after, null);
    assert.ok(all.every(x => /^[0-9a-f]{64}$/.test(x.hash)));
    // another service cannot read this owner's inventory
    assert.strictEqual((await request(svc.base, 'GET', '/api/v1/owners/recon/documents', { token: WIKI })).status, 403);
    const detail = await request(svc.base, 'GET', '/api/v1/owners/recon/documents/item/it_1', { token: own });
    assert.strictEqual(detail.body.document.revision, 2);
    assert.strictEqual(detail.body.effective_indexability.decision, 'index');
});

t('Search only makes indexability stricter', async () => {
    const own = serviceToken('gate', ['search.document.write']);
    const cases = [
        [{ visibility: 'members' }, 'members_only'],
        [{ publication_state: 'scheduled' }, 'not_published'],
        [{ provenance: [{ service: 'sources', type: 'item', id: 'x', stub: true }] }, 'stub_provider'],
        [{ canonical_url: undefined }, 'missing_canonical_url'],
    ];
    for (const [i, [over, reason]] of cases.entries()) {
        const d = doc({ owner: 'gate', type: 'thing', id: `g${i}`, ...over });
        if ('canonical_url' in over && over.canonical_url === undefined) delete d.canonical_url;
        assert.strictEqual((await put(d, own)).status, 200);
        const r = await request(svc.base, 'GET', `/api/v1/owners/gate/documents/thing/g${i}`, { token: own });
        assert.strictEqual(r.body.effective_indexability.decision, 'noindex', reason);
        assert.ok(r.body.effective_indexability.reasons.includes(reason), reason);
    }
    const d = doc({ owner: 'gate', type: 'thing', id: 'g9', indexability: { decision: 'noindex' } });
    await put(d, own);
    const r = await request(svc.base, 'GET', '/api/v1/owners/gate/documents/thing/g9', { token: own });
    assert.deepStrictEqual(r.body.effective_indexability, { decision: 'noindex', reasons: ['owner_decision'] });
});

t('done', async () => { await svc.stop(); });

t.run();

'use strict';
/**
 * Saved searches: only a signed-in person (usr_ subject) saves; each person sees only their own;
 * a run is a fresh query as that person (the ACL applies at run time); cookie changes must come
 * from this origin; the per-person limit holds.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, request, serviceToken, userToken, doc, suite } = require('./helpers');

const t = suite('saved-searches');
const ORIGIN = 'https://search.openvibe.network';
const DELEGATE = serviceToken('blog', ['search.query.delegate']);
const NO_DELEGATE = serviceToken('blog', ['search.document.write']);

const alice = ids.newId('user');
const bob = ids.newId('user');
const guest = ids.newId('guest');
const as = (subjectId, role = 'user') => ({ token: userToken({ subjectId, role, aud: ['openvibe.search'] }) });

let svc;
const call = (method, p, opts = {}) => request(svc.base, method, p, opts);

t('boot with a small per-person limit', async () => {
    svc = await boot({ env: { BASE_URL: ORIGIN, SEARCH_SAVED_MAX_PER_SUBJECT: '3' } });
    svc.store.apply(doc({ id: 'pub', title: 'Zebra migration public', canonical_url: 'https://openvibe.wiki/p/pub', facets: { category: 'animals' } }));
    svc.store.apply(doc({ id: 'mem', visibility: 'members', acl: { subjects: [alice] }, title: 'Zebra migration for alice', facets: { category: 'animals' } }));
    svc.store.apply(doc({ owner: 'blog', type: 'post', id: 'other', title: 'Zebra blog post', canonical_url: 'https://openvibe.blog/p/other' }));
});

t('anonymous callers, guests and services without delegation cannot use saved searches', async () => {
    assert.strictEqual((await call('GET', '/api/v1/saved-searches')).status, 401);
    assert.strictEqual((await call('POST', '/api/v1/saved-searches', { body: { q: 'zebra' } })).status, 401);
    const g = await call('POST', '/api/v1/saved-searches', { token: DELEGATE, headers: { 'X-OV-Subject': guest }, body: { q: 'zebra' } });
    assert.strictEqual(g.status, 403);
    assert.strictEqual(g.body.code || g.body.type.split('/').pop(), 'search.sign_in_required');
    assert.strictEqual((await call('GET', '/api/v1/saved-searches', { token: DELEGATE })).status, 401, 'a service with no subject is nobody');
    assert.strictEqual((await call('GET', '/api/v1/saved-searches', { token: NO_DELEGATE, headers: { 'X-OV-Subject': alice } })).status, 403);
});

let saved;
t('a person saves a query with filters; the same query again is the same saved search', async () => {
    const r = await call('POST', '/api/v1/saved-searches', { ...as(alice), body: { name: 'Zebras', q: '  zebra migration ', owner: 'wiki', facets: { category: ['animals'] } } });
    assert.strictEqual(r.status, 201, r.text);
    saved = r.body.saved_search;
    assert.match(saved.id, /^svs_[0-9a-z]{26}$/);
    assert.strictEqual(saved.name, 'Zebras');
    assert.strictEqual(saved.q, 'zebra migration');
    assert.deepStrictEqual(saved.filters, { owner: 'wiki', facets: [['category', ['animals']]] });
    assert.strictEqual(saved.last_run_at, null);
    assert.ok(!('subject' in saved));

    const again = await call('POST', '/api/v1/saved-searches', { ...as(alice), body: { name: 'Zebras (renamed)', q: 'zebra migration', facets: { category: 'animals' }, owner: 'wiki' } });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.saved_search.id, saved.id);
    assert.strictEqual(again.body.saved_search.name, 'Zebras (renamed)');

    const list = await call('GET', '/api/v1/saved-searches', as(alice));
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(list.body.saved_searches.map(s => s.id), [saved.id]);
    assert.strictEqual(list.body.max, 3);
    assert.strictEqual(list.headers.get('cache-control'), 'no-store');
});

t('running a saved search queries as the person now, with its filters', async () => {
    const r = await call('GET', `/api/v1/saved-searches/${saved.id}/results`, as(alice));
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.results.map(x => x.id).sort(), ['mem', 'pub'], 'owner=wiki filter applies; alice sees her members document');
    assert.strictEqual(r.body.saved_search.id, saved.id);
    const after = await call('GET', `/api/v1/saved-searches/${saved.id}`, as(alice));
    assert.ok(after.body.saved_search.last_run_at);

    // Access is decided at run time: alice loses the members document, it leaves her results.
    svc.store.apply(doc({ id: 'mem', revision: 2, visibility: 'members', acl: { subjects: [bob] }, title: 'Zebra migration for alice', facets: { category: 'animals' } }));
    const r2 = await call('GET', `/api/v1/saved-searches/${saved.id}/results`, as(alice));
    assert.deepStrictEqual(r2.body.results.map(x => x.id), ['pub']);
    // And a deleted public document leaves it too.
    svc.store.remove('wiki', 'page', 'pub');
    const r3 = await call('GET', `/api/v1/saved-searches/${saved.id}/results`, as(alice));
    assert.deepStrictEqual(r3.body.results, []);
});

t("another person's saved search is the same 404 as a missing one, for read, run and delete", async () => {
    for (const [m, p] of [['GET', `/api/v1/saved-searches/${saved.id}`], ['GET', `/api/v1/saved-searches/${saved.id}/results`], ['DELETE', `/api/v1/saved-searches/${saved.id}`]]) {
        const theirs = await call(m, p, as(bob));
        const missing = await call(m, p.replace(saved.id, 'svs_00000000000000000000000000'), as(bob));
        assert.strictEqual(theirs.status, 404, `${m} ${p}`);
        assert.strictEqual(missing.status, 404);
        assert.strictEqual(theirs.body.detail, missing.body.detail);
    }
    assert.deepStrictEqual((await call('GET', '/api/v1/saved-searches', as(bob))).body.saved_searches, []);
    assert.strictEqual((await call('GET', '/api/v1/saved-searches/not-an-id', as(alice))).status, 404);
});

t('bad saved searches are refused: nothing to search, malformed filters, oversize name', async () => {
    const bad = async (body) => (await call('POST', '/api/v1/saved-searches', { ...as(alice), body })).status;
    assert.strictEqual(await bad({}), 400);
    assert.strictEqual(await bad({ q: '   ' }), 400);
    assert.strictEqual(await bad({ q: '!!! ???' }), 400);
    assert.strictEqual(await bad({ q: 'x', owner: 'Not Valid' }), 400);
    assert.strictEqual(await bad({ q: 'x', facets: { 'Bad Key': ['v'] } }), 400);
    assert.strictEqual(await bad({ q: 'x', facets: ['v'] }), 400);
    assert.strictEqual(await bad({ q: 'x', facets: { k: [1] } }), 400);
    assert.strictEqual(await bad({ q: 'x', name: 'n'.repeat(101) }), 400);
    assert.strictEqual(await bad({ q: 5 }), 400);
    assert.strictEqual(await bad({ q: 'x'.repeat(501) }), 400);
    // Filters alone are a valid saved search (newest in a product).
    const r = await call('POST', '/api/v1/saved-searches', { ...as(alice), body: { owner: 'blog' } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.saved_search.name, 'All documents');
    const run = await call('GET', `/api/v1/saved-searches/${r.body.saved_search.id}/results`, as(alice));
    assert.deepStrictEqual(run.body.results.map(x => x.id), ['other']);
});

t('a cookie-authenticated change must come from this origin; Bearer and delegated calls need no Origin', async () => {
    const cookie = { headers: { Cookie: `ov_token=${as(alice).token}` } };
    const noOrigin = await call('POST', '/api/v1/saved-searches', { ...cookie, body: { q: 'cookie one' } });
    assert.strictEqual(noOrigin.status, 403);
    const foreign = await call('POST', '/api/v1/saved-searches', { headers: { ...cookie.headers, Origin: 'https://evil.example' }, body: { q: 'cookie one' } });
    assert.strictEqual(foreign.status, 403);
    const sibling = await call('POST', '/api/v1/saved-searches', { headers: { ...cookie.headers, Origin: 'https://openvibe.wiki' }, body: { q: 'cookie one' } });
    assert.strictEqual(sibling.status, 403);
    const same = await call('POST', '/api/v1/saved-searches', { headers: { ...cookie.headers, Origin: ORIGIN }, body: { q: 'cookie one' } });
    assert.strictEqual(same.status, 201);
    // Reading with the cookie needs no Origin.
    assert.strictEqual((await call('GET', '/api/v1/saved-searches', cookie)).status, 200);
    const del = await call('DELETE', `/api/v1/saved-searches/${same.body.saved_search.id}`, cookie);
    assert.strictEqual(del.status, 403);
    assert.strictEqual((await call('DELETE', `/api/v1/saved-searches/${same.body.saved_search.id}`, { headers: { ...cookie.headers, Origin: ORIGIN } })).status, 204);

    // A product saving for its signed-in visitor.
    const d = await call('POST', '/api/v1/saved-searches', { token: DELEGATE, headers: { 'X-OV-Subject': bob }, body: { q: 'zebra' } });
    assert.strictEqual(d.status, 201);
    assert.deepStrictEqual((await call('GET', '/api/v1/saved-searches', as(bob))).body.saved_searches.map(s => s.id), [d.body.saved_search.id]);
});

t('the per-person limit holds, and deleting frees a slot', async () => {
    // alice has 2 (zebra, owner=blog); the limit is 3.
    assert.strictEqual((await call('POST', '/api/v1/saved-searches', { ...as(alice), body: { q: 'third' } })).status, 201);
    const over = await call('POST', '/api/v1/saved-searches', { ...as(alice), body: { q: 'fourth' } });
    assert.strictEqual(over.status, 409);
    // Saving a query already saved is not a new one, even at the limit.
    assert.strictEqual((await call('POST', '/api/v1/saved-searches', { ...as(alice), body: { q: 'third' } })).status, 200);
    assert.strictEqual((await call('DELETE', `/api/v1/saved-searches/${saved.id}`, as(alice))).status, 204);
    assert.strictEqual((await call('GET', `/api/v1/saved-searches/${saved.id}`, as(alice))).status, 404);
    assert.strictEqual((await call('POST', '/api/v1/saved-searches', { ...as(alice), body: { q: 'fourth' } })).status, 201);
    const ready = await call('GET', '/api/ready');
    assert.strictEqual(ready.body.saved_searches, 4);
});

t('shutdown', async () => { await svc.stop(); });

t.run();

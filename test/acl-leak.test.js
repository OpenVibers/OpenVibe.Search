'use strict';
/**
 * Adversarial visibility tests. Every non-public document carries the same rare word, so any
 * leak — a hit, a snippet, a facet count, a suggestion, a direct get, a cursor — shows up.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, request, serviceToken, userToken, doc, suite } = require('./helpers');

const t = suite('acl-leak');
let svc;
const WIKI = serviceToken('wiki', ['search.document.write']);
const DELEGATE = serviceToken('blog', ['search.query.delegate']);

const alice = ids.newId('user');     // named in ACLs
const mallory = ids.newId('user');   // named nowhere
const guest = ids.newId('guest');

const put = (d) => request(svc.base, 'PUT', `/api/v1/documents/${d.owner}/${d.type}/${d.id}`, { token: WIKI, body: d });
const get = (p, opts = {}) => request(svc.base, 'GET', p, opts);
const q = (query, opts) => get(`/api/v1/search?${query}`, opts);
const asUser = (subjectId, role) => ({ token: userToken({ subjectId, role }) });
const asDelegate = (headers = {}) => ({ token: DELEGATE, headers });

// the corpus
const SECRET = 'quuxsecret';
const D = {
    public: doc({ id: 'pub', title: `Public ${SECRET} page`, facets: { category: 'open', tags: ['shared'] } }),
    publicNoindex: doc({ id: 'pubnoidx', title: `Public noindex ${SECRET}`, indexability: { decision: 'noindex', reasons: ['thin_content'] }, facets: { category: 'thin' } }),
    unlisted: doc({ id: 'unl', visibility: 'unlisted', acl: { subjects: [alice] }, title: `Unlisted ${SECRET}`, facets: { category: 'hiddencat-unlisted' } }),
    unlistedNoAcl: doc({ id: 'unl2', visibility: 'unlisted', title: `Unlisted no acl ${SECRET}`, facets: { category: 'hiddencat-unlisted2' } }),
    members: doc({ id: 'mem', visibility: 'members', acl: { groups: ['wiki.space:spc_1:member'], entitlements: ['vip.plan:gold'] }, title: `Members ${SECRET}`, facets: { category: 'hiddencat-members' } }),
    private: doc({ id: 'prv', visibility: 'private', acl: { subjects: [alice], groups: ['role:admin'] }, title: `Private ${SECRET} diary`, body: `private body ${SECRET} with lots of words`, facets: { category: 'hiddencat-private', tags: ['shared'] } }),
    draft: doc({ id: 'drf', visibility: 'draft', acl: { subjects: [alice] }, title: `Draft ${SECRET}`, facets: { category: 'hiddencat-draft' } }),
    unpublished: doc({ id: 'unp', visibility: 'private', acl: { subjects: [alice] }, publication_state: 'draft', title: `Unpublished ${SECRET}`, facets: { category: 'hiddencat-unpub' } }),
    retracted: doc({ id: 'ret', publication_state: 'retracted', title: `Retracted ${SECRET}`, facets: { category: 'hiddencat-retracted' } }),
    deleted: doc({ id: 'del', visibility: 'private', acl: { subjects: [alice] }, title: `Deleted ${SECRET}`, facets: { category: 'hiddencat-deleted' } }),
};

function idsOf(r) {
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.results.map(x => x.id).sort();
}

function assertNoLeak(r, allowed) {
    const text = JSON.stringify(r.body);
    for (const [name, d] of Object.entries(D)) {
        if (allowed.includes(d.id)) continue;
        assert.ok(!text.includes(`"${d.id}"`), `${name} leaked by id`);
        assert.ok(!text.includes(d.title), `${name} leaked by title`);
        if (d.facets && d.facets.category && d.facets.category.startsWith('hiddencat')) {
            assert.ok(!text.includes(d.facets.category), `${name} leaked through a facet value`);
        }
    }
    assert.ok(!text.includes(alice), 'an ACL subject leaked');
    assert.ok(!text.includes('vip.plan:gold') && !text.includes('role:admin'), 'an ACL key leaked');
}

t('boot and index the corpus', async () => {
    svc = await boot();
    for (const d of Object.values(D)) assert.strictEqual((await put(d)).status, 200, d.id);
    const r = await request(svc.base, 'DELETE', `/api/v1/documents/wiki/page/${D.deleted.id}?revision=2`, { token: WIKI });
    assert.strictEqual(r.body.outcome, 'applied');
});

t('anonymous sees public listed documents only — hits, snippets, facets, suggestions', async () => {
    const r = await q(`q=${SECRET}&facets=category,tags`);
    assert.deepStrictEqual(idsOf(r), ['pub']);
    assertNoLeak(r, ['pub']);
    assert.deepStrictEqual(r.body.facets.category, [{ value: 'open', count: 1 }]);
    assert.deepStrictEqual(r.body.facets.tags, [{ value: 'shared', count: 1 }], 'the private document also has tag shared: it must not be counted');
    const s = await get(`/api/v1/suggest?q=${SECRET.slice(0, 5)}`);
    assert.strictEqual(s.status, 200);
    assert.deepStrictEqual(s.body.suggestions.map(x => x.id), ['pub'], 'only the public title completes');
    assertNoLeak(s, ['pub']);
    const s2 = await get('/api/v1/suggest?q=pub');
    assert.deepStrictEqual(s2.body.suggestions.map(x => x.id), ['pub']);
    const browse = await q('facets=category');
    assert.deepStrictEqual(idsOf(browse), ['pub']);
    assertNoLeak(browse, ['pub']);
});

t('filtering on a hidden facet value or owner finds nothing and counts nothing', async () => {
    for (const cat of ['hiddencat-private', 'hiddencat-members', 'hiddencat-draft', 'hiddencat-deleted', 'thin']) {
        const r = await q(`facet.category=${cat}&facets=category`);
        assert.deepStrictEqual(idsOf(r), [], cat);
        assert.deepStrictEqual(r.body.facets.category, [], cat);
    }
    const r = await q(`q=diary&owner=wiki&type=page`);
    assert.deepStrictEqual(idsOf(r), []);
});

t('a signed-in stranger sees exactly what anonymous sees in results', async () => {
    const r = await q(`q=${SECRET}&facets=category`, asUser(mallory));
    assert.deepStrictEqual(idsOf(r), ['pub']);
    assertNoLeak(r, ['pub']);
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
});

t('the ACL subject sees its private and unlisted documents, never drafts, unpublished or deleted', async () => {
    const r = await q(`q=${SECRET}&facets=category`, asUser(alice));
    assert.deepStrictEqual(idsOf(r), ['prv', 'pub', 'unl']);
    const text = JSON.stringify(r.body);
    for (const hidden of ['drf', 'unp', 'ret', 'del', 'mem', 'unl2', 'pubnoidx']) assert.ok(!text.includes(`"${hidden}"`), hidden);
    assert.ok(!text.includes('"acl"'), 'the ACL itself is never returned');
    const cats = r.body.facets.category.map(c => c.value).sort();
    assert.deepStrictEqual(cats, ['hiddencat-private', 'hiddencat-unlisted', 'open']);
    const s = await get('/api/v1/suggest?q=priv', asUser(alice));
    assert.deepStrictEqual(s.body.suggestions.map(x => x.id), ['prv']);
});

t('a role group from the Network token matches role:<role> ACL keys (private needs the subject)', async () => {
    const r = await q(`q=${SECRET}`, asUser(mallory, 'admin'));
    assert.deepStrictEqual(idsOf(r), ['pub'], 'private is subject-only; an admin role is not a subject');
});

t('members documents need a vouched group or entitlement', async () => {
    const none = await q(`q=${SECRET}`, asDelegate({ 'X-OV-Subject': mallory }));
    assert.deepStrictEqual(idsOf(none), ['pub']);
    const grp = await q(`q=${SECRET}`, asDelegate({ 'X-OV-Subject': mallory, 'X-OV-Groups': 'wiki.space:spc_1:member' }));
    assert.deepStrictEqual(idsOf(grp), ['mem', 'pub']);
    const ent = await q(`q=${SECRET}`, asDelegate({ 'X-OV-Subject': guest, 'X-OV-Entitlements': 'vip.plan:gold' }));
    assert.deepStrictEqual(idsOf(ent), ['mem', 'pub']);
    const wrong = await q(`q=${SECRET}`, asDelegate({ 'X-OV-Subject': mallory, 'X-OV-Groups': 'wiki.space:spc_2:member', 'X-OV-Entitlements': 'vip.plan:silver' }));
    assert.deepStrictEqual(idsOf(wrong), ['pub']);
    const forAlice = await q(`q=${SECRET}`, asDelegate({ 'X-OV-Subject': alice }));
    assert.deepStrictEqual(idsOf(forAlice), ['prv', 'pub', 'unl']);
});

t('delegation headers are ignored for browsers and refused without the capability', async () => {
    const forged = await q(`q=${SECRET}`, { token: userToken({ subjectId: mallory }), headers: { 'X-OV-Subject': alice, 'X-OV-Groups': 'role:admin', 'X-OV-Entitlements': 'vip.plan:gold' } });
    assert.deepStrictEqual(idsOf(forged), ['pub']);
    const anonForged = await q(`q=${SECRET}`, { headers: { 'X-OV-Subject': alice } });
    assert.deepStrictEqual(idsOf(anonForged), ['pub']);
    const noCap = await q(`q=${SECRET}`, { token: serviceToken('blog', ['search.document.write']), headers: { 'X-OV-Subject': alice } });
    assert.strictEqual(noCap.status, 403);
    const groupsWithoutSubject = await q(`q=${SECRET}`, asDelegate({ 'X-OV-Groups': 'wiki.space:spc_1:member' }));
    assert.strictEqual(groupsWithoutSubject.status, 400);
    const badSubject = await q(`q=${SECRET}`, asDelegate({ 'X-OV-Subject': '57' }));
    assert.strictEqual(badSubject.status, 400);
    const asItself = await q(`q=${SECRET}`, asDelegate());
    assert.deepStrictEqual(idsOf(asItself), ['pub']);
});

t('a bad Bearer is refused, never downgraded; an unverifiable cookie is signed out', async () => {
    const forgedKey = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const bad = await q(`q=${SECRET}`, { token: userToken({ subjectId: alice, key: forgedKey.privateKey }) });
    assert.strictEqual(bad.status, 401);
    const badSvc = await q(`q=${SECRET}`, { token: serviceToken('blog', ['search.query.delegate'], { key: forgedKey.privateKey }), headers: { 'X-OV-Subject': alice } });
    assert.strictEqual(badSvc.status, 401);
    const expired = await q(`q=${SECRET}`, { token: userToken({ subjectId: alice, exp: Math.floor(Date.now() / 1000) - 3600 }) });
    assert.strictEqual(expired.status, 401);
    const wrongIss = await q(`q=${SECRET}`, { token: userToken({ subjectId: alice, iss: 'https://evil.example' }) });
    assert.strictEqual(wrongIss.status, 401);
    const cookie = await q(`q=${SECRET}`, { headers: { Cookie: `ov_token=${userToken({ subjectId: alice, key: forgedKey.privateKey })}` } });
    assert.deepStrictEqual(idsOf(cookie), ['pub']);
    const goodCookie = await q(`q=${SECRET}`, { headers: { Cookie: `ov_token=${userToken({ subjectId: alice })}` } });
    assert.deepStrictEqual(idsOf(goodCookie), ['prv', 'pub', 'unl']);
});

t('direct gets: same 404 for hidden and missing; unlisted by id needs a signed-in subject', async () => {
    const missing = await get('/api/v1/documents/wiki/page/nope');
    assert.strictEqual(missing.status, 404);
    for (const id of ['prv', 'mem', 'drf', 'unp', 'ret', 'del', 'unl', 'unl2']) {
        const r = await get(`/api/v1/documents/wiki/page/${id}`);
        assert.strictEqual(r.status, 404, `anonymous ${id}`);
        assert.deepStrictEqual(Object.keys(r.body).sort(), Object.keys(missing.body).sort());
        assert.strictEqual(r.body.code, missing.body.code);
    }
    for (const id of ['prv', 'mem', 'drf', 'unp', 'ret', 'del']) {
        assert.strictEqual((await get(`/api/v1/documents/wiki/page/${id}`, asUser(mallory))).status, 404, `stranger ${id}`);
    }
    assert.strictEqual((await get('/api/v1/documents/wiki/page/unl2', asUser(mallory))).status, 200, 'unlisted by exact id');
    assert.strictEqual((await get('/api/v1/documents/wiki/page/pubnoidx')).status, 200, 'public noindex is public by id');
    const prv = await get('/api/v1/documents/wiki/page/prv', asUser(alice));
    assert.strictEqual(prv.status, 200);
    assert.strictEqual(prv.body.document.acl, undefined);
    for (const id of ['drf', 'unp', 'del']) {
        assert.strictEqual((await get(`/api/v1/documents/wiki/page/${id}`, asUser(alice))).status, 404, `ACL subject cannot see ${id}`);
    }
});

t('FTS syntax in q cannot widen the query', async () => {
    for (const bad of [`${SECRET} OR private`, `title:${SECRET}`, '*', `"${SECRET}" NOT pub`, `{title body}: ${SECRET}`, `${SECRET}) OR (diary`, 'NEAR(quuxsecret diary)', `${SECRET}*`]) {
        const r = await q(`q=${encodeURIComponent(bad)}&facets=category`);
        assert.strictEqual(r.status, 200, bad);
        assertNoLeak(r, ['pub']);
    }
});

t('cursors are bound to their query and never widen it', async () => {
    for (let i = 0; i < 5; i++) await put(doc({ id: `page_${i}`, title: `Paging thetaword ${i}` }));
    const p1 = await q('q=thetaword&limit=2');
    assert.strictEqual(p1.body.results.length, 2);
    const p2 = await q(`q=thetaword&limit=2&cursor=${p1.body.next_cursor}`);
    const p3 = await q(`q=thetaword&limit=2&cursor=${p2.body.next_cursor}`);
    const seen = [...p1.body.results, ...p2.body.results, ...p3.body.results].map(x => x.id);
    assert.strictEqual(new Set(seen).size, 5);
    assert.strictEqual(p3.body.next_cursor, null);
    const reused = await q(`q=${SECRET}&cursor=${p1.body.next_cursor}`);
    assert.strictEqual(reused.status, 400);
    assert.strictEqual(reused.body.code, 'search.bad_cursor');
    const forged = Buffer.from(JSON.stringify({ k: 'r', r: -1e9, i: 0, h: 'x' })).toString('base64url');
    assert.strictEqual((await q(`q=${SECRET}&cursor=${forged}`)).status, 400);
});

t('a visibility change or deletion leaves results at once and announces search.document.removed', async () => {
    const d = doc({ id: 'flip', title: 'Flipping iotaword', canonical_url: 'https://openvibe.wiki/p/flip', revision: 1 });
    await put(d);
    assert.deepStrictEqual(idsOf(await q('q=iotaword')), ['flip']);
    await put({ ...d, revision: 2, visibility: 'private', acl: { subjects: [alice] } });
    assert.deepStrictEqual(idsOf(await q('q=iotaword')), []);
    assert.strictEqual((await get('/api/v1/documents/wiki/page/flip')).status, 404);
    assert.deepStrictEqual(idsOf(await q('q=iotaword', asUser(alice))), ['flip']);
    await request(svc.base, 'DELETE', '/api/v1/documents/wiki/page/flip?revision=3', { token: WIKI });
    assert.deepStrictEqual(idsOf(await q('q=iotaword', asUser(alice))), []);

    const removed = svc.outbox.all().filter(e => e.event_type === 'search.document.removed' && e.payload.id === 'flip');
    assert.strictEqual(removed.length, 2);
    assert.deepStrictEqual(removed.map(e => [e.payload.reason, e.payload.previous_exposure, e.payload.exposure]), [
        ['visibility_changed', 'public_listed', 'restricted'],
        ['deleted', 'restricted', 'none'],
    ]);
    assert.strictEqual(removed[0].payload.canonical_url, 'https://openvibe.wiki/p/flip', 'the public URL to purge');
    assert.strictEqual(removed[1].payload.canonical_url, null, 'a URL that was never public is not broadcast');
    assert.ok(removed.every(e => e.visibility === 'internal' && e.source === 'search'));
});

t('publishing → draft and public → noindex also announce removal', async () => {
    const d = doc({ id: 'unpub', title: 'Kappaword', revision: 1 });
    await put(d);
    await put({ ...d, revision: 2, publication_state: 'unpublished' });
    const d2 = doc({ id: 'noidx', title: 'Lambdaword', revision: 1 });
    await put(d2);
    await put({ ...d2, revision: 2, indexability: { decision: 'noindex', reasons: ['duplicate_without_canonical'] } });
    const reasons = svc.outbox.all().filter(e => e.event_type === 'search.document.removed' && ['unpub', 'noidx'].includes(e.payload.id)).map(e => `${e.payload.id}:${e.payload.reason}`);
    assert.deepStrictEqual(reasons, ['unpub:not_published', 'noidx:noindex']);
    assert.deepStrictEqual(idsOf(await q('q=kappaword')), []);
    assert.deepStrictEqual(idsOf(await q('q=lambdaword')), []);
});

t('done', async () => { await svc.stop(); });

t.run();

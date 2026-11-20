'use strict';
/**
 * /saved: a signed-in person sees their saved searches and web watches (what each watches, when it last ran) and removes
 * one; a signed-out visitor is asked to sign in; a removal must come from this site; nothing of it is indexed.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, request, userToken, suite } = require('./helpers');

const t = suite('saved-page');
const ORIGIN = 'https://search.openvibe.network';
const alice = ids.newId('user');
const bob = ids.newId('user');
const cookie = (subjectId) => ({ Cookie: `ov_token=${userToken({ subjectId, aud: ['openvibe.search'] })}`, Accept: 'text/html' });

let svc;
let watch;
const call = (method, p, opts = {}) => request(svc.base, method, p, opts);

t('boot and save two', async () => {
    svc = await boot({ env: { BASE_URL: ORIGIN } });
    watch = (await svc.saved.save(alice, { name: 'Node LTS', q: 'new node.js LTS release', filters: { facets: [] }, scope: 'web' })).saved;
    await svc.saved.save(alice, { name: 'Wiki zebras', q: 'zebra', filters: { owner: 'wiki', facets: [] } });
});

t('signed out: asked to sign in, never indexed', async () => {
    const r = await call('GET', '/saved', { headers: { Accept: 'text/html' } });
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /Sign in to see your saved searches/);
    assert.match(r.text, /href="\/auth\/login\?next=%2Fsaved"/);
    assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow');
});

t('signed in: each saved search, what it watches, and Remove', async () => {
    const r = await call('GET', '/saved', { headers: cookie(alice) });
    assert.strictEqual(r.status, 200, r.text.slice(0, 200));
    assert.match(r.text, /2 saved, 1 watching the web \(at most 10\)/);
    assert.match(r.text, /Node LTS<\/a><span class="saved-meta">Watching the web, once a day · not checked yet/);
    assert.match(r.text, /href="https:\/\/openvibe\.exchange\/search\?q=new%20node\.js%20LTS%20release"/, 'a web watch runs on the Exchange');
    assert.match(r.text, /Wiki zebras<\/a><span class="saved-meta">OpenVibe pages, new matches/);
    assert.match(r.text, new RegExp(`action="/saved/${watch.id}/delete"`));
    const other = await call('GET', '/saved', { headers: cookie(bob) });
    assert.match(other.text, /Nothing saved yet/, "never another person's");
});

t('remove: from this site only, and only your own', async () => {
    const foreign = await call('POST', `/saved/${watch.id}/delete`, { headers: { ...cookie(alice), Origin: 'https://evil.example' } });
    assert.strictEqual(foreign.status, 403);
    const bobs = await call('POST', `/saved/${watch.id}/delete`, { headers: { ...cookie(bob), Origin: ORIGIN }, raw: '' });
    assert.ok([303, 302].includes(bobs.status) || bobs.status === 200);
    assert.ok(await svc.saved.get(alice, watch.id), "bob cannot remove alice's watch");
    const own = await fetch(`${svc.base}/saved/${watch.id}/delete`, { method: 'POST', headers: { ...cookie(alice), Origin: ORIGIN }, redirect: 'manual' });
    assert.strictEqual(own.status, 303);
    assert.strictEqual(own.headers.get('location'), '/saved?removed=1');
    assert.strictEqual(await svc.saved.get(alice, watch.id), null, 'removed');
});

t('stop', async () => { await svc.stop(); });

t.run();

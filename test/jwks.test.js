'use strict';
// Plan T0/T1: the service's own JWKS fetching/caching is gone; the SDK's client (openvibe-sdk/auth)
// fetches the keys. These tests drive it through a stub JWKS: a token signed by the stub's key
// verifies, the cached keys keep verifying through a stub outage (an unknown kid forces a refetch),
// and /api/ready reports the client's state.
const assert = require('assert');
const { boot, request, serviceToken, userToken, doc, suite, jwksDocument } = require('./helpers');

const t = suite('jwks');
let svc;
const state = { fail: false, fetches: 0 };
const jwksFetch = async () => {
    state.fetches += 1;
    if (state.fail) throw new Error('JWKS outage');
    return { ok: true, status: 200, json: async () => jwksDocument() };
};
const write = (token, d) => request(svc.base, 'PUT', `/api/v1/documents/wiki/page/${d.id}`, { token, body: d });

t('a token signed by a key from the stub JWKS verifies', async () => {
    svc = await boot({ jwksFetch });
    await svc.keyLoaded;
    assert.ok(state.fetches >= 1, 'the SDK client fetched the stub JWKS');
    const d = doc();
    const w = await write(serviceToken('wiki', ['search.document.write']), d);
    assert.ok(w.status === 200 || w.status === 201, w.text);
    const u = await request(svc.base, 'GET', '/api/v1/search?q=example', { token: userToken({ aud: ['openvibe.search'] }) });
    assert.strictEqual(u.status, 200, u.text);
});

t('with keys cached, a JWKS outage still verifies (and refetches for a rotation)', async () => {
    const before = state.fetches;
    state.fail = true;
    try {
        // An unknown kid makes the SDK refetch at once; the refetch fails, the last good keys are served.
        const w = await write(serviceToken('wiki', ['search.document.write'], { kid: 'rotated-away' }), doc());
        assert.ok(w.status === 200 || w.status === 201, w.text);
    } finally { state.fail = false; }
    assert.ok(state.fetches > before, 'the unknown kid forced a refetch during the outage');
});

t('/api/ready reports the JWKS state as a non-required check', async () => {
    const r = await request(svc.base, 'GET', '/api/ready');
    assert.strictEqual(r.status, 200, r.text);
    const c = r.body.checks.network_jwks;
    assert.strictEqual(c.status, 'ok', c.error);
    assert.strictEqual(c.required, false);
    assert.ok(Array.isArray(c.detail) && c.detail.length === 1, JSON.stringify(c.detail));
    assert.ok(!('url' in c.detail[0]) && !r.text.includes('.well-known'), 'the internal JWKS URL is never public');
    assert.strictEqual(c.detail[0].ready, true);
    assert.ok(c.detail[0].keys >= 1);
    assert.strictEqual(c.detail[0].stale, false);
    await svc.stop();
});

t.run();

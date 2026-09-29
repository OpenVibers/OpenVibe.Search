'use strict';
// Plan T0/T1: /api/ready's network_jwks check is optional and reports the state of the SDK's JWKS
// client. With no keys ever fetched, the service stays up (200) but reports degraded.
const assert = require('assert');
const { boot, request, suite, serviceToken, doc } = require('./helpers');

const t = suite('jwks-degraded');

t('with no keys fetched, /api/ready degrades but stays 200', async () => {
    const jwksFetch = async () => { throw new Error('JWKS unreachable'); };
    const svc = await boot({ jwksFetch });
    await svc.keyLoaded;                     // resolves null: the first fetch failed, nothing to verify with
    const r = await request(svc.base, 'GET', '/api/ready');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.status, 'degraded');
    assert.ok(r.body.degraded.includes('network_jwks'), JSON.stringify(r.body.degraded));
    const c = r.body.checks.network_jwks;
    assert.strictEqual(c.status, 'fail');
    assert.strictEqual(c.required, false);
    assert.strictEqual(c.detail[0].ready, false);
    assert.match(c.error, /Network signing key not loaded yet/);
    // A review caught the SDK's error (the internal JWKS URL and the fetch error) answered in public: in the
    // readiness body and as a service write's 503 detail.
    const leaks = (text) => /JWKS unreachable|well-known|127\.0\.0\.1/.test(text);
    assert.ok(!leaks(r.text), r.text);
    const w = await request(svc.base, 'PUT', `/api/v1/documents/wiki/page/${doc().id}`, { token: serviceToken('wiki', ['search.document.write']), body: doc() });
    assert.strictEqual(w.status, 503, w.text);
    assert.ok(!leaks(w.text), w.text);
    await svc.stop();
});

t.run();

'use strict';
/**
 * Cache headers come from openvibe-shared/cache-policy (the one cache rule every OpenVibe site uses):
 * the crawl files and the update log get the estate's short public window with a long
 * stale-while-revalidate, and the content-addressed Frame files under /shared are immutable for a
 * year only for the hash of the bytes served — any other ?v=, or none, is never pinned. Search's
 * Frame files are served by openvibe-shared/serve.js, whose own one-minute revalidation for shared
 * scripts is kept as it was.
 */
const assert = require('assert');
const serve = require('openvibe-shared/serve');
const { boot, request, suite } = require('./helpers');

const t = suite('asset-cache');
let svc;

t('boot', async () => {
    svc = await boot();
});

t('the current ?v=<hash> of a shared Frame file is immutable for a year', async () => {
    const r = await request(svc.base, 'GET', `/shared/navbar.js?v=${serve.hashOf('navbar.js')}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
});

t('a wrong-but-hex ?v= and no ?v= are a short public window, never pinned', async () => {
    for (const p of ['/shared/navbar.js?v=deadbeefdeadbeef', '/shared/navbar.js']) {
        const r = await request(svc.base, 'GET', p);
        assert.strictEqual(r.status, 200, p);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=60', p);
    }
});

t('the unversioned Frame init uses the shared asset policy even with a version query', async () => {
    for (const p of ['/frame-init.js', '/frame-init.js?v=deadbeefdeadbeef']) {
        const r = await request(svc.base, 'GET', p);
        assert.strictEqual(r.status, 200, p);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=86400', p);
    }
});

t('the crawl files and the update log use the estate HTML policy', async () => {
    for (const [p, expected] of [
        ['/robots.txt', 'public, max-age=3600, stale-while-revalidate=3600'],
        ['/llms.txt', 'public, max-age=3600, stale-while-revalidate=3600'],
        ['/sitemap.xml', 'public, max-age=3600, stale-while-revalidate=3600'],
        ['/updates', 'public, max-age=60, stale-while-revalidate=3600'],
    ]) {
        const r = await request(svc.base, 'GET', p);
        assert.strictEqual(r.status, 200, p);
        assert.strictEqual(r.headers.get('cache-control'), expected, p);
    }
});

t('shutdown', async () => { await svc.stop(); });

t.run();

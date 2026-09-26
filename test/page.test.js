'use strict';
/**
 * The public HTML search page (server/web/page.js): works without JavaScript, shows only what an
 * anonymous query may see, escapes everything, never caches, and keeps result pages out of
 * search engines. Non-HTML clients still get the text route index.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, request, userToken, doc, suite } = require('./helpers');

const t = suite('page');
let svc;
const html = (p, headers = {}) => request(svc.base, 'GET', p, { headers: { Accept: 'text/html,application/xhtml+xml', ...headers } });
const alice = ids.newId('user');

t('boot', async () => {
    svc = await boot();
    svc.store.apply(doc({ id: 'pub', title: 'Kestrel <script>alert(1)</script> nesting', summary: 'Kestrel "boxes" & more', body: 'kestrel kestrel', canonical_url: 'https://openvibe.wiki/p/kestrel?a=1&b=2' }));
    svc.store.apply(doc({ id: 'prv', visibility: 'private', acl: { subjects: [alice] }, title: 'Kestrel private diary', body: 'kestrel' }));
    svc.store.apply(doc({ id: 'drf', visibility: 'draft', title: 'Kestrel draft', body: 'kestrel' }));
    for (let i = 0; i < 25; i++) svc.store.apply(doc({ id: `many${i}`, title: `Heron sighting ${i}`, body: 'heron' }));
});

t('the front page is a search form, indexable, no-store, with a strict CSP', async () => {
    const r = await html('/');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.text, /<form method="get" action="\/" role="search">/);
    assert.ok(!/noindex/.test(r.text));
    assert.strictEqual(r.headers.get('x-robots-tag'), null);
    // One canonical URL (the browser check found none): the configured origin's front page.
    const canon = r.text.match(/<link rel="canonical" href="([^"]+)">/g) || [];
    assert.strictEqual(canon.length, 1);
    assert.match(canon[0], /href="https?:\/\/[^"/]+\/">$/);
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    // The OpenVibe Frame (navbar, footer, shipped views) is the only script: from this site or
    // openvibe.network, never inline JavaScript (the Frame's config is a JSON data block).
    const csp = r.headers.get('content-security-policy');
    // Plus Cloudflare Web Analytics, which Cloudflare injects at the edge (the privacy text discloses it).
    assert.match(csp, /script-src 'self' https:\/\/openvibe\.network https:\/\/static\.cloudflareinsights\.com;/);
    // And the Events realtime stream, for release notifications (release-watch, openvibe-shared 1.17).
    assert.match(csp, /connect-src 'self' https:\/\/openvibe\.network https:\/\/cloudflareinsights\.com https:\/\/events\.openvibe\.network;/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'no inline script allowed');
    const scripts = [...r.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    for (const [, attrs, body] of scripts) {
        if (/type="application\/json"/.test(attrs)) continue;
        assert.strictEqual(body.trim(), '', 'no inline JavaScript');
        const src = (/src="([^"]+)"/.exec(attrs) || [])[1];
        assert.ok(src && (src.startsWith('/') || src.startsWith('https://openvibe.network/')), `script from this site or openvibe.network: ${src}`);
    }
    assert.ok(r.text.includes('<div id="navbar-mount"></div>') && r.text.includes('id="ov-footer"'), 'the OpenVibe Frame');
    assert.ok(r.text.includes('data-ov-shipped="latest" data-service="search" href="/updates"'), 'what shipped');
});

t('the Frame init is a same-origin script and /updates is the shared log', async () => {
    const init = await fetch(`${svc.base}/frame-init.js`);
    assert.strictEqual(init.status, 200);
    assert.match(init.headers.get('content-type'), /javascript/);
    assert.match(await init.text(), /OpenVibeNavbar\.init/);
    const r = await html('/updates');
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('What shipped on OpenVibe.Search') && r.text.includes('data-ov-shipped="log" data-service="search"'));
    assert.match(r.text, /<link rel="canonical" href="https?:\/\/[^"/]+\/updates">/);
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
});

t('results show public documents only, escaped, linked to their canonical URL, noindex', async () => {
    const r = await html('/?q=kestrel');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.match(r.text, /<meta name="robots" content="noindex, nofollow">/);
    assert.ok(!/rel="canonical"/.test(r.text), 'a result page is noindex: no canonical');
    assert.ok(r.text.includes('Kestrel &lt;script&gt;alert(1)&lt;/script&gt; nesting'));
    assert.ok(!r.text.includes('<script>alert(1)'));
    assert.ok(r.text.includes('href="https://openvibe.wiki/p/kestrel?a=1&amp;b=2"'));
    assert.match(r.text, /<mark>Kestrel<\/mark>|<mark>kestrel<\/mark>/);
    assert.ok(!/private diary|Kestrel draft/.test(r.text));
});

t('a signed-in cookie adds that person\'s documents; a bad cookie searches as anonymous', async () => {
    const mine = await html('/?q=kestrel', { Cookie: `ov_token=${userToken({ subjectId: alice, aud: ['openvibe.search'] })}` });
    assert.match(mine.text, /Kestrel private diary/);
    const bad = await html('/?q=kestrel', { Cookie: 'ov_token=not.a.jwt' });
    assert.strictEqual(bad.status, 200);
    assert.ok(!/private diary/.test(bad.text));
    const badBearer = await html('/?q=kestrel', { Authorization: 'Bearer nope.nope.nope' });
    assert.strictEqual(badBearer.status, 200, 'the page never answers 401');
});

t('paging with More results, filters carried along, and an honest empty state', async () => {
    const p1 = await html('/?q=heron&owner=wiki');
    const more = /<a class="more" href="\/\?([^"]+)">/.exec(p1.text);
    assert.ok(more, 'a next-page link');
    const qs = more[1].replace(/&amp;/g, '&');
    assert.match(qs, /owner=wiki/);
    const p2 = await html(`/?${qs}`);
    const titles = (s) => [...s.matchAll(/Heron sighting (\d+)/g)].map(m => m[1]);
    assert.strictEqual(titles(p1.text).length, 20);
    assert.strictEqual(titles(p2.text).length, 5);
    assert.ok(!titles(p2.text).some(x => titles(p1.text).includes(x)));
    const none = await html('/?q=nothingmatcheszzz');
    assert.match(none.text, /Nothing found/);
    const bad = await html('/?q=x&owner=Not%20Valid');
    assert.strictEqual(bad.status, 400);
    assert.match(bad.text, /owner is malformed/);
});

t('non-HTML clients get the text route index; robots.txt keeps result pages out', async () => {
    const r = await request(svc.base, 'GET', '/');
    assert.match(r.headers.get('content-type'), /text\/plain/);
    assert.match(r.text, /GET {4}\/api\/v1\/search/);
    assert.match(r.text, /saved-searches/);
    const robots = await request(svc.base, 'GET', '/robots.txt');
    assert.match(robots.text, /Disallow: \/\?/);
    assert.match(robots.text, /Disallow: \/api\//);
});

t('shutdown', async () => { await svc.stop(); });

t.run();

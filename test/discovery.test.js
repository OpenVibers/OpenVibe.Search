'use strict';
/**
 * The crawl files at the origin (server/web/page.js + openvibe-shared/seo): /llms.txt, /robots.txt
 * and /sitemap.xml are served from the booted app, cached like the site's other public files, list
 * the public pages and the newest public document's real time (never the clock), keep the robots
 * rules the site already had, and never name a private path or a private document.
 */
const assert = require('assert');
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');
const { boot, request, doc, suite } = require('./helpers');
const { llmsFullTxt } = require('../server/web/page');
const { createApp } = require('../server/app');

const t = suite('discovery');
let svc;
const alice = ids.newId('user');
const origin = () => svc.config.baseUrl;

t('boot', async () => {
    svc = await boot();
    // The public document is the newest content the sitemap may use; the private one is NEWER and
    // must be ignored by every file.
    await svc.store.apply(doc({ id: 'crawl-pub', title: 'Published page', canonical_url: 'https://openvibe.wiki/p/pub', updated_at: '2026-09-10T08:30:00Z' }));
    await svc.store.apply(doc({ id: 'crawl-prv', visibility: 'private', acl: { subjects: [alice] }, title: 'Private diary', canonical_url: 'https://openvibe.wiki/p/secret', updated_at: '2026-09-20T08:30:00Z' }));
});

t('GET /llms.txt: what the site is, its public pages and its public endpoints, cached', async () => {
    const r = await request(svc.base, 'GET', '/llms.txt');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/plain/);
    assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=3600, stale-while-revalidate=3600');
    assert.match(r.text, /^# OpenVibe\.Search/m);
    assert.ok(r.text.includes(`- [Search](${origin()}/)`), 'the front page');
    assert.ok(r.text.includes(`(${origin()}/updates)`), 'the update log');
    assert.ok(r.text.includes(`(${origin()}/api/v1/search?q=)`), 'the public query API');
    assert.ok(r.text.includes(`(${origin()}/sitemap.xml)`));
    // Nothing private or per-user: no saved searches, no owner API, no Events webhook.
    assert.ok(!/saved-searches|\/api\/v1\/owners|\/internal\/events/.test(r.text));
});

t('GET /robots.txt: every existing Disallow kept, plus the sitemap and the AI/search bots', async () => {
    const r = await request(svc.base, 'GET', '/robots.txt');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/plain/);
    assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=3600, stale-while-revalidate=3600');
    for (const d of ['/?', '/api/', '/internal/']) assert.ok(r.text.includes(`Disallow: ${d}`), `kept Disallow: ${d}`);
    assert.ok(r.text.includes('Allow: /$') && r.text.includes('Allow: /updates'), 'the crawlable pages');
    assert.ok(r.text.includes(`Sitemap: ${origin()}/sitemap.xml`));
    for (const bot of ['GPTBot', 'ClaudeBot', 'Googlebot']) assert.ok(r.text.includes(`User-agent: ${bot}`), `names ${bot}`);
});

t('GET /sitemap.xml: the public pages, lastmod from the newest public document, no private path', async () => {
    const r = await request(svc.base, 'GET', '/sitemap.xml');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /application\/xml/);
    assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=3600, stale-while-revalidate=3600');
    assert.ok(r.text.includes(`<loc>${origin()}/</loc>`), 'the front page');
    assert.ok(r.text.includes(`<loc>${origin()}/updates</loc>`), 'the update log');
    // The front page's lastmod is the newest PUBLIC document's time — not the clock, and not the
    // newer private document (2026-09-20), which never appears anywhere in the file.
    const front = /<url><loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod>/.exec(r.text);
    assert.ok(front, 'the front page has a lastmod');
    assert.strictEqual(front[1], `${origin()}/`);
    assert.strictEqual(front[2], '2026-09-10');
    assert.ok(!r.text.includes('2026-09-20'), 'the private document never moves the sitemap');
    for (const p of ['/api/', '/internal/', '/?', 'openvibe.wiki']) assert.ok(!r.text.includes(p), `no ${p}`);
});

t('GET /llms-full.txt: text/plain, the public routes and JSON endpoints, one line each, nothing private', async () => {
    const r = await request(svc.base, 'GET', '/llms-full.txt');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/plain/);
    assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=3600, stale-while-revalidate=3600');
    // Every public route and public JSON endpoint is named.
    for (const p of ['/', '/updates', '/robots.txt', '/sitemap.xml', '/llms.txt', '/llms-full.txt',
        '/api/v1/search?q=', '/api/v1/suggest?q=', '/api/health', '/api/ready', '/release.json']) {
        assert.ok(r.text.includes(`${origin()}${p}`), `names ${p}`);
    }
    // One line of text each: every route line carries a description after the URL.
    assert.match(r.text, /URL: \S+\n\n?\S/, 'a one-line description follows each URL');
    // Nothing private or per-user, and never search results or document data.
    assert.ok(!/saved-searches|\/api\/v1\/owners|\/internal\/events|\/api\/v1\/documents/.test(r.text));
    assert.ok(!r.text.includes('crawl-pub') && !r.text.includes('Published page'), 'no document or result data');
});

t('GET /<key>.txt: 404 when INDEXNOW_KEY is unset', async () => {
    const r = await request(svc.base, 'GET', '/no-indexnow-key.txt');
    assert.strictEqual(r.status, 404);
});

t('GET /<key>.txt: the IndexNow key file answers when INDEXNOW_KEY is set', async () => {
    const key = crypto.randomBytes(16).toString('hex');
    const on = await boot({ env: { INDEXNOW_KEY: key } });
    try {
        const r = await request(on.base, 'GET', `/${key}.txt`);
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-type'), /text\/plain/);
        assert.strictEqual(r.text, key);
        // Another path is not the key file.
        const other = await request(on.base, 'GET', '/not-the-key.txt');
        assert.strictEqual(other.status, 404);
    } finally { await on.stop(); }
});

t('the route index is built from routes only: every entry gets a line of text, none is private', async () => {
    const text = llmsFullTxt(origin());
    assert.ok(typeof createApp === 'function', 'the app wires the key file');
    const urls = text.match(/^URL: (.+)$/gm);
    assert.ok(urls && urls.length >= 8, 'the public routes and JSON endpoints are listed');
    // Each route is followed by a non-empty line of text, and nothing private or per-user appears.
    assert.match(text, /URL: \S+\n\n?\S/, 'a one-line description follows each URL');
    assert.ok(!/saved-searches|\/api\/v1\/owners|\/internal\/events|\/api\/v1\/documents/.test(text));
});

t('shutdown', async () => { await svc.stop(); });

t.run();

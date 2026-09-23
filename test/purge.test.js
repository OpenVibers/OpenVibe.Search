'use strict';
/**
 * The removal purge queue (server/purge.js): the owners' removal feed, and the Cloudflare purge
 * of formerly public URLs against a mocked Cloudflare API. No test talks to Cloudflare.
 */
const assert = require('assert');
const { boot, request, serviceToken, doc, suite } = require('./helpers');
const { load } = require('../server/config');
const { zoneFor, purgeUrls, MAX_ATTEMPTS } = require('../server/purge');

const t = suite('purge');
const WIKI = serviceToken('wiki', ['search.document.write']);
const BLOG = serviceToken('blog', ['search.document.write']);
const TOKEN = 'cf-test-token-' + 'z'.repeat(24);
const WIKI_ZONE = 'a'.repeat(32);
const NET_ZONE = 'b'.repeat(32);
const ZONES = `openvibe.wiki=${WIKI_ZONE},openvibe.network=${NET_ZONE}`;

/** A mocked Cloudflare API: records calls, answers with `respond(call)` (default: success). */
function mockCloudflare(respond = () => ({ status: 200, body: { success: true, errors: [], messages: [], result: { id: 'purge-1' } } })) {
    const calls = [];
    const fetchImpl = async (url, opts) => {
        const call = { url, method: opts.method, headers: opts.headers, body: JSON.parse(opts.body) };
        calls.push(call);
        const r = await respond(call);
        if (r instanceof Error) throw r;
        return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body, text: async () => JSON.stringify(r.body) };
    };
    return { calls, fetchImpl };
}

const hide = (d, revision = d.revision + 1) => ({ ...d, revision, visibility: 'private', acl: { subjects: ['usr_01K5ZZZZZZZZZZZZZZZZZZZZZZ'] } });

t('config: zone map parses host=zoneid pairs and refuses malformed ones', () => {
    const c = load({ CLOUDFLARE_ZONE_IDS: ZONES });
    assert.deepStrictEqual(c.purge.zones.map(z => z.host), ['openvibe.network', 'openvibe.wiki']);
    assert.throws(() => load({ CLOUDFLARE_ZONE_IDS: 'openvibe.wiki=nothex' }), /CLOUDFLARE_ZONE_IDS/);
    assert.throws(() => load({ CLOUDFLARE_ZONE_IDS: WIKI_ZONE }), /CLOUDFLARE_ZONE_IDS/);
    assert.strictEqual(load({}).purge.cloudflareToken, '');
    assert.deepStrictEqual(load({ CLOUDFLARE_PURGE_RELATED_PATHS: '/sitemap.xml,/feed.atom,javascript:x' }).purge.relatedPaths, ['/sitemap.xml', '/feed.atom']);
});

t('zoneFor matches the host or a parent domain, longest first; purgeUrls adds related paths', () => {
    const zones = load({ CLOUDFLARE_ZONE_IDS: `${ZONES},docs.openvibe.network=${'c'.repeat(32)}` }).purge.zones;
    assert.strictEqual(zoneFor('https://openvibe.wiki/p/x', zones), WIKI_ZONE);
    assert.strictEqual(zoneFor('https://search.openvibe.network/x', zones), NET_ZONE);
    assert.strictEqual(zoneFor('https://docs.openvibe.network/x', zones), 'c'.repeat(32));
    assert.strictEqual(zoneFor('https://notopenvibe.wiki/x', zones), null, 'a suffix that is not a parent domain');
    assert.strictEqual(zoneFor('ftp://openvibe.wiki/x', zones), null);
    assert.deepStrictEqual(purgeUrls('https://openvibe.wiki/p/x#top', ['/sitemap.xml']), ['https://openvibe.wiki/p/x', 'https://openvibe.wiki/sitemap.xml']);
});

t('inert without CLOUDFLARE_PURGE_TOKEN: removals are recorded for owners, nothing is queued or fetched', async () => {
    const cf = mockCloudflare();
    const svc = await boot({ env: { CLOUDFLARE_ZONE_IDS: ZONES }, fetchImpl: cf.fetchImpl });
    try {
        const d = doc({ id: 'inert1', canonical_url: 'https://openvibe.wiki/p/inert1' });
        svc.store.apply(d);
        svc.store.apply(hide(d));
        assert.deepStrictEqual(svc.purges.cdnCounts(), { pending: 0, purged: 0, failed: 0, skipped: 0 });
        assert.deepStrictEqual(await svc.purger.flush(), { purged: 0, retrying: 0, failed: 0 });
        assert.strictEqual(svc.purger.running(), false);
        assert.strictEqual(cf.calls.length, 0);
        const feed = await request(svc.base, 'GET', '/api/v1/owners/wiki/removals', { token: WIKI });
        assert.strictEqual(feed.status, 200);
        assert.strictEqual(feed.body.removals.length, 1);
        const r = feed.body.removals[0];
        assert.strictEqual(r.id, 'inert1');
        assert.strictEqual(r.reason, 'visibility_changed');
        assert.strictEqual(r.canonical_url, 'https://openvibe.wiki/p/inert1');
        assert.strictEqual(r.previous_exposure, 'public_listed');
        assert.strictEqual(r.exposure, 'restricted');
        // The removal row and the outbox event are the same removal.
        const ev = svc.outbox.all().find(e => e.event_type === 'search.document.removed' && e.payload.id === 'inert1');
        assert.strictEqual(r.event_id, ev.event_id);
        const ready = await request(svc.base, 'GET', '/api/ready');
        assert.match(JSON.stringify(ready.body), /CLOUDFLARE_PURGE_TOKEN unset/);
    } finally { await svc.stop(); }
});

t('owner removal feed: owner token only, own owner only, cursor paging, restricted removals carry no URL', async () => {
    const svc = await boot();
    try {
        const members = doc({ id: 'mem1', visibility: 'members', acl: { groups: ['g1'] } });
        svc.store.apply(members);
        svc.store.remove('wiki', 'page', 'mem1');
        const pub = doc({ id: 'pub2', canonical_url: 'https://openvibe.wiki/p/pub2' });
        svc.store.apply(pub);
        svc.store.remove('wiki', 'page', 'pub2');
        assert.strictEqual((await request(svc.base, 'GET', '/api/v1/owners/wiki/removals')).status, 401);
        assert.strictEqual((await request(svc.base, 'GET', '/api/v1/owners/wiki/removals', { token: BLOG })).status, 403);
        const p1 = await request(svc.base, 'GET', '/api/v1/owners/wiki/removals?limit=1', { token: WIKI });
        assert.deepStrictEqual(p1.body.removals.map(r => [r.id, r.reason, r.canonical_url]), [['mem1', 'deleted', null]]);
        const p2 = await request(svc.base, 'GET', `/api/v1/owners/wiki/removals?after=${p1.body.next_after}`, { token: WIKI });
        assert.deepStrictEqual(p2.body.removals.map(r => [r.id, r.reason, r.canonical_url]), [['pub2', 'deleted', 'https://openvibe.wiki/p/pub2']]);
        const blog = await request(svc.base, 'GET', '/api/v1/owners/blog/removals', { token: BLOG });
        assert.deepStrictEqual(blog.body.removals, []);
    } finally { await svc.stop(); }
});

t('with a token: the formerly public URL and its sitemap are purged in one call per zone', async () => {
    const cf = mockCloudflare();
    const svc = await boot({ env: { CLOUDFLARE_PURGE_TOKEN: TOKEN, CLOUDFLARE_ZONE_IDS: ZONES }, fetchImpl: cf.fetchImpl });
    try {
        const a = doc({ id: 'cf1', canonical_url: 'https://openvibe.wiki/p/cf1' });
        const b = doc({ id: 'cf2', canonical_url: 'https://openvibe.wiki/p/cf2' });
        const c = doc({ owner: 'wiki', id: 'cf3', canonical_url: 'https://docs.openvibe.network/cf3' });
        for (const d of [a, b, c]) svc.store.apply(d);
        svc.store.apply(hide(a));
        svc.store.remove('wiki', 'page', 'cf2');
        svc.store.apply({ ...c, revision: 2, publication_state: 'retracted' });
        // Two removals on openvibe.wiki share one pending sitemap purge.
        assert.deepStrictEqual(svc.purges.cdnCounts(), { pending: 5, purged: 0, failed: 0, skipped: 0 });

        const s = await svc.purger.flush();
        assert.deepStrictEqual(s, { purged: 5, retrying: 0, failed: 0 });
        assert.strictEqual(cf.calls.length, 2);
        const wiki = cf.calls.find(x => x.url.includes(WIKI_ZONE));
        assert.strictEqual(wiki.url, `https://api.cloudflare.com/client/v4/zones/${WIKI_ZONE}/purge_cache`);
        assert.strictEqual(wiki.method, 'POST');
        assert.strictEqual(wiki.headers.Authorization, `Bearer ${TOKEN}`);
        assert.deepStrictEqual(wiki.body.files.sort(), ['https://openvibe.wiki/p/cf1', 'https://openvibe.wiki/p/cf2', 'https://openvibe.wiki/sitemap.xml']);
        const net = cf.calls.find(x => x.url.includes(NET_ZONE));
        assert.deepStrictEqual(net.body.files.sort(), ['https://docs.openvibe.network/cf3', 'https://docs.openvibe.network/sitemap.xml']);

        // Done rows are never sent again; the token is never stored.
        assert.deepStrictEqual(await svc.purger.flush(), { purged: 0, retrying: 0, failed: 0 });
        assert.strictEqual(cf.calls.length, 2);
        const dump = JSON.stringify(svc.db.prepare('SELECT * FROM cdn_purges').all()) + JSON.stringify(svc.db.prepare('SELECT * FROM removals').all());
        assert.ok(!dump.includes(TOKEN));
        assert.strictEqual(svc.purger.running(), true);
    } finally { await svc.stop(); }
});

t('an index change that does not lower exposure, or a URL that was never public, purges nothing', async () => {
    const cf = mockCloudflare();
    const svc = await boot({ env: { CLOUDFLARE_PURGE_TOKEN: TOKEN, CLOUDFLARE_ZONE_IDS: ZONES }, fetchImpl: cf.fetchImpl });
    try {
        const d = doc({ id: 'keep', canonical_url: 'https://openvibe.wiki/p/keep' });
        svc.store.apply(d);
        svc.store.apply({ ...d, revision: 2, title: 'New title' });
        const m = doc({ id: 'mem', visibility: 'members', acl: { groups: ['g'] }, canonical_url: 'https://openvibe.wiki/p/mem' });
        svc.store.apply(m);
        svc.store.remove('wiki', 'page', 'mem');
        assert.deepStrictEqual(svc.purges.cdnCounts(), { pending: 0, purged: 0, failed: 0, skipped: 0 });
        await svc.purger.flush();
        assert.strictEqual(cf.calls.length, 0);
    } finally { await svc.stop(); }
});

t('a host with no configured zone is recorded as skipped, not sent', async () => {
    const cf = mockCloudflare();
    const svc = await boot({ env: { CLOUDFLARE_PURGE_TOKEN: TOKEN, CLOUDFLARE_ZONE_IDS: ZONES }, fetchImpl: cf.fetchImpl });
    try {
        const d = doc({ id: 'elsewhere', canonical_url: 'https://example.org/x' });
        svc.store.apply(d);
        svc.store.remove('wiki', 'page', 'elsewhere');
        assert.deepStrictEqual(svc.purges.cdnCounts(), { pending: 0, purged: 0, failed: 0, skipped: 2 });
        await svc.purger.flush();
        assert.strictEqual(cf.calls.length, 0);
        const row = svc.db.prepare("SELECT detail FROM cdn_purges WHERE url = 'https://example.org/x'").get();
        assert.match(row.detail, /no Cloudflare zone/);
    } finally { await svc.stop(); }
});

t('429, 5xx and network errors back off and retry; after MAX_ATTEMPTS the purge fails', async () => {
    let clock = Date.parse('2026-09-23T12:00:00Z');
    let mode = 'rate';
    const cf = mockCloudflare(() => {
        if (mode === 'rate') return { status: 429, body: { success: false, errors: [{ code: 971, message: 'Please wait and consider throttling your request speed' }] } };
        if (mode === 'down') return new Error('ECONNRESET');
        return { status: 200, body: { success: true, errors: [], result: { id: 'ok' } } };
    });
    const svc = await boot({ env: { CLOUDFLARE_PURGE_TOKEN: TOKEN, CLOUDFLARE_ZONE_IDS: ZONES, CLOUDFLARE_PURGE_RELATED_PATHS: 'none' }, fetchImpl: cf.fetchImpl, now: () => clock });
    try {
        const d = doc({ id: 'retry1', canonical_url: 'https://openvibe.wiki/p/retry1' });
        svc.store.apply(d);
        svc.store.remove('wiki', 'page', 'retry1');
        const n = svc.purges.cdnCounts().pending;
        assert.strictEqual(n, 1, 'related paths off (none)');
        assert.deepStrictEqual(await svc.purger.flush(), { purged: 0, retrying: n, failed: 0 });
        // Not due yet: nothing is sent before the backoff elapses.
        assert.deepStrictEqual(await svc.purger.flush(), { purged: 0, retrying: 0, failed: 0 });
        assert.strictEqual(cf.calls.length, 1);
        clock += 3000;
        mode = 'ok';
        assert.deepStrictEqual(await svc.purger.flush(), { purged: n, retrying: 0, failed: 0 });

        // A URL that never gets through fails after MAX_ATTEMPTS.
        mode = 'down';
        const e = doc({ id: 'retry2', canonical_url: 'https://openvibe.wiki/p/retry2' });
        svc.store.apply(e);
        svc.store.remove('wiki', 'page', 'retry2');
        for (let i = 0; i < MAX_ATTEMPTS; i++) { clock += 2 * 3600 * 1000; await svc.purger.flush(); }
        const rows = svc.db.prepare("SELECT state, attempts, detail FROM cdn_purges WHERE url LIKE '%retry2'").all();
        assert.deepStrictEqual(rows.map(r => [r.state, r.attempts]), [['failed', MAX_ATTEMPTS]]);
        assert.match(rows[0].detail, /gave up after/);
    } finally { await svc.stop(); }
});

t('a refused batch is retried one URL at a time: only the refused URL fails', async () => {
    const cf = mockCloudflare((call) => (call.body.files.some(f => f.includes('refused'))
        ? { status: 400, body: { success: false, errors: [{ code: 1012, message: 'Request must contain one of "purge_everything", "files", "tags", "hosts" or "prefixes"' }] } }
        : { status: 200, body: { success: true, errors: [], result: { id: 'ok' } } }));
    const svc = await boot({ env: { CLOUDFLARE_PURGE_TOKEN: TOKEN, CLOUDFLARE_ZONE_IDS: ZONES, CLOUDFLARE_PURGE_RELATED_PATHS: 'none' }, fetchImpl: cf.fetchImpl });
    try {
        for (const id of ['good1', 'refused', 'good2']) {
            svc.store.apply(doc({ id, canonical_url: `https://openvibe.wiki/p/${id}` }));
            svc.store.remove('wiki', 'page', id);
        }
        const s = await svc.purger.flush();
        assert.deepStrictEqual(s, { purged: 2, retrying: 0, failed: 1 });
        const failed = svc.db.prepare("SELECT url, detail FROM cdn_purges WHERE state = 'failed'").all();
        assert.deepStrictEqual(failed.map(r => r.url), ['https://openvibe.wiki/p/refused']);
        assert.match(failed[0].detail, /HTTP 400 1012/);
    } finally { await svc.stop(); }
});

t('a token Cloudflare rejects (403) fails the purge without retrying forever and never logs the token', async () => {
    const logged = [];
    const cf = mockCloudflare(() => ({ status: 403, body: { success: false, errors: [{ code: 10000, message: `Authentication error for ${TOKEN}` }] } }));
    const svc = await boot({ env: { CLOUDFLARE_PURGE_TOKEN: TOKEN, CLOUDFLARE_ZONE_IDS: ZONES, CLOUDFLARE_PURGE_RELATED_PATHS: 'none' }, fetchImpl: cf.fetchImpl });
    svc.purger.stop();
    const { createPurger } = require('../server/purge');
    const purger = createPurger({ db: svc.db, config: svc.config.purge, fetchImpl: cf.fetchImpl, log: { warn: (m) => logged.push(m), log() {}, error() {} } });
    try {
        svc.store.apply(doc({ id: 'auth1', canonical_url: 'https://openvibe.wiki/p/auth1' }));
        svc.store.remove('wiki', 'page', 'auth1');
        assert.deepStrictEqual(await purger.flush(), { purged: 0, retrying: 0, failed: 1 });
        const row = svc.db.prepare("SELECT state, detail FROM cdn_purges WHERE url LIKE '%auth1'").get();
        assert.strictEqual(row.state, 'failed');
        assert.ok(!row.detail.includes(TOKEN) && row.detail.includes('[token]'));
        assert.ok(logged.length && logged.every(m => !m.includes(TOKEN)));
    } finally { await svc.stop(); }
});

t.run();

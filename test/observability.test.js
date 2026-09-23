'use strict';
// Track O: GET /metrics answers direct loopback callers only, labels requests by route template and
// carries the Search gauges (documents by exposure, full-text entries); /api/ready is 503 when the
// database fails, and a full-text index out of step with the documents degrades it.
const assert = require('assert');
const nodeHttp = require('http');
const { boot, request, serviceToken, doc, suite } = require('./helpers');

const t = suite('observability');
const WIKI = serviceToken('wiki', ['search.document.write']);
let svc;

function get(base, p, headers = {}) {
    return new Promise((resolve, reject) => nodeHttp.get(base + p, { headers }, (res) => {
        let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject));
}
const put = (d) => request(svc.base, 'PUT', `/api/v1/documents/${d.owner}/${d.type}/${d.id}`, { token: WIKI, body: d });

t('boot and index two public documents, one members-only and one noindex', async () => {
    svc = await boot();
    await svc.keyLoaded;
    for (const d of [doc(), doc(), doc({ visibility: 'members', acl: { groups: ['vip'] } }), doc({ indexability: { decision: 'noindex', reasons: ['thin'] } })]) {
        const r = await put(d);
        assert.ok(r.status === 200 || r.status === 201, r.text);
    }
});

t('/api/ready: every check reports; db is the only required one; the index agrees', async () => {
    const r = await request(svc.base, 'GET', '/api/ready');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.status, 'ready');
    assert.strictEqual(r.body.service, 'search');
    assert.deepStrictEqual(Object.keys(r.body.checks), ['db', 'network_jwks', 'index']);
    for (const [name, c] of Object.entries(r.body.checks)) {
        assert.strictEqual(c.status, 'ok', `${name}: ${c.error}`);
        assert.strictEqual(c.required, name === 'db', name);
        assert.strictEqual(typeof c.latency_ms, 'number');
        assert.ok(Date.parse(c.checked_at));
    }
    assert.deepStrictEqual(r.body.checks.index.detail, { indexed: { public: 2, restricted: 1 }, expected: { public: 2, restricted: 1 } });
    assert.strictEqual(r.body.engine, 'sqlite-fts5');
    assert.strictEqual(r.body.documents.total, 4);
});

t('/metrics: 404 through a proxy; route templates and Search gauges direct', async () => {
    const d = doc({ id: 'pg_metricsdoc0001' });
    await put(d);
    await request(svc.base, 'GET', `/api/v1/documents/wiki/page/${d.id}`);
    await request(svc.base, 'GET', '/api/v1/search?q=example');
    for (const hdr of [{ 'X-Forwarded-For': '203.0.113.7' }, { 'X-Real-IP': '203.0.113.7' }, { 'CF-Connecting-IP': '203.0.113.7' }]) {
        const m = await get(svc.base, '/metrics', hdr);
        assert.strictEqual(m.status, 404, JSON.stringify(hdr));
        assert.ok(!m.body.includes('search_documents'));
    }
    const m = await get(svc.base, '/metrics');
    assert.strictEqual(m.status, 200);
    const text = m.body;
    assert.ok(/http_requests_total\{method="PUT",route="\/api\/v1\/documents\/:owner\/:type\/:id",status_class="2xx"\} 5\n/.test(text), 'route template for writes');
    assert.ok(/http_requests_total\{method="GET",route="\/api\/v1\/documents\/:owner\/:type\/:id",status_class="2xx"\} 1\n/.test(text));
    assert.ok(/http_requests_total\{method="GET",route="\/api\/v1\/search",status_class="2xx"\} 1\n/.test(text));
    assert.ok(!/route="[^"]*(pg_metricsdoc0001|example)/.test(text), 'no id or query in any label');
    assert.ok(/\nprocess_resident_memory_bytes \d+\n/.test(text));
    assert.ok(/release_info\{service="search",release="[^"]+"\} 1\n/.test(text));
    assert.ok(/search_documents\{exposure="public_listed"\} 3\n/.test(text));
    assert.ok(/search_documents\{exposure="public_unlisted"\} 1\n/.test(text));
    assert.ok(/search_documents\{exposure="restricted"\} 1\n/.test(text));
    assert.ok(/search_documents\{exposure="none"\} 0\n/.test(text));
    assert.ok(/search_documents_indexed\{index="public"\} 3\n/.test(text));
    assert.ok(/search_documents_indexed\{index="restricted"\} 1\n/.test(text));
    assert.ok(/\nsearch_outbox_pending \d+\n/.test(text));
});

t('a full-text index out of step with the documents degrades /api/ready (still 200)', async () => {
    await svc.stop();
    svc = await boot();                              // fresh: the index check has no cached result
    await put(doc());
    await put(doc());
    svc.db.prepare('DELETE FROM fts_public WHERE rowid = (SELECT MIN(rowid) FROM fts_public)').run();
    const r = await request(svc.base, 'GET', '/api/ready');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.status, 'degraded');
    assert.deepStrictEqual(r.body.degraded, ['index']);
    assert.match(r.body.checks.index.error, /fts_public has 1 entries for 2 public_listed documents/);
});

t('a broken database makes the service unready (503); /metrics still answers', async () => {
    svc.db.close();
    const r = await request(svc.base, 'GET', '/api/ready');
    assert.strictEqual(r.status, 503, r.text);
    assert.strictEqual(r.body.ready, false);
    assert.deepStrictEqual(r.body.failed, ['db']);
    assert.strictEqual(r.body.documents, null);
    const m = await get(svc.base, '/metrics');
    assert.strictEqual(m.status, 200);
    assert.ok(!/search_documents\{/.test(m.body), 'a gauge that cannot be read is left out, not invented');
    try { await svc.stop(); } catch { /* the database is already closed */ }
});

t.run();

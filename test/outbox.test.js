'use strict';
/** SDK outbox wiring: transactional writes, relay, retry, and readiness. */
const assert = require('assert');
const http = require('http');
const { validate } = require('openvibe-contracts');
const { boot, request, serviceToken, doc, suite, outboxEvents } = require('./helpers');

const t = suite('outbox');
const WIKI = serviceToken('wiki', ['search.document.write']);
const relayFetch = (url, opts) => String(url).endsWith('/oauth/token')
    ? Promise.resolve(new Response(JSON.stringify({ access_token: 'relay-token', expires_in: 300 }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    : fetch(url, opts);

async function stubEvents(respond = () => 201) {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            calls.push({ headers: req.headers, body });
            const status = respond(body);
            const list = body.events || [body];
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(status < 300 ? (body.events
                ? { results: list.map((e, i) => ({ event_id: e.event_id, seq: i + 1 })) }
                : { event_id: body.event_id, seq: 1 }) : { code: 'events.bad_request' }));
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

t('events are valid, commit with the document, and roll back with a failed change', async () => {
    const svc = await boot();
    try {
        const d = doc();
        await request(svc.base, 'PUT', `/api/v1/documents/wiki/page/${d.id}`, { token: WIKI, body: d });
        await request(svc.base, 'PUT', `/api/v1/documents/wiki/page/${d.id}`, { token: WIKI, body: { ...d, revision: 0 } });
        await request(svc.base, 'DELETE', `/api/v1/documents/wiki/page/${d.id}?revision=2`, { token: WIKI });
        const all = await outboxEvents(svc.db);
        assert.deepStrictEqual(all.map(e => e.event_type), ['search.document.indexed', 'search.document.removed']);
        for (const e of all) assert.ok(validate('events.event-envelope@1', e).valid);
        assert.strictEqual(all[1].subject.id, `wiki/page/${d.id}`);
        assert.strictEqual(all[1].subject.revision, 2);
        await assert.rejects(svc.db.tx(async () => {
            await svc.outbox.emit({ event_type: 'search.document.indexed', subject: { type: 'document', id: 'wiki/page/rollback', revision: 1 }, actor: { type: 'service', id: 'search' }, priority: 'important', visibility: 'internal', payload: {} });
            throw new Error('rollback');
        }), /rollback/);
        assert.strictEqual((await svc.outbox.status()).pending, 2);
    } finally { await svc.stop(); }
});

t('rows wait while the relay is off', async () => {
    const svc = await boot();
    try {
        await request(svc.base, 'PUT', '/api/v1/documents/wiki/page/waiting', { token: WIKI, body: doc({ id: 'waiting' }) });
        assert.strictEqual((await svc.outbox.status()).enabled, false);
        await svc.outbox.kick();
        assert.strictEqual((await svc.outbox.status()).pending, 1);
    } finally { await svc.stop(); }
});

t('relay posts with a service token and marks rows sent', async () => {
    const events = await stubEvents();
    const svc = await boot({ env: { EVENTS_URL: events.url, OV_OAUTH_CLIENT_SECRET: 'test-secret' }, fetchImpl: relayFetch });
    try {
        const d = doc();
        await request(svc.base, 'PUT', `/api/v1/documents/wiki/page/${d.id}`, { token: WIKI, body: d });
        await request(svc.base, 'DELETE', `/api/v1/documents/wiki/page/${d.id}?revision=2`, { token: WIKI });
        for (let i = 0; i < 5 && (await svc.outbox.status()).pending; i++) await svc.outbox.outbox.flush();
        assert.strictEqual((await svc.outbox.status()).pending, 0);
        assert.deepStrictEqual(events.calls.flatMap(c => c.body.events || [c.body]).map(e => e.event_type).sort(), ['search.document.indexed', 'search.document.removed']);
        assert.ok(events.calls.every(c => c.headers.authorization === 'Bearer relay-token'));
    } finally { await svc.stop(); await events.close(); }
});

t('retryable failures wait and refused envelopes do not block others', async () => {
    let mode = 'down';
    const events = await stubEvents(body => mode === 'down' ? 503 : (body.events || [body]).some(e => e.payload.id === 'poison') ? 422 : 201);
    const svc = await boot({ env: { EVENTS_URL: events.url, OV_OAUTH_CLIENT_SECRET: 'test-secret' }, fetchImpl: relayFetch });
    try {
        await request(svc.base, 'PUT', '/api/v1/documents/wiki/page/poison', { token: WIKI, body: doc({ id: 'poison' }) });
        await request(svc.base, 'PUT', '/api/v1/documents/wiki/page/fine', { token: WIKI, body: doc({ id: 'fine' }) });
        await svc.outbox.outbox.flush();
        assert.strictEqual((await svc.outbox.status()).pending, 2);
        mode = 'up';
        await svc.db.exec('UPDATE service_outbox SET next_attempt_at = 0');
        await svc.outbox.outbox.flush();
        assert.strictEqual((await svc.outbox.status()).pending, 0);
        assert.strictEqual((await svc.outbox.status()).rejected, 1);
    } finally { await svc.stop(); await events.close(); }
});

t('readiness reports the SDK outbox status', async () => {
    const svc = await boot();
    try {
        const r = await request(svc.base, 'GET', '/api/ready');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.outbox.enabled, false);
        assert.strictEqual(r.body.outbox.pending, 0);
        assert.strictEqual(r.body.webhook, 'on');
    } finally { await svc.stop(); }
});

t.run();

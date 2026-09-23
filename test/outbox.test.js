'use strict';
/** Outbox relay: removal events reach OpenVibe.Events, failures back off, refusals do not block. */
const assert = require('assert');
const http = require('http');
const { validate } = require('openvibe-contracts');
const { boot, request, serviceToken, doc, suite } = require('./helpers');

const t = suite('outbox');

/** Stub OpenVibe.Events: records publishes; `respond(body, n)` → status. */
async function stubEvents(respond = () => 201) {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
            calls.push({ headers: req.headers, body });
            const status = respond(body, calls.length);
            res.statusCode = status;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(status < 300 ? { ok: true } : { code: 'events.bad_request' }));
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(() => r())) };
}

const tokenClient = { async authHeaders() { return { Authorization: 'Bearer relay-token' }; }, invalidate() {} };
const WIKI = serviceToken('wiki', ['search.document.write']);

t('outbox envelopes are valid events.event-envelope@1 and are enqueued only with the change', async () => {
    const svc = await boot();
    try {
        const d = doc({ canonical_url: 'https://openvibe.wiki/p/a' });
        await request(svc.base, 'PUT', `/api/v1/documents/wiki/page/${d.id}`, { token: WIKI, body: d });
        await request(svc.base, 'PUT', `/api/v1/documents/wiki/page/${d.id}`, { token: WIKI, body: { ...d, revision: 0 } }); // stale: no event
        await request(svc.base, 'DELETE', `/api/v1/documents/wiki/page/${d.id}?revision=2`, { token: WIKI });
        const all = svc.outbox.all();
        assert.deepStrictEqual(all.map(e => e.event_type), ['search.document.indexed', 'search.document.removed']);
        for (const e of all) assert.ok(validate('events.event-envelope@1', e).valid, JSON.stringify(validate('events.event-envelope@1', e).errors));
        assert.strictEqual(all[1].subject.id, `wiki/page/${d.id}`);
        assert.strictEqual(all[1].subject.revision, 2);
        assert.throws(() => svc.outbox.enqueue({ event_type: 'search.document.indexed', subject: { type: 'document', id: 'x' } }), /inside the transaction/);
    } finally {
        await svc.stop();
    }
});

t('the relay publishes pending events with the service token and marks them sent', async () => {
    const events = await stubEvents();
    const svc = await boot({ env: { EVENTS_URL: events.url }, tokenClient });
    try {
        const d = doc();
        await request(svc.base, 'PUT', `/api/v1/documents/wiki/page/${d.id}`, { token: WIKI, body: d });
        await request(svc.base, 'DELETE', `/api/v1/documents/wiki/page/${d.id}?revision=2`, { token: WIKI });
        // a write kicks the relay; a flush already in flight may predate the second row
        for (let i = 0; i < 5 && svc.outbox.pending(); i++) await svc.relay.flush();
        assert.strictEqual(svc.outbox.pending(), 0);
        const published = events.calls.flatMap(c => (c.body.events ? c.body.events : [c.body]));
        assert.deepStrictEqual(published.map(e => e.event_type).sort(), ['search.document.indexed', 'search.document.removed']);
        assert.ok(events.calls.every(c => c.headers.authorization === 'Bearer relay-token'));
    } finally {
        await svc.stop();
        await events.close();
    }
});

t('an unreachable or failing Events keeps rows pending for retry; a refused row does not block the rest', async () => {
    let mode = 'down';
    const events = await stubEvents((body) => {
        if (mode === 'down') return 503;
        const list = body.events || [body];
        return list.some(e => e.payload && e.payload.id === 'poison') ? 422 : 201;
    });
    const svc = await boot({ env: { EVENTS_URL: events.url }, tokenClient });
    try {
        await request(svc.base, 'PUT', '/api/v1/documents/wiki/page/poison', { token: WIKI, body: doc({ id: 'poison' }) });
        await request(svc.base, 'PUT', '/api/v1/documents/wiki/page/fine', { token: WIKI, body: doc({ id: 'fine' }) });
        await svc.relay.flush();
        await svc.relay.flush();
        assert.strictEqual(svc.outbox.pending(), 2, 'kept for retry');
        mode = 'up';
        svc.db.prepare('UPDATE event_outbox SET next_attempt_at = 0').run();
        await svc.relay.flush();
        await svc.relay.flush();
        assert.strictEqual(svc.outbox.pending(), 0);
        assert.strictEqual(svc.outbox.rejected(), 1, 'the poison row is set aside');
    } finally {
        await svc.stop();
        await events.close();
    }
});

t('readiness reports the outbox and the webhook state', async () => {
    const svc = await boot();
    try {
        const r = await request(svc.base, 'GET', '/api/ready');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.engine, 'sqlite-fts5');
        assert.match(r.body.outbox.relay, /^off/);
        assert.strictEqual(r.body.webhook, 'on');
    } finally {
        await svc.stop();
    }
});

t.run();

'use strict';
/** Migration from the legacy outbox to the SDK table, including delivery of a copied row. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ids, validate } = require('openvibe-contracts');
const { createDb } = require('openvibe-sdk/db');
const { createServiceOutbox } = require('openvibe-sdk/events');
const { load } = require('../server/config');
const { start } = require('../server/index');
const { testDb } = require('./db');
const { suite, doc, outboxEvents } = require('./helpers');

const t = suite('outbox-migration');

t('service writes valid SDK outbox rows in the document transaction', async () => {
    const testdb = await testDb();
    const config = load({ NODE_ENV: 'test', SEARCH_EVENTS_SECRET: 'whsec_test_' + 'x'.repeat(40) });
    const svc = await start({ config, db: testdb.db, listen: false, log: { log() {}, warn() {}, error() {} }, fetchImpl: async () => ({ ok: true, json: async () => ({ keys: [] }) }) });
    try {
        const d = doc();
        await svc.store.apply(d);
        const all = await outboxEvents(svc.db);
        assert.strictEqual(all.length, 1);
        assert.strictEqual(all[0].event_type, 'search.document.indexed');
        assert.ok(validate('events.event-envelope@1', all[0]).valid);
        await assert.rejects(svc.db.tx(async () => {
            await svc.store.apply(doc({ id: 'rollback' }));
            throw new Error('rollback');
        }), /rollback/);
        assert.strictEqual((await outboxEvents(svc.db)).length, 1);
        assert.strictEqual((await svc.outbox.status()).pending, 1);
    } finally { await svc.close(); await testdb.close(); }
});

t('a legacy pending row copied by the migration is relayed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-outbox-'));
    const first = path.join(dir, 'first');
    fs.mkdirSync(first);
    fs.copyFileSync(path.join(__dirname, '..', 'migrations', '0001_initial.sql'), path.join(first, '0001_initial.sql'));
    const db = createDb({ pglite: true, service: 'search-outbox-test' });
    try {
        await db.migrate({ dir: first });
        const eventId = ids.newId('event');
        const env = { event_id: eventId, event_type: 'search.document.indexed', version: 1, source: 'search', actor: { type: 'service', id: 'search' }, timestamp: new Date().toISOString(), priority: 'important', visibility: 'internal', subject: { type: 'document', id: 'wiki/page/legacy', revision: 1 }, payload: { owner: 'wiki', type: 'page', id: 'legacy', revision: 1, exposure: 'public_listed', reindexed: false, canonical_url: 'https://openvibe.wiki/p/legacy' } };
        assert.ok(validate('events.event-envelope@1', env).valid);
        await db.query('INSERT INTO event_outbox (event_id, event_type, envelope, created_at, attempts, next_attempt_at) VALUES ($1, $2, $3, $4, 2, 0)', [eventId, env.event_type, JSON.stringify(env), Date.now()]);
        await db.migrate({ dir: path.join(__dirname, '..', 'migrations') });
        const calls = [];
        const fetchImpl = async (url, opts) => {
            if (String(url).endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: 'relay-token', expires_in: 300 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            calls.push({ url: String(url), headers: opts.headers, body: JSON.parse(opts.body) });
            return new Response(JSON.stringify({ event_id: eventId, seq: 17 }), { status: 201, headers: { 'Content-Type': 'application/json' } });
        };
        const outbox = createServiceOutbox({ db, source: 'search', table: 'service_outbox', eventsUrl: 'http://events.test', networkInternalUrl: 'http://network.test', clientId: 'search', clientSecret: 'test-secret', fetch: fetchImpl });
        assert.strictEqual((await outbox.status()).pending, 1);
        await outbox.outbox.flush();
        assert.strictEqual((await outbox.status()).pending, 0);
        assert.strictEqual(calls[0].body.event_id, eventId);
        assert.strictEqual(new Headers(calls[0].headers).get('authorization'), 'Bearer relay-token');
        assert.strictEqual(await db.value('SELECT attempts FROM service_outbox WHERE event_id = $1', [eventId]), 3);
    } finally { await db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

t.run();

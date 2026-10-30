'use strict';
/**
 * ADR-033: Search's part of an account export and deletion, through the signed POST /internal/events route with a
 * stand-in Network. Ada's saved searches are exported and erased; Bo's stay; the index rows (keyed by their publishing
 * owner, not a person) are untouched. The guard fails when a new table with a person column is neither covered nor
 * exempted with a reason.
 */
const assert = require('assert');
const http = require('http');
const { uncovered } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, suite } = require('./helpers');
const { TABLES } = require('../server/account-data');

const t = suite('account-data');
const SECRET = `whsec_${'fixture'.repeat(6)}`;
const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';
const EXP = 'exp_01JZ0000000000000000000EXP';
const DEL = 'del_01JZ0000000000000000000DEX';

async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_search', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

const ev = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), payload });
const body = (event) => JSON.stringify({ event, seq: 1 });

t('every table that names a person is covered or exempted with a reason', async () => {
    const stub = await startNetworkStub();
    const h = await boot({ env: { SEARCH_EVENTS_SECRET: SECRET, OV_NETWORK_INTERNAL_URL: stub.url, OV_OAUTH_CLIENT_SECRET: 'search-secret' } });
    try {
        const missing = await uncovered(h.db, {
            tables: TABLES,
            exempt: {
                account_data_events: 'the ledger of requests itself: which export and deletion Search applied',
                documents: 'the index is keyed by the publishing owner (a service), not a person',
                ingest_rejections: 'the index intake is keyed by the publishing owner, not a person',
                removals: 'the index removals are keyed by the publishing owner, not a person',
                search_embeddings: 'the embeddings belong to an indexed document, not a person',
            },
        });
        assert.deepStrictEqual(missing, [], `a table with a person column is neither covered nor exempted: ${missing.join(', ')}`);
    } finally { await h.stop(); await stub.close(); }
});

t('an export carries the person\'s saved searches; a deletion erases them and confirms once', async () => {
    const stub = await startNetworkStub();
    const h = await boot({ env: { SEARCH_EVENTS_SECRET: SECRET, OV_NETWORK_INTERNAL_URL: stub.url, OV_OAUTH_CLIENT_SECRET: 'search-secret' } });
    try {
        for (const [subject, name] of [[A, 'ada'], [B, 'bo']]) {
            await h.db.exec("INSERT INTO saved_searches (id, subject, name, q, filters, query_hash, created_at, updated_at) VALUES ($1, $2, $3, 'x', '{}', $4, 1, 1)",
                [`svs_${name}`, subject, `search-${name}`, `h-${name}`]);
        }
        const deliver = async (event) => {
            const raw = body(event);
            const res = await fetch(`${h.base}/internal/events`, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(raw, SECRET) } });
            return { status: res.status, json: await res.json().catch(() => null) };
        };

        const r = await deliver(ev('evt_01JZ0000000000000000000E01', 'network.account.export_requested', { export_id: EXP, subject: A }));
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert.strictEqual(r.json.outcome, 'exported');
        const part = stub.calls.find((c) => c.url === `/internal/account-exports/${EXP}/parts`);
        assert.ok(part, 'the part was pushed to Network');
        const file = part.body.files.find((f) => f.name === 'saved-searches.json');
        assert.ok(file, 'saved-searches.json is in the part');
        assert.deepStrictEqual(file.content.map((x) => x.name), ['search-ada']);

        const d = await deliver(ev('evt_01JZ0000000000000000000D01', 'network.account.deleted', { deletion_id: DEL, subject: A, aliases: [] }));
        assert.strictEqual(d.status, 200, JSON.stringify(d.json));
        assert.strictEqual(d.json.outcome, 'erased');
        assert.strictEqual(Number(await h.db.value('SELECT count(*)::int FROM saved_searches WHERE subject = $1', [A])), 0);
        assert.strictEqual(Number(await h.db.value('SELECT count(*)::int FROM saved_searches WHERE subject = $1', [B])), 1);
        const confirmation = stub.calls.find((c) => c.url === `/internal/account-deletions/${DEL}/confirmations`);
        assert.ok(confirmation, 'the confirmation was sent');
        assert.strictEqual(confirmation.body.erased.saved_searches, 1);
    } finally { await h.stop(); await stub.close(); }
});

t.run();

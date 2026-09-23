'use strict';
/**
 * Shared test fixtures: a generated Network signing key, service/user token minting, a booted
 * Search service on a random port with a temp database, index-document builders and a signed
 * Events delivery helper. Nothing here needs the network or a running OpenVibe.Network.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { serviceAuth, ids } = require('openvibe-contracts');
const { load } = require('../server/config');
const { start } = require('../server/index');
const { sign, signV2 } = require('../server/api/webhook');

const ISSUER = 'https://openvibe.network';
const WEBHOOK_SECRET = 'whsec_test_' + 'x'.repeat(40);
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const silent = { log() {}, warn() {}, error(...a) { if (process.env.DEBUG) console.error(...a); } };

function serviceToken(slug, cap, { aud = 'openvibe.search', exp = Math.floor(Date.now() / 1000) + 300, iss = ISSUER, key = privateKey, sub } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({
        iss, sub: sub || `svc:${slug}`, actor_type: 'service', aud: [aud], cap, ns: [], iat: now, exp,
        jti: `tok_${crypto.randomBytes(8).toString('hex')}`,
    }, key);
}

function userToken({ subjectId = ids.newId('user'), role = 'user', aud = ['openvibe.live', 'openvibe.network'], exp = Math.floor(Date.now() / 1000) + 3600, key = privateKey, iss = ISSUER } = {}) {
    return serviceAuth.signServiceToken({
        sub: 57, id: 57, subject_id: subjectId, username: 'viewer', role, iss, aud, iat: Math.floor(Date.now() / 1000), exp,
    }, key);
}

const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function tmpDir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-search-test-'));
    made.push(d);
    return d;
}

async function boot({ env = {}, fetchImpl, tokenClient, now } = {}) {
    const dir = tmpDir();
    const config = load({
        NODE_ENV: 'test',
        PORT: '0',
        SEARCH_DB_PATH: path.join(dir, 'search.db'),
        OV_NETWORK_PUBLIC_KEY: publicKey,
        SEARCH_EVENTS_SECRET: WEBHOOK_SECRET,
        ...env,
    });
    const h = await start({ config, log: silent, fetchImpl, tokenClient, now });
    const base = `http://127.0.0.1:${h.server.address().port}`;
    return { ...h, base, dir, async stop() { await h.close(); } };
}

async function request(base, method, p, { token, body, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, text, headers: res.headers };
}

/** A valid, public, published, indexable document. Override anything. */
function doc(overrides = {}) {
    return {
        owner: 'wiki',
        type: 'page',
        id: 'pg_' + crypto.randomBytes(6).toString('hex'),
        revision: 1,
        visibility: 'public',
        acl: {},
        canonical_url: 'https://openvibe.wiki/p/example',
        title: 'Example page',
        summary: 'A short summary.',
        body: 'Body text.',
        facets: { category: 'guides', tags: ['alpha', 'beta'] },
        language: 'en',
        authorship: 'human',
        provenance: [],
        publication_state: 'published',
        published_at: '2026-09-01T10:00:00Z',
        updated_at: '2026-09-02T10:00:00Z',
        indexability: { decision: 'index', reasons: [] },
        ...overrides,
    };
}

/** A delivered Events envelope carrying an index document. */
function indexEvent(document, { action = 'upserted', source = document.owner, eventId = ids.newId('event'), subject, eventType } = {}) {
    const payload = action === 'deleted' ? { type: document.type, id: document.id, revision: document.revision } : { ...document };
    return {
        event_id: eventId,
        event_type: eventType || `${source}.index_document.${action}`,
        version: 1,
        source,
        actor: { type: 'service', id: source },
        timestamp: new Date().toISOString(),
        visibility: 'internal',
        subject: subject || { type: document.type, id: document.id, revision: document.revision },
        payload,
    };
}

/**
 * POST a signed delivery to /internal/events with the three signature headers Events sends.
 * `v1Only` drops the v2 headers; `now` (ms) backdates the v2 timestamp.
 */
async function deliver(base, event, { secret = WEBHOOK_SECRET, seq = 1, badSignature = false, v1Only = false, now = Date.now() } = {}) {
    const raw = JSON.stringify({ event, seq });
    const key = badSignature ? 'wrong-secret-' + 'y'.repeat(32) : secret;
    const ts = Math.floor(now / 1000);
    const v2 = v1Only ? {} : { 'X-OpenVibe-Timestamp': String(ts), 'X-OpenVibe-Signature-V2': signV2(raw, key, ts) };
    return request(base, 'POST', '/internal/events', {
        raw,
        headers: { 'Content-Type': 'application/json', 'X-OpenVibe-Signature': sign(raw, key), ...v2, 'X-OpenVibe-Event-Id': event.event_id },
    });
}

function suite(name) {
    const tests = [];
    const t = (n, fn) => tests.push([n, fn]);
    t.run = async () => {
        let failed = 0;
        for (const [n, fn] of tests) {
            try { await fn(); console.log(`  ok   ${n}`); } catch (err) { failed++; console.log(`  FAIL ${n}\n${err.stack}`); }
        }
        console.log(`${name}: ${tests.length - failed}/${tests.length} passed`);
        if (failed) process.exit(1);
    };
    return t;
}

module.exports = {
    ISSUER, WEBHOOK_SECRET, privateKey, publicKey, silent, serviceToken, userToken, tmpDir, boot, request,
    doc, indexEvent, deliver, suite,
};

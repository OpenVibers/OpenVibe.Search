'use strict';
/**
 * Track O: truthful readiness for GET /api/ready and the Search gauges on GET /metrics
 * (openvibe-shared/ready and openvibe-shared/metrics).
 *
 *   db            required  a real read of the documents table and of both full-text tables (they
 *                           live in the same SQLite file): without them nothing can be indexed or found
 *   network_jwks  optional  the Network signing key has loaded. Without it anonymous queries still
 *                           answer (public documents only), but no token can be verified: owner
 *                           writes and signed-in queries fail, so it degrades rather than fails
 *   index         optional  the full-text index agrees with the documents table: fts_public holds
 *                           exactly the public_listed documents and fts_restricted the restricted
 *                           ones. A mismatch means queries miss (or would surface) documents
 *
 * Gauges: documents by exposure, full-text entries by table, and the events outbox backlog.
 */
const { createReadiness } = require('openvibe-shared/ready');
const { EXPOSURE } = require('./document');

const EXPOSURE_NAMES = Object.fromEntries(Object.entries(EXPOSURE).map(([name, n]) => [n, name]));

function readers(db) {
    const byExposure = db.prepare('SELECT exposure, COUNT(*) AS n FROM documents GROUP BY exposure');
    const ftsPublic = db.prepare('SELECT COUNT(*) AS n FROM fts_public');
    const ftsRestricted = db.prepare('SELECT COUNT(*) AS n FROM fts_restricted');
    return {
        /** { none, restricted, public_unlisted, public_listed }, every exposure present (0 when empty). */
        documents() {
            const out = Object.fromEntries(Object.keys(EXPOSURE).map((k) => [k, 0]));
            for (const r of byExposure.all()) out[EXPOSURE_NAMES[r.exposure] || 'none'] += r.n;
            return out;
        },
        indexed: () => ({ public: ftsPublic.get().n, restricted: ftsRestricted.get().n }),
    };
}

function createSearchReadiness({ db, keys, config, engine, store, outbox, relay, release = null }) {
    const read = readers(db);
    return createReadiness({
        service: 'search',
        release,
        checks: [
            {
                name: 'db', required: true,
                check: () => {
                    db.prepare('SELECT rid FROM documents LIMIT 1').all();
                    db.prepare('SELECT rowid FROM fts_public LIMIT 1').all();
                    db.prepare('SELECT rowid FROM fts_restricted LIMIT 1').all();
                    return true;
                },
            },
            { name: 'network_jwks', required: false, check: () => keys.loaded() || 'Network signing key not loaded yet: owner writes and signed-in queries cannot be verified' },
            {
                name: 'index', required: false, cacheMs: 10_000,
                check: () => {
                    const docs = read.documents();
                    const fts = read.indexed();
                    const detail = { indexed: fts, expected: { public: docs.public_listed, restricted: docs.restricted } };
                    const off = [];
                    if (fts.public !== docs.public_listed) off.push(`fts_public has ${fts.public} entries for ${docs.public_listed} public_listed documents`);
                    if (fts.restricted !== docs.restricted) off.push(`fts_restricted has ${fts.restricted} entries for ${docs.restricted} restricted documents`);
                    return off.length ? { ok: false, error: `index out of step: ${off.join('; ')}`, detail } : { ok: true, detail };
                },
            },
        ],
        details: (body) => {
            const dbOk = body.checks.db.status === 'ok';
            return {
                engine: engine.name,
                documents: dbOk ? store.counts() : null,
                outbox: dbOk ? { pending: outbox.pending(), rejected: outbox.rejected(), relay: config.events.url ? (relay.running() ? 'running' : 'stopped') : 'off (EVENTS_URL unset)' } : null,
                webhook: config.events.webhookSecrets.length ? 'on' : 'off (SEARCH_EVENTS_SECRET unset)',
            };
        },
    });
}

/** Search gauges on the openvibe-shared/metrics registry. */
function registerSearchGauges(registry, { db, outbox }) {
    const read = readers(db);
    registry.gauge({
        name: 'search_documents', help: 'Documents held, by exposure (public_listed and restricted are searchable; tombstones and drafts are none)', labelNames: ['exposure'],
        collect: () => Object.entries(read.documents()).map(([exposure, value]) => ({ labels: { exposure }, value })),
    });
    registry.gauge({
        name: 'search_documents_indexed', help: 'Documents in the full-text index, by table', labelNames: ['index'],
        collect: () => Object.entries(read.indexed()).map(([index, value]) => ({ labels: { index }, value })),
    });
    registry.gauge({ name: 'search_outbox_pending', help: 'Events waiting in the outbox', collect: () => outbox.pending() });
    registry.gauge({ name: 'search_outbox_rejected', help: 'Events OpenVibe.Events refused for good', collect: () => outbox.rejected() });
}

module.exports = { createSearchReadiness, registerSearchGauges };

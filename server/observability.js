'use strict';
/**
 * Track O: truthful readiness for GET /api/ready and the Search gauges on GET /metrics
 * (openvibe-shared/ready and openvibe-shared/metrics).
 *
 *   db            required  a real read of the documents table and of the full-text table (they
 *                           live in the same database): without them nothing can be indexed or found
 *   network_jwks  optional  the SDK's JWKS client (openvibe-sdk/auth) has keys loaded. Without them
 *                           anonymous queries still answer (public documents only), but no token can
 *                           be verified: owner writes and signed-in queries fail, so it degrades
 *                           rather than fails. Reports each client's keys, staleness, failures and
 *                           next try (never its URL or error) from jwksStatus()
 *   index         optional  the full-text index agrees with the documents table: search_fts holds
 *                           exactly the public_listed and restricted documents. A mismatch means
 *                           queries miss (or would surface) documents
 *
 * Gauges: documents by exposure, full-text entries by audience, and the events outbox backlog.
 */
const { createReadiness } = require('openvibe-shared/ready');
const { jwksStatus } = require('openvibe-sdk/auth');
const { EXPOSURE } = require('./document');

const EXPOSURE_NAMES = Object.fromEntries(Object.entries(EXPOSURE).map(([name, n]) => [n, name]));

function readers(db, engine) {
    const byExposure = db.prepare('SELECT exposure, COUNT(*)::int AS n FROM documents GROUP BY exposure');
    return {
        /** { none, restricted, public_unlisted, public_listed }, every exposure present (0 when empty). */
        async documents() {
            const out = Object.fromEntries(Object.keys(EXPOSURE).map((k) => [k, 0]));
            for (const r of await byExposure.all()) out[EXPOSURE_NAMES[r.exposure] || 'none'] += r.n;
            return out;
        },
        indexed: async () => { const c = await engine.counts(); return { public: c.public_listed, restricted: c.restricted }; },
    };
}

function createSearchReadiness({ db, config, engine, store, outbox, relay, purges = null, purger = null, saved = null, release = null }) {
    const read = readers(db, engine);
    return createReadiness({
        service: 'search',
        release,
        checks: [
            {
                name: 'db', required: true,
                // A real round trip that names the store (postgresql / pglite), and the tables present.
                check: async () => {
                    const r = await db.ready();
                    if (!r.ok) return r.error;
                    await db.prepare('SELECT rid FROM documents LIMIT 1').all();
                    await db.prepare('SELECT rid FROM search_fts LIMIT 1').all();
                    return { ok: true, detail: r.detail };
                },
            },
            {
                name: 'network_jwks', required: false,
                check: () => {
                    const states = jwksStatus();
                    // Public: counts and times only. The JWKS URL is internal and the fetch error names it.
                    const detail = states.map((s) => ({
                        ready: s.ready, keys: s.keys, stale: s.stale, failures: s.failures,
                        next_try_at: s.nextTryAt ? new Date(s.nextTryAt).toISOString() : null,
                    }));
                    if (states.length && states.every((s) => s.ready)) return { ok: true, detail };
                    return { ok: false, error: 'Network signing key not loaded yet: owner writes and signed-in queries cannot be verified', detail };
                },
            },
            {
                name: 'index', required: false, cacheMs: 10_000,
                check: async () => {
                    const docs = await read.documents();
                    const fts = await read.indexed();
                    const detail = { indexed: fts, expected: { public: docs.public_listed, restricted: docs.restricted } };
                    const off = [];
                    if (fts.public !== docs.public_listed) off.push(`the public index has ${fts.public} entries for ${docs.public_listed} public_listed documents`);
                    if (fts.restricted !== docs.restricted) off.push(`the restricted index has ${fts.restricted} entries for ${docs.restricted} restricted documents`);
                    return off.length ? { ok: false, error: `index out of step: ${off.join('; ')}`, detail } : { ok: true, detail };
                },
            },
        ],
        details: async (body) => {
            const dbOk = body.checks.db.status === 'ok';
            return {
                engine: engine.name,
                documents: dbOk ? await store.counts() : null,
                outbox: dbOk ? { pending: await outbox.pending(), rejected: await outbox.rejected(), relay: config.events.url ? (relay.running() ? 'running' : 'stopped') : 'off (EVENTS_URL unset)' } : null,
                webhook: config.events.webhookSecrets.length ? 'on' : 'off (SEARCH_EVENTS_SECRET unset)',
                purge: dbOk && purges ? {
                    cdn: purges.cdnOn() ? (purger && purger.running() ? 'cloudflare' : 'cloudflare (stopped)') : 'off (CLOUDFLARE_PURGE_TOKEN unset)',
                    zones: config.purge.zones.length,
                    ...await purges.cdnCounts(),
                } : null,
                saved_searches: dbOk && saved ? await saved.total() : null,
                freshness: config.freshness,
            };
        },
    });
}

/** Search gauges on the openvibe-shared/metrics registry. */
function registerSearchGauges(registry, { db, engine, outbox, purges = null }) {
    const read = readers(db, engine);
    registry.gauge({
        name: 'search_documents', help: 'Documents held, by exposure (public_listed and restricted are searchable; tombstones and drafts are none)', labelNames: ['exposure'],
        collect: async () => Object.entries(await read.documents()).map(([exposure, value]) => ({ labels: { exposure }, value })),
    });
    registry.gauge({
        name: 'search_documents_indexed', help: 'Documents in the full-text index, by audience', labelNames: ['index'],
        collect: async () => Object.entries(await read.indexed()).map(([index, value]) => ({ labels: { index }, value })),
    });
    registry.gauge({ name: 'search_outbox_pending', help: 'Events waiting in the outbox', collect: async () => await outbox.pending() });
    registry.gauge({ name: 'search_outbox_rejected', help: 'Events OpenVibe.Events refused for good', collect: async () => await outbox.rejected() });
    if (purges) {
        registry.gauge({
            name: 'search_cdn_purges', help: 'Cloudflare cache purges of removed documents, by state', labelNames: ['state'],
            collect: async () => Object.entries(await purges.cdnCounts()).map(([state, value]) => ({ labels: { state }, value })),
        });
    }
}

module.exports = { createSearchReadiness, registerSearchGauges };

'use strict';
/**
 * OpenVibe.Search entry point.
 *
 *   node server/index.js            (systemd: openvibe-search.service)
 *
 * start() is also what the tests use: it takes a config (server/config.js load()) plus injectable
 * clock/fetch/log, and returns handles to every part.
 */
const { load } = require('./config');
const { openDb } = require('./db');
const { createEngine } = require('./engine/pg');
const { createStore } = require('./store');
const { createServiceOutbox } = require('openvibe-sdk/events');
const contracts = require('openvibe-contracts');
const { jwksClient } = require('openvibe-sdk/auth');
const { gracefulStop } = require('openvibe-sdk/service');
const { createAuth } = require('./auth');
const { createPurgeQueue, createPurger } = require('./purge');
const { createSavedSearches } = require('./saved');
const { createSearcher } = require('./api/query');
const { createNetworkPush } = require('./network-push');
const { createSavedNotifier } = require('./saved-notifier');
const { createApp } = require('./app');

async function start({ config, db: givenDb = null, now = () => Date.now(), fetchImpl = globalThis.fetch, networkPush = null, log = console, listen = true } = {}) {
    config = config || load();
    // PostgreSQL (ADR-035): opened and migrated here unless the caller (a test) hands in a migrated handle.
    const db = givenDb || await openDb(config, { log });
    const engine = createEngine(db, { freshness: config.freshness });
    // The index is derived from documents: rebuilt at boot when it disagrees with the documents table.
    const rebuilt = await engine.reconcile();
    if (rebuilt.rebuilt) log.log(`[search] full-text index rebuilt: ${rebuilt.rebuilt} document(s)`);
    const outbox = createServiceOutbox({
        db, source: config.serviceId, eventsUrl: config.events.url, networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        intervalMs: config.events.relayIntervalMs, log, table: 'service_outbox', now, fetch: fetchImpl,
        eventTypes: ['search.document.indexed', 'search.document.removed'],
        validate: (env) => contracts.validate('events.event-envelope@1', env),
    });
    const purges = createPurgeQueue(db, { config: config.purge, now });
    const purger = createPurger({ db, config: config.purge, fetchImpl, log, now });
    const saved = createSavedSearches(db, { maxPerSubject: config.savedSearches.maxPerSubject, now });
    const store = createStore({ db, engine, outbox, purges, now });
    // Identity keys: the SDK keeps one JWKS client per URL (openvibe-sdk/auth). It serves the last good
    // keys through an outage, refetches at once for an unknown kid (a rotation) and backs off on failure.
    const jwksUrl = `${config.networkInternalUrl}/api/.well-known/jwks`;
    const jwks = jwksClient(jwksUrl, { log, fetch: fetchImpl });
    const auth = createAuth({ config, jwks, log });
    const searcher = createSearcher({ config, store, engine, now });
    // Saved-search notifications through Network: off unless SEARCH_SAVED_NOTIFY=1 with the `search` client's secret.
    const notifier = createSavedNotifier({
        config, saved, searcher, now, log,
        network: networkPush || createNetworkPush({ config, fetchImpl }),
    });
    const app = createApp({ config, db, store, engine, auth, outbox, purges, purger, saved, searcher, notifier, log, now });

    // The background refresher is not started under the test runtime (the tests stub the fetch and load
    // the keys once below); a real boot refreshes on an unref'd timer. keyLoaded settles the first load.
    if (config.nodeEnv !== 'test') jwks.start();
    const keyLoaded = jwks.keys().catch(() => null);
    outbox.start();
    purger.start();
    notifier.start();
    const pruneTimer = setInterval(async () => { try { await outbox.outbox.prune(); } catch (err) { log.error(`[outbox] prune: ${err.message}`); } }, 6 * 3600 * 1000);
    pruneTimer.unref?.();

    let server = null;
    if (listen) {
        server = await new Promise((resolve, reject) => {
            const s = app.listen(config.port, config.host, () => resolve(s));
            s.on('error', reject);
        });
        log.log(`[search] listening on http://${config.host}:${server.address().port} (engine ${engine.name})`);
    }

    async function close() {
        clearInterval(pruneTimer);
        jwks.stop();
        await outbox.stop();
        await purger.stop();
        await notifier.stop();
        if (server) {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(() => resolve()));
        }
        if (!givenDb) await db.close();
    }

    return { config, db, engine, store, outbox, purges, purger, saved, searcher, notifier, jwks, keyLoaded, auth, app, server, close };
}

if (require.main === module) {
    require('dotenv').config();
    start().then((handles) => {
        // SIGTERM/SIGINT (openvibe-sdk/service, docs/service.md's handles family): requests in flight get 8 s,
        // then handles.close() (the prune timer and JWKS refresher stopped, the relay, purger and saved-search
        // notifier stopped, the server closed, the database closed; a rejection exits 1); past 10 s the process exits 1.
        gracefulStop({ name: 'search', server: handles.server, handles, drainMs: 8000, deadlineMs: 10000 });
    }).catch((err) => {
        console.error(`[search] failed to start: ${err.stack || err}`);
        process.exit(1);
    });
}

module.exports = { start };

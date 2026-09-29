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
const { createOutbox, createRelay } = require('./events/outbox');
const { jwksClient } = require('openvibe-sdk/auth');
const { createAuth } = require('./auth');
const { createPurgeQueue, createPurger } = require('./purge');
const { createSavedSearches } = require('./saved');
const { createApp } = require('./app');

async function start({ config, db: givenDb = null, now = () => Date.now(), fetchImpl = globalThis.fetch, tokenClient, log = console, listen = true } = {}) {
    config = config || load();
    // PostgreSQL (ADR-035): opened and migrated here unless the caller (a test) hands in a migrated handle.
    const db = givenDb || await openDb(config, { log });
    const engine = createEngine(db, { freshness: config.freshness });
    // The index is derived from documents: rebuilt at boot when it disagrees with the documents table.
    const rebuilt = await engine.reconcile();
    if (rebuilt.rebuilt) log.log(`[search] full-text index rebuilt: ${rebuilt.rebuilt} document(s)`);
    const outbox = createOutbox(db, { source: config.serviceId, now });
    const purges = createPurgeQueue(db, { config: config.purge, now });
    const purger = createPurger({ db, config: config.purge, fetchImpl, log, now });
    const saved = createSavedSearches(db, { maxPerSubject: config.savedSearches.maxPerSubject, now });
    const store = createStore({ db, engine, outbox, purges, now });
    const relay = createRelay({
        db, outbox, eventsUrl: config.events.url, intervalMs: config.events.relayIntervalMs, fetchImpl, log, now,
        tokenClient,
        tokenOpts: config.oauth.clientSecret ? { tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret } : null,
    });
    // Identity keys: the SDK keeps one JWKS client per URL (openvibe-sdk/auth). It serves the last good
    // keys through an outage, refetches at once for an unknown kid (a rotation) and backs off on failure.
    const jwksUrl = `${config.networkInternalUrl}/api/.well-known/jwks`;
    const jwks = jwksClient(jwksUrl, { log, fetch: fetchImpl });
    const auth = createAuth({ config, jwks, log });
    const app = createApp({ config, db, store, engine, auth, outbox, relay, purges, purger, saved, log, now });

    // The background refresher is not started under the test runtime (the tests stub the fetch and load
    // the keys once below); a real boot refreshes on an unref'd timer. keyLoaded settles the first load.
    if (config.nodeEnv !== 'test') jwks.start();
    const keyLoaded = jwks.keys().catch(() => null);
    relay.start();
    purger.start();
    const pruneTimer = setInterval(async () => { try { await outbox.prune(); } catch (err) { log.error(`[outbox] prune: ${err.message}`); } }, 6 * 3600 * 1000);
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
        await relay.stop();
        await purger.stop();
        if (server) {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(() => resolve()));
        }
        if (!givenDb) await db.close();
    }

    return { config, db, engine, store, outbox, relay, purges, purger, saved, jwks, keyLoaded, auth, app, server, close };
}

if (require.main === module) {
    require('dotenv').config();
    start().then((handles) => {
        const shutdown = (sig) => {
            console.log(`[search] ${sig}: shutting down`);
            handles.close().then(() => process.exit(0), () => process.exit(1));
            setTimeout(() => process.exit(1), 10000).unref();
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    }).catch((err) => {
        console.error(`[search] failed to start: ${err.stack || err}`);
        process.exit(1);
    });
}

module.exports = { start };

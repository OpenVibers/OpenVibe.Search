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
const { createEngine } = require('./engine/fts5');
const { createStore } = require('./store');
const { createOutbox, createRelay } = require('./events/outbox');
const { createKeyStore, createAuth } = require('./auth');
const { createApp } = require('./app');

async function start({ config, now = () => Date.now(), fetchImpl = globalThis.fetch, tokenClient, log = console, listen = true } = {}) {
    config = config || load();
    const db = openDb(config.dbPath);
    const engine = createEngine(db);
    const outbox = createOutbox(db, { source: config.serviceId, now });
    const store = createStore({ db, engine, outbox, now });
    const relay = createRelay({
        db, outbox, eventsUrl: config.events.url, intervalMs: config.events.relayIntervalMs, fetchImpl, log, now,
        tokenClient,
        tokenOpts: config.oauth.clientSecret ? { tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret } : null,
    });
    const keys = createKeyStore({ urls: [config.networkInternalUrl, config.networkUrl], pem: config.networkPublicKey, fetchImpl, log });
    const auth = createAuth({ config, keys });
    const app = createApp({ config, db, store, engine, auth, keys, outbox, relay, log, now });

    const keyLoaded = keys.start().catch(() => null);
    relay.start();
    const pruneTimer = setInterval(() => { try { outbox.prune(); } catch (err) { log.error(`[outbox] prune: ${err.message}`); } }, 6 * 3600 * 1000);
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
        keys.stop();
        await relay.stop();
        if (server) {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(() => resolve()));
        }
        db.close();
    }

    return { config, db, engine, store, outbox, relay, keys, keyLoaded, auth, app, server, close };
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

'use strict';
/** Express app: request context, the v1 API, the Events webhook, health/readiness, metrics. */
const path = require('path');
const express = require('express');
const { http } = require('openvibe-contracts');
const { instrument } = require('openvibe-shared/metrics');
const { createRelease } = require('openvibe-shared/release');
const { createSearchReadiness, registerSearchGauges } = require('./observability');
const { documentsRouter } = require('./api/documents');
const { queryRouter } = require('./api/query');
const { webhookRouter } = require('./api/webhook');
const pkg = require('../package.json');

function createApp({ config, db, store, engine, auth, keys, outbox, relay, log = console, now }) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback');
    app.set('query parser', 'extended');
    const release = createRelease({ service: 'search', root: path.join(__dirname, '..') });
    // HTTP golden signals by route template, process metrics, release_info and the Search gauges;
    // GET /metrics answers direct loopback callers only (Track O).
    const metrics = instrument(app, { service: 'search', release: release.release });
    registerSearchGauges(metrics.registry, { db, outbox });
    app.use(http.middleware());
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        next();
    });

    // The webhook reads its raw body itself (the signature covers the exact bytes).
    app.use(webhookRouter({ config, db, store, relay, log, now }));

    app.use('/api', express.json({ limit: config.maxBodyBytes, type: ['application/json', 'application/*+json'] }));

    app.get('/api/health', (_req, res) => {
        res.json({ status: 'ok', service: 'openvibe-search', version: pkg.version });
    });

    // Readiness (openvibe-shared/ready): 503 only when the database (documents and full-text tables)
    // fails; the Network key and index consistency are optional and degrade it (see observability.js).
    const readiness = createSearchReadiness({ db, keys, config, engine, store, outbox, relay, release: release.release });
    app.get('/api/ready', readiness.handler);
    app.get('/release.json', release.handler);

    app.use(documentsRouter({ store, auth, db, relay }));
    app.use(queryRouter({ config, store, engine, auth }));

    app.get('/', (_req, res) => {
        res.type('text/plain').send([
            'OpenVibe.Search: permission-aware search over documents the network\'s services index.',
            '',
            'GET    /api/v1/search?q=&owner=&type=&facet.<key>=&cursor=   query (anonymous: public only)',
            'GET    /api/v1/suggest?q=                                     title suggestions',
            'GET    /api/v1/documents/:owner/:type/:id                     one document the caller may see',
            'PUT    /api/v1/documents/:owner/:type/:id                     index (owner, search.document.write)',
            'DELETE /api/v1/documents/:owner/:type/:id?revision=           tombstone (owner)',
            'GET    /api/v1/owners/:owner/documents                        reconciliation (owner)',
            'POST   /internal/events                                       OpenVibe.Events delivery (signed)',
            'GET    /api/health, /api/ready, /release.json',
            '',
            'Source: https://github.com/OpenVibers/OpenVibe.Search',
            '',
        ].join('\n'));
    });

    app.use((req, res) => http.sendProblem(res, 404, 'search.not_found', { detail: `no route ${req.method} ${req.path}`, ctx: req.ov }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        if (err.type === 'entity.parse.failed') return http.sendProblem(res, 400, 'search.bad_json', { detail: 'request body is not valid JSON', ctx: req.ov });
        if (err.type === 'entity.too.large') return http.sendProblem(res, 413, 'search.too_large', { detail: 'request body too large', ctx: req.ov });
        log.error(`[app] ${req.method} ${req.path}: ${err.stack || err}`);
        if (res.headersSent) return res.end();
        return http.sendProblem(res, 500, 'search.internal', { detail: 'internal error', ctx: req.ov });
    });

    app.locals.metrics = metrics;
    return app;
}

module.exports = { createApp };

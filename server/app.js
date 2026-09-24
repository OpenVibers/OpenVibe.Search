'use strict';
/** Express app: request context, the v1 API, the Events webhook, health/readiness, metrics. */
const path = require('path');
const express = require('express');
const { http } = require('openvibe-contracts');
const { instrument } = require('openvibe-shared/metrics');
const { createRelease } = require('openvibe-shared/release');
const { createSearchReadiness, registerSearchGauges } = require('./observability');
const { documentsRouter } = require('./api/documents');
const { queryRouter, createSearcher } = require('./api/query');
const { savedRouter } = require('./api/saved');
const { pageRouter } = require('./web/page');
const { webhookRouter } = require('./api/webhook');
const pkg = require('../package.json');

function createApp({ config, db, store, engine, auth, keys, outbox, relay, purges, purger, saved, log = console, now }) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback');
    app.set('query parser', 'extended');
    const release = createRelease({ service: 'search', root: path.join(__dirname, '..') });
    // HTTP golden signals by route template, process metrics, release_info and the Search gauges;
    // GET /metrics answers direct loopback callers only (Track O).
    const metrics = instrument(app, { service: 'search', release: release.release });
    registerSearchGauges(metrics.registry, { db, outbox, purges });
    app.use(http.middleware());
    // One W3C trace across services (openvibe-shared/trace): calls made while serving a request carry its traceparent.
    require('openvibe-shared/trace').install(app);
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        next();
    });

    // The webhook reads its raw body itself (the signature covers the exact bytes).
    // This site's own pinned copy of the OpenVibe Frame's browser files (openvibe-shared/serve).
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(webhookRouter({ config, db, store, relay, log, now }));

    app.use('/api', express.json({ limit: config.maxBodyBytes, type: ['application/json', 'application/*+json'] }));

    app.get('/api/health', (_req, res) => {
        res.json({ status: 'ok', service: 'openvibe-search', version: pkg.version });
    });

    // Readiness (openvibe-shared/ready): 503 only when the database (documents and full-text tables)
    // fails; the Network key and index consistency are optional and degrade it (see observability.js).
    const readiness = createSearchReadiness({ db, keys, config, engine, store, outbox, relay, purges, purger, saved, release: release.release });
    app.get('/api/ready', readiness.handler);
    // GET /release.json (ADR-016) and POST /release-metrics (open tabs' update reports into /metrics).
    release.mount(app, { registry: metrics.registry });

    const searcher = createSearcher({ config, store, engine, now });
    app.use(documentsRouter({ store, auth, db, relay, purges }));
    app.use(queryRouter({ config, store, engine, auth, searcher }));
    app.use(savedRouter({ config, saved, searcher, auth }));
    // GET / (HTML search page for browsers, the text route index otherwise) and /robots.txt.
    app.use(pageRouter({ searcher, auth }));

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

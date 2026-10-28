'use strict';
/**
 * Search Fabric routes (capability search.fabric.query):
 *
 *   POST /api/v1/query            search.fabric-request@1 body → search.fabric-result@1
 *   GET  /api/v1/query            the same request in the query string (scopes comma-separated)
 *   GET  /api/v1/query/providers  the web ladder's offers (search.provider-offer@1)
 *
 * GET routes answer any origin (Access-Control-Allow-Origin *): a cross-site browser is anonymous
 * anyway, and the answer it reads is exactly what anonymous gets. POST does not: a browser sends it
 * with its own credentials.
 */
const express = require('express');
const { withViewer, one } = require('./query');

const SEARCH_LIMITS = { minute: 30, hour: 600 };

/** The query string as a search.fabric-request@1 body; identity never comes from here. */
function requestFromQuery(query) {
    const body = { q: one(query.q) === undefined ? '' : String(one(query.q)) };
    const scopes = one(query.scopes);
    if (scopes !== undefined) {
        body.scopes = String(scopes).split(',').map((s) => s.trim()).filter(Boolean);
    }
    for (const key of ['freshness', 'depth', 'cursor']) {
        const value = one(query[key]);
        if (value !== undefined) body[key] = String(value);
    }
    if (one(query.limit) !== undefined) body.limit = parseInt(one(query.limit), 10);
    const filters = {};
    for (const [param, key] of [['owner', 'owner'], ['type', 'type'], ['lang', 'lang'], ['site', 'site']]) {
        const value = one(query[param]);
        if (value !== undefined) filters[key] = String(value);
    }
    if (Object.keys(filters).length) body.filters = filters;
    return body;
}

function fabricRouter({ fabric, auth, limits }) {
    const router = express.Router();
    const guarded = (limit, h) => withViewer(auth, h, limit);
    const search = limits('search.fabric', SEARCH_LIMITS);
    const cors = (_req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); };

    router.post('/api/v1/query', guarded(search, async (req, res) => {
        res.json(await fabric.query(req.body, req.viewer));
    }));

    router.get('/api/v1/query', cors, guarded(search, async (req, res) => {
        res.json(await fabric.query(requestFromQuery(req.query), req.viewer));
    }));

    router.get('/api/v1/query/providers', cors, guarded(limits('search.fabric.providers'), async (_req, res) => {
        res.json({ providers: await fabric.providers() });
    }));

    return router;
}

module.exports = { fabricRouter, requestFromQuery, SEARCH_LIMITS };

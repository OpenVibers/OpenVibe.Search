'use strict';
/**
 * Code search routes.
 *
 *   GET  /api/v1/search/code?q=&lang=&repo=&licence=&limit=&cursor=   public, CORS *, merged sources
 *   POST /api/v1/search/code/deep    { q, lang?, repo?, licence? }    signed in, AI metered
 *   GET  /api/v1/code/sources                                         owner: sources, key names, health
 *   PUT  /api/v1/code/sources/:id    { enabled: true|false }           owner: the console's switch
 *
 * The public route is limited per address or per signed-in person like the other read routes; the
 * deep route is a paid action and gets a much smaller budget. Keys stay in the source modules: this
 * file never reads one, and the owner answer carries the environment variable name only.
 */
const express = require('express');
const { http, ids } = require('openvibe-contracts');
const { withViewer, QueryError, one } = require('./query');

const Q_RE = /^[\s\S]{1,200}$/;
const LANG_RE = /^[A-Za-z0-9+#._ -]{1,40}$/;
const REPO_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const LICENCE_RE = /^[A-Za-z0-9.+-]{1,40}$/;

function bad(detail) {
    return new QueryError('search.bad_query', detail);
}

function parseQuery(input) {
    const q = String(input.q == null ? '' : input.q).replace(/\u0000/g, '').trim();
    if (!q) throw bad('q is required');
    if (!Q_RE.test(q)) throw bad('q is longer than 200 characters');
    const out = { q };
    for (const [key, re] of [['lang', LANG_RE], ['repo', REPO_RE], ['licence', LICENCE_RE]]) {
        const value = input[key];
        if (value === undefined || value === null || value === '') continue;
        const s = String(value).trim();
        if (!re.test(s)) throw bad(`${key} is malformed`);
        out[key] = s;
    }
    if (input.limit !== undefined && input.limit !== null && input.limit !== '') {
        const n = parseInt(input.limit, 10);
        if (!Number.isFinite(n) || n < 1 || n > 50) throw bad('limit must be 1..50');
        out.limit = n;
    }
    if (input.cursor !== undefined && input.cursor !== null && input.cursor !== '') out.cursor = String(input.cursor);
    return out;
}

function codeRouter({ auth, limits, registry, search, deep }) {
    const router = express.Router();
    const guarded = (limit, h) => withViewer(auth, h, limit);
    const publicLimit = limits('search.code', { minute: 30, hour: 600 });
    const deepLimit = limits('search.code.deep', { minute: 6, hour: 60 });

    router.get('/api/v1/search/code', (req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); },
        guarded(publicLimit, async (req, res) => {
            const input = parseQuery({ ...req.query, limit: one(req.query.limit), cursor: one(req.query.cursor), q: one(req.query.q), lang: one(req.query.lang), repo: one(req.query.repo), licence: one(req.query.licence) });
            try {
                res.json(await search.run(input));
            } catch (err) {
                if (err && err.code === 'search.bad_cursor') throw new QueryError(err.code, err.message);
                if (err && err.status) return http.sendProblem(res, err.status, err.code || 'search.code_failed', { detail: err.message, ctx: req.ov });
                throw err;
            }
        }));

    router.post('/api/v1/search/code/deep', guarded(deepLimit, async (req, res, viewer) => {
        if (!viewer || !viewer.subject) return http.sendProblem(res, 401, 'token.missing', { detail: 'sign in for deep code search', ctx: req.ov });
        if (!ids.isSubjectId('user', viewer.subject)) {
            return http.sendProblem(res, 403, 'search.sign_in_required', { detail: 'deep code search belongs to signed-in people', ctx: req.ov });
        }
        const input = parseQuery({ ...(req.body || {}), limit: undefined, cursor: undefined });
        let out;
        try {
            out = await deep.run({ ...input, subject: viewer.subject });
        } catch (err) {
            if (err && err.code === 'search.ai_unavailable') return http.sendProblem(res, 503, err.code, { detail: 'deep code search is not configured', ctx: req.ov });
            if (err && err.code === 'search.ai_failed') return http.sendProblem(res, 502, err.code, { detail: err.message, ctx: req.ov });
            if (err instanceof QueryError) throw err;
            return http.sendProblem(res, 502, 'search.code_failed', { detail: 'deep code search failed', ctx: req.ov });
        }
        res.json(out);
    }));

    // Owner side: the console reads the same list and flips the same switches. A service principal with
    // search.code.sources; a key value is never in the answer, only its environment variable name.
    const owner = auth.requireCap('search.code.sources');
    router.get('/api/v1/code/sources', owner, async (_req, res) => {
        res.json({ sources: registry.list() });
    });
    router.put('/api/v1/code/sources/:id', owner, async (req, res) => {
        const body = req.body || {};
        if (typeof body.enabled !== 'boolean') return http.sendProblem(res, 400, 'search.bad_query', { detail: 'enabled must be a boolean', ctx: req.ov });
        const updated = await registry.setEnabled(req.params.id, body.enabled);
        if (!updated) return http.sendProblem(res, 404, 'search.not_found', { detail: 'no such code source', ctx: req.ov });
        res.json({ source: updated });
    });

    return router;
}

module.exports = { codeRouter, parseQuery };

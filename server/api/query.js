'use strict';
/**
 * Query API. Visibility is decided by the engine SQL for every hit, count and suggestion:
 *
 *   anonymous                  public, published, indexable documents only
 *   user (Network JWT)         + restricted documents whose ACL names its subject (or role:<role>)
 *   service + X-OV-Subject     + the ACL matches of that subject and the groups/entitlements the
 *   (search.query.delegate)      service vouches for
 *
 *   GET /api/v1/search?q=&owner=&type=&lang=&facet.<key>=<value>&facets=<k1,k2>&limit=&cursor=
 *   GET /api/v1/suggest?q=&owner=&type=&limit=
 *   GET /api/v1/documents/:owner/:type/:id       one document by exact id (unlisted: any signed-in
 *                                                subject; public noindex: anyone)
 *
 * Nothing here ever returns an ACL, a draft, an unpublished or deleted document, a total count, or
 * a facet count over documents the viewer cannot see. A document the viewer may not see and a
 * document that does not exist give the same 404.
 */
const crypto = require('crypto');
const express = require('express');
const { http } = require('openvibe-contracts');
const { toMatch, snippetHtml } = require('../engine/fts5');
const { EXPOSURE } = require('../document');
const { AuthError } = require('../auth');
const { OWNER_RE, TYPE_RE, ID_RE } = require('./documents');

const FACET_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const LANG_RE = /^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

class QueryError extends Error {
    constructor(code, detail) { super(detail); this.code = code; }
}

function one(v) {
    return Array.isArray(v) ? v[0] : v;
}

/** Filters from the query string (identity never comes from here). */
function parseFilters(query, config) {
    const filters = { facets: [] };
    const owner = one(query.owner);
    const type = one(query.type);
    const lang = one(query.lang);
    if (owner !== undefined) { if (!OWNER_RE.test(String(owner))) throw new QueryError('search.bad_query', 'owner is malformed'); filters.owner = String(owner); }
    if (type !== undefined) { if (!TYPE_RE.test(String(type))) throw new QueryError('search.bad_query', 'type is malformed'); filters.type = String(type); }
    if (lang !== undefined) { if (!LANG_RE.test(String(lang))) throw new QueryError('search.bad_query', 'lang is malformed'); filters.language = String(lang); }
    for (const [k, v] of Object.entries(query)) {
        if (!k.startsWith('facet.')) continue;
        const key = k.slice(6);
        if (!FACET_KEY_RE.test(key)) throw new QueryError('search.bad_query', `facet key ${key} is malformed`);
        const values = (Array.isArray(v) ? v : [v]).map(String).filter(x => x.length && x.length <= 200).slice(0, 20);
        if (!values.length) continue;
        filters.facets.push([key, values]);
    }
    if (filters.facets.length > config.query.maxFacetFilters) throw new QueryError('search.bad_query', `at most ${config.query.maxFacetFilters} facet filters`);
    return filters;
}

function queryHash(parts) {
    return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 16);
}

function encodeCursor(obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function decodeCursor(s, hash) {
    if (s === undefined || s === '') return null;
    let c;
    try { c = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); } catch { c = null; }
    if (!c || c.h !== hash || !Number.isInteger(c.i)) throw new QueryError('search.bad_cursor', 'cursor does not belong to this query');
    // n: the first page's reference time for freshness, so later pages rank on the same clock.
    if (c.k === 'r' && typeof c.r === 'number') return { rank: c.r, rid: c.i, now: Number.isFinite(c.n) ? c.n : null };
    if (c.k === 't' && typeof c.t === 'string') return { sort_at: c.t, rid: c.i };
    throw new QueryError('search.bad_cursor', 'cursor is malformed');
}

/** What a viewer gets for one document: never the ACL, the hash or the owner's internals. */
function projection(doc, row, snip) {
    const out = {
        owner: doc.owner, type: doc.type, id: doc.id, revision: doc.revision,
        visibility: doc.visibility,
        title: doc.title,
        summary: doc.summary || null,
        canonical_url: doc.canonical_url,
        facets: doc.facets,
        language: doc.language,
        authorship: doc.authorship,
        provenance: doc.provenance,
        published_at: doc.published_at,
        updated_at: doc.updated_at,
        indexable: row.index_decision === 'index',
    };
    if (snip !== undefined) out.snippet_html = snippetHtml(snip);
    return out;
}

/** May this viewer see this stored document by exact id? */
function canView(viewer, row, doc) {
    if (row.deleted || row.exposure === EXPOSURE.none) return false;
    if (row.exposure >= EXPOSURE.public_unlisted) return true;
    if (!viewer.subject) return false;
    const acl = doc.acl || {};
    const subj = (acl.subjects || []).includes(viewer.subject);
    if (doc.visibility === 'private') return subj;
    if (doc.visibility === 'unlisted') return true; // a signed-in subject holding the exact id
    if (doc.visibility === 'members') {
        return subj
            || (acl.groups || []).some(g => (viewer.groups || []).includes(g))
            || (acl.entitlements || []).some(e => (viewer.entitlements || []).includes(e));
    }
    return false;
}

/**
 * One search as a viewer: the query API, saved-search runs and the HTML page all go through here.
 *   run({ text, query, viewer, limit, cursor, facetKeys, now }) → { results, next_cursor, facets? }
 * `query` is the query-string-shaped filter source (owner, type, lang, facet.<key>). Throws
 * QueryError for a malformed request.
 */
function createSearcher({ config, store, engine, now: clock = () => Date.now() }) {
    function run({ text = '', query = {}, filters = null, viewer, limit, cursor, facetKeys = [], now = clock() }) {
        if (text.length > 500) throw new QueryError('search.bad_query', 'q is longer than 500 characters');
        filters = filters || parseFilters(query, config);
        limit = Math.min(Math.max(parseInt(limit, 10) || config.query.defaultLimit, 1), config.query.maxLimit);
        if (facetKeys.length > 5 || facetKeys.some(k => !FACET_KEY_RE.test(k))) throw new QueryError('search.bad_query', 'facets: at most 5 well-formed keys');

        const match = text.trim() ? toMatch(text, { maxTerms: config.query.maxTerms }) : null;
        const hash = queryHash([match, filters]);
        const after = decodeCursor(cursor, hash);
        if (text.trim() && !match) {
            return { results: [], next_cursor: null, ...(facetKeys.length ? { facets: Object.fromEntries(facetKeys.map(k => [k, []])) } : {}) };
        }
        let page;
        let refNow = now;
        if (match) {
            if (after && after.rank === undefined) throw new QueryError('search.bad_cursor', 'cursor does not belong to this query');
            if (after && after.now != null) refNow = after.now;
            page = engine.search({ match, filters, viewer, limit, after, now: refNow });
        } else {
            if (after && after.sort_at === undefined) throw new QueryError('search.bad_cursor', 'cursor does not belong to this query');
            page = engine.browse({ filters, viewer, limit, after });
        }
        const results = [];
        for (const h of page.hits) {
            const found = store.byRid(h.rid);
            // Defence in depth: the engine already filtered; re-check against the stored row.
            if (!found || !canView(viewer, found.row, found.doc)) continue;
            results.push(projection(found.doc, found.row, match ? h.snip : undefined));
        }
        const next = page.next
            ? encodeCursor(match ? { k: 'r', r: page.next.rank, i: page.next.rid, n: refNow, h: hash } : { k: 't', t: page.next.sort_at, i: page.next.rid, h: hash })
            : null;
        const body = { results, next_cursor: next };
        if (facetKeys.length) body.facets = engine.facetCounts({ match, filters, viewer, keys: facetKeys });
        return body;
    }

    return {
        run,
        parseFilters: (query) => parseFilters(query, config),
        hasWords: (text) => toMatch(text, { maxTerms: config.query.maxTerms }) !== null,
    };
}

/** Wraps a handler: resolves the viewer (AuthError → problem), no-store, QueryError → 400. */
function withViewer(auth, handler) {
    return (req, res, next) => {
        const ctx = req.ov;
        let viewer;
        try {
            viewer = auth.viewer(req);
        } catch (err) {
            if (err instanceof AuthError) return http.sendProblem(res, err.status, err.code, { detail: err.message, ctx });
            return next(err);
        }
        // Never cached: a visibility change or deletion must leave results immediately, and a
        // personalised answer must never reach a shared cache.
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Vary', 'Authorization, Cookie, X-OV-Subject, X-OV-Groups, X-OV-Entitlements');
        try {
            return handler(req, res, viewer);
        } catch (err) {
            if (err instanceof QueryError) return http.sendProblem(res, 400, err.code, { detail: err.message, ctx });
            return next(err);
        }
    };
}

function queryRouter({ config, store, engine, auth, searcher = createSearcher({ config, store, engine }) }) {
    const router = express.Router();
    const guarded = (h) => withViewer(auth, h);

    router.get('/api/v1/search', guarded((req, res, viewer) => {
        const q = one(req.query.q);
        res.json(searcher.run({
            text: q === undefined ? '' : String(q),
            query: req.query,
            viewer,
            limit: one(req.query.limit),
            cursor: one(req.query.cursor),
            facetKeys: String(one(req.query.facets) || '').split(',').map(s => s.trim()).filter(Boolean),
        }));
    }));

    router.get('/api/v1/suggest', guarded((req, res, viewer) => {
        const text = String(one(req.query.q) || '');
        if (text.length > 100) throw new QueryError('search.bad_query', 'q is longer than 100 characters');
        const filters = parseFilters(req.query, config);
        const limit = Math.min(Math.max(parseInt(one(req.query.limit), 10) || 8, 1), 20);
        const match = toMatch(text, { maxTerms: 6, column: 'title', prefixLast: true });
        if (!match) return res.json({ suggestions: [] });
        const rows = engine.suggest({ match, filters, viewer, limit });
        const suggestions = [];
        for (const r of rows) {
            const found = store.byRid(r.rid);
            if (!found || !canView(viewer, found.row, found.doc)) continue;
            suggestions.push({ owner: found.doc.owner, type: found.doc.type, id: found.doc.id, title: found.doc.title, canonical_url: found.doc.canonical_url });
        }
        res.json({ suggestions });
    }));

    router.get('/api/v1/documents/:owner/:type/:id', guarded((req, res, viewer) => {
        const { owner, type, id } = req.params;
        if (!OWNER_RE.test(owner) || !TYPE_RE.test(type) || !ID_RE.test(id)) throw new QueryError('search.bad_identity', 'owner, type or id is malformed');
        const found = store.get(owner, type, id);
        if (!found || !canView(viewer, found.row, found.doc)) {
            return http.sendProblem(res, 404, 'search.not_found', { detail: 'no such document', ctx: req.ov });
        }
        res.json({ document: projection(found.doc, found.row) });
    }));

    return router;
}

module.exports = { queryRouter, createSearcher, withViewer, parseFilters, QueryError, canView, projection, toMatch, one };

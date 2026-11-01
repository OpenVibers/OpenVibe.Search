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
 *   GET /api/v1/documents/:owner/:type/:id
 *
 * Search and suggest answer any origin (Access-Control-Allow-Origin *, never with credentials): what another site's
 * page reads is what anonymous reads.       one document by exact id (unlisted: any signed-in
 *                                                subject; public noindex: anyone)
 *
 * Nothing here ever returns an ACL, a draft, an unpublished or deleted document, a total count, or
 * a facet count over documents the viewer cannot see. A document the viewer may not see and a
 * document that does not exist give the same 404.
 */
const crypto = require('crypto');
const express = require('express');
const cache = require('openvibe-shared/cache-policy');
const { http } = require('openvibe-contracts');
const { toMatch, snippetHtml } = require('../engine/pg');
const { EXPOSURE } = require('../document');
const { AuthError } = require('../auth');
const { OWNER_RE, TYPE_RE, ID_RE } = require('./documents');
const { fuseRrf } = require('../fabric/rrf');
const { createQueryEmbeddingCache } = require('../fabric/embed');
const { docTier, isThin, dedupeKey, siteHosts } = require('../ranking');

const FACET_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const LANG_RE = /^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const HYBRID_CANDIDATES = 100;

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
    // f: a hybrid page is an offset into the fused list (the keyword and vector ranks are recomputed for
    // each page, so the fused order is stable; `i` carries the last rid for the shared cursor shape).
    if (c.k === 'f' && Number.isInteger(c.o) && c.o >= 0) return { offset: c.o, rid: c.i, now: Number.isFinite(c.n) ? c.n : null };
    // A keyword page cursor carries the whole sort key: rank, importance, recency, rid.
    if (c.k === 'r' && typeof c.r === 'number' && typeof c.m === 'number' && typeof c.s === 'string') {
        return { rank: c.r, importance: c.m, recency: c.s, rid: c.i, now: Number.isFinite(c.n) ? c.n : null };
    }
    if (c.k === 't' && typeof c.t === 'string') return { sort_at: c.t, rid: c.i };
    throw new QueryError('search.bad_cursor', 'cursor is malformed');
}

/** What a viewer gets for one document: never the ACL, the hash or the owner's internals. */
function projection(doc, row, snip, ranks) {
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
    if (ranks !== undefined) out.ranks = ranks;
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

// ── Deals: a title or category match outranks a description-only one (11-01) ───────────────────
// "mechanical keyboard" ranked Bit Blaster XL as the only deal: its description says "Keyboard + Gamepad Support",
// and a near vector hit (under the 0.30 floor) plus a description keyword hit beat the real product. For the deals
// owner, every result whose title or category names the thing asked for (the query's head noun: a keyboard, not a
// game) comes before one that only matched in its summary or body, and a vector-only hit (no keyword match at all)
// comes last. The order inside each group stays the fused order, so relevance still decides among equals.
const WORD_RE = /[\p{L}\p{N}]+/gu;
function foldedWords(text) {
    return String(text || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().match(WORD_RE) || [];
}
/** "keyboard" carries "keyboards" and the other way round once the shorter word is at least four letters. */
function wordMatches(token, word) {
    return token === word || token.startsWith(word) || (token.length >= 4 && word.startsWith(token));
}
function titleOrCategoryMatch(doc, match) {
    if (!doc || !match || !match.words.length) return false;
    const category = doc.facets && doc.facets.category;
    const text = `${doc.title || ''} ${Array.isArray(category) ? category.join(' ') : (category || '')}`;
    const tokens = foldedWords(text);
    // The head noun is what the person wants ("mechanical keyboard" -> keyboard); a modifier may only be in the
    // description, and that is still a title/category match for the product.
    const head = match.words[match.words.length - 1];
    return tokens.some((t) => wordMatches(t, head));
}
async function dealsOrder(fused, { match, store }) {
    if (!match || !match.words.length) return fused;
    const rows = new Map();
    for (const hit of fused) rows.set(hit.rid, await store.byRid(hit.rid));
    const tierOf = (hit) => {
        const found = rows.get(hit.rid);
        if (found && titleOrCategoryMatch(found.doc, match)) return 0;
        return hit.ranks && hit.ranks.keyword != null ? 1 : 2;
    };
    return fused
        .map((hit, i) => ({ hit, i, tier: tierOf(hit) }))
        .sort((a, b) => a.tier - b.tier || a.i - b.i)
        .map(({ hit }) => ({ ...hit, found: rows.get(hit.rid) }));
}

// ── A plain query's order (11-01) ──────────────────────────────────────────────────────────────
// The keyword engine already ranks with the same tiers (server/engine/pg.js), but a hybrid page is
// the RRF order of two top-100 lists, and a strong vector hit could still lift a summary-only VOD
// above a help article whose title says what was asked. Re-apply the tiers to the fused list, so:
//   - a query naming a site ("openvibe live") puts that site's own records first (site 10);
//   - a title match (3) outranks a summary-only match (2), which outranks a body-only one (1);
//   - a thin username-titled VOD ranks below a real title+summary inside the same tier.
// The fused order is the final tie-break, so relevance still decides among equals.
async function rankOrder(fused, { match, store }) {
    if (!match || !match.words.length) return fused;
    const hosts = siteHosts(match);
    const rows = new Map();
    for (const hit of fused) rows.set(hit.rid, hit.found !== undefined ? hit.found : await store.byRid(hit.rid));
    return fused
        .filter((hit) => rows.get(hit.rid))
        .map((hit, i) => {
            const found = rows.get(hit.rid);
            return { hit, found, i, tier: docTier(found.doc, match, hosts), thin: isThin(found.doc) };
        })
        .sort((a, b) => b.tier - a.tier || (a.thin === b.thin ? 0 : a.thin ? 1 : -1) || a.i - b.i)
        .map(({ hit, found }) => ({ ...hit, found }));
}

/**
 * One search as a viewer: the query API, saved-search runs and the HTML page all go through here.
 *   run({ text, query, viewer, limit, cursor, facetKeys, now, since }) → { results, next_cursor, explain, facets? }
 * `query` is the query-string-shaped filter source (owner, type, lang, facet.<key>). `since` (epoch ms,
 * internal callers only: the saved-search notifier) keeps documents indexed after it; the public
 * API never passes it. Throws QueryError for a malformed request.
 *
 * With a vector store and embeddings configured, a query of at least two characters also ranks the
 * public listed documents by cosine distance (top 100) and fuses that list with the keyword top 100 by
 * reciprocal rank fusion (k = 60). The keyword list still supplies snippets, filters, facet counts and
 * the ACL: the vector list is public-only, and every fused hit is re-checked by canView. When vectors
 * are not available, AI fails or the query is too short, the answer is exactly today's keyword page and
 * `explain` says which reason applied. Keyword paging keeps its rank/importance/recency/rid cursor; a hybrid page carries
 * an offset into the fused list. `ranks` on each hit are 1-based positions in the two lists (null when
 * the hit is absent from one).
 */
function createSearcher({ config, store, engine, vectorStore = null, embeddings = null, now: clock = () => Date.now() }) {
    const queryEmbeddings = embeddings ? createQueryEmbeddingCache({ client: embeddings, now: clock }) : null;

    /** 'no_vectors' when the extension/table or a current-model embedding is missing, else null. */
    async function vectorAvailability() {
        if (!vectorStore || typeof vectorStore.available !== 'function') return 'no_vectors';
        try {
            if (!await vectorStore.available()) return 'no_vectors';
            if (typeof vectorStore.hasEmbeddings === 'function' && !await vectorStore.hasEmbeddings()) return 'no_vectors';
        } catch {
            return 'no_vectors';
        }
        return null;
    }

    /** The ranking this query would get: { ranking: 'hybrid', vector } or { ranking: 'keyword', reason }. */
    async function semanticState(text) {
        const unavailable = await vectorAvailability();
        if (unavailable) return { ranking: 'keyword', reason: unavailable };
        if (String(text).trim().length < 2) return { ranking: 'keyword', reason: 'short_query' };
        if (!queryEmbeddings) return { ranking: 'keyword', reason: 'ai_unavailable' };
        const embedded = await queryEmbeddings.get(text);
        if (!embedded.ok) return { ranking: 'keyword', reason: 'ai_unavailable' };
        if (vectorStore.dim && embedded.vector.length !== vectorStore.dim) return { ranking: 'keyword', reason: 'ai_unavailable' };
        return { ranking: 'hybrid', vector: embedded.vector };
    }

    /** The two top-100 lists and their RRF order; snippets come from the keyword side. */
    async function hybridCandidates({ match, filters, viewer, now, vector }) {
        const [keyword, vectorHits] = await Promise.all([
            engine.search({ match, filters, viewer, limit: HYBRID_CANDIDATES, now }),
            vectorStore.nearest({ vector, filters, viewer, limit: HYBRID_CANDIDATES }),
        ]);
        const snips = new Map(keyword.hits.map((h) => [h.rid, h.snip]));
        // A vector hit counts only when it is near enough to mean something (config.query.vectorMaxDistance); a query
        // with no near document and no keyword hit answers nothing rather than its nearest strangers.
        const floor = config.query.vectorMaxDistance;
        const near = vectorHits.filter((h) => !(Number(h.distance) > floor));
        return fuseRrf(keyword.hits, near).map((h) => ({ ...h, snip: snips.get(h.rid) }));
    }

    async function run({ text = '', query = {}, filters = null, viewer, limit, cursor, facetKeys = [], now = clock(), since = null }) {
        if (text.length > 500) throw new QueryError('search.bad_query', 'q is longer than 500 characters');
        filters = filters || parseFilters(query, config);
        if (since != null) filters = { ...filters, since: Number(since) };
        limit = Math.min(Math.max(parseInt(limit, 10) || config.query.defaultLimit, 1), config.query.maxLimit);
        if (facetKeys.length > 5 || facetKeys.some(k => !FACET_KEY_RE.test(k))) throw new QueryError('search.bad_query', 'facets: at most 5 well-formed keys');

        const trimmed = text.trim();
        const match = trimmed ? toMatch(text, { maxTerms: config.query.maxTerms }) : null;
        const hash = queryHash([match, filters]);
        const after = decodeCursor(cursor, hash);
        if (trimmed && !match) {
            const unavailable = await vectorAvailability();
            return {
                results: [], next_cursor: null,
                explain: { ranking: 'keyword', reason: unavailable || 'short_query' },
                ...(facetKeys.length ? { facets: Object.fromEntries(facetKeys.map(k => [k, []])) } : {}),
            };
        }

        const results = [];
        const seen = new Set();
        let next = null;
        let explain;
        let refNow = now;
        if (match) {
            const state = await semanticState(trimmed);
            if (state.ranking === 'hybrid') {
                if (after && after.offset === undefined) throw new QueryError('search.bad_cursor', 'cursor does not belong to this query');
                if (after && after.now != null) refNow = after.now;
                let fused = await hybridCandidates({ match, filters, viewer, now: refNow, vector: state.vector });
                // A plain query's tiers: site first, then title > summary > body, thin VODs last within a tier.
                fused = await rankOrder(fused, { match, store });
                // Deals: the product the person asked for (its title or category) beats a description-only match.
                if (filters.owner === 'deals') fused = await dealsOrder(fused, { match, store });
                let consumed = after ? after.offset : 0;
                let lastRid = after ? after.rid : null;
                for (let i = consumed; i < fused.length && results.length < limit; i++) {
                    const f = fused[i];
                    consumed = i + 1;
                    lastRid = f.rid;
                    // Defence in depth: the vector store is public-only, the keyword SQL is ACL-aware.
                    const found = f.found !== undefined ? f.found : await store.byRid(f.rid);
                    if (!found || !canView(viewer, found.row, found.doc)) continue;
                    const key = dedupeKey(found.doc);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    results.push(projection(found.doc, found.row, f.snip, f.ranks));
                }
                if (consumed < fused.length) next = encodeCursor({ k: 'f', o: consumed, i: lastRid, n: refNow, h: hash });
                explain = { ranking: 'hybrid' };
            } else {
                if (after && after.rank === undefined) throw new QueryError('search.bad_cursor', 'cursor does not belong to this query');
                if (after && after.now != null) refNow = after.now;
                const page = await engine.search({ match, filters, viewer, limit, after, now: refNow });
                let position = 0;
                for (const h of page.hits) {
                    position++;
                    const found = await store.byRid(h.rid);
                    // Defence in depth: the engine already filtered; re-check against the stored row.
                    if (!found || !canView(viewer, found.row, found.doc)) continue;
                    const key = dedupeKey(found.doc);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    results.push(projection(found.doc, found.row, h.snip, { keyword: position, vector: null }));
                }
                next = page.next ? encodeCursor({ k: 'r', r: page.next.rank, m: page.next.importance, s: page.next.recency, i: page.next.rid, n: refNow, h: hash }) : null;
                explain = { ranking: 'keyword', reason: state.reason };
            }
        } else {
            if (after && after.sort_at === undefined) throw new QueryError('search.bad_cursor', 'cursor does not belong to this query');
            const page = await engine.browse({ filters, viewer, limit, after });
            for (const h of page.hits) {
                const found = await store.byRid(h.rid);
                if (!found || !canView(viewer, found.row, found.doc)) continue;
                results.push(projection(found.doc, found.row));
            }
            next = page.next ? encodeCursor({ k: 't', t: page.next.sort_at, i: page.next.rid, h: hash }) : null;
            const unavailable = await vectorAvailability();
            explain = { ranking: 'keyword', reason: unavailable || 'short_query' };
        }

        const body = { results, next_cursor: next, explain };
        if (facetKeys.length) body.facets = await engine.facetCounts({ match, filters, viewer, keys: facetKeys });
        return body;
    }

    return {
        run,
        parseFilters: (query) => parseFilters(query, config),
        hasWords: (text) => toMatch(text, { maxTerms: config.query.maxTerms }) !== null,
        vectorAvailability,
    };
}

/**
 * Wraps a handler: resolves the viewer (AuthError → problem), no-store, QueryError → 400. With `limit`
 * (a per-actor limit, server/actor-limits.js) the viewer is counted as req.viewer before the handler runs.
 */
function withViewer(auth, handler, limit = null) {
    return async (req, res, next) => {
        const ctx = req.ov;
        let viewer;
        try {
            viewer = await auth.viewer(req);
        } catch (err) {
            if (err instanceof AuthError) return http.sendProblem(res, err.status, err.code, { detail: err.message, ctx });
            return next(err);
        }
        // Never cached: a visibility change or deletion must leave results immediately, and a
        // personalised answer must never reach a shared cache.
        res.setHeader('Cache-Control', cache.htmlHeaders({ private: true }));
        res.setHeader('Vary', 'Authorization, Cookie, X-OV-Subject, X-OV-Groups, X-OV-Entitlements');
        const run = async () => {
            try {
                return await handler(req, res, viewer);
            } catch (err) {
                if (err instanceof QueryError) return http.sendProblem(res, 400, err.code, { detail: err.message, ctx });
                return next(err);
            }
        };
        req.viewer = viewer;
        return limit ? limit(req, res, run) : await run();
    };
}

function queryRouter({ config, store, engine, auth, limits, vectorStore = null, embeddings = null, searcher = createSearcher({ config, store, engine, vectorStore, embeddings }) }) {
    const router = express.Router();
    const guarded = (limit, h) => withViewer(auth, h, limit);

    // Any page may ask search and suggest from the browser (the navbar's search on every OpenVibe site, Shared 4.21, and
    // anyone's own box): Access-Control-Allow-Origin * and nothing more. A browser never sends cookies to a * answer,
    // and a cross-site Authorization header would need a preflight this router does not grant, so what another site's
    // page can read is exactly what anonymous gets: public, published, indexable documents.
    router.get(['/api/v1/search', '/api/v1/suggest'], (req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });

    // Per-actor limits (server/actor-limits.js): queries and document reads take the defaults. Suggest
    // answers a search box as the person types, several requests a second, so it allows 300 a minute.
    router.get('/api/v1/search', guarded(limits('search.query'), async (req, res, viewer) => {
        const q = one(req.query.q);
        res.json(await searcher.run({
            text: q === undefined ? '' : String(q),
            query: req.query,
            viewer,
            limit: one(req.query.limit),
            cursor: one(req.query.cursor),
            facetKeys: String(one(req.query.facets) || '').split(',').map(s => s.trim()).filter(Boolean),
        }));
    }));

    router.get('/api/v1/suggest', guarded(limits('search.suggest', { minute: 300, hour: 6000 }), async (req, res, viewer) => {
        const text = String(one(req.query.q) || '');
        if (text.length > 100) throw new QueryError('search.bad_query', 'q is longer than 100 characters');
        const filters = parseFilters(req.query, config);
        const limit = Math.min(Math.max(parseInt(one(req.query.limit), 10) || 8, 1), 20);
        const match = toMatch(text, { maxTerms: 6, column: 'title', prefixLast: true });
        if (!match) return res.json({ suggestions: [] });
        const rows = await engine.suggest({ match, filters, viewer, limit });
        const suggestions = [];
        for (const r of rows) {
            const found = await store.byRid(r.rid);
            if (!found || !canView(viewer, found.row, found.doc)) continue;
            suggestions.push({ owner: found.doc.owner, type: found.doc.type, id: found.doc.id, title: found.doc.title, canonical_url: found.doc.canonical_url });
        }
        res.json({ suggestions });
    }));

    router.get('/api/v1/documents/:owner/:type/:id', guarded(limits('search.document.read'), async (req, res, viewer) => {
        const { owner, type, id } = req.params;
        if (!OWNER_RE.test(owner) || !TYPE_RE.test(type) || !ID_RE.test(id)) throw new QueryError('search.bad_identity', 'owner, type or id is malformed');
        const found = await store.get(owner, type, id);
        if (!found || !canView(viewer, found.row, found.doc)) {
            return http.sendProblem(res, 404, 'search.not_found', { detail: 'no such document', ctx: req.ov });
        }
        res.json({ document: projection(found.doc, found.row) });
    }));

    return router;
}

module.exports = { queryRouter, createSearcher, withViewer, parseFilters, QueryError, canView, projection, toMatch, one, fuseRrf };

'use strict';
/**
 * Saved searches of the signed-in person (server/saved.js).
 *
 *   GET    /api/v1/saved-searches                    the caller's saved searches, newest first
 *   POST   /api/v1/saved-searches                    { name?, q?, owner?, type?, lang?, facets?: { key: [values] } }
 *                                                    201 new, 200 when the same query was already saved
 *   GET    /api/v1/saved-searches/:id                one
 *   DELETE /api/v1/saved-searches/:id                204
 *   GET    /api/v1/saved-searches/:id/results?limit=&cursor=
 *                                                    runs it now, as the caller (the ACL applies at
 *                                                    run time, never at save time)
 *
 * Who: a Network user JWT carrying a usr_ subject_id (Bearer, or the ov_token cookie), or a
 * first-party service with search.query.delegate acting for X-OV-Subject: usr_… (a product saving
 * for its signed-in visitor). Guests and anonymous callers cannot save. A saved search of another
 * person and a missing one give the same 404. A cookie-authenticated POST/DELETE must come from
 * this origin (Origin header), so another site cannot save or delete in someone's name.
 */
const express = require('express');
const { http, ids } = require('openvibe-contracts');
const { withViewer, QueryError, one } = require('./query');

const NAME_MAX = 100;

function savedRouter({ config, saved, searcher, auth }) {
    const router = express.Router();
    const selfOrigin = (() => { try { return new URL(config.baseUrl).origin; } catch { return null; } })();

    /** The viewer's usr_ subject, or a problem sent (null). */
    function person(req, res, viewer, { write = false } = {}) {
        const ctx = req.ov;
        if (!viewer.subject) {
            http.sendProblem(res, 401, 'token.missing', { detail: 'sign in to use saved searches', ctx });
            return null;
        }
        if (!ids.isSubjectId('user', viewer.subject)) {
            http.sendProblem(res, 403, 'search.sign_in_required', { detail: 'saved searches belong to signed-in people (usr_ subjects), not guests', ctx });
            return null;
        }
        if (write && viewer.via === 'cookie') {
            const origin = req.get('origin');
            if (!origin || origin !== selfOrigin) {
                http.sendProblem(res, 403, 'search.cross_origin', { detail: 'a cookie-authenticated change must come from this origin', ctx });
                return null;
            }
        }
        return viewer.subject;
    }

    const guarded = (h) => withViewer(auth, h);

    router.get('/api/v1/saved-searches', guarded((req, res, viewer) => {
        const subject = person(req, res, viewer);
        if (!subject) return;
        res.json({ saved_searches: saved.list(subject), max: saved.maxPerSubject });
    }));

    router.post('/api/v1/saved-searches', guarded((req, res, viewer) => {
        const ctx = req.ov;
        const subject = person(req, res, viewer, { write: true });
        if (!subject) return;
        const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
        if (!b) return http.sendProblem(res, 400, 'search.bad_saved_search', { detail: 'body must be a JSON object', ctx });
        const q = b.q == null ? '' : b.q;
        const name = b.name == null ? '' : b.name;
        if (typeof q !== 'string' || q.length > 500) throw new QueryError('search.bad_query', 'q must be a string of at most 500 characters');
        if (typeof name !== 'string' || name.trim().length > NAME_MAX) throw new QueryError('search.bad_saved_search', `name must be a string of at most ${NAME_MAX} characters`);
        // The filters take the same shape and checks as the query string of /api/v1/search.
        const query = {};
        for (const k of ['owner', 'type', 'lang']) {
            if (b[k] == null) continue;
            if (typeof b[k] !== 'string') throw new QueryError('search.bad_query', `${k} must be a string`);
            query[k] = b[k];
        }
        if (b.facets != null) {
            if (typeof b.facets !== 'object' || Array.isArray(b.facets)) throw new QueryError('search.bad_query', 'facets must be an object of key → values');
            for (const [k, v] of Object.entries(b.facets)) {
                const values = Array.isArray(v) ? v : [v];
                if (values.some(x => typeof x !== 'string')) throw new QueryError('search.bad_query', `facets.${k} values must be strings`);
                query[`facet.${k}`] = values;
            }
        }
        const filters = searcher.parseFilters(query);
        const hasFilter = filters.owner || filters.type || filters.language || filters.facets.length;
        const text = q.trim();
        if (text && !searcher.hasWords(text)) throw new QueryError('search.bad_query', 'q has no searchable words');
        if (!text && !hasFilter) throw new QueryError('search.bad_saved_search', 'a saved search needs words (q) or at least one filter');
        const r = saved.save(subject, { name: name.trim(), q: text, filters });
        if (r.error === 'limit') return http.sendProblem(res, 409, 'search.saved_search_limit', { detail: `at most ${saved.maxPerSubject} saved searches per person`, ctx });
        res.status(r.created ? 201 : 200).json({ saved_search: r.saved });
    }));

    router.get('/api/v1/saved-searches/:id', guarded((req, res, viewer) => {
        const subject = person(req, res, viewer);
        if (!subject) return;
        const s = saved.get(subject, req.params.id);
        if (!s) return http.sendProblem(res, 404, 'search.not_found', { detail: 'no such saved search', ctx: req.ov });
        res.json({ saved_search: s });
    }));

    router.delete('/api/v1/saved-searches/:id', guarded((req, res, viewer) => {
        const subject = person(req, res, viewer, { write: true });
        if (!subject) return;
        if (!saved.remove(subject, req.params.id)) return http.sendProblem(res, 404, 'search.not_found', { detail: 'no such saved search', ctx: req.ov });
        res.status(204).end();
    }));

    router.get('/api/v1/saved-searches/:id/results', guarded((req, res, viewer) => {
        const subject = person(req, res, viewer);
        if (!subject) return;
        const s = saved.get(subject, req.params.id);
        if (!s) return http.sendProblem(res, 404, 'search.not_found', { detail: 'no such saved search', ctx: req.ov });
        const body = searcher.run({
            text: s.q,
            filters: { ...s.filters, facets: s.filters.facets || [] },
            viewer,
            limit: one(req.query.limit),
            cursor: one(req.query.cursor),
        });
        saved.markRun(s.id);
        res.json({ saved_search: { id: s.id, name: s.name }, ...body });
    }));

    return router;
}

module.exports = { savedRouter };

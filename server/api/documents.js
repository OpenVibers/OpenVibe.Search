'use strict';
/**
 * Owner-side API (service token with search.document.write; a service writes and reads only the
 * documents it owns: svc:wiki → owner "wiki").
 *
 *   PUT    /api/v1/documents/:owner/:type/:id           upsert (search.index-document@1 body)
 *   DELETE /api/v1/documents/:owner/:type/:id?revision=  tombstone
 *   GET    /api/v1/owners/:owner/documents?type=&after=&limit=
 *                                                        reconciliation: (type, id, revision, deleted, hash)
 *   GET    /api/v1/owners/:owner/documents/:type/:id    the stored document + effective indexability
 *   GET    /api/v1/owners/:owner/rejections?after=      index-document events Search refused
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { validate, effectiveIndexability } = require('../document');
const { CAPS } = require('../auth');

const OWNER_RE = /^[a-z][a-z0-9-]{1,39}$/;
const TYPE_RE = /^[a-z][a-z0-9_]{1,39}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/;

function validIdentity(p) {
    return OWNER_RE.test(p.owner) && TYPE_RE.test(p.type) && (p.id === undefined || ID_RE.test(p.id));
}

function outcomeResponse(res, ctx, r) {
    if (r.outcome === 'stale') {
        return http.sendProblem(res, 409, 'search.stale_revision', {
            detail: `revision ${r.revision} is older than the stored revision ${r.stored_revision}${r.deleted ? ' (tombstone)' : ''}`,
            ctx, extra: { stored_revision: r.stored_revision, deleted: r.deleted },
        });
    }
    if (r.outcome === 'conflict') {
        return http.sendProblem(res, 409, 'search.revision_conflict', {
            detail: `revision ${r.revision} is already indexed with different content; send a new revision`,
            ctx, extra: { stored_revision: r.stored_revision },
        });
    }
    return res.json(r);
}

function documentsRouter({ store, auth, db, relay }) {
    const router = express.Router();
    const guard = auth.requireCap(CAPS.write);

    function ownerCheck(req, res) {
        const ctx = req.ov;
        if (!validIdentity(req.params)) {
            http.sendProblem(res, 400, 'search.bad_identity', { detail: 'owner, type or id is malformed', ctx });
            return false;
        }
        if (req.params.owner !== req.principal.service) {
            http.sendProblem(res, 403, 'search.not_owner', { detail: `svc:${req.principal.service} cannot write or read documents owned by ${req.params.owner}`, ctx });
            return false;
        }
        return true;
    }

    router.put('/api/v1/documents/:owner/:type/:id', guard, (req, res) => {
        const ctx = req.ov;
        if (!ownerCheck(req, res)) return;
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
        if (!body) return http.sendProblem(res, 400, 'search.bad_document', { detail: 'body must be an index document object', ctx });
        for (const k of ['owner', 'type', 'id']) {
            if (body[k] !== undefined && body[k] !== req.params[k]) {
                return http.sendProblem(res, 422, 'search.bad_document', { detail: `body ${k} does not match the path`, ctx });
            }
        }
        const doc = { ...body, owner: req.params.owner, type: req.params.type, id: req.params.id };
        const v = validate(doc);
        if (!v.valid) return http.sendProblem(res, 422, 'search.bad_document', { detail: 'document does not match search.index-document@1', ctx, errors: v.errors });
        const r = store.apply(doc, { via: 'api', traceId: ctx.traceId });
        if (r.outcome === 'applied' && relay) relay.flush().catch(() => {});
        return outcomeResponse(res, ctx, r);
    });

    router.delete('/api/v1/documents/:owner/:type/:id', guard, (req, res) => {
        const ctx = req.ov;
        if (!ownerCheck(req, res)) return;
        let revision = null;
        if (req.query.revision !== undefined) {
            if (!/^\d{1,15}$/.test(String(req.query.revision))) return http.sendProblem(res, 400, 'search.bad_revision', { detail: 'revision must be a non-negative integer', ctx });
            revision = Number(req.query.revision);
        }
        const r = store.remove(req.params.owner, req.params.type, req.params.id, { revision, via: 'api', traceId: ctx.traceId });
        if (r.outcome === 'applied' && relay) relay.flush().catch(() => {});
        return outcomeResponse(res, ctx, r);
    });

    router.get('/api/v1/owners/:owner/documents', guard, (req, res) => {
        const ctx = req.ov;
        if (!ownerCheck(req, res)) return;
        const type = req.query.type ? String(req.query.type) : null;
        if (type && !TYPE_RE.test(type)) return http.sendProblem(res, 400, 'search.bad_identity', { detail: 'type is malformed', ctx });
        const after = /^\d{1,15}$/.test(String(req.query.after || '')) ? Number(req.query.after) : 0;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000);
        res.json({ owner: req.params.owner, ...store.ownerPage(req.params.owner, { type, after, limit }) });
    });

    router.get('/api/v1/owners/:owner/documents/:type/:id', guard, (req, res) => {
        const ctx = req.ov;
        if (!ownerCheck(req, res)) return;
        const found = store.get(req.params.owner, req.params.type, req.params.id);
        if (!found) return http.sendProblem(res, 404, 'search.not_found', { detail: 'no such document', ctx });
        res.json({
            document: found.doc,
            effective_indexability: effectiveIndexability(found.doc),
            exposure: store.EXPOSURE_NAME[found.row.exposure],
            via: found.row.via,
            event_id: found.row.event_id,
            indexed_at: new Date(found.row.indexed_at).toISOString(),
        });
    });

    router.get('/api/v1/owners/:owner/rejections', guard, (req, res) => {
        if (!ownerCheck(req, res)) return;
        const after = /^\d{1,15}$/.test(String(req.query.after || '')) ? Number(req.query.after) : 0;
        const rows = db.prepare('SELECT * FROM ingest_rejections WHERE owner = ? AND seq > ? ORDER BY seq LIMIT 200').all(req.params.owner, after);
        res.json({
            rejections: rows.map(r => ({
                seq: r.seq, event_id: r.event_id, event_type: r.event_type, type: r.type, id: r.id, revision: r.revision,
                code: r.code, detail: r.detail, at: new Date(r.at).toISOString(),
            })),
            next_after: rows.length ? rows[rows.length - 1].seq : null,
        });
    });

    return router;
}

module.exports = { documentsRouter, OWNER_RE, TYPE_RE, ID_RE };

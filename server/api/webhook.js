'use strict';
/**
 * Events consumer: POST /internal/events, the endpoint of Search's OpenVibe.Events subscription
 * (topic pattern `*.index_document.*`, see scripts/subscribe.js).
 *
 * Owners publish, through their own outbox:
 *   <owner>.index_document.upserted   payload = search.index-document@1 (owner may be omitted)
 *   <owner>.index_document.deleted    payload = { type, id, revision } (a tombstone)
 * with envelope subject { type, id, revision } and visibility "internal".
 *
 * Exactly once: the inbox receipt (consumer, event_id) and the document change commit in one
 * SQLite transaction. A redelivery of a processed event is answered 204 and changes nothing.
 * Revision order is the store's rule, so out-of-order delivery is harmless.
 *
 * Refusals (unknown owner, a source writing another owner's document, a bad document, a subject
 * that does not match the payload) are acknowledged, recorded once in ingest_rejections and
 * visible to the owner through GET /api/v1/owners/:owner/rejections: retrying cannot fix them.
 */
const crypto = require('crypto');
const express = require('express');
const { http } = require('openvibe-contracts');
const { validate } = require('../document');

const CONSUMER = 'search-index';
const TYPE_RE = /^([a-z][a-z0-9-]{1,39})\.index_document\.(upserted|deleted)$/;

function sign(raw, secret) {
    return 'sha256=' + crypto.createHmac('sha256', String(secret)).update(raw).digest('hex');
}

function verifySignature(raw, header, secrets) {
    if (!raw || typeof header !== 'string') return false;
    const given = Buffer.from(header.trim());
    return secrets.some((s) => {
        const expected = Buffer.from(sign(raw, s));
        return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    });
}

function createInbox(db, { now = () => Date.now() } = {}) {
    const claim = db.prepare('INSERT OR IGNORE INTO idempotency_receipts (consumer, event_id, outcome, processed_at) VALUES (?, ?, ?, ?)');
    const setOutcome = db.prepare('UPDATE idempotency_receipts SET outcome = ? WHERE consumer = ? AND event_id = ?');
    const reject = db.prepare(`INSERT INTO ingest_rejections (event_id, event_type, owner, type, id, revision, code, detail, at)
        VALUES (@event_id, @event_type, @owner, @type, @id, @revision, @code, @detail, @at)`);

    /** fn() runs inside the transaction and returns an outcome string. */
    function once(eventId, fn) {
        return db.transaction(() => {
            if (claim.run(CONSUMER, eventId, 'processing', now()).changes === 0) return { duplicate: true };
            const outcome = fn();
            setOutcome.run(outcome, CONSUMER, eventId);
            return { duplicate: false, outcome };
        })();
    }

    function recordRejection(r) {
        reject.run({ owner: null, type: null, id: null, revision: null, detail: null, event_type: null, ...r, at: now() });
    }

    return { once, recordRejection };
}

/** Turn one delivered envelope into { doc } or { reject: { code, detail } } or { ignore }. */
function documentFromEvent(event, owners) {
    const m = TYPE_RE.exec(String(event.event_type || ''));
    if (!m) return { ignore: 'not an index_document event' };
    const [, prefixOwner, action] = m;
    const source = event.source;
    if (prefixOwner !== source) return { reject: { code: 'owner_mismatch', detail: `event_type ${event.event_type} from source ${source}` } };
    if (!owners.includes(source)) return { reject: { code: 'owner_not_accepted', detail: `${source} is not in SEARCH_EVENT_OWNERS` } };
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    if (payload.owner !== undefined && payload.owner !== source) {
        return { reject: { code: 'owner_mismatch', detail: `payload owner ${payload.owner} from source ${source}` } };
    }
    const doc = action === 'deleted'
        ? { owner: source, type: payload.type, id: payload.id, revision: payload.revision, deleted: true }
        : { ...payload, owner: source };
    const subject = event.subject || {};
    if (subject.type !== doc.type || subject.id !== doc.id || (subject.revision !== undefined && subject.revision !== doc.revision)) {
        return { reject: { code: 'subject_mismatch', detail: 'envelope subject {type, id, revision} must match the document' } };
    }
    const v = validate(doc);
    if (!v.valid) return { reject: { code: 'invalid_document', detail: v.errors.map(e => `${e.path} ${e.message}`).join('; ').slice(0, 1000) } };
    return { doc };
}

function webhookRouter({ config, db, store, relay, log = console, now }) {
    const router = express.Router();
    const inbox = createInbox(db, { now });

    router.post('/internal/events',
        express.raw({ type: () => true, limit: config.maxBodyBytes }),
        (req, res) => {
            const ctx = req.ov;
            const secrets = config.events.webhookSecrets;
            if (!secrets.length) return http.sendProblem(res, 503, 'search.webhook_disabled', { detail: 'SEARCH_EVENTS_SECRET is not set', ctx });
            const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
            if (!verifySignature(raw, req.get('x-openvibe-signature'), secrets)) {
                return http.sendProblem(res, 401, 'search.bad_signature', { detail: 'X-OpenVibe-Signature does not verify', ctx });
            }
            let body;
            try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; }
            const event = body && body.event;
            if (!event || typeof event.event_id !== 'string' || !/^evt_[0-9A-HJKMNP-TV-Z]{26}$/.test(event.event_id)) {
                return http.sendProblem(res, 400, 'search.bad_delivery', { detail: 'body must be { event: <envelope>, seq }', ctx });
            }

            const r = inbox.once(event.event_id, () => {
                const parsed = documentFromEvent(event, config.events.owners);
                if (parsed.ignore) return 'ignored';
                if (parsed.reject) {
                    const p = event.payload || {};
                    inbox.recordRejection({
                        event_id: event.event_id, event_type: event.event_type, owner: event.source,
                        type: typeof p.type === 'string' ? p.type.slice(0, 40) : null,
                        id: typeof p.id === 'string' ? p.id.slice(0, 128) : null,
                        revision: Number.isInteger(p.revision) ? p.revision : null,
                        code: parsed.reject.code, detail: parsed.reject.detail,
                    });
                    log.warn(`[inbox] refused ${event.event_type} ${event.event_id}: ${parsed.reject.code}`);
                    return `rejected:${parsed.reject.code}`;
                }
                const traceId = typeof event.trace_id === 'string' ? event.trace_id : null;
                const out = store.apply(parsed.doc, { via: 'event', eventId: event.event_id, traceId });
                return out.outcome;
            });
            if (!r.duplicate && r.outcome === 'applied' && relay) relay.flush().catch(() => {});
            res.status(200).json({ event_id: event.event_id, duplicate: Boolean(r.duplicate), outcome: r.outcome || null });
        });

    return router;
}

module.exports = { webhookRouter, createInbox, documentFromEvent, verifySignature, sign, CONSUMER };

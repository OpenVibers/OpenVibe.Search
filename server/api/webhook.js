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

/** X-OpenVibe-Signature-V2 value: t=<unix seconds>,v2=<hex HMAC-SHA256 of "<t>.<raw body>">. */
function signV2(raw, secret, ts = Math.floor(Date.now() / 1000)) {
    return `t=${ts},v2=` + crypto.createHmac('sha256', String(secret)).update(`${ts}.`).update(raw).digest('hex');
}

const V2_TOLERANCE_SEC = 300;

/**
 * Constant-time check of X-OpenVibe-Signature-V2 against the raw body with any of `secrets`, and
 * of its timestamp (±300 s of now; X-OpenVibe-Timestamp, when sent, must be the same t). Same
 * rules as openvibe-sdk 0.4.0 verifyDeliveryV2(). v1 is never consulted.
 */
function verifySignatureV2(raw, headerV2, headerTs, secrets, now = Date.now()) {
    if (!raw || typeof headerV2 !== 'string') return false;
    let t = null;
    const given = [];
    for (const part of headerV2.split(',')) {
        const i = part.indexOf('=');
        if (i < 0) return false;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k === 't') {
            if (t !== null || !/^\d{1,12}$/.test(v)) return false;
            t = Number(v);
        } else if (k === 'v2') given.push(Buffer.from(v));
    }
    if (t === null || !given.length) return false;
    if (headerTs !== undefined && String(headerTs).trim() !== String(t)) return false;
    if (Math.abs(now / 1000 - t) > V2_TOLERANCE_SEC) return false;
    return secrets.some((s) => {
        const expected = Buffer.from(signV2(raw, s, t).split(',v2=')[1]);
        return given.some((g) => g.length === expected.length && crypto.timingSafeEqual(g, expected));
    });
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
            // v2 only: signature over "<t>.<raw body>" and t within ±300 s (a replayed or v1-only delivery fails).
            if (!verifySignatureV2(raw, req.get('x-openvibe-signature-v2'), req.get('x-openvibe-timestamp'), secrets)) {
                return http.sendProblem(res, 401, 'search.bad_signature', { detail: 'X-OpenVibe-Signature-V2 does not verify or is outside the replay window', ctx });
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

module.exports = { webhookRouter, createInbox, documentFromEvent, verifySignature, sign, verifySignatureV2, signV2, CONSUMER };

'use strict';
/**
 * Transactional outbox (events.event-envelope@1), OpenVibe.Events client semantics:
 *
 *   enqueue(envelope)  INSIDE the transaction that makes the change, so an event exists exactly
 *                      when its effect does (throws outside a transaction)
 *   relay              publishes unsent rows to OpenVibe.Events (POST /api/v1/events, service
 *                      token for audience openvibe.events with events.event.publish), marks them
 *                      sent, backs off on failure; a permanently refused row (4xx other than
 *                      401/408/429) is marked rejected so it cannot block the rest
 *
 * The relay runs only when EVENTS_URL is set; without it rows wait and are relayed later. Events
 * deduplicates on event_id, so a retry after a lost response never publishes twice.
 */
const { ids, validate, serviceAuth } = require('openvibe-contracts');

const BACKOFF_MS = [1000, 5000, 30000, 120000, 600000];

function ensureSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS event_outbox (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id        TEXT NOT NULL UNIQUE,
        event_type      TEXT NOT NULL,
        envelope        TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        sent_at         INTEGER,
        rejected_at     INTEGER,
        last_error      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_event_outbox_due ON event_outbox(sent_at, rejected_at, next_attempt_at);`);
}

function createOutbox(db, { source, now = () => Date.now() }) {
    const insert = db.prepare('INSERT INTO event_outbox (event_id, event_type, envelope, created_at) VALUES (?, ?, ?, ?)');

    /** { event_type, subject, payload, visibility?, priority?, actor?, trace_id? } → envelope */
    function enqueue({ event_type, subject, payload, visibility = 'internal', priority = 'important', actor, trace_id }) {
        if (!db.inTransaction) throw new Error('outbox.enqueue() must run inside the transaction that makes the change');
        const ms = now();
        const env = {
            event_id: ids.newId('event', ms),
            event_type,
            version: 1,
            source,
            actor: actor || { type: 'service', id: source },
            timestamp: new Date(ms).toISOString(),
            priority,
            visibility,
            subject,
            payload: payload || {},
        };
        if (trace_id && /^[0-9a-f]{32}$/.test(trace_id)) env.trace_id = trace_id;
        const v = validate('events.event-envelope@1', env);
        if (!v.valid) throw new Error(`outbox: invalid envelope for ${event_type}: ${v.errors.map(e => `${e.path} ${e.message}`).join('; ')}`);
        insert.run(env.event_id, event_type, JSON.stringify(env), ms);
        return env;
    }

    const q = {
        due: db.prepare('SELECT seq, event_id, envelope, attempts FROM event_outbox WHERE sent_at IS NULL AND rejected_at IS NULL AND next_attempt_at <= ? ORDER BY seq LIMIT ?'),
        sent: db.prepare('UPDATE event_outbox SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE seq = ?'),
        failed: db.prepare('UPDATE event_outbox SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE seq = ?'),
        rejected: db.prepare('UPDATE event_outbox SET rejected_at = ?, attempts = attempts + 1, last_error = ? WHERE seq = ?'),
        pending: db.prepare('SELECT COUNT(*) AS n FROM event_outbox WHERE sent_at IS NULL AND rejected_at IS NULL'),
        rejectedCount: db.prepare('SELECT COUNT(*) AS n FROM event_outbox WHERE rejected_at IS NOT NULL'),
        list: db.prepare('SELECT envelope FROM event_outbox ORDER BY seq'),
        prune: db.prepare('DELETE FROM event_outbox WHERE sent_at IS NOT NULL AND sent_at < ?'),
    };

    return {
        enqueue,
        pending: () => q.pending.get().n,
        rejected: () => q.rejectedCount.get().n,
        /** Every envelope in order (tests and operators). */
        all: () => q.list.all().map(r => JSON.parse(r.envelope)),
        prune: (olderThanMs = 7 * 24 * 3600 * 1000) => q.prune.run(now() - olderThanMs).changes,
        _q: q,
    };
}

/**
 * createRelay({ db, outbox, eventsUrl, intervalMs?, tokenClient? | tokenOpts?, fetchImpl?, log?, now? })
 *   → { start, stop, flush, running }
 * tokenOpts = { tokenUrl, clientId, clientSecret } builds a client-credentials token client for
 * audience openvibe.events. Without eventsUrl or a token source the relay does nothing.
 */
function createRelay({ outbox, eventsUrl, intervalMs = 2000, tokenClient, tokenOpts, fetchImpl = globalThis.fetch, log = console, now = () => Date.now(), db }) {
    const q = outbox._q;
    const tokens = tokenClient || (tokenOpts && serviceAuth.createTokenClient({ ...tokenOpts, audience: 'openvibe.events', scope: 'events.event.publish', fetchImpl }));
    let timer = null;
    let flushing = null;

    function permanent(status) {
        return status >= 400 && status < 500 && ![401, 408, 429].includes(status);
    }

    async function post(rows) {
        const body = rows.length === 1 ? JSON.parse(rows[0].envelope) : { events: rows.map(r => JSON.parse(r.envelope)) };
        const res = await fetchImpl(`${eventsUrl}/api/v1/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await tokens.authHeaders()) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10000),
        });
        if (res.status === 401 && typeof tokens.invalidate === 'function') tokens.invalidate();
        const text = await res.text().catch(() => '');
        return { ok: res.ok, status: res.status, text };
    }

    function mark(rows, fn) { db.transaction(() => { for (const r of rows) fn(r); })(); }

    async function publishRows(rows) {
        let r;
        try {
            r = await post(rows);
        } catch (err) {
            mark(rows, row => q.failed.run(now() + BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)], String(err.message).slice(0, 500), row.seq));
            return { sent: 0, failed: rows.length, rejected: 0 };
        }
        if (r.ok) {
            mark(rows, row => q.sent.run(now(), row.seq));
            return { sent: rows.length, failed: 0, rejected: 0 };
        }
        if (permanent(r.status) && rows.length > 1) {
            // One bad envelope refuses the batch: isolate it.
            const total = { sent: 0, failed: 0, rejected: 0 };
            for (const row of rows) {
                const s = await publishRows([row]);
                total.sent += s.sent; total.failed += s.failed; total.rejected += s.rejected;
            }
            return total;
        }
        const msg = `${r.status} ${r.text.slice(0, 300)}`;
        if (permanent(r.status)) {
            mark(rows, row => q.rejected.run(now(), msg, row.seq));
            log.warn(`[outbox] event refused by Events: ${msg}`);
            return { sent: 0, failed: 0, rejected: rows.length };
        }
        mark(rows, row => q.failed.run(now() + BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)], msg, row.seq));
        return { sent: 0, failed: rows.length, rejected: 0 };
    }

    async function doFlush() {
        const total = { sent: 0, failed: 0, rejected: 0 };
        if (!eventsUrl || !tokens) return total;
        for (;;) {
            const rows = q.due.all(now(), 50);
            if (!rows.length) break;
            const s = await publishRows(rows);
            total.sent += s.sent; total.failed += s.failed; total.rejected += s.rejected;
            if (s.failed || rows.length < 50) break;
        }
        if (total.failed) log.warn(`[outbox] ${total.failed} event(s) not published yet; will retry`);
        return total;
    }

    function flush() {
        if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
        return flushing;
    }

    function start() {
        if (timer || !eventsUrl) return;
        timer = setInterval(() => { flush().catch(err => log.warn(`[outbox] relay: ${err.message}`)); }, intervalMs);
        timer.unref?.();
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        return flushing || Promise.resolve();
    }

    return { start, stop, flush, running: () => Boolean(timer) };
}

module.exports = { ensureSchema, createOutbox, createRelay };

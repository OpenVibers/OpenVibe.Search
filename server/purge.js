'use strict';
/**
 * The removal purge queue: Search's own consumer of its search.document.removed decisions.
 *
 * Every change that lowers a document's exposure (store.js announce()) records, in the same
 * transaction as the index change and the outbox event:
 *
 *   removals     one row per removal: the feed products read to drop the document from their own
 *                caches and sitemaps (GET /api/v1/owners/:owner/removals, owner token). Products
 *                own their pages, so Search tells them rather than reaching into them.
 *   cdn_purges   one row per URL to purge from Cloudflare's cache: the canonical URL the document
 *                had while it was public, plus the configured related paths on the same host
 *                (the product's sitemap by default). Written only when CLOUDFLARE_PURGE_TOKEN is
 *                set; without it the CDN side is inert and nothing is queued.
 *
 * The purger (createPurger) posts pending URLs to the Cloudflare API, grouped by zone, at most
 * 30 per call (POST /zones/:zone/purge_cache { files }), with backoff on 429/5xx/network errors,
 * permanent failure after MAX_ATTEMPTS or a 4xx refusal (a refused batch is retried one URL at a
 * time so one bad URL cannot sink the others). The token is sent only in the Authorization
 * header and never stored or logged.
 */

const BACKOFF_MS = [2000, 10000, 60000, 300000, 900000, 1800000, 3600000];
const MAX_ATTEMPTS = 8;
const FILES_PER_CALL = 30;
const DETAIL_MAX = 300;

function ensureSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS removals (
        seq               INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id          TEXT NOT NULL,              -- the search.document.removed event
        owner             TEXT NOT NULL,
        type              TEXT NOT NULL,
        id                TEXT NOT NULL,
        revision          INTEGER NOT NULL,
        reason            TEXT NOT NULL,
        previous_exposure TEXT NOT NULL,
        exposure          TEXT NOT NULL,
        canonical_url     TEXT,                       -- only a URL that had been public
        at                INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_removals_owner ON removals (owner, seq);

    CREATE TABLE IF NOT EXISTS cdn_purges (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        removal_seq     INTEGER NOT NULL,
        provider        TEXT NOT NULL DEFAULT 'cloudflare',
        zone_id         TEXT,
        url             TEXT NOT NULL,
        state           TEXT NOT NULL CHECK (state IN ('pending', 'purged', 'failed', 'skipped')),
        detail          TEXT,
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        done_at         INTEGER
    );
    -- One pending purge per URL: a sitemap shared by many removals is purged once per batch.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cdn_purges_pending ON cdn_purges (zone_id, url) WHERE state = 'pending';
    CREATE INDEX IF NOT EXISTS idx_cdn_purges_due ON cdn_purges (state, next_attempt_at, seq);
    `);
}

/** The zone a URL belongs to: exact host or a parent domain in the map, longest first. */
function zoneFor(url, zones) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.hostname.toLowerCase();
    for (const z of zones) {
        if (host === z.host || host.endsWith(`.${z.host}`)) return z.zoneId;
    }
    return null;
}

/** The canonical URL plus the related paths on its host, without fragments, de-duplicated. */
function purgeUrls(canonicalUrl, relatedPaths) {
    let u;
    try { u = new URL(canonicalUrl); } catch { return []; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return [];
    u.hash = '';
    const out = [u.toString()];
    for (const p of relatedPaths) out.push(`${u.origin}${p}`);
    return [...new Set(out)];
}

function createPurgeQueue(db, { config, now = () => Date.now() }) {
    const cdnOn = Boolean(config.cloudflareToken);
    const st = {
        insRemoval: db.prepare(`INSERT INTO removals (event_id, owner, type, id, revision, reason, previous_exposure, exposure, canonical_url, at)
            VALUES (@event_id, @owner, @type, @id, @revision, @reason, @previous_exposure, @exposure, @canonical_url, @at)`),
        insPurge: db.prepare(`INSERT INTO cdn_purges (removal_seq, zone_id, url, state, detail, created_at, done_at)
            VALUES (@removal_seq, @zone_id, @url, @state, @detail, @created_at, @done_at)
            ON CONFLICT (zone_id, url) WHERE state = 'pending' DO NOTHING`),
        ownerFeed: db.prepare('SELECT * FROM removals WHERE owner = ? AND seq > ? ORDER BY seq LIMIT ?'),
        cdnCounts: db.prepare('SELECT state, COUNT(*) AS n FROM cdn_purges GROUP BY state'),
        purgesFor: db.prepare('SELECT * FROM cdn_purges WHERE removal_seq = ? ORDER BY seq'),
    };

    /**
     * Record one removal (the payload of the search.document.removed event). Must run inside the
     * transaction that made the change, like the outbox.
     */
    function record(eventId, p) {
        if (!db.inTransaction) throw new Error('purge.record() must run inside the transaction that makes the change');
        const at = now();
        const removalSeq = Number(st.insRemoval.run({
            event_id: eventId, owner: p.owner, type: p.type, id: p.id, revision: p.revision, reason: p.reason,
            previous_exposure: p.previous_exposure, exposure: p.exposure, canonical_url: p.canonical_url || null, at,
        }).lastInsertRowid);
        if (!cdnOn || !p.canonical_url) return removalSeq;
        for (const url of purgeUrls(p.canonical_url, config.relatedPaths)) {
            const zoneId = zoneFor(url, config.zones);
            st.insPurge.run({
                removal_seq: removalSeq, zone_id: zoneId, url,
                state: zoneId ? 'pending' : 'skipped',
                detail: zoneId ? null : 'no Cloudflare zone configured for this host (CLOUDFLARE_ZONE_IDS)',
                created_at: at, done_at: zoneId ? null : at,
            });
        }
        return removalSeq;
    }

    /** The owner's removal feed, oldest first after a cursor. */
    function ownerFeed(owner, { after = 0, limit = 200 } = {}) {
        const rows = st.ownerFeed.all(owner, after, limit);
        return {
            removals: rows.map(r => ({
                seq: r.seq, event_id: r.event_id, type: r.type, id: r.id, revision: r.revision, reason: r.reason,
                previous_exposure: r.previous_exposure, exposure: r.exposure, canonical_url: r.canonical_url,
                at: new Date(r.at).toISOString(),
            })),
            next_after: rows.length ? rows[rows.length - 1].seq : null,
        };
    }

    function cdnCounts() {
        const out = { pending: 0, purged: 0, failed: 0, skipped: 0 };
        for (const r of st.cdnCounts.all()) out[r.state] = r.n;
        return out;
    }

    return { record, ownerFeed, cdnCounts, purgesFor: (seq) => st.purgesFor.all(seq), cdnOn: () => cdnOn };
}

/**
 * createPurger({ db, config, fetchImpl?, log?, now? }) → { start, stop, flush, running }
 * Does nothing without config.cloudflareToken.
 */
function createPurger({ db, config, fetchImpl = globalThis.fetch, log = console, now = () => Date.now() }) {
    const token = config.cloudflareToken;
    const q = {
        due: db.prepare(`SELECT seq, zone_id, url, attempts FROM cdn_purges
            WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY seq LIMIT ?`),
        purged: db.prepare("UPDATE cdn_purges SET state = 'purged', attempts = attempts + 1, detail = ?, done_at = ? WHERE seq = ?"),
        retry: db.prepare('UPDATE cdn_purges SET attempts = attempts + 1, next_attempt_at = ?, detail = ? WHERE seq = ?'),
        failed: db.prepare("UPDATE cdn_purges SET state = 'failed', attempts = attempts + 1, detail = ?, done_at = ? WHERE seq = ?"),
    };
    let timer = null;
    let flushing = null;

    const clip = (s) => (token ? String(s || '').split(token).join('[token]') : String(s || '')).slice(0, DETAIL_MAX);

    function mark(rows, fn) { db.transaction(() => { for (const r of rows) fn(r); })(); }

    function retryOrFail(rows, detail) {
        mark(rows, (r) => {
            if (r.attempts + 1 >= MAX_ATTEMPTS) q.failed.run(clip(`gave up after ${MAX_ATTEMPTS} attempts: ${detail}`), now(), r.seq);
            else q.retry.run(now() + BACKOFF_MS[Math.min(r.attempts, BACKOFF_MS.length - 1)], clip(detail), r.seq);
        });
    }

    async function call(zoneId, urls) {
        const res = await fetchImpl(`${config.apiBase}/zones/${encodeURIComponent(zoneId)}/purge_cache`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ files: urls }),
            signal: AbortSignal.timeout(15000),
        });
        let body = null;
        try { body = await res.json(); } catch { body = null; }
        return { status: res.status, body };
    }

    /** → { purged, retrying, failed } for one zone's batch. */
    async function purgeBatch(zoneId, rows) {
        let r;
        try {
            r = await call(zoneId, rows.map(x => x.url));
        } catch (err) {
            retryOrFail(rows, `network: ${err.message}`);
            return { purged: 0, retrying: rows.length, failed: 0 };
        }
        const errors = (r.body && Array.isArray(r.body.errors) ? r.body.errors : []).map(e => `${e.code}: ${e.message}`).join('; ');
        if (r.status >= 200 && r.status < 300 && r.body && r.body.success === true) {
            const id = r.body.result && r.body.result.id ? `cloudflare purge ${r.body.result.id}` : 'purged';
            mark(rows, x => q.purged.run(clip(id), now(), x.seq));
            return { purged: rows.length, retrying: 0, failed: 0 };
        }
        if (r.status === 429 || r.status >= 500 || r.status === 408) {
            retryOrFail(rows, `HTTP ${r.status} ${errors}`);
            return { purged: 0, retrying: rows.length, failed: 0 };
        }
        // Refused (bad URL, token without purge permission, unknown zone): isolate, then fail.
        if (rows.length > 1) {
            const total = { purged: 0, retrying: 0, failed: 0 };
            for (const row of rows) {
                const s = await purgeBatch(zoneId, [row]);
                total.purged += s.purged; total.retrying += s.retrying; total.failed += s.failed;
            }
            return total;
        }
        mark(rows, x => q.failed.run(clip(`HTTP ${r.status} ${errors || 'refused'}`), now(), x.seq));
        log.warn(`[purge] Cloudflare refused a purge: HTTP ${r.status} ${clip(errors)}`);
        return { purged: 0, retrying: 0, failed: rows.length };
    }

    async function doFlush() {
        const total = { purged: 0, retrying: 0, failed: 0 };
        if (!token) return total;
        const rows = q.due.all(now(), 200);
        const byZone = new Map();
        for (const r of rows) {
            if (!byZone.has(r.zone_id)) byZone.set(r.zone_id, []);
            byZone.get(r.zone_id).push(r);
        }
        for (const [zoneId, zoneRows] of byZone) {
            for (let i = 0; i < zoneRows.length; i += FILES_PER_CALL) {
                const s = await purgeBatch(zoneId, zoneRows.slice(i, i + FILES_PER_CALL));
                total.purged += s.purged; total.retrying += s.retrying; total.failed += s.failed;
            }
        }
        if (total.retrying) log.warn(`[purge] ${total.retrying} URL(s) not purged yet; will retry`);
        return total;
    }

    function flush() {
        if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
        return flushing;
    }

    function start() {
        if (timer || !token) return;
        timer = setInterval(() => { flush().catch(err => log.warn(`[purge] ${err.message}`)); }, config.intervalMs);
        timer.unref?.();
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        return flushing || Promise.resolve();
    }

    return { start, stop, flush, running: () => Boolean(timer) };
}

module.exports = { ensureSchema, createPurgeQueue, createPurger, zoneFor, purgeUrls, MAX_ATTEMPTS, FILES_PER_CALL };

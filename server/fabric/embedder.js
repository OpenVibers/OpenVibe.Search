'use strict';
/**
 * The embedding job (SF-2): keeps search_embeddings in step with the public documents table.
 *
 * It is a job loop in the codebase's style (createPurger/createSavedNotifier): start() puts an unref'd
 * timer on the process, tick() is one pass (overlapping calls share it), stop() clears it and waits.
 * Every pass takes the public, published documents and compares their documents.hash with the stored
 * search_embeddings.content_hash; a document with no row, a changed hash, another model or another
 * dimension is pending. It embeds up to 32 at a time — title + summary + body, cut to 2 000 characters
 * — through OpenVibe.AI, and stores each vector under the documents table's identity (owner, type, id).
 *
 * It is off when SEARCH_EMBED=0, under the restore-drill flag (SEARCH_DRILL=1), or when AI is not
 * configured. Never embeds a document whose visibility is not 'public' (drafts, unpublished,
 * unlisted, members and private documents have no vector at all). At most SEARCH_EMBED_PER_MIN
 * documents are embedded per rolling minute. A failed AI call stores nothing and backs off
 * exponentially (2 s .. 1 h); the documents stay pending and are retried after the delay.
 *
 * createEmbedder({ db, vectors, embeddings, config, now?, log? }) -> { start, stop, tick, state, running }
 */
const { identity } = require('./vector-store');

const BATCH_SIZE = 32;
const MAX_CHARS = 2000;
const BACKOFF_MS = [2000, 10000, 60000, 300000, 900000, 1800000, 3600000];

/** Why the job is off, or null when it may run. `embeddings.available()` is synchronous by contract. */
function disabledReason(config, embeddings) {
    const embed = config.embed || {};
    if (!embed.enabled) return 'off (SEARCH_EMBED=0)';
    if (config.drill) return 'off (SEARCH_DRILL=1)';
    let state;
    try { state = embeddings && embeddings.available ? embeddings.available() : { configured: false, reason: 'no embedding client' }; } catch { state = { configured: false, reason: 'embedding client unavailable' }; }
    if (!state.configured) return `off (${state.reason || 'AI is not configured'})`;
    return null;
}

/** The text one document contributes: title + summary + body, cut to 2 000 characters. */
function embeddingText(doc) {
    const d = typeof doc === 'string' ? JSON.parse(doc) : (doc || {});
    return [d.title, d.summary, d.body].filter((x) => typeof x === 'string' && x.length).join('\n').slice(0, MAX_CHARS);
}

function createEmbedder({ db, vectors, embeddings, config, now = () => Date.now(), log = console }) {
    const embed = config.embed || {};
    const perMinute = Math.max(1, Number(embed.perMinute) || 120);
    const intervalMs = Math.max(1000, Number(embed.intervalMs) || 60000);
    const off = disabledReason(config, embeddings);

    let timer = null;
    let ticking = null;
    let failures = 0;
    let nextTryAt = 0;
    let windowStart = now();
    let usedThisWindow = 0;

    function budgetLeft() {
        const at = now();
        if (at - windowStart >= 60000) { windowStart = at; usedThisWindow = 0; }
        return Math.max(0, perMinute - usedThisWindow);
    }

    function backoff(error) {
        failures++;
        nextTryAt = now() + BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
        log.warn(`[embed] ${error}; retrying in ${Math.round((nextTryAt - now()) / 1000)}s`);
        return nextTryAt;
    }

    async function publicDocuments() {
        return await db.prepare(`SELECT rid, owner, type, id, hash, doc FROM documents
            WHERE deleted = 0 AND visibility = 'public' AND publication_state = 'published'
            ORDER BY rid`).all();
    }

    async function doTick() {
        if (off) return { skipped: off };
        if (now() < nextTryAt) return { backoff: true, retry_at: nextTryAt, failures };
        if (!vectors || typeof vectors.available !== 'function') return { skipped: 'no_vectors' };
        if (!await vectors.available()) return { skipped: 'no_vectors' };

        const docs = await publicDocuments();
        const existing = await vectors.existing();
        const pending = docs.filter((row) => {
            const prev = existing.get(identity(row.owner, row.type, row.id));
            return !prev || prev.model !== vectors.model || prev.dim !== vectors.dim || prev.content_hash !== row.hash;
        });
        if (!pending.length) return { embedded: 0, batches: 0, pending: 0 };

        let embedded = 0;
        let batches = 0;
        let at = 0;
        while (at < pending.length) {
            const left = budgetLeft();
            if (left <= 0) break;
            const rows = pending.slice(at, at + Math.min(BATCH_SIZE, left, pending.length - at));
            const texts = rows.map((row) => embeddingText(row.doc));
            const r = await embeddings.embed(texts);
            usedThisWindow += rows.length;
            if (!r || !r.ok) {
                const retryAt = backoff((r && r.error) || 'AI did not answer');
                return { embedded, batches, pending: pending.length - embedded, failed: 1, error: (r && r.error) || 'AI did not answer', retry_at: retryAt };
            }
            const vectorsOut = r.vectors || [];
            if (vectorsOut.length !== rows.length || vectorsOut.some((v) => !Array.isArray(v) || v.length !== vectors.dim)) {
                const retryAt = backoff(`AI answered ${vectorsOut.length} vector(s) of the wrong dimension`);
                return { embedded, batches, pending: pending.length - embedded, failed: 1, error: 'invalid vectors', retry_at: retryAt };
            }
            const updatedAt = new Date(now()).toISOString();
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                await vectors.put({
                    owner: row.owner, type: row.type, key: row.id,
                    embedding: vectorsOut[i], contentHash: row.hash, updatedAt,
                });
            }
            failures = 0;
            nextTryAt = 0;
            embedded += rows.length;
            batches++;
            at += rows.length;
        }
        return { embedded, batches, pending: Math.max(0, pending.length - embedded) };
    }

    /** What one pass would do, without calling AI or writing anything (scripts/embed-backfill.js --dry). */
    async function plan() {
        if (off) return { skipped: off };
        if (!vectors || typeof vectors.available !== 'function') return { skipped: 'no_vectors' };
        if (!await vectors.available()) return { skipped: 'no_vectors' };
        const docs = await publicDocuments();
        const existing = await vectors.existing();
        const pending = docs.filter((row) => {
            const prev = existing.get(identity(row.owner, row.type, row.id));
            return !prev || prev.model !== vectors.model || prev.dim !== vectors.dim || prev.content_hash !== row.hash;
        });
        return { available: true, public: docs.length, embedded: docs.length - pending.length, pending: pending.length };
    }

    /** One pass (overlapping calls share it). */
    function tick() {
        if (!ticking) ticking = doTick().finally(() => { ticking = null; });
        return ticking;
    }

    function start() {
        if (timer || off) return;
        timer = setInterval(() => { tick().catch((err) => log.warn(`[embed] tick: ${err.message}`)); }, intervalMs);
        timer.unref?.();
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        return ticking ? ticking.catch(() => {}) : Promise.resolve();
    }

    return {
        start, stop, tick, plan,
        running: () => Boolean(timer),
        state: () => off || (timer ? 'running' : 'stopped'),
        failures: () => failures,
        nextTryAt: () => nextTryAt,
    };
}

module.exports = { createEmbedder, disabledReason, embeddingText, BATCH_SIZE, MAX_CHARS, BACKOFF_MS };

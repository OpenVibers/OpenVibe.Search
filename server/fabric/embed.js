'use strict';
/**
 * Embeddings through OpenVibe.AI, and the short-lived cache the query path keeps in front of them.
 *
 *   POST <config.fabric.aiUrl>/api/v1/embed?wait=30000   { input: [text, ...] }
 *   -> { run: { status, output: { vectors, dimensions }, provenance: { model } } }
 *
 * Search calls AI as itself: a Network client-credentials token (client `search`, audience
 * openvibe.ai) carrying ai.run.create and the ai.embed namespace. The token is fetched lazily, so a
 * Search without the Network OAuth client boots and simply degrades to keyword ranking. Nothing here
 * throws: a network failure, a non-2xx answer, a failed run or malformed vectors becomes
 * { ok: false, error } so the query can answer with reason 'ai_unavailable' and the embedder can back off.
 *
 * Query vectors are cached for 10 minutes by normalized text (LRU, 500 entries): the same search
 * typed twice costs one embedding call, and a popular query never grows the cache past its bound.
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { normalizeQuery } = require('./cache');

const AI_TIMEOUT_MS = 30000;
const MAX_INPUTS = 64;

function shortError(err) {
    return String((err && (err.message || err.name)) || 'request failed').replace(/\s+/g, ' ').trim().slice(0, 160) || 'request failed';
}

function createEmbeddingClient({ config, fetchImpl = globalThis.fetch, tokenClient = null, now = () => Date.now(), log = console }) {
    const fabric = config.fabric || {};
    const oauth = config.oauth || {};
    const embedConfig = config.embed || {};
    const aiUrl = String(fabric.aiUrl || '').replace(/\/+$/, '');
    const model = String(embedConfig.model || 'bge-small-en-v1.5');
    let tokens = null;

    function available() {
        const missing = [];
        if (!aiUrl) missing.push('OV_AI_INTERNAL_URL');
        if (!oauth.clientSecret) missing.push('OV_OAUTH_CLIENT_SECRET');
        return { configured: missing.length === 0, reason: missing.length ? `${missing.join(' and ')} unset` : null };
    }

    function client() {
        if (!tokens) {
            tokens = tokenClient || createServiceTokenClient({
                network: config.networkInternalUrl,
                clientId: oauth.clientId,
                clientSecret: oauth.clientSecret,
                audience: 'openvibe.ai',
                fetch: fetchImpl,
                now,
            });
        }
        return tokens;
    }

    /** Embed 1..64 texts. → { ok, vectors, dimensions, model, ms } | { ok: false, error, ms }. */
    async function embed(texts) {
        const started = now();
        const ms = () => Math.max(0, Math.round(now() - started));
        const fail = (error) => ({ ok: false, error, ms: ms() });
        const inputs = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t == null ? '' : t));
        if (!inputs.length) return fail('no text to embed');
        if (inputs.length > MAX_INPUTS) return fail(`at most ${MAX_INPUTS} texts per embedding call`);

        const state = available();
        if (!state.configured) return fail(state.reason);

        try {
            const token = await client().getToken({ audience: 'openvibe.ai' });
            const timeout = AbortSignal.timeout(AI_TIMEOUT_MS);
            const res = await fetchImpl(`${aiUrl}/api/v1/embed?wait=30000`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ input: inputs }),
                signal: timeout,
            });
            if (!res.ok) return fail(`AI answered ${res.status}`);
            let json;
            try { json = await res.json(); } catch { return fail('AI answered no JSON'); }
            const run = json && json.run;
            if (!run) return fail('AI answered no run');
            if (run.status !== 'succeeded' && run.status !== 'cached') return fail(`AI run ${run.status || 'did not finish'}`);
            const output = run.output || {};
            const vectors = output.vectors;
            if (!Array.isArray(vectors) || vectors.length !== inputs.length
                || vectors.some((v) => !Array.isArray(v) || !v.length || v.some((n) => typeof n !== 'number' || !Number.isFinite(n)))) {
                return fail('AI answered invalid vectors');
            }
            return {
                ok: true,
                vectors,
                dimensions: Number(output.dimensions) || (vectors[0] ? vectors[0].length : 0),
                model: (run.provenance && run.provenance.model) || model,
                ms: ms(),
            };
        } catch (err) {
            log.warn(`[embed] AI: ${shortError(err)}`);
            return fail(shortError(err));
        }
    }

    return { embed, available, model };
}

/**
 * Query-embedding cache: normalized text -> vector, 10 minutes, LRU 500. `get()` returns
 * { ok, vector, cached } or { ok: false, error }; a failure is never cached, so the next search tries again.
 */
function createQueryEmbeddingCache({ client, now = () => Date.now(), ttlMs = 10 * 60 * 1000, max = 500 }) {
    const entries = new Map();   // insertion order is the LRU order

    async function get(text) {
        const key = normalizeQuery(text);
        if (!key) return { ok: false, error: 'empty query' };
        const hit = entries.get(key);
        if (hit) {
            if (now() - hit.at <= ttlMs) {
                entries.delete(key);
                entries.set(key, hit);
                return { ok: true, vector: hit.vector, cached: true, model: hit.model };
            }
            entries.delete(key);
        }
        const r = await client.embed([key]);
        if (!r.ok) return { ok: false, error: r.error };
        const vector = r.vectors && r.vectors[0];
        if (!Array.isArray(vector) || !vector.length) return { ok: false, error: 'AI answered no vector' };
        entries.set(key, { vector, at: now(), model: r.model || null });
        while (entries.size > max) entries.delete(entries.keys().next().value);
        return { ok: true, vector, cached: false, model: r.model || null };
    }

    return { get, size: () => entries.size, clear: () => entries.clear() };
}

module.exports = { createEmbeddingClient, createQueryEmbeddingCache, shortError, AI_TIMEOUT_MS, MAX_INPUTS };

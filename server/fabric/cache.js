'use strict';
/**
 * The Search Fabric's answer cache (query_cache, migrations/0005_fabric.sql): one provider step's
 * results for one normalized question, kept until it expires. A hit costs nothing and never reaches
 * a provider; a miss is the caller's to fetch and fill. `key` is shared by every caller — the query
 * text is only ever used to compute it and is never stored or returned.
 */
const crypto = require('crypto');

/** Lowers, collapses whitespace and trims: the same question typed two ways is one cache entry. */
function normalizeQuery(q) {
    return String(q == null ? '' : q).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** sha256(base64url) of [q, scope, step, freshness, site], the q normalized as above. */
function cacheKey(parts) {
    const [q, scope, step, freshness, site] = Array.isArray(parts)
        ? parts
        : [parts.q, parts.scope, parts.step, parts.freshness, parts.site];
    return crypto.createHash('sha256')
        .update(JSON.stringify([normalizeQuery(q), scope, step, freshness, site]))
        .digest('base64url');
}

function createQueryCache({ db, now = () => Date.now() }) {
    const st = {
        // An expired row is as good as absent; prune() removes it later.
        get: db.prepare('SELECT key, scope, step, results, cost_usd FROM query_cache WHERE key = ? AND expires_at > ?'),
        put: db.prepare(`INSERT INTO query_cache (key, scope, step, results, cost_usd, created_at, expires_at)
            VALUES (@key, @scope, @step, @results::jsonb, @cost_usd, @created_at, @expires_at)
            ON CONFLICT (key) DO UPDATE SET scope = EXCLUDED.scope, step = EXCLUDED.step,
                results = EXCLUDED.results, cost_usd = EXCLUDED.cost_usd,
                created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at`),
        prune: db.prepare('DELETE FROM query_cache WHERE expires_at <= ?'),
    };

    async function get(key) {
        const row = await st.get.get(key, new Date(now()).toISOString());
        if (!row) return null;
        return { scope: row.scope, step: row.step, results: row.results || [], cost_usd: Number(row.cost_usd) || 0 };
    }

    async function put(key, { scope, step, results, cost_usd = 0 }, ttlMs) {
        const at = now();
        await st.put.run({
            key, scope, step,
            results: JSON.stringify(results || []),
            cost_usd,
            created_at: new Date(at).toISOString(),
            expires_at: new Date(at + ttlMs).toISOString(),
        });
    }

    /** Drop every expired row; called at boot's hourly timer (server/index.js). */
    async function prune() {
        return (await st.prune.run(new Date(now()).toISOString())).changes;
    }

    return { get, put, prune };
}

module.exports = { createQueryCache, cacheKey, normalizeQuery };

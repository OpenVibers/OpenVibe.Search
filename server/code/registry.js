'use strict';
/**
 * The code-source registry: one small module per source, with a manifest the owner console reads, an
 * on/off switch that survives a restart (migrations/0005), a per-minute quota, and health measured from
 * real calls.
 *
 * A source module exports:
 *   { id, kind:'code', label, cost, keyName, requiredKey, order, quota:{perMinute},
 *     configured(), search({ q, lang, repo, limit, signal }) -> normalized result[] }
 *
 * The registry never passes a key value to a caller: `list()` returns `keyName` only. A source that
 * throws is reported in the `sources` summary of the answer and never fails the other sources.
 */
const { createGithubSource } = require('./sources/github');
const { createSourcegraphSource } = require('./sources/sourcegraph');
const { createForgeSource } = require('./sources/forge');
const { shortError, SourceError } = require('./util');

const DOWN_AFTER = 3;

function createCodeRegistry({ config, db, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    const code = config.code || {};
    const sources = [
        createGithubSource({ config: code.github || {}, fetchImpl, log }),
        createSourcegraphSource({ config: code.sourcegraph || {}, fetchImpl, log }),
        createForgeSource({ config: code.forge || {}, fetchImpl, now, log }),
    ].sort((a, b) => a.order - b.order);

    const state = new Map(sources.map((s) => [s.id, {
        source: s,
        enabled: true,
        minute: -1,
        used: 0,
        calls: 0,
        failures: 0,
        consecutive: 0,
        lastOkAt: null,
        lastErrorAt: null,
        lastError: null,
        lastMs: null,
    }]));

    function at(ms) { return ms == null ? null : new Date(ms).toISOString(); }

    function healthOf(s) {
        if (!s.enabled) return 'off';
        const source = s.source;
        if (source.requiredKey && !source.configured()) return 'unconfigured';
        if (s.consecutive >= DOWN_AFTER) return 'down';
        if (s.consecutive > 0) return 'degraded';
        if (s.lastOkAt != null) return 'ok';
        return 'unknown';
    }

    function view(s) {
        return {
            id: s.source.id,
            kind: s.source.kind,
            label: s.source.label,
            cost: s.source.cost,
            key: { name: s.source.keyName, required: Boolean(s.source.requiredKey), configured: s.source.configured() },
            quota: { per_minute: s.source.quota && s.source.quota.perMinute || null, window: 'minute' },
            enabled: s.enabled,
            health: healthOf(s),
            order: s.source.order,
            calls: s.calls,
            failures: s.failures,
            last_ok_at: at(s.lastOkAt),
            last_error_at: at(s.lastErrorAt),
            last_error: s.lastError,
            last_latency_ms: s.lastMs,
        };
    }

    /** Read the persisted switches (migrations/0005). A boot without the table keeps the defaults. */
    async function load() {
        try {
            const rows = await db.prepare('SELECT source_id, enabled FROM code_source_settings').all();
            for (const row of rows) {
                const s = state.get(String(row.source_id));
                if (s) s.enabled = Number(row.enabled) !== 0;
            }
        } catch (err) {
            log.warn(`[code] source switches not read (${shortError(err)}); using the defaults`);
        }
        return api;
    }

    async function setEnabled(id, enabled) {
        const s = state.get(String(id));
        if (!s) return null;
        s.enabled = Boolean(enabled);
        await db.prepare(`INSERT INTO code_source_settings (source_id, enabled, updated_at) VALUES (?, ?, ?)
            ON CONFLICT (source_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at`)
            .run(s.source.id, s.enabled ? 1 : 0, new Date(now()).toISOString());
        return view(s);
    }

    function take(s) {
        const minute = Math.floor(now() / 60_000);
        if (s.minute !== minute) { s.minute = minute; s.used = 0; }
        const limit = Number(s.source.quota && s.source.quota.perMinute) || 0;
        if (limit && s.used >= limit) {
            throw new SourceError(`${s.source.label} is over its ${limit}/minute budget`, { code: 'source.quota', status: 503 });
        }
        s.used += 1;
    }

    /** One source, with its timeout, quota, health and error text. Never throws. */
    async function runOne(s, query) {
        const started = now();
        if (!s.enabled) return { id: s.source.id, ok: false, skipped: 'off', count: 0, error: 'switched off', latency_ms: 0 };
        if (s.source.requiredKey && !s.source.configured()) {
            return { id: s.source.id, ok: false, skipped: 'unconfigured', count: 0, error: `${s.source.keyName} is unset`, latency_ms: 0 };
        }
        try {
            take(s);
            const results = await s.source.search(query);
            const elapsed = Math.max(0, now() - started);
            s.calls += 1;
            s.lastMs = elapsed;
            s.lastOkAt = now();
            s.consecutive = 0;
            return { id: s.source.id, ok: true, count: results.length, latency_ms: elapsed, results };
        } catch (err) {
            const elapsed = Math.max(0, now() - started);
            s.calls += 1;
            s.failures += 1;
            s.consecutive += 1;
            s.lastMs = elapsed;
            s.lastErrorAt = now();
            s.lastError = shortError(err);
            return { id: s.source.id, ok: false, count: 0, latency_ms: elapsed, error: s.lastError, code: err && err.code || 'source.failed' };
        }
    }

    /** Fan out to every enabled source; `sources` carries one row per source either way. */
    async function searchAll({ q, lang = null, repo = null, licence = null, limit = 20, signal = null }) {
        if (code.enabled === false) throw new SourceError('code search is off', { code: 'search.code_off', status: 503 });
        const active = sources.map((source) => state.get(source.id));
        const settled = await Promise.all(active.map((s) => runOne(s, { q, lang, repo, licence, limit, signal })));
        return {
            results: settled.flatMap((s) => (s.ok ? s.results : [])),
            sources: settled.map(({ results, ...rest }) => rest),
        };
    }

    const api = {
        list: () => sources.map((s) => view(state.get(s.id))),
        get: (id) => { const s = state.get(String(id)); return s ? view(s) : null; },
        searchAll,
        setEnabled,
        load,
        enabled: code.enabled !== false,
        size: sources.length,
    };
    return api;
}

module.exports = { createCodeRegistry };

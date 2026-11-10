'use strict';
/**
 * Merged code search: one query over every enabled source, one row per file at one commit, ranked
 * exact identifier matches first, then stars, then recency.
 *
 *   - de-duplication key: `<repo>@<ref>:<path>` (the same file at the same commit is one result even
 *     when GitHub and Sourcegraph both know it); the rows' contexts are merged by line number;
 *   - filters (lang, repo, licence) are applied to the merged rows as well as passed to the sources,
 *     because not every source implements every qualifier;
 *   - pagination is a cursor over the merged, ranked list: the sources are asked for `offset+limit+1`
 *     (at most 50), so page 2 is a fresh, deterministic-enough query rather than a promise of a
 *     server-side snapshot. `next_cursor` binds the filters, so a cursor cannot be replayed on a
 *     different query.
 */
const crypto = require('crypto');

const MAX_RESULTS = 50;
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NOT_IDENTIFIERS = new Set(['function', 'const', 'let', 'var', 'return', 'class', 'import', 'export', 'from', 'async', 'await', 'this', 'that', 'with', 'where', 'when', 'what', 'which', 'into', 'using', 'the', 'and', 'for', 'not']);

function hashOf(parts) {
    return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 16);
}

function encodeCursor(obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function decodeCursor(value, hash) {
    if (!value) return 0;
    let c;
    try { c = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')); } catch { c = null; }
    if (!c || c.h !== hash || !Number.isInteger(c.o) || c.o < 0 || c.o > MAX_RESULTS) {
        const err = new Error('cursor does not belong to this query');
        err.code = 'search.bad_cursor';
        throw err;
    }
    return c.o;
}

function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactIdentifier(q, result) {
    const token = String(q || '').trim().split(/\s+/)
        .filter((w) => IDENT_RE.test(w) && w.length >= 3 && !NOT_IDENTIFIERS.has(w.toLowerCase()))
        .sort((a, b) => b.length - a.length)[0];
    if (!token) return 0;
    const re = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRe(token)}([^A-Za-z0-9_$]|$)`);
    return result.lines.some((line) => line.match && re.test(line.text)) ? 1 : 0;
}

function mergeLines(base, extra) {
    const byNumber = new Map();
    for (const line of [...base, ...extra]) {
        if (!line || line.number == null) continue;
        const prev = byNumber.get(line.number);
        if (!prev) byNumber.set(line.number, { ...line });
        else if (line.match) prev.match = true;
    }
    return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

function mergeResults(rows) {
    const merged = new Map();
    for (const row of rows) {
        if (!row || !row.repo || !row.path || !row.permalink) continue;
        const key = `${String(row.repo).toLowerCase()}@${row.ref || ''}:${row.path}`;
        const prev = merged.get(key);
        if (!prev) {
            merged.set(key, { ...row, sources: [row.source] });
            continue;
        }
        prev.lines = mergeLines(prev.lines, row.lines);
        if (prev.line_start == null && row.line_start != null) prev.line_start = row.line_start;
        if (row.line_start != null && (prev.line_end == null || row.line_end > prev.line_end)) prev.line_end = row.line_end;
        prev.sources = [...new Set([...prev.sources, row.source])];
        prev.stars = Math.max(Number(prev.stars) || 0, Number(row.stars) || 0);
        prev.licence = prev.licence || row.licence || null;
        prev.language = prev.language || row.language || null;
        if (row.last_commit_at && (!prev.last_commit_at || String(row.last_commit_at) > String(prev.last_commit_at))) prev.last_commit_at = row.last_commit_at;
        if (!prev.fetched_at && row.fetched_at) prev.fetched_at = row.fetched_at;
    }
    for (const row of merged.values()) {
        row.line_start = row.lines.length ? row.lines[0].number : row.line_start;
        row.line_end = row.lines.length ? row.lines[row.lines.length - 1].number : row.line_end;
    }
    return [...merged.values()];
}

function matchesFilters(row, { lang, repo, licence }) {
    if (lang && String(row.language || '').toLowerCase() !== String(lang).toLowerCase()) return false;
    if (repo && !String(row.repo).toLowerCase().includes(String(repo).toLowerCase())) return false;
    if (licence && String(row.licence || '').toLowerCase() !== String(licence).toLowerCase()) return false;
    return true;
}

function recency(row) {
    for (const value of [row.last_commit_at, row.fetched_at]) {
        const t = Date.parse(value || '');
        if (Number.isFinite(t)) return t;
    }
    return 0;
}

function createCodeSearch({ config, registry, now = () => Date.now() }) {
    const ttl = Math.max(0, Number(config.code && config.code.cacheMs) || 0);
    const cache = new Map();

    async function fetchMerged({ q, lang, repo, licence, limit, offset }) {
        const fetchLimit = Math.min(MAX_RESULTS, Math.max(limit, offset + limit + 1));
        const key = JSON.stringify([q, lang, repo, licence, fetchLimit]);
        const hit = ttl ? cache.get(key) : null;
        if (hit && now() - hit.at < ttl) return hit.value;
        const out = await registry.searchAll({ q, lang, repo, licence, limit: fetchLimit });
        const value = { rows: mergeResults(out.results), sources: out.sources };
        if (ttl) {
            cache.set(key, { at: now(), value });
            if (cache.size > 100) cache.delete(cache.keys().next().value);
        }
        return value;
    }

    async function run({ q, lang = null, repo = null, licence = null, limit = 20, cursor = null }) {
        const started = now();
        const size = Math.max(1, Math.min(MAX_RESULTS, Number(limit) || 20));
        const hash = hashOf([q, lang, repo, licence]);
        const offset = decodeCursor(cursor, hash);
        const { rows, sources } = await fetchMerged({ q, lang, repo, licence, limit: size, offset });
        const filtered = rows
            .filter((row) => matchesFilters(row, { lang, repo, licence }))
            .map((row) => ({ ...row, exact_identifier: Boolean(exactIdentifier(q, row)) }));
        filtered.sort((a, b) => Number(b.exact_identifier) - Number(a.exact_identifier)
            || (Number(b.stars) || 0) - (Number(a.stars) || 0)
            || recency(b) - recency(a)
            || String(a.repo).localeCompare(String(b.repo))
            || String(a.path).localeCompare(String(b.path)));
        const page = filtered.slice(offset, offset + size);
        const more = filtered.length > offset + size;
        return {
            query: { q, lang, repo, licence, limit: size },
            results: page,
            sources,
            next_cursor: more ? encodeCursor({ h: hash, o: offset + size }) : null,
            took_ms: Math.max(0, now() - started),
        };
    }

    return { run, MAX_RESULTS };
}

module.exports = { createCodeSearch, mergeResults, exactIdentifier, MAX_RESULTS };

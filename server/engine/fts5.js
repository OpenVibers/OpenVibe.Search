'use strict';
/**
 * Search engine: SQLite FTS5 in the service's own database (decision: docs/adr-engine.md).
 *
 * Two full-text tables, split by audience so an anonymous query never touches, ranks against or
 * counts anything but public listed documents:
 *
 *   fts_public      documents with exposure public_listed (public, published, indexable)
 *   fts_restricted  documents with exposure restricted (unlisted/members/private, published)
 *
 * Drafts, unpublished, deleted and public-noindex documents are in neither, so no MATCH can
 * reach them. Every query is also filtered by `documents.exposure` and, for restricted rows, by
 * the viewer's ACL keys (doc_acl) in the same SQL: visibility is decided before anything is
 * ranked, counted, snippeted or suggested.
 *
 * The interface (put/remove/search/browse/facetCounts/suggest) is what a PostgreSQL FTS engine
 * would implement; nothing outside this file writes SQL against the FTS tables.
 */
const { EXPOSURE } = require('../document');

const TOKENIZE = "tokenize = 'unicode61 remove_diacritics 2'";
const WEIGHTS = '10.0, 4.0, 1.0';   // title, summary, body
const MARK_OPEN = '\u0001';
const MARK_CLOSE = '\u0002';

const DAY_MS = 24 * 3600 * 1000;

/**
 * Freshness multiplier for a document dated `iso` at reference time `nowMs`:
 *
 *   1 + weight × 2^(−age_days / halfLifeDays)
 *
 * With the defaults (weight 1, half-life 30 days) a document published today counts ×2.0, one
 * 30 days old ×1.5, 60 days ×1.25, 90 days ×1.125, a year old ×1.0002: relevance still decides,
 * and between comparably relevant documents the newer one ranks first. A future date counts as
 * today; no date (or an unparsable one) counts ×1. Weight 0 turns the boost off.
 */
function freshnessBoost(iso, nowMs, halfLifeDays, weight) {
    if (!weight || !iso) return 1;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return 1;
    const ageDays = Math.max(0, (nowMs - t) / DAY_MS);
    return 1 + weight * Math.pow(2, -ageDays / halfLifeDays);
}

function createEngine(db, { freshness = { weight: 1, halfLifeDays: 30 } } = {}) {
    // bm25() is negative (lower = more relevant), so multiplying by a boost ≥ 1 ranks newer first.
    db.function('ov_freshness', { deterministic: true }, (iso, nowMs, halfLifeDays, weight) => freshnessBoost(iso, nowMs, halfLifeDays, weight));
    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_public USING fts5(title, summary, body, ${TOKENIZE});
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_restricted USING fts5(title, summary, body, ${TOKENIZE});
    `);
    const st = {
        delPublic: db.prepare('DELETE FROM fts_public WHERE rowid = ?'),
        delRestricted: db.prepare('DELETE FROM fts_restricted WHERE rowid = ?'),
        insPublic: db.prepare('INSERT INTO fts_public (rowid, title, summary, body) VALUES (?, ?, ?, ?)'),
        insRestricted: db.prepare('INSERT INTO fts_restricted (rowid, title, summary, body) VALUES (?, ?, ?, ?)'),
    };

    /** (Re)index one document according to its exposure. Call inside the store's transaction. */
    function put(rid, doc, exposure) {
        remove(rid);
        if (exposure === EXPOSURE.public_listed) st.insPublic.run(rid, doc.title || '', doc.summary || '', doc.body || '');
        else if (exposure === EXPOSURE.restricted) st.insRestricted.run(rid, doc.title || '', doc.summary || '', doc.body || '');
    }

    function remove(rid) {
        st.delPublic.run(rid);
        st.delRestricted.run(rid);
    }

    // ── SQL building ─────────────────────────────────────────

    /**
     * The ACL predicate for restricted rows (alias d). private: the viewer's subject is in
     * acl.subjects. members/unlisted: subject, group or entitlement match. Returns null when the
     * viewer has no subject (then the restricted branch is not queried at all).
     */
    function aclClause(viewer, params) {
        if (!viewer || !viewer.subject) return null;
        params.v_subject = viewer.subject;
        params.v_groups = JSON.stringify(viewer.groups || []);
        params.v_ents = JSON.stringify(viewer.entitlements || []);
        return `(
            (d.visibility = 'private' AND EXISTS (SELECT 1 FROM doc_acl a WHERE a.rid = d.rid AND a.kind = 's' AND a.value = @v_subject))
            OR (d.visibility IN ('members', 'unlisted') AND EXISTS (SELECT 1 FROM doc_acl a WHERE a.rid = d.rid AND (
                   (a.kind = 's' AND a.value = @v_subject)
                OR (a.kind = 'g' AND a.value IN (SELECT value FROM json_each(@v_groups)))
                OR (a.kind = 'e' AND a.value IN (SELECT value FROM json_each(@v_ents))))))
        )`;
    }

    function filterClause(filters, params) {
        const parts = [];
        if (filters.owner) { parts.push('d.owner = @f_owner'); params.f_owner = filters.owner; }
        if (filters.type) { parts.push('d.type = @f_type'); params.f_type = filters.type; }
        if (filters.language) { parts.push('d.language = @f_lang'); params.f_lang = filters.language; }
        (filters.facets || []).forEach(([key, values], i) => {
            params[`f_fk${i}`] = key;
            params[`f_fv${i}`] = JSON.stringify(values);
            parts.push(`EXISTS (SELECT 1 FROM doc_facets x WHERE x.rid = d.rid AND x.key = @f_fk${i} AND x.value IN (SELECT value FROM json_each(@f_fv${i})))`);
        });
        return parts.length ? ` AND ${parts.join(' AND ')}` : '';
    }

    /**
     * The visible, matching set as (rid, rank, snip) rows. match = FTS5 expression. rank is bm25
     * times the freshness boost at reference time `now` (ms), so pages of one query (which carry
     * their first page's `now` in the cursor) rank against the same clock.
     */
    function matchedSet({ match, filters, viewer, snippets = true, now = Date.now() }, params) {
        params.match = match;
        params.r_now = now;
        params.r_half = freshness.halfLifeDays;
        params.r_weight = freshness.weight;
        const where = filterClause(filters, params);
        const snip = (t) => (snippets ? `snippet(${t}, -1, char(1), char(2), '…', 16)` : 'NULL');
        const rank = (t) => `bm25(${t}, ${WEIGHTS}) * ov_freshness(COALESCE(d.published_at, d.updated_at), @r_now, @r_half, @r_weight)`;
        const branches = [`SELECT d.rid AS rid, ${rank('fts_public')} AS rank, ${snip('fts_public')} AS snip
            FROM fts_public JOIN documents d ON d.rid = fts_public.rowid
            WHERE fts_public MATCH @match AND d.exposure = ${EXPOSURE.public_listed} AND d.deleted = 0${where}`];
        const acl = aclClause(viewer, params);
        if (acl) {
            branches.push(`SELECT d.rid AS rid, ${rank('fts_restricted')} AS rank, ${snip('fts_restricted')} AS snip
                FROM fts_restricted JOIN documents d ON d.rid = fts_restricted.rowid
                WHERE fts_restricted MATCH @match AND d.exposure = ${EXPOSURE.restricted} AND d.deleted = 0${where} AND ${acl}`);
        }
        return branches.join('\nUNION ALL\n');
    }

    /** The visible set without a text query (browse). */
    function visibleSet({ filters, viewer }, params) {
        const where = filterClause(filters, params);
        const acl = aclClause(viewer, params);
        const vis = acl
            ? `(d.exposure = ${EXPOSURE.public_listed} OR (d.exposure = ${EXPOSURE.restricted} AND ${acl}))`
            : `d.exposure = ${EXPOSURE.public_listed}`;
        return `SELECT d.rid AS rid, d.sort_at AS sort_at FROM documents d WHERE d.deleted = 0 AND ${vis}${where}`;
    }

    // ── Queries ──────────────────────────────────────────────

    /** Ranked full-text search. after = { rank, rid } keyset cursor. */
    function search({ match, filters = {}, viewer, limit, after, now = Date.now() }) {
        const params = { limit: limit + 1 };
        let sql = `SELECT rid, rank, snip FROM (${matchedSet({ match, filters, viewer, now }, params)})`;
        if (after) {
            sql += ' WHERE (rank > @c_rank OR (rank = @c_rank AND rid > @c_rid))';
            params.c_rank = after.rank;
            params.c_rid = after.rid;
        }
        sql += ' ORDER BY rank, rid LIMIT @limit';
        const rows = db.prepare(sql).all(params);
        const more = rows.length > limit;
        const hits = rows.slice(0, limit);
        const last = hits[hits.length - 1];
        return { hits, next: more && last ? { rank: last.rank, rid: last.rid } : null };
    }

    /** Newest first, no text query. after = { sort_at, rid }. */
    function browse({ filters = {}, viewer, limit, after }) {
        const params = { limit: limit + 1 };
        let sql = `SELECT rid, sort_at FROM (${visibleSet({ filters, viewer }, params)})`;
        if (after) {
            sql += ' WHERE (sort_at < @c_sort OR (sort_at = @c_sort AND rid < @c_rid))';
            params.c_sort = after.sort_at;
            params.c_rid = after.rid;
        }
        sql += ' ORDER BY sort_at DESC, rid DESC LIMIT @limit';
        const rows = db.prepare(sql).all(params);
        const more = rows.length > limit;
        const hits = rows.slice(0, limit).map(r => ({ rid: r.rid, rank: null, snip: null, sort_at: r.sort_at }));
        const last = hits[hits.length - 1];
        return { hits, next: more && last ? { sort_at: last.sort_at, rid: last.rid } : null };
    }

    /**
     * Value counts for facet keys over exactly the visible matching set (same SQL as the hits),
     * so a count can never include a document the viewer cannot see.
     */
    function facetCounts({ match, filters = {}, viewer, keys, perKey = 20 }) {
        const out = {};
        for (const key of keys) {
            const params = { fkey: key, per: perKey };
            const set = match ? matchedSet({ match, filters, viewer, snippets: false }, params) : visibleSet({ filters, viewer }, params);
            const rows = db.prepare(`SELECT f.value AS value, COUNT(*) AS count FROM doc_facets f
                WHERE f.key = @fkey AND f.rid IN (SELECT rid FROM (${set}))
                GROUP BY f.value ORDER BY count DESC, value LIMIT @per`).all(params);
            out[key] = rows;
        }
        return out;
    }

    /** Title prefix suggestions over the visible set. */
    function suggest({ match, filters = {}, viewer, limit }) {
        const params = { limit };
        const sql = `SELECT rid, rank FROM (${matchedSet({ match, filters, viewer, snippets: false }, params)}) ORDER BY rank, rid LIMIT @limit`;
        return db.prepare(sql).all(params);
    }

    function counts() {
        return {
            public_listed: db.prepare('SELECT COUNT(*) AS n FROM fts_public').get().n,
            restricted: db.prepare('SELECT COUNT(*) AS n FROM fts_restricted').get().n,
        };
    }

    return { name: 'sqlite-fts5', put, remove, search, browse, facetCounts, suggest, counts, freshness };
}

// ── Query text → FTS5 expression ─────────────────────────────

/**
 * Turns user text into a safe FTS5 expression: word tokens only, each quoted (no operators,
 * column filters or syntax errors reach FTS5), all required. A trailing `*` on the last word
 * makes it a prefix. Returns null when nothing searchable is left.
 */
function toMatch(q, { maxTerms = 16, column = null, prefixLast = false } = {}) {
    const text = String(q || '').normalize('NFKC');
    const words = (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).slice(0, maxTerms);
    if (!words.length) return null;
    const wantsPrefix = prefixLast || /[\p{L}\p{N}_]\*\s*$/u.test(text);
    const parts = words.map((w, i) => `"${w}"${wantsPrefix && i === words.length - 1 ? '*' : ''}`);
    const expr = parts.join(' ');
    return column ? `{${column}} : (${expr})` : expr;
}

/** Plain text with the engine's snippet marks → HTML with <mark>, everything else escaped. */
function snippetHtml(snip) {
    if (!snip) return null;
    const esc = String(snip).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return esc.split(MARK_OPEN).join('<mark>').split(MARK_CLOSE).join('</mark>');
}

module.exports = { createEngine, toMatch, snippetHtml, freshnessBoost };

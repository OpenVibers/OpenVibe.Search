'use strict';
/**
 * Search engine: PostgreSQL full-text search in the service's own database (ADR-035; it replaced SQLite FTS5, the
 * engine docs/adr-engine.md chose, with the same interface and the same guarantees).
 *
 * One table, search_fts, split by audience so an anonymous query never touches, ranks against or counts anything but
 * public listed documents:
 *
 *   audience 3  documents with exposure public_listed (public, published, indexable)
 *   audience 1  documents with exposure restricted (unlisted/members/private, published)
 *
 * Drafts, unpublished, deleted and public-noindex documents have no row, so no query can reach them. Every query is
 * also filtered by `documents.exposure` and, for restricted rows, by the viewer's ACL keys (doc_acl) in the same SQL:
 * visibility is decided before anything is ranked, counted, snippeted or suggested.
 *
 * Text is folded before it is indexed or queried (NFKD, combining marks removed: FTS5's remove_diacritics), split into
 * runs of letters and digits (FTS5's unicode61) and tokenized by the `simple` configuration (lower case, no stemming, no stop words: FTS5's unicode61). Title, summary and
 * body weigh 10, 4 and 1 (tsvector weights A, B, C). Every function here is async; put and remove run inside the store's
 * transaction (ambient). Nothing outside this file writes SQL against search_fts.
 */
const { EXPOSURE } = require('../document');

const CONFIG = 'simple';
const WEIGHTS = '{0.1, 0.1, 0.4, 1.0}';   // D, C body, B summary, A title: FTS5's bm25 weights 10 / 4 / 1
const MARK_OPEN = '\u0001';
const MARK_CLOSE = '\u0002';
const HEADLINE = `StartSel=${MARK_OPEN}, StopSel=${MARK_CLOSE}, MaxWords=16, MinWords=8, ShortWord=0, MaxFragments=1, FragmentDelimiter=" … "`;

const DAY_MS = 24 * 3600 * 1000;

/**
 * Freshness multiplier for a document dated `iso` at reference time `nowMs`:
 *
 *   1 + weight × 2^(−age_days / halfLifeDays)
 *
 * With the defaults (weight 1, half-life 30 days) a document published today counts ×2.0, one
 * 30 days old ×1.5, 60 days ×1.25, 90 days ×1.125, a year old ×1.0002: relevance still decides,
 * and between comparably relevant documents the newer one ranks first. A future date counts as
 * today; no date (or an unparsable one) counts ×1. Weight 0 turns the boost off. The SQL below
 * computes the same from search_fts.fresh_at.
 */
function freshnessBoost(iso, nowMs, halfLifeDays, weight) {
    if (!weight || !iso) return 1;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return 1;
    const ageDays = Math.max(0, (nowMs - t) / DAY_MS);
    return 1 + weight * Math.pow(2, -ageDays / halfLifeDays);
}

/** Diacritics folded, as FTS5's remove_diacritics did: the index and every query see the same text. */
function fold(s) {
    return String(s || '').normalize('NFKD').replace(/\p{M}+/gu, '').normalize('NFC');
}

/**
 * The words FTS5's unicode61 tokenizer saw: runs of letters and digits, everything else a separator. PostgreSQL's
 * parser would keep "OpenVibe.Live", "a_b" or "3.5" as single tokens (host, word, number); separating them first makes
 * "openvibe" find "OpenVibe.Live" as it did.
 */
function words(s) {
    return fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ');
}

function createEngine(db, { freshness = { weight: 1, halfLifeDays: 30 } } = {}) {
    const st = {
        del: db.prepare('DELETE FROM search_fts WHERE rid = ?'),
        ins: db.prepare(`INSERT INTO search_fts (rid, audience, fresh_at, title, summary, body, tsv)
                         VALUES (@rid, @audience, @fresh_at, @title, @summary, @body,
                                 setweight(to_tsvector('${CONFIG}', @f_title), 'A') || setweight(to_tsvector('${CONFIG}', @f_summary), 'B')
                                 || setweight(to_tsvector('${CONFIG}', @f_body), 'C'))`),
    };

    /** (Re)index one document according to its exposure. Call inside the store's transaction. */
    async function put(rid, doc, exposure) {
        await remove(rid);
        if (exposure !== EXPOSURE.public_listed && exposure !== EXPOSURE.restricted) return;
        const at = Date.parse(doc.published_at || doc.updated_at || '');
        const title = doc.title || '';
        const summary = doc.summary || '';
        const body = doc.body || '';
        await st.ins.run({
            rid, audience: exposure, fresh_at: Number.isFinite(at) ? at : null, title, summary, body,
            f_title: words(title), f_summary: words(summary), f_body: words(body),
        });
    }

    async function remove(rid) {
        await st.del.run(rid);
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
        params.v_groups = (viewer.groups || []).map(String);
        params.v_ents = (viewer.entitlements || []).map(String);
        return `(
            (d.visibility = 'private' AND EXISTS (SELECT 1 FROM doc_acl a WHERE a.rid = d.rid AND a.kind = 's' AND a.value = @v_subject))
            OR (d.visibility IN ('members', 'unlisted') AND EXISTS (SELECT 1 FROM doc_acl a WHERE a.rid = d.rid AND (
                   (a.kind = 's' AND a.value = @v_subject)
                OR (a.kind = 'g' AND a.value = ANY(@v_groups::text[]))
                OR (a.kind = 'e' AND a.value = ANY(@v_ents::text[])))))
        )`;
    }

    function filterClause(filters, params) {
        const parts = [];
        if (filters.owner) { parts.push('d.owner = @f_owner'); params.f_owner = filters.owner; }
        if (filters.type) { parts.push('d.type = @f_type'); params.f_type = filters.type; }
        if (filters.language) { parts.push('d.language = @f_lang'); params.f_lang = filters.language; }
        (filters.facets || []).forEach(([key, values], i) => {
            params[`f_fk${i}`] = key;
            params[`f_fv${i}`] = values.map(String);
            parts.push(`EXISTS (SELECT 1 FROM doc_facets x WHERE x.rid = d.rid AND x.key = @f_fk${i} AND x.value = ANY(@f_fv${i}::text[]))`);
        });
        return parts.length ? ` AND ${parts.join(' AND ')}` : '';
    }

    /**
     * The visible, matching set as (rid, rank) rows. match = toMatch()'s query. rank is minus ts_rank times the
     * freshness boost at reference time `now` (ms), so lower ranks first (as FTS5's bm25 did) and pages of one query
     * (which carry their first page's `now` in the cursor) rank against the same clock.
     */
    function matchedSet({ match, filters, viewer, now = Date.now() }, params) {
        params.match = tsquery(match);
        params.r_now = now;
        params.r_half = freshness.halfLifeDays;
        params.r_weight = freshness.weight;
        const where = filterClause(filters, params);
        const rank = `-(ts_rank('${WEIGHTS}'::float4[], f.tsv, to_tsquery('${CONFIG}', @match), 1)
            * CASE WHEN f.fresh_at IS NULL OR @r_weight::float8 = 0 THEN 1
                   ELSE 1 + @r_weight::float8 * power(2::float8, -(GREATEST(0, @r_now::bigint - f.fresh_at)::float8 / ${DAY_MS}) / @r_half::float8) END)`;
        const branches = [`SELECT d.rid AS rid, ${rank} AS rank
            FROM search_fts f JOIN documents d ON d.rid = f.rid
            WHERE f.audience = ${EXPOSURE.public_listed} AND f.tsv @@ to_tsquery('${CONFIG}', @match)
              AND d.exposure = ${EXPOSURE.public_listed} AND d.deleted = 0${where}`];
        const acl = aclClause(viewer, params);
        if (acl) {
            branches.push(`SELECT d.rid AS rid, ${rank} AS rank
                FROM search_fts f JOIN documents d ON d.rid = f.rid
                WHERE f.audience = ${EXPOSURE.restricted} AND f.tsv @@ to_tsquery('${CONFIG}', @match)
                  AND d.exposure = ${EXPOSURE.restricted} AND d.deleted = 0${where} AND ${acl}`);
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

    /**
     * Ranked full-text search. after = { rank, rid } keyset cursor. The snippet is computed for the page's rows only:
     * the summary and body when they match, else the title.
     */
    async function search({ match, filters = {}, viewer, limit, after, now = Date.now() }) {
        const params = { limit: limit + 1 };
        let sql = `SELECT rid, rank FROM (${matchedSet({ match, filters, viewer, now }, params)}) m`;
        if (after) {
            sql += ' WHERE (rank > @c_rank::float8 OR (rank = @c_rank::float8 AND rid > @c_rid::bigint))';
            params.c_rank = after.rank;
            params.c_rid = after.rid;
        }
        sql += ' ORDER BY rank, rid LIMIT @limit';
        const page = `SELECT p.rid, p.rank,
                CASE WHEN to_tsvector('${CONFIG}', f.summary || ' ' || f.body) @@ to_tsquery('${CONFIG}', @match)
                     THEN ts_headline('${CONFIG}', f.summary || ' ' || f.body, to_tsquery('${CONFIG}', @match), @hl)
                     ELSE ts_headline('${CONFIG}', f.title, to_tsquery('${CONFIG}', @match), @hl) END AS snip
            FROM (${sql}) p JOIN search_fts f ON f.rid = p.rid ORDER BY p.rank, p.rid`;
        params.hl = HEADLINE;
        const rows = await db.prepare(page).all(params);
        const more = rows.length > limit;
        const hits = rows.slice(0, limit);
        const last = hits[hits.length - 1];
        return { hits, next: more && last ? { rank: last.rank, rid: last.rid } : null };
    }

    /** Newest first, no text query. after = { sort_at, rid }. */
    async function browse({ filters = {}, viewer, limit, after }) {
        const params = { limit: limit + 1 };
        let sql = `SELECT rid, sort_at FROM (${visibleSet({ filters, viewer }, params)}) v`;
        if (after) {
            sql += ' WHERE (sort_at < @c_sort OR (sort_at = @c_sort AND rid < @c_rid::bigint))';
            params.c_sort = after.sort_at;
            params.c_rid = after.rid;
        }
        sql += ' ORDER BY sort_at DESC, rid DESC LIMIT @limit';
        const rows = await db.prepare(sql).all(params);
        const more = rows.length > limit;
        const hits = rows.slice(0, limit).map(r => ({ rid: r.rid, rank: null, snip: null, sort_at: r.sort_at }));
        const last = hits[hits.length - 1];
        return { hits, next: more && last ? { sort_at: last.sort_at, rid: last.rid } : null };
    }

    /**
     * Value counts for facet keys over exactly the visible matching set (same SQL as the hits),
     * so a count can never include a document the viewer cannot see.
     */
    async function facetCounts({ match, filters = {}, viewer, keys, perKey = 20 }) {
        const out = {};
        for (const key of keys) {
            const params = { fkey: key, per: perKey };
            const set = match ? matchedSet({ match, filters, viewer }, params) : visibleSet({ filters, viewer }, params);
            out[key] = await db.prepare(`SELECT f.value AS value, COUNT(*)::int AS count FROM doc_facets f
                WHERE f.key = @fkey AND f.rid IN (SELECT rid FROM (${set}) s)
                GROUP BY f.value ORDER BY count DESC, value LIMIT @per`).all(params);
        }
        return out;
    }

    /** Title prefix suggestions over the visible set. */
    async function suggest({ match, filters = {}, viewer, limit }) {
        const params = { limit };
        return await db.prepare(`SELECT rid, rank FROM (${matchedSet({ match, filters, viewer }, params)}) m ORDER BY rank, rid LIMIT @limit`).all(params);
    }

    async function counts() {
        const rows = await db.prepare('SELECT audience, COUNT(*)::int AS n FROM search_fts GROUP BY audience').all();
        const of = (a) => (rows.find((r) => Number(r.audience) === a) || { n: 0 }).n;
        return { public_listed: of(EXPOSURE.public_listed), restricted: of(EXPOSURE.restricted) };
    }

    /**
     * Rebuild the index from documents.doc when its counts disagree with the documents table (after the one-time import
     * from SQLite, whose FTS5 tables are not copied). Returns what it did.
     */
    async function reconcile() {
        const docs = await db.prepare(`SELECT
                COUNT(*) FILTER (WHERE exposure = ${EXPOSURE.public_listed} AND deleted = 0)::int AS public_listed,
                COUNT(*) FILTER (WHERE exposure = ${EXPOSURE.restricted} AND deleted = 0)::int AS restricted
            FROM documents`).get();
        const idx = await counts();
        if (idx.public_listed === docs.public_listed && idx.restricted === docs.restricted) return { rebuilt: 0 };
        let rebuilt = 0;
        await db.tx(async () => {
            await db.prepare('DELETE FROM search_fts').run();
            const rows = await db.prepare(`SELECT rid, exposure, doc FROM documents WHERE deleted = 0 AND exposure IN (${EXPOSURE.public_listed}, ${EXPOSURE.restricted}) ORDER BY rid`).all();
            for (const r of rows) {
                await put(r.rid, typeof r.doc === 'string' ? JSON.parse(r.doc) : r.doc, Number(r.exposure));
                rebuilt++;
            }
        });
        return { rebuilt };
    }

    return { name: 'postgresql-fts', put, remove, search, browse, facetCounts, suggest, counts, reconcile, freshness };
}

// ── Query text → tsquery ─────────────────────────────────────

/**
 * Turns user text into a safe query: word tokens only (no operators or syntax reach PostgreSQL), all required. A
 * trailing `*` on the last word makes it a prefix; column 'title' restricts every word to the title. Returns
 * { words, prefix, column } or null when nothing searchable is left.
 */
function toMatch(q, { maxTerms = 16, column = null, prefixLast = false } = {}) {
    const text = String(q || '').normalize('NFKC');
    const words = (fold(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, maxTerms);
    if (!words.length) return null;
    const prefix = prefixLast || /[\p{L}\p{N}_]\*\s*$/u.test(text);
    return { words, prefix, column };
}

/** toMatch()'s query → to_tsquery text: 'w1' & 'w2' & 'w3':* (and :A on each word for the title). */
function tsquery(m) {
    const weight = m.column === 'title' ? 'A' : '';
    return m.words.map((w, i) => {
        const star = m.prefix && i === m.words.length - 1 ? '*' : '';
        return `'${w}'${star || weight ? `:${star}${weight}` : ''}`;
    }).join(' & ');
}

/** Plain text with the engine's snippet marks → HTML with <mark>, everything else escaped. */
function snippetHtml(snip) {
    if (!snip) return null;
    const esc = String(snip).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return esc.split(MARK_OPEN).join('<mark>').split(MARK_CLOSE).join('</mark>');
}

module.exports = { createEngine, toMatch, tsquery, snippetHtml, freshnessBoost, fold, words };

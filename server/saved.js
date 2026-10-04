'use strict';
/**
 * Saved searches: a signed-in person (a usr_ subject) keeps a query (text + filters) and runs it
 * again later. The saved row holds the query only, never results: every run is a fresh query as
 * that person at that moment, so a document that became private or was deleted since the save
 * is simply not there, and one they gained access to is.
 *
 * last_run_at is also the watermark of the saved-search notifier (server/saved-notifier.js): what was
 * indexed after it is new.
 */
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');

const ID_RE = /^svs_[0-9a-z]{26}$/;

/** Filters in one canonical shape, so equal queries hash equally whatever order they came in. */
function canonicalFilters(f) {
    const out = {};
    if (f.owner) out.owner = f.owner;
    if (f.type) out.type = f.type;
    if (f.language) out.language = f.language;
    const facets = (f.facets || [])
        .map(([k, vs]) => [k, [...new Set(vs)].sort()])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (facets.length) out.facets = facets;
    return out;
}

function hashOf(q, filters) {
    return crypto.createHash('sha256').update(JSON.stringify([q, filters])).digest('base64url').slice(0, 22);
}

function createSavedSearches(db, { maxPerSubject = 50, now = () => Date.now() } = {}) {
    const st = {
        list: db.prepare('SELECT * FROM saved_searches WHERE subject = ? ORDER BY created_at DESC, id DESC'),
        get: db.prepare('SELECT * FROM saved_searches WHERE id = ? AND subject = ?'),
        byHash: db.prepare('SELECT * FROM saved_searches WHERE subject = ? AND query_hash = ?'),
        count: db.prepare('SELECT COUNT(*) AS n FROM saved_searches WHERE subject = ?'),
        insert: db.prepare(`INSERT INTO saved_searches (id, subject, name, q, filters, query_hash, created_at, updated_at)
            VALUES (@id, @subject, @name, @q, @filters, @query_hash, @at, @at)`),
        rename: db.prepare('UPDATE saved_searches SET name = ?, updated_at = ? WHERE id = ?'),
        del: db.prepare('DELETE FROM saved_searches WHERE id = ? AND subject = ?'),
        ran: db.prepare('UPDATE saved_searches SET last_run_at = ? WHERE id = ?'),
        // Never moves back: a person opening the results during a notifier tick keeps the later time.
        advance: db.prepare('UPDATE saved_searches SET last_run_at = GREATEST(COALESCE(last_run_at, 0), ?) WHERE id = ?'),
        due: db.prepare('SELECT * FROM saved_searches ORDER BY COALESCE(last_run_at, created_at), id LIMIT ?'),
        total: db.prepare('SELECT COUNT(*) AS n FROM saved_searches'),
    };

    function view(r) {
        return {
            id: r.id,
            name: r.name,
            q: r.q,
            filters: JSON.parse(r.filters),
            created_at: new Date(r.created_at).toISOString(),
            updated_at: new Date(r.updated_at).toISOString(),
            last_run_at: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
        };
    }

    /**
     * Save (subject, q, filters) with a name. The same query again returns the existing row
     * (renamed when a new name is given): { created, saved } | { error: 'limit' }.
     */
    async function save(subject, { name, q, filters }) {
        return await db.tx(async () => {
            const f = canonicalFilters(filters);
            const hash = hashOf(q, f);
            const at = now();
            const existing = await st.byHash.get(subject, hash);
            if (existing) {
                if (name && name !== existing.name) await st.rename.run(name, at, existing.id);
                return { created: false, saved: view(await st.get.get(existing.id, subject)) };
            }
            if ((await st.count.get(subject)).n >= maxPerSubject) return { error: 'limit' };
            const id = `svs_${ids.ulid(at).toLowerCase()}`;
            await st.insert.run({ id, subject, name: name || q || 'All documents', q, filters: JSON.stringify(f), query_hash: hash, at });
            return { created: true, saved: view(await st.get.get(id, subject)) };
        });
    }

    return {
        list: async (subject) => (await st.list.all(subject)).map(view),
        /** One saved search of this subject; another subject's id is the same as a missing one. */
        get: async (subject, id) => {
            if (!ID_RE.test(String(id))) return null;
            const r = await st.get.get(id, subject);
            return r ? view(r) : null;
        },
        save,
        remove: async (subject, id) => ID_RE.test(String(id)) && (await st.del.run(id, subject)).changes > 0,
        markRun: async (id) => await st.ran.run(now(), id),
        /**
         * The notifier's queue: up to `limit` saved searches, longest without a run first, each with its
         * subject and watermark (last_run_at, else created_at; epoch ms).
         */
        due: async (limit) => (await st.due.all(limit)).map(r => ({ ...view(r), subject: r.subject, watermark: Number(r.last_run_at ?? r.created_at) })),
        /** Move the watermark to `at` (epoch ms) after a notification went out or there was nothing new. */
        advance: async (id, at) => await st.advance.run(at, id),
        total: async () => (await st.total.get()).n,
        maxPerSubject,
    };
}

module.exports = { createSavedSearches, canonicalFilters, ID_RE };

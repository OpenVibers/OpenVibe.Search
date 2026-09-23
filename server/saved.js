'use strict';
/**
 * Saved searches: a signed-in person (a usr_ subject) keeps a query (text + filters) and runs it
 * again later. The saved row holds the query only, never results: every run is a fresh query as
 * that person at that moment, so a document that became private or was deleted since the save
 * is simply not there, and one they gained access to is.
 *
 * Notifications for new matches wait for OpenVibe.Network's notifications (README "Saved
 * searches"); last_run_at is kept so that job can tell what is new.
 */
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');

const ID_RE = /^svs_[0-9a-z]{26}$/;

function ensureSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS saved_searches (
        id           TEXT PRIMARY KEY,
        subject      TEXT NOT NULL,                  -- usr_… (the person who saved it)
        name         TEXT NOT NULL,
        q            TEXT NOT NULL DEFAULT '',
        filters      TEXT NOT NULL,                  -- canonical JSON {owner,type,language,facets}
        query_hash   TEXT NOT NULL,                  -- same query saved twice = one row
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        last_run_at  INTEGER,
        UNIQUE (subject, query_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_saved_searches_subject ON saved_searches (subject, created_at);
    `);
}

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
    function save(subject, { name, q, filters }) {
        return db.transaction(() => {
            const f = canonicalFilters(filters);
            const hash = hashOf(q, f);
            const at = now();
            const existing = st.byHash.get(subject, hash);
            if (existing) {
                if (name && name !== existing.name) st.rename.run(name, at, existing.id);
                return { created: false, saved: view(st.get.get(existing.id, subject)) };
            }
            if (st.count.get(subject).n >= maxPerSubject) return { error: 'limit' };
            const id = `svs_${ids.ulid(at).toLowerCase()}`;
            st.insert.run({ id, subject, name: name || q || 'All documents', q, filters: JSON.stringify(f), query_hash: hash, at });
            return { created: true, saved: view(st.get.get(id, subject)) };
        })();
    }

    return {
        list: (subject) => st.list.all(subject).map(view),
        /** One saved search of this subject; another subject's id is the same as a missing one. */
        get: (subject, id) => {
            if (!ID_RE.test(String(id))) return null;
            const r = st.get.get(id, subject);
            return r ? view(r) : null;
        },
        save,
        remove: (subject, id) => ID_RE.test(String(id)) && st.del.run(id, subject).changes > 0,
        markRun: (id) => st.ran.run(now(), id),
        total: () => st.total.get().n,
        maxPerSubject,
    };
}

module.exports = { ensureSchema, createSavedSearches, canonicalFilters, ID_RE };

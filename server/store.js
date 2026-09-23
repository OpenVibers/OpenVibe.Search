'use strict';
/**
 * The document store: revision ordering, tombstones, ACL and facet rows, and the removal /
 * indexed events, all in one transaction with the engine update.
 *
 * Ordering rule (both ingestion paths):
 *   - an incoming revision lower than the stored one is stale and changes nothing;
 *   - at the same revision a deletion wins: a tombstone replaces a document, an upsert never
 *     replaces a tombstone; the same content again is `unchanged`; different content with the
 *     same revision is a `conflict` (first write wins);
 *   - a higher revision replaces whatever is stored, including a tombstone (restore).
 * A tombstone keeps only the identity and revision, so a late, older upsert is still refused.
 */
const { normalize, effectiveIndexability, exposureOf, facetPairs, EXPOSURE } = require('./document');

const EXPOSURE_NAME = Object.fromEntries(Object.entries(EXPOSURE).map(([k, v]) => [v, k]));

function createStore({ db, engine, outbox, purges = null, now = () => Date.now() }) {
    const st = {
        get: db.prepare('SELECT * FROM documents WHERE owner = ? AND type = ? AND id = ?'),
        byRid: db.prepare('SELECT * FROM documents WHERE rid = ?'),
        insert: db.prepare(`INSERT INTO documents (owner, type, id, revision, deleted, visibility, publication_state, exposure,
            index_decision, noindex_reasons, canonical_url, title, language, published_at, updated_at, sort_at, doc, hash, via, event_id, indexed_at)
            VALUES (@owner, @type, @id, @revision, @deleted, @visibility, @publication_state, @exposure,
            @index_decision, @noindex_reasons, @canonical_url, @title, @language, @published_at, @updated_at, @sort_at, @doc, @hash, @via, @event_id, @indexed_at)`),
        update: db.prepare(`UPDATE documents SET revision = @revision, deleted = @deleted, visibility = @visibility,
            publication_state = @publication_state, exposure = @exposure, index_decision = @index_decision,
            noindex_reasons = @noindex_reasons, canonical_url = @canonical_url, title = @title, language = @language,
            published_at = @published_at, updated_at = @updated_at, sort_at = @sort_at, doc = @doc, hash = @hash,
            via = @via, event_id = @event_id, indexed_at = @indexed_at WHERE rid = @rid`),
        delAcl: db.prepare('DELETE FROM doc_acl WHERE rid = ?'),
        insAcl: db.prepare('INSERT OR IGNORE INTO doc_acl (rid, kind, value) VALUES (?, ?, ?)'),
        delFacets: db.prepare('DELETE FROM doc_facets WHERE rid = ?'),
        insFacet: db.prepare('INSERT OR IGNORE INTO doc_facets (rid, key, value) VALUES (?, ?, ?)'),
        ownerPage: db.prepare(`SELECT rid, type, id, revision, deleted, hash, exposure, indexed_at FROM documents
            WHERE owner = @owner AND (@type IS NULL OR type = @type) AND rid > @after ORDER BY rid LIMIT @limit`),
        counts: db.prepare(`SELECT COUNT(*) AS total, SUM(deleted) AS tombstones,
            SUM(CASE WHEN exposure = 3 THEN 1 ELSE 0 END) AS public_listed,
            SUM(CASE WHEN exposure = 2 THEN 1 ELSE 0 END) AS public_unlisted,
            SUM(CASE WHEN exposure = 1 THEN 1 ELSE 0 END) AS restricted FROM documents`),
    };

    function rowValues(doc, hash, { via, eventId }) {
        const idx = effectiveIndexability(doc);
        return {
            owner: doc.owner, type: doc.type, id: doc.id, revision: doc.revision,
            deleted: doc.deleted ? 1 : 0,
            visibility: doc.deleted ? null : doc.visibility,
            publication_state: doc.deleted ? null : doc.publication_state,
            exposure: exposureOf(doc),
            index_decision: idx.decision,
            noindex_reasons: JSON.stringify(idx.reasons),
            canonical_url: doc.deleted ? null : doc.canonical_url,
            title: doc.deleted ? null : doc.title,
            language: doc.deleted ? null : doc.language,
            published_at: doc.deleted ? null : doc.published_at,
            updated_at: doc.deleted ? null : doc.updated_at,
            sort_at: doc.deleted ? '' : (doc.updated_at || doc.published_at || ''),
            doc: JSON.stringify(doc),
            hash,
            via,
            event_id: eventId || null,
            indexed_at: now(),
        };
    }

    function writeSideRows(rid, doc, exposure) {
        st.delAcl.run(rid);
        st.delFacets.run(rid);
        if (exposure === EXPOSURE.none) return;
        if (exposure === EXPOSURE.restricted) {
            for (const s of doc.acl.subjects) st.insAcl.run(rid, 's', s);
            for (const g of doc.acl.groups) st.insAcl.run(rid, 'g', g);
            for (const e of doc.acl.entitlements) st.insAcl.run(rid, 'e', e);
        }
        for (const [k, v] of facetPairs(doc.facets)) st.insFacet.run(rid, k, v);
    }

    function removalReason(prev, doc) {
        if (doc.deleted) return 'deleted';
        if (doc.visibility === 'draft') return 'draft';
        if (doc.publication_state !== 'published') return 'not_published';
        if (prev && prev.visibility !== doc.visibility) return 'visibility_changed';
        return 'noindex';
    }

    function announce(prevRow, prevDoc, doc, exposure, traceId) {
        const prevExposure = prevRow ? prevRow.exposure : EXPOSURE.none;
        const subject = { type: 'document', id: `${doc.owner}/${doc.type}/${doc.id}`, revision: doc.revision };
        const wasPublic = prevExposure >= EXPOSURE.public_unlisted;
        if (exposure < prevExposure) {
            const payload = {
                owner: doc.owner, type: doc.type, id: doc.id, revision: doc.revision,
                reason: removalReason(prevDoc, doc),
                previous_exposure: EXPOSURE_NAME[prevExposure],
                exposure: EXPOSURE_NAME[exposure],
                // Only a URL that was public already: caches and sitemaps purge it.
                canonical_url: wasPublic ? prevRow.canonical_url : null,
            };
            const env = outbox.enqueue({ event_type: 'search.document.removed', subject, trace_id: traceId, payload });
            // Search's own consumer: the owners' removal feed and the CDN purge queue (purge.js).
            if (purges) purges.record(env.event_id, payload);
        }
        if (!doc.deleted && exposure > EXPOSURE.none) {
            outbox.enqueue({
                event_type: 'search.document.indexed',
                subject,
                trace_id: traceId,
                payload: {
                    owner: doc.owner, type: doc.type, id: doc.id, revision: doc.revision,
                    exposure: EXPOSURE_NAME[exposure],
                    reindexed: Boolean(prevRow),
                    canonical_url: exposure >= EXPOSURE.public_unlisted ? doc.canonical_url : null,
                },
            });
        }
    }

    /**
     * Apply a valid index document (or tombstone). Returns
     *   { outcome: 'applied'|'unchanged'|'stale'|'conflict', revision, stored_revision, deleted }
     * Must be called inside a transaction when combined with other writes (inbox); it opens its
     * own otherwise.
     */
    function apply(input, { via = 'api', eventId = null, traceId = null } = {}) {
        const run = () => {
            const { doc, hash } = normalize(input);
            const cur = st.get.get(doc.owner, doc.type, doc.id);
            if (cur) {
                const base = { revision: doc.revision, stored_revision: cur.revision, deleted: Boolean(cur.deleted) };
                if (doc.revision < cur.revision) return { outcome: 'stale', ...base };
                if (doc.revision === cur.revision) {
                    if (cur.deleted && !doc.deleted) return { outcome: 'stale', ...base };
                    if (cur.hash === hash) return { outcome: 'unchanged', ...base };
                    if (!(doc.deleted && !cur.deleted)) return { outcome: 'conflict', ...base };
                }
            }
            const values = rowValues(doc, hash, { via, eventId });
            let rid;
            if (cur) {
                rid = cur.rid;
                st.update.run({ ...values, rid });
            } else {
                rid = Number(st.insert.run(values).lastInsertRowid);
            }
            writeSideRows(rid, doc, values.exposure);
            engine.put(rid, doc, values.exposure);
            const prevDoc = cur ? JSON.parse(cur.doc) : null;
            announce(cur, prevDoc, doc, values.exposure, traceId);
            return { outcome: 'applied', revision: doc.revision, stored_revision: cur ? cur.revision : null, deleted: doc.deleted };
        };
        return db.inTransaction ? run() : db.transaction(run)();
    }

    /**
     * Tombstone a document. revision omitted = the stored revision (a deletion wins the tie), or
     * 0 for a document Search has never seen (so a late older upsert is still refused).
     */
    function remove(owner, type, id, { revision = null, via = 'api', eventId = null, traceId = null } = {}) {
        const run = () => {
            const cur = st.get.get(owner, type, id);
            const rev = revision != null ? revision : (cur ? cur.revision : 0);
            return apply({ owner, type, id, revision: rev, deleted: true }, { via, eventId, traceId });
        };
        return db.inTransaction ? run() : db.transaction(run)();
    }

    function get(owner, type, id) {
        const row = st.get.get(owner, type, id);
        return row ? { row, doc: JSON.parse(row.doc) } : null;
    }

    function byRid(rid) {
        const row = st.byRid.get(rid);
        return row ? { row, doc: JSON.parse(row.doc) } : null;
    }

    /** Reconciliation page for an owner: (type, id, revision, deleted, hash) by insertion order. */
    function ownerPage(owner, { type = null, after = 0, limit = 500 } = {}) {
        const rows = st.ownerPage.all({ owner, type, after, limit: limit + 1 });
        const more = rows.length > limit;
        const page = rows.slice(0, limit);
        return {
            documents: page.map(r => ({
                type: r.type, id: r.id, revision: r.revision, deleted: Boolean(r.deleted),
                exposure: EXPOSURE_NAME[r.exposure], hash: r.hash, indexed_at: new Date(r.indexed_at).toISOString(),
            })),
            next_after: more && page.length ? page[page.length - 1].rid : null,
        };
    }

    function counts() {
        const c = st.counts.get();
        return {
            total: c.total || 0, tombstones: c.tombstones || 0, public_listed: c.public_listed || 0,
            public_unlisted: c.public_unlisted || 0, restricted: c.restricted || 0,
        };
    }

    return { apply, remove, get, byRid, ownerPage, counts, EXPOSURE_NAME };
}

module.exports = { createStore, EXPOSURE_NAME };

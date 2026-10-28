'use strict';
/**
 * The vector side of the Search Fabric's network scope (SF-2): a small interface the PostgreSQL/pgvector
 * implementation satisfies and the tests replace with a fake, because PGlite has no `vector` type.
 *
 *   available()                 the extension and search_embeddings table are both there
 *   hasEmbeddings()             at least one vector for the configured model exists
 *   existing()                  Map(identity -> { model, dim, content_hash }) for the embedder
 *   put(row)                    store/replace one document's vector (owner, type, key is the identity)
 *   nearest({ vector, filters, limit })  the top hits by cosine distance, public listed only
 *
 * Rows are keyed by the documents table's identity (owner, type, key=id), so one document has at most one
 * vector: switching models replaces it instead of mixing two vector spaces. `nearest` always joins
 * documents and keeps only public listed, non-deleted rows, so a document that stops being public can
 * never come back through a stale vector. Filters are the engine's own SQL predicate (owner, type, lang,
 * facets, since) — visibility is decided here, not by the caller.
 */
const { EXPOSURE } = require('../document');
const { filterClause } = require('../engine/pg');

const IDENTITY_SEP = '\u0000';

function identity(owner, type, id) {
    return `${owner}${IDENTITY_SEP}${type}${IDENTITY_SEP}${id}`;
}

function createPgVectorStore({ db, model = 'bge-small-en-v1.5', dim = 384 }) {
    let availability = null;

    async function available() {
        if (availability !== null) return availability;
        try {
            const ext = await db.prepare("SELECT 1 AS ok FROM pg_extension WHERE extname = 'vector'").get();
            if (!ext) return (availability = false);
            const table = await db.prepare("SELECT to_regclass('search_embeddings') AS name").get();
            return (availability = Boolean(table && table.name));
        } catch {
            // A database without pg_extension (or a proxy that refuses the query) has no vectors.
            return (availability = false);
        }
    }

    async function hasEmbeddings() {
        if (!await available()) return false;
        const row = await db.prepare('SELECT 1 AS ok FROM search_embeddings WHERE model = @model LIMIT 1').get({ model });
        return Boolean(row);
    }

    /** One round trip for the embedder: every stored vector's identity and content hash. */
    async function existing() {
        const out = new Map();
        if (!await available()) return out;
        const rows = await db.prepare('SELECT owner, type, key, model, dim, content_hash FROM search_embeddings').all();
        for (const row of rows) {
            out.set(identity(row.owner, row.type, row.key), {
                model: row.model,
                dim: Number(row.dim),
                content_hash: row.content_hash,
            });
        }
        return out;
    }

    async function put({ owner, type, key, embedding, contentHash, updatedAt = new Date().toISOString() }) {
        if (!Array.isArray(embedding) || embedding.length !== dim) throw new Error(`embedding must have ${dim} dimensions`);
        await db.prepare(`INSERT INTO search_embeddings (owner, type, key, model, dim, embedding, content_hash, updated_at)
            VALUES (@owner, @type, @key, @model, @dim, @embedding::vector, @content_hash, @updated_at)
            ON CONFLICT (owner, type, key) DO UPDATE SET
                model = EXCLUDED.model, dim = EXCLUDED.dim, embedding = EXCLUDED.embedding,
                content_hash = EXCLUDED.content_hash, updated_at = EXCLUDED.updated_at`).run({
            owner, type, key,
            model,
            dim: embedding.length,
            embedding: JSON.stringify(embedding),
            content_hash: contentHash,
            updated_at: updatedAt,
        });
    }

    /** Top hits by cosine distance among the public listed documents the filters allow. */
    async function nearest({ vector, filters = {}, limit = 100 }) {
        if (!Array.isArray(vector) || vector.length !== dim) return [];
        const params = { qvec: JSON.stringify(vector), r_model: model, r_dim: dim, limit };
        const where = filterClause(filters, params);
        const rows = await db.prepare(`SELECT d.rid AS rid, (e.embedding <=> @qvec::vector) AS distance
            FROM search_embeddings e
            JOIN documents d ON d.owner = e.owner AND d.type = e.type AND d.id = e.key
            WHERE e.model = @r_model AND e.dim = @r_dim
              AND d.deleted = 0 AND d.exposure = ${EXPOSURE.public_listed}${where}
            ORDER BY e.embedding <=> @qvec::vector, d.rid
            LIMIT @limit`).all(params);
        return rows.map((row) => ({ rid: Number(row.rid), distance: Number(row.distance) }));
    }

    return {
        name: 'pgvector', model, dim,
        available, hasEmbeddings, existing, put, nearest,
    };
}

module.exports = { createPgVectorStore, identity, IDENTITY_SEP };

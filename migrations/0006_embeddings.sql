-- phase: expand
-- Semantic ranking (SF-2, plan 2026-10-28 §4.5): one embedding per public document for the Search Fabric's network
-- scope. PostgreSQL 18 with pgvector 0.8.1 has the extension already (created by the superuser in ov_search); PGlite
-- has no `vector` type, so this migration checks pg_extension first and creates nothing there. The DDL runs through
-- EXECUTE because the vector type must not even be parsed on a database without the extension.
DO $embeddings$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
        -- owner, type and key are the document's identity exactly as the documents table keys it (owner, type, id);
        -- one row per document, so switching models replaces the old vector instead of mixing two vector spaces.
        EXECUTE $ddl$
            CREATE TABLE IF NOT EXISTS search_embeddings (
                owner        text COLLATE "C" NOT NULL,
                type         text COLLATE "C" NOT NULL,
                key          text COLLATE "C" NOT NULL,
                model        text COLLATE "C" NOT NULL,
                dim          integer NOT NULL,
                embedding    vector(384) NOT NULL,
                content_hash text COLLATE "C" NOT NULL,
                updated_at   timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (owner, type, key)
            )
        $ddl$;
        EXECUTE 'CREATE INDEX IF NOT EXISTS search_embeddings_embedding_hnsw
                 ON search_embeddings USING hnsw (embedding vector_cosine_ops)';
    END IF;
END
$embeddings$;

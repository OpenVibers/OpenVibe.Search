# ADR: search engine for Wave 14 — SQLite FTS5 now, PostgreSQL FTS when Postgres exists

**Status:** accepted for alpha (2026-09-22) · **Owner:** OpenVibe.Search · **Roadmap:** §4.2 A, §15.12, Wave 14

## Context

The roadmap asks for an event-fed, permission-aware index with the engine chosen only after
measuring need: *"PostgreSQL FTS first; Meilisearch or OpenSearch only if justified"*, and warns
against engine shopping. The network runs every service on one host with one SQLite database per
service; PostgreSQL is not provisioned yet (it arrives with the legacy-retirement track). There
is no corpus to measure: no product indexes anything today.

## Decision

1. **SQLite FTS5 inside Search's own database** (`/var/lib/openvibe-search/search.db`), no
   external engine, no new daemon. FTS5 ships in better-sqlite3's bundled SQLite (3.49), gives
   BM25 ranking, snippets and prefix queries, and commits in the same transaction as the
   document row, ACL rows, facet rows, the inbox receipt and the outbox event. That transaction
   is what makes "a visibility change or deletion removes the document from results immediately"
   true without a second system to converge.
2. **Behind a small engine interface** — [server/engine/fts5.js](../server/engine/fts5.js):
   `put(rid, doc, exposure)`, `remove(rid)`, `search`, `browse`, `facetCounts`, `suggest`. The
   store, the revision rules, the ACL model and the APIs do not know FTS5 exists.
3. **PostgreSQL FTS is the next engine**, as the roadmap says, once a PostgreSQL instance exists
   for services: a `tsvector` column with `websearch_to_tsquery`/`ts_rank_cd`, GIN index, the same
   ACL predicate as SQL. Meilisearch/OpenSearch stay out unless a measurement justifies them.

## How visibility is enforced inside the engine

- Documents are split into two FTS tables by audience: `fts_public` holds only public,
  published, indexable documents; `fts_restricted` only published unlisted/members/private
  documents. Drafts, unpublished, deleted and public-noindex documents are in neither, so no text
  query can reach them.
- An anonymous query (or a viewer without a subject) only ever reads `fts_public`. BM25 statistics
  are per table, so private documents cannot even shift the ranking an anonymous caller sees.
- A signed-in query adds a second branch over `fts_restricted`, filtered in the same SQL by the
  viewer's ACL keys (`doc_acl`: subject, group, entitlement). Facet counts and suggestions reuse
  the exact same visible-set SQL, so they cannot count or complete what the viewer cannot see.
- Known limitation: within `fts_restricted`, BM25 term statistics include restricted documents the
  viewer cannot see. The effect on ordering is statistical and returns no content, but it is a
  theoretical side channel between signed-in users; a per-audience or per-tenant index (or
  PostgreSQL with ranking that ignores global statistics) removes it if it ever matters.

## Consequences

- One process and one file: backups, restores and moves are the same as every other service.
- Write throughput is SQLite's (single writer, WAL). That is ample for the expected corpus (tens to
  hundreds of thousands of documents); the trigger to revisit is measured: p95 query latency over
  200 ms at the public edge, index size over a few GB, or write contention in `/api/ready`.
- Tokenizer is `unicode61 remove_diacritics 2` without stemming: predictable across languages
  (Japanese/Chinese get no word segmentation; a later engine or an ICU tokenizer fixes that).
- Moving to PostgreSQL is an engine swap plus a re-index from owners (the reconciliation API
  exists for exactly that), not a contract change.

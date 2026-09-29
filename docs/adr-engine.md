# ADR: search engine for Wave 14 — PostgreSQL full-text search

**Status:** accepted (2026-09-22; engine updated to PostgreSQL on 2026-09-28, ADR-035) · **Owner:** OpenVibe.Search · **Roadmap:** §4.2 A, §15.12, Wave 14

## Context

The roadmap asks for an event-fed, permission-aware index with the engine chosen only after
measuring need: *"PostgreSQL FTS first; Meilisearch or OpenSearch only if justified"*, and warns
against engine shopping. No external search engine is wanted: the corpus is SQL rows, the ACL
model is SQL, and a visibility change must leave results in the same transaction that makes it.
There is no corpus to measure: no product indexes anything today.

## Decision

1. **PostgreSQL full-text search in the service's own database** (`search_fts`, ADR-035), no
   external engine, no new daemon. A `tsvector` weighted title A, summary B, body C with a GIN
   index gives ranked matches, `ts_headline` snippets and prefix queries, and commits in the same
   transaction as the document row, ACL rows, facet rows, the inbox receipt and the outbox event.
   That transaction is what makes "a visibility change or deletion removes the document from
   results immediately" true without a second system to converge.
2. **Behind a small engine interface** — [server/engine/pg.js](../server/engine/pg.js):
   `put(rid, doc, exposure)`, `remove(rid)`, `search`, `browse`, `facetCounts`, `suggest`, `counts`,
   `reconcile`. The store, the revision rules, the ACL model and the APIs do not know the engine.
3. **Meilisearch/OpenSearch stay out** unless a measurement justifies them, as the roadmap says.

## How visibility is enforced inside the engine

- One table, `search_fts`, split by the `audience` column: exposure 3 holds only public, published,
  indexable documents; exposure 1 holds published unlisted/members/private documents. Drafts,
  unpublished, deleted and public-noindex documents have no row, so no text query can reach them.
- An anonymous query (or a viewer without a subject) only ever reads audience 3. Ranking statistics
  are computed over the same visible rows, so private documents cannot shift what an anonymous
  caller sees.
- A signed-in query adds a second branch over audience 1, filtered in the same SQL by the viewer's
  ACL keys (`doc_acl`: subject, group, entitlement). Facet counts and suggestions reuse the exact
  same visible-set SQL, so they cannot count or complete what the viewer cannot see.
- Known limitation: within audience 1, `ts_rank` term statistics include restricted documents the
  viewer cannot see. The effect on ordering is statistical and returns no content, but it is a
  theoretical side channel between signed-in users; a per-audience or per-tenant index removes it
  if it ever matters.

## Consequences

- One database: backups, restores and moves are the same as every other service (PostgreSQL,
  ADR-035).
- Ranking is `ts_rank` with title/summary/body weights 10/4/1 times a freshness boost
  ([README "Ranking"](../README.md#ranking)), returned as minus the score so ascending keyset
  cursors work.
- Text is folded (diacritics removed) and split into runs of letters and digits before the
  `simple` configuration sees it, so tokens are predictable across languages (Japanese/Chinese get
  no word segmentation; a later engine or ICU tokenizer fixes that) and a query and the index
  always agree on what a word is.
- The index is derived from `documents.doc`: at boot, when its counts disagree with the documents
  table, it is rebuilt (the reconciliation API lets owners re-push everything if needed).

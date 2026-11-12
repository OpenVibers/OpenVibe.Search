# AGENTS.md — OpenVibe.Search

## Project overview

OpenVibe.Search is the network's permission-aware discovery service: it owns the canonical index
document (`search.index-document@1`), receives documents from product services through OpenVibe.Events
or the owner API, keeps a revision-ordered copy with tombstones and removals, and answers queries
through an ACL-filtered PostgreSQL full-text engine (plus optional semantic/fabric ranking and code
search). It is the only service that stores the network's search index; it does not own the content.

- **Entry:** `server/index.js` (`start()` is also the test entry); Express app in `server/app.js`.
- **Port / host:** `127.0.0.1:4710`, public `https://search.openvibe.network`; service id `search`.
- **Index and query:** `server/store.js`, `server/document.js`, `server/engine/pg.js`,
  `server/ranking.js`, `server/api/`; saved searches in `server/saved.js`.
- **Ingest:** `POST /internal/events` (`server/app.js`) verifies and applies index-document
  deliveries; the owner API writes directly. Removals and CDN purges are in `server/purge.js`.
- **Fabric / semantic search:** `server/fabric/` (local `bge-small-en-v1.5` 384-dim embeddings,
  vector store, RRF; `docs/adr-engine.md`).
- **Code search:** `server/code/` (`registry.js`, `search.js`, `deep.js`, hosts from
  `server/code/sources/`; `docs/code-sources.md`).
- **Pages:** `server/web/page.js` renders the search page and saved searches with
  `openvibe-shared/shell`; `server/web-sso.js` mounts Network sign-in. No SPA/build step.
- **MCP:** `server/api/mcp.js` exposes the read-only search tools at `/mcp`.

## Owns, does not own

Owns: the `documents`, `doc_acl`, `doc_facets`, `search_fts`, `idempotency_receipts`,
`ingest_rejections`, `service_outbox`, `removals`, `cdn_purges` and `saved_searches` tables; the
query API and its ranking/ACL filtering; the search page; deletion and visibility propagation,
including the CDN purge of a removed public URL.

Does not own: any product's content, publication state or indexability decision (the publishing
service is the source of truth); sitemaps, feeds or page caches (each product reads the removal feed
or listens to `search.document.removed`); identity, groups or entitlements (Network, products,
VIP/Billing — Search matches only the keys it is given).

## Who calls it, what it calls

Every publication product (Wiki, Blog, News, Reviews, Deals, Coupons, Trade, Work, Inventory and the
rest) tells Search about its resources with the one index-document contract, normally by publishing
an Events topic. SDK `openvibe-sdk/search` is the public query client (`query`, `iterate`,
`suggest`, `document`, `code`, `codeIterate`); saved searches are the person's own.

Search calls OpenVibe.Network (JWKS keys, service token, with `SEARCH_SAVED_NOTIFY=1` identity
resolve and notification push), OpenVibe.Events (index-document deliveries and the
`search.document.*` outbox), the Cloudflare purge API when configured, three code-source hosts, and
OpenVibe.AI for deep code search (`ai.complete`). It never fetches a URL a user chose.

## Database and migrations

PostgreSQL `ov_search` (ADR-035) through `openvibe-sdk/db`: `DATABASE_URL` through PgBouncer for
queries, `DATABASE_DIRECT_URL` for migrations. `server/db.js` opens and migrates at boot under an
advisory lock; `migrations/NNNN_*.sql` are ordered and never edited after they run. The full-text
index is derived and is reconciled/rebuilt at boot when it disagrees with `documents`. The
`event_outbox` table remains only for the N-1 rollback window (the expand migration copies pending
rows to `service_outbox`). A new table or column is an expand migration; removal waits for a contract
migration.

## Auth and exposure

Tokens are RS256 JWTs from OpenVibe.Network, verified with the SDK JWKS client at
`/api/.well-known/jwks`. Service tokens need audience `openvibe.search` and the route's capability:
`search.document.write` (owner writes, own service slug only), `search.query.delegate` (query and
saved-search routes acting for `X-OV-Subject`), `search.query.run` (public search/suggest/document
reads) and `search.code.sources`. Delegation headers (`X-OV-Subject`, `X-OV-Groups`,
`X-OV-Entitlements`) count only with a `search.query.delegate` service token. A bearer that does not
verify is a 401, never anonymous.

The public vhost exposes the search page, the GET query API, saved searches and `/api/health`. The
owner API, document writes, `/internal/events` and `/metrics` are loopback-only; nginx takes client
addresses from `$remote_addr`.

## Deploy

`sudo ovhost deploy search` on the production host (git-checkout: fetch, fast-forward
`/opt/openvibe.search`, install on a lockfile change, restart, wait for `/api/ready`; rollback
`sudo ovhost rollback search --to <sha>`). Unit `openvibe-search.service`
(`deploy/systemd/openvibe-search.service`), env `/etc/openvibe/search.env`, nginx
`deploy/nginx/search.openvibe.network.conf`. `ovhost deploy` removes the previous sha when readiness
fails. The schema only adds tables/columns, so an older release still runs after a rollback.

## Commands and tests

```bash
npm ci
npm run dev                 # NODE_ENV=development, http://127.0.0.1:4710
npm test                    # every test/*.test.js, PGlite per file, no network
npm test -- acl outbox      # only matching files
npm run test:pg             # the same on PostgreSQL (SEARCH_TEST_STORE=pg)
npm run subscribe           # create the Events subscription once (HMAC)
node --check <file.js>      # syntax check; no linter
```

`test/run.js` delegates to `openvibe-shared/test-runner` (60 s, serial): each file gets its own
PGlite database, generated RSA keys and stub subscribers on random ports; a skipped file is not
counted as passed. `test/acl-leak.test.js` is the privacy guard; `test/documents.test.js` covers
revision ordering and tombstones; `test/outbox*.test.js` the N-1 outbox; `test/front.test.js` and
`test/page.test.js` the pages.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; no build step and no frontend framework.
- Errors and responses are problem+json (`openvibe-contracts/http`); never leak an ACL or a raw
  database row. Every API response is `no-store`.
- Owner writes only under the caller's own service slug; visibility is enforced in the engine SQL and
  re-checked per hit (hidden = the same 404 as missing).
- Runtime state (timers, subscribers, sockets) starts in `server/index.js` after config load, never at
  module load; the signal handler stops them in order.
- Limits go through `server/actor-limits.js` (`openvibe-sdk/limits`), after the credential and before
  any work.

## Key pitfalls

- **An ACL leak is the worst bug here.** `test/acl-leak.test.js` exists because a query hit must never
  expose a document the caller cannot see; a hidden document is a 404, not a 403.
- **Revision ordering and tombstones:** a stale or out-of-order event must not resurrect a removed or
  older document; `documents.revision` and `removals` decide, not arrival time.
- **The index is derived:** do not hand-write `search_fts`; reconcile/rebuild is the boot path.
- **Events outbox:** `emit` inside the change's transaction, or the event and the row disagree after a
  crash. `event_outbox` is only for the rollback window.
- **Public/loopback split:** adding a route under the public vhost by accident is a security change;
  update `deploy/nginx/search.openvibe.network.conf` and the security tests together.
- **Saved searches store the query only** — never the person's results or identity in clear text.

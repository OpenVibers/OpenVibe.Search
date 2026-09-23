# OpenVibe.Search

> Permission-aware discovery for the network: the canonical index document, event-fed indexing,
> an ACL-filtered query API, and deletion/visibility propagation.

**Status:** alpha (roadmap Wave 14). Deployed internally, not launched: it runs on the production host
(127.0.0.1:4710 only, since 2026-09-23) and is fed through Events, but the index holds only 10 wiki
tombstones and 0 public documents.  
**Domain:** `search.openvibe.network` (vhost in [deploy/nginx/](deploy/nginx/search.openvibe.network.conf),
not installed yet: until it is, the name falls through to the admin.openvibe.network placeholder.
Install steps: [Public host](#public-host))  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 — roadmap §4.2 A, §15.12, §29, §32.3.  
**License:** AGPL-3.0.

## Purpose

Every publication product (Wiki, Blog, News, Reviews, Deals, Coupons, Trade) and every other
service with discoverable content tells Search about its resources with one contract —
[`search.index-document@1`](docs/contracts-proposal/) — and Search answers queries without ever
returning a document the caller may not see. The owner stays the source of truth; Search keeps a
revision-ordered copy and can be reconciled against it.

## Running it

```bash
npm install
cp .env.example .env
npm run dev            # http://127.0.0.1:4710
npm test               # every test/*.test.js, temp databases, no network needed
```

Node 22 in production (`fnm exec --using=22.22.1 npm test`). Production: `/opt/openvibe.search`,
env `/etc/openvibe/search.env`, unit [deploy/systemd/openvibe-search.service](deploy/systemd/openvibe-search.service),
index `/var/lib/openvibe-search/search.db`, nginx [deploy/nginx/search.openvibe.network.conf](deploy/nginx/search.openvibe.network.conf)
(the public vhost exposes the search page, the GET query API, saved searches and health; the owner
API and the Events webhook are loopback-only, and owners and Events call `127.0.0.1:4710`).

`GET /api/health` is liveness. `GET /api/ready` (openvibe-shared/ready) is 503 only when the
database (the documents and both full-text tables) fails; a Network signing key that has not loaded
(anonymous queries still answer) and a full-text index out of step with the documents table degrade
it. It also reports document counts by exposure, the outbox backlog and whether the Events webhook
is on. `GET /metrics` (openvibe-shared/metrics) answers direct loopback callers only: golden signals
by route template, `search_documents{exposure}`, `search_documents_indexed{index}` and the outbox
backlog.

## Query API

```http
GET /api/v1/search?q=solar+eclipse&owner=news&type=story&lang=en&facet.topic=space&facets=topic&limit=20&cursor=…
GET /api/v1/suggest?q=sol
GET /api/v1/documents/:owner/:type/:id
```

- `q` is plain text: word tokens only, every word required, a trailing `*` makes the last word a
  prefix. FTS operators and column filters in `q` are neutralised. No `q` = newest first.
- Results carry `owner, type, id, revision, visibility, title, summary, canonical_url, facets,
  language, authorship, provenance, published_at, updated_at, indexable` and a `snippet_html`
  (escaped text with `<mark>`). Never the ACL. `next_cursor` is bound to the query that made it.
- `facets=k1,k2` returns value counts over exactly the visible matching set. There is no total count.
- Every response is `Cache-Control: no-store`.

Who sees what:

| Caller | Sees |
|---|---|
| anonymous (or a user token without `subject_id`) | public, published, indexable documents |
| Network user JWT (`ov_token` cookie or Bearer) | + restricted documents whose ACL names its subject or `role:<role>` |
| service token with `search.query.delegate` + `X-OV-Subject` | + the ACL matches of that `usr_`/`gst_` subject and the `X-OV-Groups` / `X-OV-Entitlements` the service vouches for |

Drafts, unpublished, retracted and deleted documents are returned to nobody. A hidden document and
a missing one give the same 404. A Bearer that does not verify is a 401 (never downgraded to
anonymous); delegation headers from a browser are ignored. Visibility is enforced in the engine
SQL (two FTS tables split by audience plus an ACL predicate) and re-checked per hit — see
[docs/adr-engine.md](docs/adr-engine.md).

The search page at `/` runs the same query as HTML for browsers (no JavaScript; no-store; result
pages `noindex`; anonymous unless this host has an `ov_token` cookie). Other clients get a text
route index at `/`.

### Ranking

Full-text results are ordered by bm25 relevance (title ×10, summary ×4, body ×1) multiplied by a
freshness boost:

```
score = bm25 × (1 + W × 2^(−age_days / H))        W = SEARCH_FRESHNESS_WEIGHT (default 1)
                                                  H = SEARCH_FRESHNESS_HALF_LIFE_DAYS (default 30)
```

`age_days` counts from `published_at`, else `updated_at` (an edit does not make an old document
new); a future date counts as today and a missing one gets no boost. With the defaults a document
published today counts ×2.0, 30 days old ×1.5, 60 days ×1.25, 90 days ×1.125 and a year old ×1.0002:
relevance still decides, and between comparably relevant documents the newer one ranks first.
`W = 0` turns it off. Suggestions use the same score; browsing without `q` stays newest first. A
cursor carries its first page's clock, so later pages rank on the same scores
(`test/freshness.test.js`).

### Saved searches

```http
GET    /api/v1/saved-searches
POST   /api/v1/saved-searches            { "name": "Eclipses", "q": "solar eclipse", "owner": "news", "facets": { "topic": ["space"] } }
GET    /api/v1/saved-searches/:id
DELETE /api/v1/saved-searches/:id
GET    /api/v1/saved-searches/:id/results?limit=&cursor=
```

A signed-in person (a Network user token with a `usr_` subject, as Bearer or the `ov_token`
cookie) or a first-party service with `search.query.delegate` acting for `X-OV-Subject: usr_…`
keeps up to `SEARCH_SAVED_MAX_PER_SUBJECT` (50) queries: words, filters or both. Saving the same
query again returns the existing one (renamed if a new name is given). Only the query is stored:
every run is a fresh query as that person at that moment, so what they lost access to (or what was
deleted) is gone and what they gained appears. Someone else's saved search is the same 404 as a
missing one; guests cannot save; a cookie-authenticated POST/DELETE must carry this origin's
`Origin`. Notifications of new matches wait for OpenVibe.Network's notifications (`last_run_at` is
kept for that job). Signing in on `search.openvibe.network` itself needs a Network OAuth client
(`search`), which does not exist yet: today saved searches are used through Bearer tokens or a
product acting for its visitor.

## Indexing

Owners call with an OpenVibe.Network client-credentials token (`audience=openvibe.search`) holding
`search.document.write`, and may only touch documents whose `owner` is their own service slug.

```http
PUT    /api/v1/documents/wiki/page/pg_123      { …search.index-document@1… }
DELETE /api/v1/documents/wiki/page/pg_123?revision=8
GET    /api/v1/owners/wiki/documents?type=page&after=0&limit=500      # reconciliation
GET    /api/v1/owners/wiki/documents/page/pg_123                      # stored doc + effective indexability
GET    /api/v1/owners/wiki/rejections                                 # refused index events
```

Or, preferred, through Events: publish `wiki.index_document.upserted` (payload = the document) or
`wiki.index_document.deleted` (payload = `{type, id, revision}`) from the owner's outbox with
`visibility: "internal"`. Search subscribes to `*.index_document.*` (`npm run subscribe`) and
consumes deliveries at `POST /internal/events`: HMAC-verified (`SEARCH_EVENTS_SECRET`), one inbox
receipt per event in the same transaction as the change, so a redelivery never applies twice. A
source may only write its own owner's documents (`SEARCH_EVENT_OWNERS` limits which sources feed
the index at all).

Revision order, on both paths: an older revision is `stale` and changes nothing; the same revision
again is `unchanged`; different content at the same revision is a `conflict` (first write wins); at
equal revision a deletion wins; a tombstone keeps the revision, so a late older upsert cannot bring
the document back; a higher revision restores it. Search only makes indexability stricter (drafts,
private/members/unlisted, unpublished, stub-provider provenance and public documents without a
canonical URL are always `noindex`, with the reason recorded).

Every change that lowers a document's exposure (deleted, drafted, unpublished, made
private/members/unlisted, or public → noindex) leaves results in the same transaction and emits
`search.document.removed` (with the canonical URL if it had been public, so caches and sitemaps
purge); every accepted upsert emits `search.document.indexed`. Both go through a transactional
outbox relayed to Events when `EVENTS_URL` is set.

### Removals, caches and the CDN

Search consumes its own removals ([server/purge.js](server/purge.js)); in the same transaction as
the `search.document.removed` event it records:

- **the owner's removal feed** — `GET /api/v1/owners/:owner/removals?after=&limit=` (owner token,
  own owner only): `seq, event_id, type, id, revision, reason, previous_exposure, exposure,
  canonical_url, at`. Products own their pages, caches and sitemaps, so they poll this feed (or
  subscribe to `search.document.removed`) and drop the document from anything derived they keep.
- **a Cloudflare purge queue** — only when `CLOUDFLARE_PURGE_TOKEN` is set (inert otherwise:
  nothing is queued or sent). For a removal whose URL had been public, the canonical URL and the
  `CLOUDFLARE_PURGE_RELATED_PATHS` on its host (default `/sitemap.xml`) are queued once each and
  purged by URL (`POST /zones/:zone/purge_cache {"files": […]}`, at most 30 per call) in the zone
  `CLOUDFLARE_ZONE_IDS` maps the host (or its nearest parent domain) to. A host with no zone is
  recorded as `skipped`. 429, 5xx and network errors back off and retry (8 attempts); a refusal is
  retried one URL at a time and then marked `failed`. The token needs only *Zone → Cache Purge →
  Purge* on those zones; it is read from the environment, sent only in the Authorization header,
  and never stored or logged. `/api/ready` reports the purge state and counts, `/metrics` the
  `search_cdn_purges{state}` gauge (`test/purge.test.js`, against a mocked Cloudflare API).

## Owns

- the index document contract (`search.index-document@1`, released in openvibe-contracts v0.12.0; proposal in [docs/contracts-proposal/](docs/contracts-proposal/))
- `documents`, `doc_acl`, `doc_facets`, `fts_public`, `fts_restricted`, `idempotency_receipts`,
  `ingest_rejections`, `event_outbox`, `removals`, `cdn_purges`, `saved_searches` (SQLite; engine
  decision in [docs/adr-engine.md](docs/adr-engine.md))
- the query API, its ranking and ACL filtering, the search page and saved searches; deletion and
  visibility-change propagation, including the CDN purge of removed public URLs

## Does not own

- any product's content, publication state or indexability decision (owners and the publishing packages do)
- sitemaps, feeds or page caches (each product; they read the removal feed or listen to
  `search.document.removed`). Search only purges the CDN copy of a removed public URL.
- identity, groups or entitlements (Network, products, VIP/Billing — Search only matches the keys it is given)

## Depends on

- OpenVibe.Contracts (service tokens, problem details, ids, the event envelope)
- OpenVibe.Network (signing key; service principal `search`)
- OpenVibe.Events (index-document deliveries in, `search.document.*` out)

## Capabilities (released in openvibe-contracts v0.12.0; proposal in [docs/capabilities-proposal/](docs/capabilities-proposal/))

| Capability | Routes |
|---|---|
| `search.document.write` | `PUT/DELETE /api/v1/documents/:owner/:type/:id`, `/api/v1/owners/:owner/...` including the removal feed (own owner only) |
| `search.query.delegate` | the query and saved-search routes, acting for `X-OV-Subject` |

Released in `openvibe-contracts` v0.12.0 with the service manifest (this repo pins v0.13.0);
[server/auth.js](server/auth.js) decides them with the contracts grant rule, and CI runs
`openvibe-contracts-check --service search`.

## Acceptance (tests)

- a private or draft document is never returned to an unauthorized query — hits, snippets, facet
  counts, suggestions, direct gets, cursors and FTS-syntax injection (`test/acl-leak.test.js`)
- a visibility change or deletion removes the document from results immediately and emits
  `search.document.removed` (`test/acl-leak.test.js`)
- revision ordering, tombstones, restore, reconciliation (`test/documents.test.js`)
- signed deliveries, inbox dedupe, out-of-order delivery, crash before commit redelivers once,
  owner spoofing refused (`test/webhook-inbox.test.js`)
- outbox relay to Events, retry and poison isolation (`test/outbox.test.js`)
- proposals valid against the contracts schemas (`test/proposals.test.js`)
- removals reach the owner feed; the CDN purge is inert without a token and, with one, purges the
  formerly public URL and its sitemap per zone, retries, isolates refusals and never stores the
  token (`test/purge.test.js`)
- freshness decay, newer-first between equals, relevance over age, stable cursors (`test/freshness.test.js`)
- saved searches: signed-in only, own only, run-time ACL, Origin check for cookies, limits
  (`test/saved-searches.test.js`)
- the search page: public only, escaped, no-store, noindex results, paging (`test/page.test.js`)

Not yet demonstrated: a document with content indexed end to end in production. The Events
subscription delivered 20 wiki events; the 10 upserts were rejected (`owner_not_accepted`, since
fixed) and only the 10 tombstones landed. Wiki pages enter the index once a person reviews them;
Sources has every seed disabled. The removal feed and the CDN purge queue exist, but no product
polls the feed yet and the purge needs a token with Cache Purge permission (the current Cloudflare
token has DNS and rulesets scope only).

Restore drill: `ovhost drill search` passed on the production host on 2026-09-23 (integrity check,
readiness, identical query answers, row counts; see OpenVibe.Host `docs/restore-drills.md`).

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until: an owning runtime
with health/readiness; Network identity and service principals; a public route useful without
JavaScript (the search page at `/`); real
persistence and end-to-end workflows; capabilities and events registered in OpenVibe.Contracts; a
security review; and acceptance tests. The domain is not in `OpenVibe.Sites/sites.json`; this
repository's own vhost serves it.

## Public host

`search.openvibe.network` resolves through Cloudflare, but until this vhost is installed nginx
answers it with its default site (the admin placeholder). The vhost
([deploy/nginx/search.openvibe.network.conf](deploy/nginx/search.openvibe.network.conf)) uses the
Network wildcard certificate, sets the client-address headers from `$remote_addr` only, answers
`/metrics` with 404, keeps `/internal/`, `/api/v1/owners/` and document writes loopback-only, and
answers every unknown path with a JSON 404. Install on the host, after the service runs a release
that has the search page and saved searches (`ovhost deploy search`):

```bash
sudo install -m 0644 /opt/openvibe.search/deploy/nginx/search.openvibe.network.conf /etc/nginx/sites-available/search.openvibe.network.conf
sudo ln -sf /etc/nginx/sites-available/search.openvibe.network.conf /etc/nginx/sites-enabled/search.openvibe.network.conf
sudo nginx -t && sudo systemctl reload nginx
# check
curl -sS https://search.openvibe.network/api/health
curl -sS -H 'Accept: text/html' https://search.openvibe.network/ | grep -o '<title>[^<]*'
curl -sS -o /dev/null -w '%{http_code}\n' https://search.openvibe.network/metrics                   # 404
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://search.openvibe.network/internal/events   # 403
curl -sS -o /dev/null -w '%{http_code}\n' https://search.openvibe.network/api/v1/owners/wiki/removals # 403
```

For the CDN purge, create a Cloudflare API token with only *Zone → Cache Purge → Purge* on the
product zones, then add `CLOUDFLARE_PURGE_TOKEN` and `CLOUDFLARE_ZONE_IDS` to
`/etc/openvibe/search.env` (0600) and restart `openvibe-search`; `/api/ready` then shows
`purge.cdn: "cloudflare"`.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

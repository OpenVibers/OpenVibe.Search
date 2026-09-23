# Proposal for OpenVibe.Contracts: `search.index-document@1`

Files to add to OpenVibe.Contracts in its next release:

| File here | Goes to |
|---|---|
| [contracts/search/index-document.v1.json](contracts/search/index-document.v1.json) | `contracts/search/index-document.v1.json` |
| [catalog-entry.json](catalog-entry.json) | a new entry in `contracts/catalog.json` |
| [../capabilities-proposal/*.json](../capabilities-proposal/) | `manifests/capabilities/` |
| [../service-manifest-proposal.json](../service-manifest-proposal.json) | `manifests/services/search.json` |

Until then Search validates with this file directly (server/document.js); once the release ships,
it switches to `contracts.validate('search.index-document@1')` and CI turns on
`openvibe-contracts-check --service search`.

## The document

One document per owned resource, keyed by `(owner, type, id)` and ordered by the owner's
`revision`:

| Field | Meaning |
|---|---|
| `owner`, `type`, `id` | Typed reference to the owner's resource (`EntityRef` without the label). Only `svc:<owner>` may write it. |
| `revision` | Owner's monotonic revision. Older never overwrites newer; at equal revision a deletion wins. |
| `deleted` | Deletion marker. A tombstone needs only owner/type/id/revision. |
| `visibility` | `public` · `unlisted` · `members` · `private` · `draft` |
| `acl` | `subjects` (usr_/gst_), `groups`, `entitlements` — who may see a non-public document. Never returned to viewers. |
| `canonical_url`, `title`, `summary`, `body` | What is shown and searched. Plain text; no HTML. |
| `facets` | Filterable key → value(s) (category, tags, space, currency, instrument…). |
| `language`, `authorship` | BCP 47 tag; `human` · `ai_assisted` · `ai_generated` · `imported`. |
| `provenance` | Source references (`{service, type, id, revision?, url?, retrieved_at?, stub?}`) — enough to reconcile a claim against its source record. |
| `publication_state` | `draft` · `scheduled` · `published` · `unpublished` · `retracted` · `archived`. Only `published` is served. |
| `published_at`, `updated_at` | The owner's timestamps; never invented. |
| `indexability` | The publishing gate's decision `index`/`noindex` with explicit reasons (roadmap §32.3). |

### Visibility rules Search enforces

| Visibility | In results | By exact id |
|---|---|---|
| `public` (published, indexable) | everyone | everyone |
| `public` (noindex) | nobody | everyone |
| `unlisted` | ACL matches only | any signed-in subject |
| `members` | subject, group or entitlement in `acl` | same |
| `private` | subject in `acl.subjects` | same |
| `draft`, not `published`, deleted | never | never |

Search only makes indexability stricter: `draft`, `private`, `members_only`, `unlisted`,
`not_published`, `stub_provider` and (for public) `missing_canonical_url` are added as reasons
whatever the owner sent.

## How owners send documents

- **Events (preferred):** through the owner's transactional outbox, `event_type`
  `<owner>.index_document.upserted` (payload = the document) or `<owner>.index_document.deleted`
  (payload = `{type, id, revision}`), envelope `subject = {type, id, revision}` of the resource,
  `visibility: "internal"` (never `public`: the payload may describe a private document). The
  body must fit Events' payload limit (64 KB by default).
- **Direct:** `PUT /api/v1/documents/:owner/:type/:id` and `DELETE …?revision=` with a
  `search.document.write` token for audience `openvibe.search`.

Both paths share one revision order. Reconciliation: `GET /api/v1/owners/:owner/documents`
lists `(type, id, revision, deleted, hash)`; diff it against the source of truth and re-send what
differs. Refused events are listed at `GET /api/v1/owners/:owner/rejections`.

## Shapes the planned products will send

| Owner / type | Visibility | Facets | Provenance |
|---|---|---|---|
| `wiki/page` | public, or members with `acl.groups: ["wiki.space:<id>:member"]` | `space`, `tags` | citations → `sources/item` |
| `blog/post` | public, or members with `acl.entitlements: ["vip.plan:<id>"]` | `blog`, `series`, `tags` | — |
| `news/story` | public | `topic`, `cluster` | every claim → `sources/item` |
| `reviews/entity` | public | `category` | signals → `sources/item`; no invented rating |
| `deals/offer` | public | `store`, `currency`, `condition` | price observation → `sources/item` with `retrieved_at` |
| `coupons/coupon` | public | `merchant`, `status` | evidence → `sources/item` |
| `trade/instrument` | public | `exchange`, `kind` | observations/filings → `sources/item` |
| `sources/item` | members, `acl.groups: ["role:admin", "role:global_mod"]` | `category`, `source` | the source item itself |

Search emits `search.document.indexed` and `search.document.removed` (payload: owner, type, id,
revision, `reason`, previous and new exposure, and the canonical URL only when it had been
public) so caches, sitemaps and feeds can purge.

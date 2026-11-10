# Adding a code source

Code search is a small registry (`server/code/registry.js`) over one module per source. A source is
one file, one manifest, one `search()` function, and one fixture set. This page is the contract; if a
source passes `test/code-sources.test.js`, it is ready to be switched on in the owner console.

## What the registry expects

Create `server/code/sources/<id>.js` exporting a factory:

```js
function createExampleSource({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    return {
        id: 'example',                    // unique, lower-case; the result's `source`
        kind: 'code',
        label: 'Example code index',      // the console's name
        cost: 'free; 60 calls/minute',    // shown to the owner, not billed here
        keyName: 'EXAMPLE_CODE_TOKEN',    // the env variable; the value is never returned
        requiredKey: false,               // true: no key -> health "unconfigured", skipped
        order: 40,                        // small first in the merged result and the console
        quota: { perMinute: 60 },         // the registry enforces it, then marks a source quota error
        configured() { return Boolean(config.token); },
        async search({ q, lang, repo, limit, signal }) {
            // ... your request(s), with config.timeoutMs, the injected fetchImpl and `signal` ...
            return [/* normalized results */];
        },
    };
}
```

Register it in `server/code/registry.js` (one line in the `sources` array), its settings in
`server/config.js` (`code.<id>`) and `.env.example`. Do not read `process.env` in the module: the config
is the only way a secret reaches it, and the registry never passes a request's body or query into a key.

## The normalized result

Every result is one file at one commit; the search layer de-duplicates on `<repo>@<ref>:<path>` and
merges the line rows, so a source must not return the same file twice.

```js
{
  source: 'example',
  repo: 'Owner/Repo',                     // no host prefix (github.com/Owner/Repo -> Owner/Repo)
  repo_url: 'https://host/Owner/Repo',    // https to the source's own host, or null
  path: 'src/app.js',
  ref: 'abc123',                          // the commit the file was read at, or null
  line_start: 3,                          // first line of `lines`, null when unplaceable
  line_end: 9,
  lines: [                                // ±2 context, merged, in file order
    { number: 3, text: 'const x = 1;', match: false },
    { number: 5, text: 'createSearcher();', match: true },
  ],
  language: 'JavaScript',                 // or null
  stars: 12,
  licence: 'MIT',                         // SPDX id, or null when the source does not know
  last_commit_at: '2026-11-09T10:00:00Z', // or null; say what it is in last_commit_source
  last_commit_source: 'repository.push',  // e.g. repository.push, commit, file
  permalink: 'https://host/Owner/Repo/blob/abc123/src/app.js#L5',
}
```

Rules, enforced by `test/code-source-contract.js`:

- **Public only.** Drop a repository unless the source can prove it is public (GitHub:
  `private !== true` and `visibility === 'public'`; forge: `visibility === 'public'`; Sourcegraph
  Cloud: public by construction). A private repository is never searched or returned, and a token
  that can see one does not change that.
- **Text, not HTML.** `lines[].text` is data. No markup is generated here; the API escapes on render.
- **https only.** `permalink` and `repo_url` are `https:` to the source's own host, built with
  `httpsUrl()` in `server/code/util.js`. Never `http:`, `javascript:` or a relative URL.
- **No key leaves.** Never put a token in a URL, a log, a result or an error. `keyName` is the only
  key-related field the console sees.
- **Bounded.** Use `config.timeoutMs` and the caller's `signal`; cap files, lines and raw body size.
  A source that cannot answer in time returns an error, not an unbounded wait.
- **No live calls in tests.** Use a fixture and the injected `fetchImpl`; the contract test must pass
  without a network, a key or a provider account.

## The test every source passes

`test/code-sources.test.js` builds each source with `createXSource({ config, fetchImpl })`, calls
`search({ q, limit })` against `test/fixtures/code/`, and runs `assertResults(rows, id)` from
`test/code-contract.js`. For a new source:

1. add `test/fixtures/code/<id>-*.json|txt` (the API answer and the file body(s));
2. add one case to `test/code-sources.test.js` with the source's own facts (a public hit, the line
   numbers, the permalink host, a private item that must not appear);
3. run `npm test -- code-sources code-search` and then the whole suite once.

A source also appears in `GET /api/v1/search/code`'s `sources` array with `ok`, `count`, `latency_ms`,
`error` and `code`, and in the console at `/console/code-sources` with its switch, key name, quota and
health. A failing source does not fail the query: the other sources still answer, and the owner sees
the last error.

## The three sources shipped today

| id | Key | Limit | Notes |
|---|---|---|---|
| `github` | `GITHUB_CODE_TOKEN` (required) | 10 API requests/minute | Default branch, <384 KB files, archived repos excluded; raw blob for line numbers; `last_commit_at` is the repository's push time |
| `sourcegraph` | `SOURCEGRAPH_TOKEN` (optional) | 30/minute by our registry; Cloud has no published quota | Public stream; no licence; `last_commit_at` is null (the stream gives repo fetch time, not commit time) |
| `forge` | `FORGE_TOKEN` (optional) | 60/minute by our registry | No global forge search: fans out over up to `SEARCH_FORGE_MAX_REPOS` public repositories (newest pushed first, or `FORGE_CODE_REPOS`); one git-grep per repository |

To turn one off, use the console switch or
`PUT /api/v1/code/sources/:id` with a service token carrying `search.code.sources` and
`{"enabled": false}`. The choice is stored in `code_source_settings` and survives a restart.

## Not accepted as a source (yet)

- grep.app (Vercel checkpoint on a server-side request), searchcode's public API (removed; the product
  is now self-hosted and keyed), Codeberg (no global code-search route; its repo API rate-limits).
- Package registries (npm, PyPI, crates) and Hugging Face are fetch layers, not indexes: use them after
  a name is known, not as a query source.
- A private index (Zoekt/Sourcebot) is the next step if the fan-out becomes the bottleneck; it should
  be its own source module and its own policy.

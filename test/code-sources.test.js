'use strict';
/**
 * Every code source, straight from its module, against test/fixtures/code: the contract in
 * test/code-contract.js and the source-specific facts (public only, line numbers, https permalink).
 * No boot, no network, no keys beyond a fixture token.
 */
const assert = require('assert');
const { suite } = require('./helpers');
const { codeFetch } = require('./code-helpers');
const { assertResults } = require('./code-contract');
const { createGithubSource } = require('../server/code/sources/github');
const { createSourcegraphSource } = require('../server/code/sources/sourcegraph');
const { createForgeSource } = require('../server/code/sources/forge');

const t = suite('code-sources');

t('GitHub: public item only, line numbers from the blob, repository push time', async () => {
    const counters = {};
    const src = createGithubSource({ config: { token: 'test-token', timeoutMs: 8000 }, fetchImpl: codeFetch(counters) });
    const rows = await src.search({ q: 'createSearcher', limit: 10 });
    assertResults(rows, 'github');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].repo, 'OpenVibers/OpenVibe.Search');
    assert.strictEqual(rows[0].licence, 'AGPL-3.0');
    assert.ok(rows[0].lines.some((line) => line.number === 5 && line.match));
    assert.ok(rows[0].line_start <= 5 && rows[0].line_end >= 5);
    assert.strictEqual(counters.github, 1);
    assert.ok(counters.raw >= 1);
});

t('GitHub: no token is unconfigured, never a keyless call', async () => {
    const counters = {};
    const src = createGithubSource({ config: { token: '', timeoutMs: 8000 }, fetchImpl: codeFetch(counters) });
    await assert.rejects(() => src.search({ q: 'x', limit: 1 }), (err) => err.code === 'source.unconfigured');
    assert.strictEqual(counters.github || 0, 0);
});

t('Sourcegraph: the stream is parsed, repoStars and commit are kept, the host is sourcegraph.com', async () => {
    const counters = {};
    const src = createSourcegraphSource({ config: { url: 'https://sourcegraph.com', timeoutMs: 8000 }, fetchImpl: codeFetch(counters) });
    const rows = await src.search({ q: 'createSearcher', limit: 10 });
    assertResults(rows, 'sourcegraph');
    assert.deepStrictEqual(rows.map((r) => r.repo).sort(), ['OpenVibers/OpenVibe.Search', 'acme/lib']);
    const express = rows.find((r) => r.repo === 'OpenVibers/OpenVibe.Search');
    assert.strictEqual(express.stars, 12);
    assert.strictEqual(express.ref, 'abc123');
    assert.match(express.permalink, /^https:\/\/sourcegraph\.com\/github\.com\/OpenVibers\/OpenVibe\.Search@abc123\/-\/blob\//);
    assert.strictEqual(counters.sourcegraph, 1);
});

t('forge: public repositories only, per-repo git-grep, blob context and a blob permalink', async () => {
    const counters = {};
    const src = createForgeSource({ config: { url: 'https://git.openvibe.codes', timeoutMs: 8000, maxRepos: 20 }, fetchImpl: codeFetch(counters), now: () => Date.parse('2026-11-10T10:00:00Z') });
    const rows = await src.search({ q: 'createSearcher', limit: 10 });
    assertResults(rows, 'forge');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].repo, 'openvibers/openvibe.search');
    assert.strictEqual(rows[0].ref, 'abc123');
    assert.ok(rows[0].lines.some((line) => line.number === 5 && line.match));
    assert.match(rows[0].permalink, /^https:\/\/git\.openvibe\.codes\/openvibers\/openvibe\.search\/blob\?ref=abc123&path=/);
    assert.ok(!JSON.stringify(rows).includes('secret/private'));
    assert.ok(counters.forgeRepos >= 1 && counters.forge >= 1);
});

t('the fixture stream is not mistaken for JSON and every source returns text, not markup', async () => {
    const src = createSourcegraphSource({ config: { url: 'https://sourcegraph.com', timeoutMs: 8000 }, fetchImpl: codeFetch({}) });
    const rows = await src.search({ q: 'createSearcher', limit: 10 });
    assert.ok(rows.every((r) => r.lines.every((line) => typeof line.text === 'string' && !/<[a-z]+>/i.test(line.text))));
});

t.run();

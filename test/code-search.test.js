'use strict';
/**
 * Merged code search over fixtures: GitHub, Sourcegraph and our forge answer, the same file at the
 * same commit is one row, exact identifier hits rank first, filters and the cursor work, private
 * repositories never appear, and every link is https. No test reaches the network.
 */
const assert = require('assert');
const { boot, request, suite, userToken } = require('./helpers');
const { codeFetch, codeEnv } = require('./code-helpers');

const t = suite('code-search');
const counters = {};
const fetchImpl = codeFetch(counters);
const ORIGIN = 'https://search.openvibe.network';
let svc;

const call = (method, p, opts = {}) => request(svc.base, method, p, opts);

t('boot', async () => {
    svc = await boot({ env: codeEnv({ BASE_URL: ORIGIN }), fetchImpl });
});

t('a query merges all three sources and de-duplicates one file at one commit', async () => {
    const r = await call('GET', '/api/v1/search/code?q=createSearcher&limit=10');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.query.q, 'createSearcher');
    assert.deepStrictEqual(r.body.results.map((x) => x.repo).sort(), ['OpenVibers/OpenVibe.Search', 'acme/lib']);
    const own = r.body.results.find((x) => x.repo === 'OpenVibers/OpenVibe.Search');
    assert.deepStrictEqual(own.sources.sort(), ['forge', 'github', 'sourcegraph'], 'the same file at abc123 is one row');
    assert.strictEqual(own.ref, 'abc123');
    assert.strictEqual(own.path, 'server/api/query.js');
    assert.strictEqual(own.language, 'JavaScript');
    assert.strictEqual(own.stars, 12);
    assert.strictEqual(own.licence, 'AGPL-3.0');
    assert.strictEqual(own.last_commit_source, 'repository.push');
    assert.ok(own.line_start <= 5 && own.line_end >= 5, 'line 5 is in the window');
    assert.ok(own.lines.some((line) => line.number === 5 && line.match && line.text.includes('createSearcher')));
    assert.ok(/^https:\/\/github\.com\/.+#L5$/.test(own.permalink), own.permalink);
    assert.strictEqual(own.exact_identifier, true);
    const other = r.body.results.find((x) => x.repo === 'acme/lib');
    assert.strictEqual(other.exact_identifier, false);
    assert.ok(!JSON.stringify(r.body).includes('secret/private'), 'a private GitHub repository is dropped');
    assert.deepStrictEqual(r.body.sources.map((s) => s.id), ['github', 'sourcegraph', 'forge']);
    assert.ok(r.body.sources.every((s) => s.ok && s.count >= 1));
    assert.strictEqual(counters.github, 1);
    assert.strictEqual(counters.sourcegraph, 1);
});

t('exact identifier beats a much more starred non-exact hit', async () => {
    const r = await call('GET', '/api/v1/search/code?q=createSearcher');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.results[0].repo, 'OpenVibers/OpenVibe.Search');
    assert.ok(r.body.results[0].stars < r.body.results[1].stars, 'ranking is not stars alone');
});

t('filters are applied to the merged rows as well as to the sources', async () => {
    const own = await call('GET', '/api/v1/search/code?q=createSearcher&repo=OpenVibers%2FOpenVibe.Search');
    assert.strictEqual(own.status, 200, own.text);
    assert.deepStrictEqual(own.body.results.map((x) => x.repo), ['OpenVibers/OpenVibe.Search']);

    const licensed = await call('GET', '/api/v1/search/code?q=createSearcher&licence=AGPL-3.0');
    assert.deepStrictEqual(licensed.body.results.map((x) => x.repo), ['OpenVibers/OpenVibe.Search']);

    const none = await call('GET', '/api/v1/search/code?q=createSearcher&lang=Ruby');
    assert.strictEqual(none.status, 200);
    assert.deepStrictEqual(none.body.results, []);
});

t('a page has a cursor bound to its query', async () => {
    const first = await call('GET', '/api/v1/search/code?q=createSearcher&limit=1');
    assert.strictEqual(first.status, 200, first.text);
    assert.strictEqual(first.body.results.length, 1);
    assert.ok(first.body.next_cursor);
    const second = await call('GET', `/api/v1/search/code?q=createSearcher&limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`);
    assert.strictEqual(second.status, 200, second.text);
    assert.strictEqual(second.body.results.length, 1);
    assert.notStrictEqual(second.body.results[0].repo, first.body.results[0].repo);
    const wrong = await call('GET', `/api/v1/search/code?q=other&limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`);
    assert.strictEqual(wrong.status, 400, wrong.text);
    assert.strictEqual(wrong.body.code, 'search.bad_cursor');
});

t('a malformed query is 400 and never reaches a source', async () => {
    for (const p of ['/api/v1/search/code', '/api/v1/search/code?q=', `/api/v1/search/code?q=${'x'.repeat(201)}`, '/api/v1/search/code?q=x&limit=51', '/api/v1/search/code?q=x&repo=https%3A%2F%2Fevil.example']) {
        const r = await call('GET', p);
        assert.strictEqual(r.status, 400, `${p}: ${r.status} ${r.text}`);
    }
});

t('the public answer is CORS-readable and no host key is in it', async () => {
    const r = await call('GET', '/api/v1/search/code?q=createSearcher');
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
    assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
    assert.ok(!r.text.includes('test-token'));
    assert.ok(!r.text.includes('GITHUB_CODE_TOKEN'));
});

t('a signed-in caller is limited as themselves (the limit applies before the sources)', async () => {
    const token = userToken({ subjectId: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', aud: ['openvibe.search'] });
    const before = counters.github;
    const r = await call('GET', '/api/v1/search/code?q=createSearcher', { token });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(counters.github, before + 1);
});

t('an unconfigured GitHub is skipped, not fatal, and reports unconfigured', async () => {
    const svc2 = await boot({ env: codeEnv({ BASE_URL: ORIGIN, GITHUB_CODE_TOKEN: '' }), fetchImpl: codeFetch({}) });
    try {
        const r = await request(svc2.base, 'GET', '/api/v1/search/code?q=createSearcher');
        assert.strictEqual(r.status, 200, r.text);
        const github = r.body.sources.find((s) => s.id === 'github');
        assert.strictEqual(github.ok, false);
        assert.strictEqual(github.skipped, 'unconfigured');
        assert.ok(r.body.results.length >= 1, 'the other sources still answer');
    } finally {
        await svc2.stop();
    }
});

t('stop', async () => { await svc.stop(); });
t.run();

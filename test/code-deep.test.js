'use strict';
/**
 * Deep code search: signed in only, a rewrite call and an answer call with a hard budget, file:line
 * citations, and the real run cost in the answer. AI and every code source are fixtures.
 */
const assert = require('assert');
const { boot, request, suite, userToken } = require('./helpers');
const { codeFetch, codeEnv } = require('./code-helpers');

const t = suite('code-deep');
const alice = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const token = userToken({ subjectId: alice, aud: ['openvibe.search'] });

t('boot', async () => {
    t.svc = await boot({ env: codeEnv(), fetchImpl: codeFetch(t.counters = {}) });
});

t('anonymous callers and services without a person cannot spend AI', async () => {
    const anon = await request(t.svc.base, 'POST', '/api/v1/search/code/deep', { body: { q: 'Where is createSearcher?' } });
    assert.strictEqual(anon.status, 401);
    assert.strictEqual(anon.body.code, 'token.missing');
    const guest = userToken({ subjectId: 'gst_01JAB2C3D4E5F6G7H8J9K0MNPQ', aud: ['openvibe.search'] });
    const g = await request(t.svc.base, 'POST', '/api/v1/search/code/deep', { token: guest, body: { q: 'Where is createSearcher?' } });
    assert.strictEqual(g.status, 401);
});

t('a signed-in question gets a cited answer, two calls at most, and the real cost', async () => {
    const r = await request(t.svc.base, 'POST', '/api/v1/search/code/deep', { token, body: { q: 'Where is createSearcher defined?' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.queries.length, 3);
    assert.ok(r.body.answer.includes('[1]'), r.body.answer);
    assert.ok(r.body.citations.length >= 1);
    assert.strictEqual(r.body.citations[0].repo, 'OpenVibers/OpenVibe.Search');
    assert.ok(r.body.citations[0].line_start <= 5 && r.body.citations[0].line_end >= 5);
    assert.ok(/^https:\/\//.test(r.body.citations[0].permalink));
    assert.deepStrictEqual(r.body.route.budget.max_model_calls, 2);
    assert.ok(Math.abs(r.body.route.usage.cost_usd - 0.0004) < 1e-9, String(r.body.route.usage.cost_usd));
    assert.strictEqual(r.body.route.explain.find((x) => x.step === 'answer').model_calls, 1);
    assert.strictEqual(t.counters.ai, 2, 'one rewrite and one answer');
    assert.ok(!r.text.includes('test-ai-token'));
});

t('the budget caps the rewrite to the configured number of queries', async () => {
    const deep = require('../server/code/deep');
    assert.deepStrictEqual(deep.parseQueries('["alpha","beta","gamma","delta","epsilon"]', ['fallback'], 3), ['alpha', 'beta', 'gamma']);
    assert.deepStrictEqual(deep.parseQueries('not json, but a sentence', ['fallback'], 3), ['not json, but a sentence']);
    assert.deepStrictEqual(deep.parseQueries('', ['fallback'], 3), ['fallback']);
});

t('an AI failure is a 502 and never a partial answer', async () => {
    const svc2 = await boot({
        env: codeEnv(),
        fetchImpl: codeFetch({}, { ai: () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } }) }),
    });
    try {
        const r = await request(svc2.base, 'POST', '/api/v1/search/code/deep', { token, body: { q: 'Where is createSearcher?' } });
        assert.strictEqual(r.status, 502, r.text);
        assert.strictEqual(r.body.code, 'search.ai_failed');
        assert.ok(!('answer' in (r.body || {})));
    } finally {
        await svc2.stop();
    }
});

t('deep mode is 503 when it is off or the AI client secret is unset', async () => {
    const off = await boot({ env: codeEnv({ SEARCH_CODE_DEEP: 'off' }), fetchImpl: codeFetch({}) });
    try {
        const r = await request(off.base, 'POST', '/api/v1/search/code/deep', { token, body: { q: 'Where is createSearcher?' } });
        assert.strictEqual(r.status, 503, r.text);
        assert.strictEqual(r.body.code, 'search.ai_unavailable');
    } finally { await off.stop(); }
    const noSecret = await boot({ env: codeEnv({ OV_OAUTH_CLIENT_SECRET: '' }), fetchImpl: codeFetch({}) });
    try {
        const r = await request(noSecret.base, 'POST', '/api/v1/search/code/deep', { token, body: { q: 'Where is createSearcher?' } });
        assert.strictEqual(r.status, 503, r.text);
    } finally { await noSecret.stop(); }
});

t('stop', async () => { await t.svc.stop(); });
t.run();

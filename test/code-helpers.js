'use strict';
/**
 * Fixtures and one injected fetch for the code-search tests: every GitHub, Sourcegraph, forge and
 * AI request is answered from test/fixtures/code. No test reaches the network.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'fixtures', 'code');
const cache = new Map();
function fixture(name, as = 'json') {
    const key = `${name}:${as}`;
    if (!cache.has(key)) {
        const raw = fs.readFileSync(path.join(DIR, name), 'utf8');
        cache.set(key, as === 'text' ? raw : JSON.parse(raw));
    }
    return cache.get(key);
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const text = (body, type = 'text/plain', status = 200) => new Response(body, { status, headers: { 'content-type': type } });

const codeEnv = (extra = {}) => ({
    GITHUB_CODE_TOKEN: 'test-token',
    OV_OAUTH_CLIENT_ID: 'search',
    OV_OAUTH_CLIENT_SECRET: 'test-secret',
    SEARCH_CODE_AI_URL: 'https://ai.test',
    SEARCH_CODE_CACHE_MS: '0',
    BASE_URL: 'https://search.openvibe.network',
    ...extra,
});

/**
 * One fetch for a booted Search. `counters` counts the calls per upstream so a test can prove that a
 * source was (or was not) asked. `ai` may be a function (input) => body to simulate a run or a failure.
 */
function codeFetch(counters = {}, { ai = null } = {}) {
    return async (url, opts = {}) => {
        const u = new URL(String(url));
        const href = u.toString();
        if (u.hostname === '127.0.0.1' && u.pathname === '/oauth/token') {
            counters.token = (counters.token || 0) + 1;
            return json({ access_token: 'test-ai-token', token_type: 'Bearer', expires_in: 300 });
        }
        if (u.hostname === 'api.github.com' && u.pathname === '/search/code') {
            counters.github = (counters.github || 0) + 1;
            if (!opts.headers || !String(opts.headers.Authorization || '').startsWith('Bearer ')) return json({ message: 'Requires authentication' }, 401);
            return json(fixture('github-search.json'));
        }
        if (u.hostname === 'raw.githubusercontent.com') {
            counters.raw = (counters.raw || 0) + 1;
            if (u.pathname.includes('acme/lib')) return text(fixture('sourcegraph-acme-js.txt', 'text'));
            return text(fixture('github-query-js.txt', 'text'));
        }
        if (u.hostname === 'sourcegraph.com' && u.pathname === '/.api/search/stream') {
            counters.sourcegraph = (counters.sourcegraph || 0) + 1;
            return text(fixture('sourcegraph-stream.txt', 'text'), 'text/event-stream');
        }
        if (u.hostname === 'sourcegraph.com' && u.pathname.startsWith('/r/')) {
            counters.raw = (counters.raw || 0) + 1;
            return text(u.pathname.includes('acme/lib') ? fixture('sourcegraph-acme-js.txt', 'text') : fixture('sourcegraph-query-js.txt', 'text'));
        }
        if (u.hostname === 'git.openvibe.codes' && u.pathname === '/api/v1/repos') {
            counters.forgeRepos = (counters.forgeRepos || 0) + 1;
            return json(fixture('forge-repos.json'));
        }
        if (u.hostname === 'git.openvibe.codes' && u.pathname.endsWith('/search')) {
            counters.forge = (counters.forge || 0) + 1;
            if (u.pathname.includes('/openvibe.search/')) return json(fixture('forge-search.json'));
            return json({ ref: 'fff', results: [], truncated: false });
        }
        if (u.hostname === 'git.openvibe.codes' && u.pathname.endsWith('/raw')) {
            counters.raw = (counters.raw || 0) + 1;
            return text(fixture('forge-query-js.txt', 'text'));
        }
        if (u.hostname === 'ai.test' && u.pathname === '/api/v1/runs') {
            counters.ai = (counters.ai || 0) + 1;
            if (typeof ai === 'function') return ai(JSON.parse(opts.body || '{}'));
            const body = JSON.parse(opts.body || '{}');
            const rewrite = /JSON array/.test(String(body.input && body.input.messages && body.input.messages[0] && body.input.messages[0].content));
            return json(fixture(rewrite ? 'ai-rewrite.json' : 'ai-answer.json'));
        }
        throw new Error(`unexpected fetch in a code test: ${href}`);
    };
}

module.exports = { fixture, codeFetch, codeEnv };

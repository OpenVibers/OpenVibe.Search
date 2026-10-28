'use strict';
/**
 * Search Fabric (server/fabric, POST/GET /api/v1/query and /api/v1/query/providers):
 * network visibility, mine only for a person, the web ladder (open index, paid DeepSeek, free
 * Wikipedia), cache hits, quick depth, provider failures that do not sink the network scope, the
 * daily cap, a bad request, GET/POST parity and CORS, provider offers, and freshness/site filters.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { ids } = require('openvibe-contracts');
const { boot, request, userToken, doc, suite } = require('./helpers');

const t = suite('fabric');
const alice = ids.newId('user');
const asAlice = { token: userToken({ subjectId: alice, aud: ['openvibe.search'] }) };
const AI_ENV = { OV_AI_INTERNAL_URL: 'http://ai.test', OV_OAUTH_CLIENT_SECRET: 'test-ai-secret', SEARCH_WEB_DAILY: '500' };
const RETRIEVED = '2026-10-28T12:00:00.000Z';

let svc;
const call = (method, p, opts = {}) => request(svc.base, method, p, opts);

let aiCalls = [];
let research = null;

function response(status, json) {
    return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) };
}

function runWith(sources, providers = {}, retrievedAt = RETRIEVED) {
    return { run: { status: 'succeeded', output: { sources, providers, usage: {}, retrieved_at: retrievedAt } } };
}

function wikiSource(overrides = {}) {
    return {
        source_type: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Test', title: 'Test — Wikipedia',
        snippet: '<p>An <b>article</b> &amp; its summary.</p>', retrieved_at: RETRIEVED,
        provenance: { provider: 'wikipedia' }, ...overrides,
    };
}

function webSource(overrides = {}) {
    return {
        source_type: 'web', url: 'https://deep.example/quasar', title: 'Quasar result',
        snippet: 'A web snippet', retrieved_at: RETRIEVED, published_at: '2026-10-27T00:00:00Z',
        provenance: { provider: 'deepseek' }, ...overrides,
    };
}

function defaultResearch(body) {
    if (body.providers.includes('deepseek')) {
        return runWith([webSource()], { deepseek: { ok: true, count: 1, ms: 10 } });
    }
    return runWith([wikiSource()], { wikipedia: { ok: true, count: 1, ms: 10 } });
}

async function fetchImpl(url, opts = {}) {
    const u = String(url);
    if (u.includes('/oauth/token')) return response(200, { access_token: 'test-ai-token', token_type: 'Bearer', expires_in: 300 });
    if (u.includes('/api/v1/research')) {
        const body = opts.body ? JSON.parse(opts.body) : {};
        aiCalls.push(body);
        if (research) return research(body, opts);
        return response(200, defaultResearch(body));
    }
    throw new Error(`unexpected fetch ${u}`);
}

t('boot with the web ladder configured and the fixtures indexed', async () => {
    svc = await boot({ env: AI_ENV, fetchImpl });
    await svc.store.apply(doc({ id: 'solstice-public', title: 'Solstice migration public', body: 'solstice public body', canonical_url: 'https://openvibe.wiki/p/solstice' }));
    await svc.store.apply(doc({
        id: 'solstice-private', visibility: 'private', acl: { subjects: [alice] },
        title: 'Solstice migration private', body: 'solstice private body', canonical_url: 'https://openvibe.wiki/p/solstice-private',
    }));
    await svc.store.apply(doc({ owner: 'sources', type: 'item', id: 'src_pulsar', title: 'Pulsar source page', body: 'pulsar', canonical_url: 'https://sources.example/pulsar' }));
    await svc.store.apply(doc({ id: 'failure-public', title: 'Failure report public', body: 'failure', canonical_url: 'https://openvibe.wiki/p/failure' }));
});

t('anonymous network: public published documents only, as document results, and the answer validates', async () => {
    const r = await call('POST', '/api/v1/query', { body: { q: 'solstice', scopes: ['network'] } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.results.map((x) => x.id), ['solstice-public']);
    assert.ok(r.body.results.every((x) => x.scope === 'network' && x.kind === 'document' && x.owner === 'wiki' && x.type === 'page'));
    assert.strictEqual(r.body.groups.network, 1);
    assert.ok(!('q' in r.body), 'the answer never echoes the query');
    const v = contracts.validate('search.fabric-result@1', r.body);
    assert.ok(v.valid, JSON.stringify(v.errors));
});

t('mine: anonymous is skipped, a signed-in person gets their private document', async () => {
    const anon = await call('POST', '/api/v1/query', { body: { q: 'solstice', scopes: ['mine'] } });
    assert.strictEqual(anon.status, 200);
    assert.deepStrictEqual(anon.body.results, []);
    assert.strictEqual(anon.body.route.explain.find((e) => e.scope === 'mine').skipped, 'needs a signed-in person');

    const mine = await call('POST', '/api/v1/query', { ...asAlice, body: { q: 'solstice', scopes: ['mine'] } });
    assert.strictEqual(mine.status, 200, mine.text);
    assert.deepStrictEqual(mine.body.results.map((x) => x.id), ['solstice-private']);
    assert.ok(mine.body.results.every((x) => x.scope === 'mine' && x.kind === 'document'));
});

t('web anonymous: the open index runs, DeepSeek is skipped, Wikipedia answers and citations are numbered', async () => {
    aiCalls = [];
    const r = await call('POST', '/api/v1/query', { body: { q: 'pulsar', scopes: ['web'] } });
    assert.strictEqual(r.status, 200, r.text);
    const explain = r.body.route.explain;
    assert.strictEqual(explain.find((e) => e.step === 'open_index').ok, true);
    assert.strictEqual(explain.find((e) => e.step === 'deepseek').skipped, 'paid providers need a signed-in person');
    assert.strictEqual(explain.find((e) => e.step === 'wikipedia').ok, true);
    assert.deepStrictEqual(aiCalls.map((b) => b.providers), [['wikipedia']], 'only the free provider is called');
    assert.ok(r.body.results.some((x) => x.provider === 'wikipedia'), r.text);
    assert.strictEqual(r.body.citations[0].n, 1);
    assert.deepStrictEqual(r.body.citations.map((c) => c.n), r.body.citations.map((_c, i) => i + 1));
    assert.strictEqual(r.body.citations[0].url, r.body.results.find((x) => x.scope === 'web').url);
});

t('web signed in: DeepSeek answers and costs $0.00075; the same query again is a free cache hit', async () => {
    aiCalls = [];
    const first = await call('POST', '/api/v1/query', { ...asAlice, body: { q: 'quasar', scopes: ['web'] } });
    assert.strictEqual(first.status, 200, first.text);
    assert.deepStrictEqual(aiCalls[0].providers, ['deepseek']);
    assert.strictEqual(first.body.route.cost_usd, 0.00075);
    assert.strictEqual(first.body.route.explain.find((e) => e.step === 'deepseek').cost_usd, 0.00075);
    assert.ok(aiCalls.length >= 1);

    aiCalls = [];
    const again = await call('POST', '/api/v1/query', { ...asAlice, body: { q: 'quasar', scopes: ['web'] } });
    assert.strictEqual(again.status, 200, again.text);
    const deep = again.body.route.explain.find((e) => e.step === 'deepseek');
    assert.deepStrictEqual([deep.cached, deep.cost_usd, deep.ok], [true, 0, true]);
    assert.strictEqual(again.body.route.cost_usd, 0);
    assert.strictEqual(aiCalls.length, 0, 'a cache hit never reaches AI');
});

t('depth quick reads indexes and caches only: AI is never called', async () => {
    aiCalls = [];
    const r = await call('POST', '/api/v1/query', { ...asAlice, body: { q: 'quick only', scopes: ['web'], depth: 'quick' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(aiCalls.length, 0);
    assert.strictEqual(r.body.route.explain.find((e) => e.step === 'deepseek').skipped, 'quick search reads indexes only');
    assert.strictEqual(r.body.route.explain.find((e) => e.step === 'wikipedia').skipped, 'quick search reads indexes only');
});

t('AI answers 500: that step is not ok, while the network scope in the same request still answers', async () => {
    research = () => response(500, { error: 'boom' });
    try {
        const r = await call('POST', '/api/v1/query', { ...asAlice, body: { q: 'failure', scopes: ['network', 'web'] } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.route.explain.find((e) => e.step === 'deepseek').ok, false);
        assert.deepStrictEqual(r.body.results.filter((x) => x.scope === 'network').map((x) => x.id), ['failure-public']);
    } finally {
        research = null;
    }
});

t('daily cap: a second distinct signed-in query skips DeepSeek with daily cap reached', async () => {
    const calls = [];
    const capFetch = async (url, opts = {}) => {
        const u = String(url);
        if (u.includes('/oauth/token')) return response(200, { access_token: 'cap-token', token_type: 'Bearer', expires_in: 300 });
        if (u.includes('/api/v1/research')) {
            const body = opts.body ? JSON.parse(opts.body) : {};
            calls.push(body);
            return response(200, defaultResearch(body));
        }
        throw new Error(`unexpected fetch ${u}`);
    };
    const capSvc = await boot({ env: { ...AI_ENV, SEARCH_WEB_DAILY: '1' }, fetchImpl: capFetch });
    try {
        const one = await request(capSvc.base, 'POST', '/api/v1/query', { ...asAlice, body: { q: 'cap one', scopes: ['web'] } });
        assert.strictEqual(one.status, 200, one.text);
        assert.strictEqual(one.body.route.explain.find((e) => e.step === 'deepseek').ok, true);
        const two = await request(capSvc.base, 'POST', '/api/v1/query', { ...asAlice, body: { q: 'cap two', scopes: ['web'] } });
        assert.strictEqual(two.status, 200, two.text);
        assert.strictEqual(two.body.route.explain.find((e) => e.step === 'deepseek').skipped, 'daily cap reached');
    } finally {
        await capSvc.stop();
    }
});

t('a bad request is 400 search.bad_query', async () => {
    const r = await call('POST', '/api/v1/query', { body: { q: 'x', scopes: ['everything'] } });
    assert.strictEqual(r.status, 400, r.text);
    assert.strictEqual(r.body.code, 'search.bad_query');
});

t('GET /api/v1/query equals the POST answer in shape and results; CORS is on GET only', async () => {
    const posted = await call('POST', '/api/v1/query', { body: { q: 'both', scopes: ['network', 'web'] } });
    assert.strictEqual(posted.status, 200, posted.text);
    assert.strictEqual(posted.headers.get('access-control-allow-origin'), null, 'POST is not cross-site readable');

    const got = await call('GET', '/api/v1/query?q=both&scopes=network,web');
    assert.strictEqual(got.status, 200, got.text);
    assert.strictEqual(got.headers.get('access-control-allow-origin'), '*');
    assert.deepStrictEqual(Object.keys(got.body).sort(), Object.keys(posted.body).sort());
    assert.deepStrictEqual(got.body.groups, posted.body.groups);
    assert.deepStrictEqual(got.body.results, posted.body.results, 'the second answer is the same cached page');
});

t('provider offers validate against search.provider-offer@1', async () => {
    const r = await call('GET', '/api/v1/query/providers');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.providers.map((p) => p.provider), ['open_index', 'deepseek', 'wikipedia']);
    for (const offer of r.body.providers) {
        const v = contracts.validate('search.provider-offer@1', offer);
        assert.ok(v.valid, `${offer.provider}: ${JSON.stringify(v.errors)}`);
    }
    const deep = r.body.providers.find((p) => p.provider === 'deepseek');
    assert.strictEqual(deep.daily_cap, 500);
    assert.ok(Number.isInteger(deep.used_today) && deep.used_today >= 1);
    assert.strictEqual(deep.terms_url, 'https://api-docs.deepseek.com/guides/search');
});

t('freshness day drops an old dated result; filters.site keeps only that host', async () => {
    research = (body) => {
        if (body.query === 'fresh check') {
            return response(200, runWith([
                wikiSource({ url: 'https://example.com/old', title: 'Old', published_at: '2020-01-01T00:00:00Z' }),
                wikiSource({ url: 'https://example.com/new', title: 'New', published_at: new Date().toISOString() }),
            ], { wikipedia: { ok: true, count: 2, ms: 5 } }));
        }
        return response(200, runWith([
            wikiSource({ url: 'https://example.com/kept', title: 'Kept' }),
            wikiSource({ url: 'https://other.test/dropped', title: 'Dropped' }),
        ], { wikipedia: { ok: true, count: 2, ms: 5 } }));
    };
    try {
        const fresh = await call('POST', '/api/v1/query', { body: { q: 'fresh check', scopes: ['web'], freshness: 'day' } });
        assert.strictEqual(fresh.status, 200, fresh.text);
        assert.deepStrictEqual(fresh.body.results.map((x) => x.url), ['https://example.com/new']);

        const site = await call('POST', '/api/v1/query', { body: { q: 'site check', scopes: ['web'], filters: { site: 'example.com' } } });
        assert.strictEqual(site.status, 200, site.text);
        assert.deepStrictEqual(site.body.results.map((x) => x.url), ['https://example.com/kept']);
    } finally {
        research = null;
    }
});

t('stop', async () => { await svc.stop(); });

t.run();

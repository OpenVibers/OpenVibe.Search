'use strict';
/**
 * MCP over Streamable HTTP (server/api/mcp.js, POST /mcp): initialization and version negotiation,
 * notifications, ping, the two tools and their contract-fed schemas, an anonymous search (DeepSeek
 * skipped, Wikipedia answers), a signed-in search that reaches DeepSeek, tool errors as results,
 * JSON-RPC errors, batching, 405s, CORS and the protocol-version header. The AI stub is the fabric
 * test's, so the same ladder is exercised end to end.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { ids } = require('openvibe-contracts');
const { boot, request, userToken, doc, suite } = require('./helpers');

const t = suite('mcp');
const pkg = require('../package.json');
const requestContract = require('openvibe-contracts/contracts/search/fabric-request.v1.json');
const alice = ids.newId('user');
const asAlice = { token: userToken({ subjectId: alice, aud: ['openvibe.search'] }) };
const AI_ENV = { OV_AI_INTERNAL_URL: 'http://ai.test', OV_OAUTH_CLIENT_SECRET: 'test-ai-secret', SEARCH_WEB_DAILY: '500' };
const RETRIEVED = '2026-10-28T12:00:00.000Z';

let svc;
const call = (method, p, opts = {}) => request(svc.base, method, p, opts);
const post = (body, opts = {}) => call('POST', '/mcp', { body, ...opts });
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

let aiCalls = [];

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
        return response(200, defaultResearch(body));
    }
    throw new Error(`unexpected fetch ${u}`);
}

t('boot with the web ladder configured and the fixtures indexed', async () => {
    svc = await boot({ env: AI_ENV, fetchImpl });
    await svc.store.apply(doc({
        id: 'mcp-public', title: 'MCP public solstice', body: 'solstice mcp public body',
        canonical_url: 'https://openvibe.wiki/p/mcp-public',
    }));
    await svc.store.apply(doc({
        owner: 'sources', type: 'item', id: 'src_mcp', title: 'MCP source pulsar', body: 'pulsar mcp source body',
        canonical_url: 'https://sources.example/pulsar',
    }));
    await svc.store.apply(doc({
        id: 'mcp-private', visibility: 'private', acl: { subjects: [alice] },
        title: 'MCP private solstice', body: 'solstice private body',
        canonical_url: 'https://openvibe.wiki/p/mcp-private',
    }));
});

t('initialize negotiates the protocol version, names the server and sets tools capabilities', async () => {
    const old = await post(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, 1));
    assert.strictEqual(old.status, 200, old.text);
    assert.strictEqual(old.body.jsonrpc, '2.0');
    assert.strictEqual(old.body.id, 1);
    assert.strictEqual(old.body.result.protocolVersion, '2025-03-26');
    assert.deepStrictEqual(old.body.result.capabilities, { tools: { listChanged: false } });
    assert.deepStrictEqual(old.body.result.serverInfo, { name: 'openvibe-search', title: 'OpenVibe Search', version: pkg.version });
    assert.strictEqual(typeof old.body.result.instructions, 'string');
    assert.match(old.body.result.instructions, /provider/i);
    assert.match(old.body.result.instructions, /date/i);
    assert.match(old.body.result.instructions, /never stored/i);

    const latest = await post(rpc('initialize', { protocolVersion: '2025-06-18' }, 2));
    assert.strictEqual(latest.body.result.protocolVersion, '2025-06-18');
    const unknown = await post(rpc('initialize', { protocolVersion: '2024-11-05' }, 3));
    assert.strictEqual(unknown.body.result.protocolVersion, '2025-06-18', 'an unknown version gets the latest supported');
    const missing = await post(rpc('initialize', {}, 4));
    assert.strictEqual(missing.body.result.protocolVersion, '2025-06-18');
});

t('notifications/initialized and any notification answer 202 with an empty body', async () => {
    const one = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.strictEqual(one.status, 202, one.text);
    assert.strictEqual(one.text, '');
    const other = await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } });
    assert.strictEqual(other.status, 202);
    assert.strictEqual(other.text, '');
    const batch = await post([
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', method: 'notifications/cancelled', params: {} },
    ]);
    assert.strictEqual(batch.status, 202, batch.text);
    assert.strictEqual(batch.text, '');
});

t('ping answers {}', async () => {
    const r = await post(rpc('ping', undefined, 'ping-1'));
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.result, {});
    assert.strictEqual(r.body.id, 'ping-1');
});

t('tools/list has both read-only tools; input enums are the contract\'s and outputSchema is stripped', async () => {
    const r = await post(rpc('tools/list', {}, 2));
    assert.strictEqual(r.status, 200, r.text);
    const tools = r.body.result.tools;
    assert.strictEqual(tools.length, 2);
    assert.deepStrictEqual(tools.map((x) => x.name), ['openvibe_search', 'openvibe_search_providers']);

    const search = tools[0];
    assert.strictEqual(search.title, 'Search OpenVibe and the web');
    for (const word of ['network', 'mine', 'web', 'DeepSeek', 'Wikipedia', 'news', 'video', 'products', 'places', 'code', 'route.explain', 'cost']) {
        assert.ok(search.description.includes(word), `description mentions ${word}`);
    }
    assert.deepStrictEqual(search.annotations, { readOnlyHint: true, openWorldHint: true });
    assert.deepStrictEqual(search.inputSchema.required, ['q']);
    assert.strictEqual(search.inputSchema.properties.q.type, 'string');
    assert.strictEqual(search.inputSchema.properties.q.minLength, 1);
    assert.strictEqual(search.inputSchema.properties.q.maxLength, 200);
    assert.deepStrictEqual(search.inputSchema.properties.scopes.items.enum, requestContract.properties.scopes.items.enum, 'scopes enum equals fabric-request@1');
    assert.deepStrictEqual(search.inputSchema.properties.freshness.enum, requestContract.properties.freshness.enum, 'freshness enum equals fabric-request@1');
    assert.deepStrictEqual(search.inputSchema.properties.depth.enum, requestContract.properties.depth.enum, 'depth enum equals fabric-request@1');
    assert.strictEqual(search.inputSchema.properties.limit.type, 'integer');
    assert.deepStrictEqual([search.inputSchema.properties.limit.minimum, search.inputSchema.properties.limit.maximum, search.inputSchema.properties.limit.default], [1, 20, 8]);
    assert.strictEqual(search.inputSchema.properties.site.type, 'string');
    assert.ok(search.outputSchema, 'the fabric result schema is the outputSchema');
    assert.strictEqual(search.outputSchema.$schema, undefined);
    assert.strictEqual(search.outputSchema.$id, undefined);
    assert.strictEqual(search.outputSchema.type, 'object');
    assert.ok(search.outputSchema.properties.results);

    const providers = tools[1];
    assert.deepStrictEqual(providers.inputSchema, { type: 'object', properties: {} });
    assert.deepStrictEqual(providers.annotations, { readOnlyHint: true });
});

t('anonymous openvibe_search: network + web answer, DeepSeek is skipped, Wikipedia runs and the result validates', async () => {
    aiCalls = [];
    const r = await post(rpc('tools/call', {
        name: 'openvibe_search',
        arguments: { q: 'solstice', scopes: ['network', 'web'], limit: 5 },
    }, 10));
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.result.isError, false);
    const answer = r.body.result.structuredContent;
    const valid = contracts.validate('search.fabric-result@1', answer);
    assert.ok(valid.valid, JSON.stringify(valid.errors));
    assert.deepStrictEqual(answer.results.filter((x) => x.scope === 'network').map((x) => x.id), ['mcp-public']);
    assert.strictEqual(answer.route.explain.find((e) => e.step === 'deepseek').skipped, 'paid providers need a signed-in person');
    assert.strictEqual(answer.route.explain.find((e) => e.step === 'wikipedia').ok, true);
    assert.deepStrictEqual(aiCalls.map((b) => b.providers), [['wikipedia']], 'only the free provider is called for an anonymous caller');

    const text = r.body.result.content[0].text;
    assert.match(text, /## network/);
    assert.match(text, /## web/);
    assert.match(text, /1\. MCP public solstice — https:\/\/openvibe\.wiki\/p\/mcp-public/);
    assert.ok(text.includes('MCP source pulsar') || text.includes('Test — Wikipedia'), 'web titles are in the text');
    assert.match(text, /Route: /);
    assert.match(text, /cost \$0\.00000/);
});

t('a signed-in openvibe_search reaches DeepSeek and reports its cost', async () => {
    aiCalls = [];
    const r = await post(rpc('tools/call', { name: 'openvibe_search', arguments: { q: 'quasar', scopes: ['web'] } }, 11), asAlice);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.result.isError, false);
    assert.deepStrictEqual(aiCalls[0].providers, ['deepseek'], 'the signed-in caller climbs to the paid provider');
    const answer = r.body.result.structuredContent;
    assert.strictEqual(answer.route.explain.find((e) => e.step === 'deepseek').ok, true);
    assert.strictEqual(answer.route.cost_usd, 0.00075);
    assert.ok(r.body.result.content[0].text.includes('Quasar result'));
});

t('openvibe_search_providers lists one line per provider with price and availability', async () => {
    const r = await post(rpc('tools/call', { name: 'openvibe_search_providers', arguments: {} }, 12));
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.result.isError, false);
    const providers = r.body.result.structuredContent.providers;
    assert.deepStrictEqual(providers.map((p) => p.provider), ['open_index', 'deepseek', 'wikipedia']);
    const lines = r.body.result.content[0].text.split('\n');
    assert.strictEqual(lines.length, 3);
    for (const line of lines) assert.match(line, /available/);
    assert.match(lines[0], /^open_index: .*free/);
    assert.match(lines[1], /^deepseek: .*per call/);
});

t('a bad argument is a tool result with isError true, not a JSON-RPC error', async () => {
    const r = await post(rpc('tools/call', { name: 'openvibe_search', arguments: { q: 'x', scopes: ['everything'] } }, 13));
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.error, undefined);
    assert.strictEqual(r.body.result.isError, true);
    assert.match(r.body.result.content[0].text, /scopes/);
    const over = await post(rpc('tools/call', { name: 'openvibe_search', arguments: { q: 'x', limit: 21 } }, 131));
    assert.strictEqual(over.body.result.isError, true, 'the tool schema caps limit at 20');
    assert.match(over.body.result.content[0].text, /limit/);
});

t('an unknown tool is -32602 and an unknown method is -32601', async () => {
    const tool = await post(rpc('tools/call', { name: 'no_such_tool', arguments: {} }, 14));
    assert.strictEqual(tool.status, 200, tool.text);
    assert.deepStrictEqual(tool.body.error, { code: -32602, message: 'Unknown tool' });
    const method = await post(rpc('no/such/method', {}, 15));
    assert.strictEqual(method.status, 200, method.text);
    assert.strictEqual(method.body.error.code, -32601);
});

t('malformed JSON is -32700 with HTTP 400', async () => {
    const r = await call('POST', '/mcp', { raw: '{"jsonrpc":"2.0",', headers: { 'Content-Type': 'application/json' } });
    assert.strictEqual(r.status, 400, r.text);
    assert.strictEqual(r.body.jsonrpc, '2.0');
    assert.strictEqual(r.body.id, null);
    assert.deepStrictEqual(r.body.error, { code: -32700, message: 'Parse error' });
});

t('valid JSON that is not a JSON-RPC request is -32600', async () => {
    const scalar = await call('POST', '/mcp', { raw: '"hello"', headers: { 'Content-Type': 'application/json' } });
    assert.strictEqual(scalar.status, 200, scalar.text);
    assert.deepStrictEqual(scalar.body.error, { code: -32600, message: 'Invalid Request' });
    const noMethod = await post({ jsonrpc: '2.0', id: 1 });
    assert.strictEqual(noMethod.status, 200, noMethod.text);
    assert.strictEqual(noMethod.body.error.code, -32600);
});

t('a batch of two requests answers an array of two responses', async () => {
    const r = await post([
        rpc('ping', undefined, 21),
        rpc('tools/list', {}, 22),
    ]);
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(Array.isArray(r.body), 'a batch answers an array');
    assert.strictEqual(r.body.length, 2);
    assert.deepStrictEqual(r.body.map((x) => x.id), [21, 22]);
    assert.deepStrictEqual(r.body[0].result, {});
    assert.strictEqual(r.body[1].result.tools.length, 2);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
});

t('GET and DELETE answer 405 with Allow: POST; OPTIONS preflights CORS', async () => {
    for (const method of ['GET', 'DELETE']) {
        const r = await call(method, '/mcp');
        assert.strictEqual(r.status, 405, `${method}: ${r.text}`);
        assert.strictEqual(r.headers.get('allow'), 'POST', `${method}: Allow`);
        assert.strictEqual(r.headers.get('access-control-allow-origin'), '*', `${method}: CORS`);
    }
    const options = await call('OPTIONS', '/mcp');
    assert.strictEqual(options.status, 204, options.text);
    assert.strictEqual(options.headers.get('access-control-allow-origin'), '*');
    assert.match(options.headers.get('access-control-allow-methods'), /POST/);
    assert.match(options.headers.get('access-control-allow-methods'), /OPTIONS/);
    const allowed = options.headers.get('access-control-allow-headers');
    for (const header of ['Content-Type', 'Authorization', 'Mcp-Protocol-Version']) assert.match(allowed, new RegExp(header, 'i'));
    assert.strictEqual(options.headers.get('access-control-max-age'), '600');
});

t('an unsupported MCP-Protocol-Version is 400 -32600; a supported one is ignored', async () => {
    const bad = await call('POST', '/mcp', { body: rpc('ping', undefined, 30), headers: { 'MCP-Protocol-Version': '2024-11-05' } });
    assert.strictEqual(bad.status, 400, bad.text);
    assert.deepStrictEqual(bad.body.error, { code: -32600, message: 'Unsupported protocol version' });
    const good = await call('POST', '/mcp', { body: rpc('ping', undefined, 31), headers: { 'MCP-Protocol-Version': '2025-03-26' } });
    assert.strictEqual(good.status, 200, good.text);
    assert.deepStrictEqual(good.body.result, {});
});

t('initialize and tools/list do not count against search.fabric; each tools/call does', async () => {
    // The fabric's own budget is fixed at 30 a minute (SEARCH_LIMITS_* only sets other routes).
    const limited = await boot({ env: AI_ENV, fetchImpl });
    try {
        for (let i = 0; i < 5; i++) {
            const init = await request(limited.base, 'POST', '/mcp', { body: rpc('initialize', { protocolVersion: '2025-06-18' }, i + 1) });
            assert.strictEqual(init.status, 200, init.text);
            const list = await request(limited.base, 'POST', '/mcp', { body: rpc('tools/list', {}, 100 + i) });
            assert.strictEqual(list.status, 200, list.text);
        }
        for (let i = 0; i < 30; i++) {
            const ok = await request(limited.base, 'POST', '/mcp', { body: rpc('tools/call', { name: 'openvibe_search_providers', arguments: {} }, i + 1) });
            assert.strictEqual(ok.status, 200, `call ${i + 1}: ${ok.text}`);
        }
        const refused = await request(limited.base, 'POST', '/mcp', { body: rpc('tools/call', { name: 'openvibe_search_providers', arguments: {} }, 31) });
        assert.strictEqual(refused.status, 429, refused.text);
        assert.match(refused.headers.get('content-type'), /application\/problem\+json/);
        assert.strictEqual(refused.body.code, 'rate_limited');
        assert.ok(Number(refused.headers.get('retry-after')) > 0);
    } finally {
        await limited.stop();
    }
});

t('stop', async () => { await svc.stop(); });

t.run();

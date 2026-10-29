'use strict';

/**
 * RFC 9728 on Search's MCP endpoint: the protected-resource metadata at
 * /.well-known/oauth-protected-resource, and the WWW-Authenticate challenge on a 401. A call that needs a token
 * (the "mine" scope) and has none answers 401 and names the metadata; a call that needs no token is still answered.
 */

const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, request, userToken, serviceToken, suite } = require('./helpers');
const protectedResource = require('../server/protected-resource');

const t = suite('protected-resource');
const METADATA_PATH = '/.well-known/oauth-protected-resource';
const BASE_URL = 'https://search.openvibe.network';
const alice = ids.newId('user');
const asAlice = { token: userToken({ subjectId: alice, aud: ['openvibe.search'] }) };
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

let svc;
const call = (method, p, opts = {}) => request(svc.base, method, p, opts);
const post = (body, opts = {}) => call('POST', '/mcp', { body, ...opts });

t('boot with the public base URL', async () => {
    svc = await boot({ env: { BASE_URL } });
});

t('the metadata document names the resource, the authorization server and the bearer method', async () => {
    const r = await call('GET', METADATA_PATH);
    assert.strictEqual(r.status, 200, r.text);
    assert.match(r.headers.get('content-type'), /application\/json/);
    const doc = r.body;
    assert.strictEqual(doc.resource, BASE_URL);
    assert.deepStrictEqual(doc.authorization_servers, ['https://openvibe.network']);
    assert.ok(Array.isArray(doc.scopes_supported) && doc.scopes_supported.length > 0, 'scopes_supported is a non-empty list');
    assert.deepStrictEqual(doc.bearer_methods_supported, ['header']);
    assert.strictEqual(doc.resource_documentation, `${BASE_URL}/openapi.json`);
});

t('the document is the one the challenge names', async () => {
    const doc = protectedResource.document({ baseUrl: BASE_URL, issuer: 'https://openvibe.network' });
    assert.strictEqual(protectedResource.metadataUrl({ baseUrl: BASE_URL }), `${BASE_URL}${METADATA_PATH}`);
    assert.deepStrictEqual(doc.authorization_servers, ['https://openvibe.network']);
});

t('a call that needs a person answers 401 and names the metadata', async () => {
    const r = await post(rpc('tools/call', { name: 'openvibe_search', arguments: { q: 'solstice', scopes: ['mine'] } }, 10));
    assert.strictEqual(r.status, 401, r.text);
    assert.strictEqual(r.headers.get('www-authenticate'), `Bearer resource_metadata="${BASE_URL}${METADATA_PATH}"`);
    assert.strictEqual(r.body.error.code, -32001);
    assert.strictEqual(r.body.error.data.resource_metadata, `${BASE_URL}${METADATA_PATH}`);
});

t('a call that needs no token is still answered', async () => {
    const r = await post(rpc('tools/call', { name: 'openvibe_search', arguments: { q: 'solstice', scopes: ['network'] } }, 11));
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.result.isError, false);
    assert.strictEqual(r.headers.get('www-authenticate'), null);
});

t('a token that does not verify answers 401 with the challenge', async () => {
    const r = await post(rpc('tools/call', { name: 'openvibe_search', arguments: { q: 'solstice' } }, 12), { token: 'not-a-token' });
    assert.strictEqual(r.status, 401, r.text);
    assert.strictEqual(r.headers.get('www-authenticate'), `Bearer resource_metadata="${BASE_URL}${METADATA_PATH}"`);
});

t('a person with a token gets the "mine" scope', async () => {
    const r = await post(rpc('tools/call', { name: 'openvibe_search', arguments: { q: 'solstice', scopes: ['mine'] } }, 13), asAlice);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.result.isError, false, r.text);
    assert.strictEqual(r.headers.get('www-authenticate'), null);
});

t('a service token asking for the "mine" scope keeps its answer, not the sign-in challenge', async () => {
    const token = serviceToken('wiki', ['search.query.delegate']);
    const r = await post(rpc('tools/call', { name: 'openvibe_search', arguments: { q: 'solstice', scopes: ['mine'] } }, 14), { token });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.result.isError, false, r.text);
    assert.strictEqual(r.headers.get('www-authenticate'), null);
});

t('stop', async () => { await svc.stop(); });

t.run();

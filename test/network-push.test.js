'use strict';
/**
 * The saved-search notification adapter: SDK subject resolution and push, with safe errors.
 * Token caching and refresh belong to openvibe-sdk/auth and are tested there.
 */
const assert = require('assert');
const { load } = require('../server/config');
const { createNetworkPush, NetworkError } = require('../server/network-push');
const { suite } = require('./helpers');

const t = suite('network-push');
const config = load({ NODE_ENV: 'test', OV_NETWORK_INTERNAL_URL: 'http://network.test', OV_OAUTH_CLIENT_SECRET: 'client-secret-xyz' });
const SUBJECT = 'usr_01j9zzzzzzzzzzzzzzzzzzzzzz';
const NOTE = { type: 'SEARCH_SAVED_MATCH', service: 'search', category: 'service', priority: 'normal', title: 'New results', message: 'One', url: 'https://search.test/?q=x' };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fakeTokens() {
    return { async getToken({ audience }) { assert.strictEqual(audience, 'openvibe.network'); return 'tok-SECRET'; } };
}

function fakeFetch(answers) {
    const calls = [];
    const fn = async (url, opts = {}) => {
        calls.push({ url: String(url), opts });
        const answer = answers.shift();
        if (!answer) throw new Error(`unexpected call ${url}`);
        return typeof answer === 'function' ? answer(url, opts) : answer;
    };
    fn.calls = calls;
    return fn;
}

t('resolves the subject, then pushes one notification to the numeric user id', async () => {
    const fetchImpl = fakeFetch([json(200, { network_user_id: 42 }), json(200, { ok: true, notification: { id: 7 } })]);
    const out = await createNetworkPush({ config, fetchImpl, tokenClient: fakeTokens() }).push(SUBJECT, NOTE);
    assert.deepStrictEqual(out, { sent: true, skipped: false });
    const [resolve, push] = fetchImpl.calls;
    assert.strictEqual(fetchImpl.calls.length, 2);
    assert.strictEqual(resolve.url, `http://network.test/internal/identity/resolve?subject_id=${SUBJECT}`);
    assert.strictEqual(resolve.opts.method, 'GET');
    assert.strictEqual(resolve.opts.headers.get('Authorization'), 'Bearer tok-SECRET');
    assert.ok(resolve.opts.signal, 'a request timeout');
    assert.strictEqual(push.url, 'http://network.test/internal/notifications/push');
    assert.strictEqual(push.opts.method, 'POST');
    assert.strictEqual(push.opts.headers.get('Content-Type'), 'application/json');
    assert.strictEqual(push.opts.headers.get('Authorization'), 'Bearer tok-SECRET');
    assert.ok(push.opts.signal);
    assert.deepStrictEqual(JSON.parse(push.opts.body), { ...NOTE, user_id: 42 });
});

t('a category the person switched off (skipped) still counts as delivered', async () => {
    const fetchImpl = fakeFetch([json(200, { network_user_id: 42 }), json(200, { skipped: true })]);
    assert.deepStrictEqual(await createNetworkPush({ config, fetchImpl, tokenClient: fakeTokens() }).push(SUBJECT, NOTE), { sent: true, skipped: true });
});

t('an unknown subject or a deleted account is not pushed to', async () => {
    let fetchImpl = fakeFetch([json(404, { code: 'identity.subject_not_found' })]);
    assert.deepStrictEqual(await createNetworkPush({ config, fetchImpl, tokenClient: fakeTokens() }).push(SUBJECT, NOTE), { sent: false, reason: 'unknown_subject' });
    assert.strictEqual(fetchImpl.calls.length, 1);
    fetchImpl = fakeFetch([json(200, { network_user_id: 42, deleted: true })]);
    assert.deepStrictEqual(await createNetworkPush({ config, fetchImpl, tokenClient: fakeTokens() }).push(SUBJECT, NOTE), { sent: false, reason: 'unknown_subject' });
    assert.strictEqual(fetchImpl.calls.length, 1);
});

t('a refusal throws NetworkError with status but no Network body or credentials', async () => {
    const fetchImpl = fakeFetch([json(200, { network_user_id: 42 }), json(403, { detail: 'private response tok-SECRET client-secret-xyz' })]);
    const err = await createNetworkPush({ config, fetchImpl, tokenClient: fakeTokens() }).push(SUBJECT, NOTE).then(() => null, e => e);
    assert.ok(err instanceof NetworkError);
    assert.strictEqual(err.status, 403);
    assert.ok(!/private response|tok-SECRET|client-secret-xyz/.test(err.message), err.message);
    assert.strictEqual(fetchImpl.calls.length, 2, 'one push attempt');
});

t('a resolve refusal throws NetworkError before the push', async () => {
    const fetchImpl = fakeFetch([json(403, { detail: 'private response' })]);
    const err = await createNetworkPush({ config, fetchImpl, tokenClient: fakeTokens() }).push(SUBJECT, NOTE).then(() => null, e => e);
    assert.ok(err instanceof NetworkError);
    assert.strictEqual(err.status, 403);
    assert.strictEqual(fetchImpl.calls.length, 1);
});

t('a timeout or a dropped connection throws NetworkError without status', async () => {
    for (const failure of ['timeout', 'dropped']) {
        const fetchImpl = fakeFetch([json(200, { network_user_id: 42 }), (url, opts) => failure === 'timeout'
            ? new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('timed out tok-SECRET')), { once: true }))
            : Promise.reject(new Error('dropped tok-SECRET'))]);
        const err = await createNetworkPush({ config, fetchImpl, tokenClient: fakeTokens(), timeoutMs: 20 }).push(SUBJECT, NOTE).then(() => null, e => e);
        assert.ok(err instanceof NetworkError);
        assert.strictEqual(err.status, null);
        assert.ok(!/tok-SECRET/.test(err.message), err.message);
        assert.strictEqual(fetchImpl.calls.length, 2, 'one push attempt');
    }
});

t('without an injected provider, the SDK token uses the internal Network URL', async () => {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        calls.push({ url: String(url), opts });
        if (String(url).endsWith('/oauth/token')) return json(200, { access_token: 'service-token', expires_in: 300 });
        if (String(url).includes('/identity/resolve')) return json(200, { network_user_id: 42 });
        return json(200, { skipped: false });
    };
    assert.deepStrictEqual(await createNetworkPush({ config, fetchImpl }).push(SUBJECT, NOTE), { sent: true, skipped: false });
    assert.strictEqual(calls[0].url, 'http://network.test/oauth/token');
    const form = new URLSearchParams(calls[0].opts.body);
    assert.strictEqual(form.get('client_id'), config.oauth.clientId);
    assert.strictEqual(form.get('client_secret'), config.oauth.clientSecret);
    assert.strictEqual(form.get('audience'), 'openvibe.network');
    assert.strictEqual(calls[1].opts.headers.get('Authorization'), 'Bearer service-token');
    assert.strictEqual(calls[2].opts.headers.get('Authorization'), 'Bearer service-token');
});

t.run();

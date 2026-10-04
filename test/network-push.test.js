'use strict';
/**
 * The Network client of the saved-search notifier: resolve a usr_ subject, then push one notification
 * (network.notification-push-request@1) with client-credentials tokens for audience openvibe.network;
 * an unknown or deleted person is not pushed to; a 401 drops the cached token; refusals and 5xx throw
 * with the status only, never a token.
 */
const assert = require('assert');
const { load } = require('../server/config');
const { createNetworkPush, NetworkError } = require('../server/network-push');
const { suite } = require('./helpers');

const t = suite('network-push');
const config = load({ NODE_ENV: 'test', OV_NETWORK_INTERNAL_URL: 'http://network.test', OV_OAUTH_CLIENT_SECRET: 'client-secret-xyz' });
const SUBJECT = 'usr_01j9zzzzzzzzzzzzzzzzzzzzzz';
const NOTE = { type: 'SEARCH_SAVED_MATCH', service: 'search', category: 'service', priority: 'normal', title: 'New results', message: 'One', url: 'https://search.test/?q=x' };

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

function fakeTokens() {
    const tk = { invalidated: 0, async authHeaders() { return { Authorization: 'Bearer tok-SECRET' }; }, invalidate() { tk.invalidated++; } };
    return tk;
}

function fakeFetch(answers) {
    const calls = [];
    const fn = async (url, opts = {}) => {
        calls.push({ url: String(url), opts });
        const a = answers.shift();
        if (!a) throw new Error(`unexpected call ${url}`);
        return typeof a === 'function' ? a(url, opts) : a;
    };
    fn.calls = calls;
    return fn;
}

t('resolves the subject, then pushes one notification to the numeric user id', async () => {
    const tokens = fakeTokens();
    const fetchImpl = fakeFetch([json(200, { subject: { type: 'user', id: SUBJECT }, network_user_id: 42 }), json(200, { ok: true, notification: { id: 7 } })]);
    const out = await createNetworkPush({ config, fetchImpl, tokenClient: tokens }).push(SUBJECT, NOTE);
    assert.deepStrictEqual(out, { sent: true, skipped: false });
    const [resolve, push] = fetchImpl.calls;
    assert.strictEqual(resolve.url, `http://network.test/internal/identity/resolve?subject_id=${SUBJECT}`);
    assert.strictEqual(resolve.opts.method, 'GET');
    assert.strictEqual(resolve.opts.headers.Authorization, 'Bearer tok-SECRET');
    assert.ok(resolve.opts.signal, 'a request timeout');
    assert.strictEqual(push.url, 'http://network.test/internal/notifications/push');
    assert.strictEqual(push.opts.method, 'POST');
    assert.strictEqual(push.opts.headers['Content-Type'], 'application/json');
    assert.ok(push.opts.signal);
    assert.deepStrictEqual(JSON.parse(push.opts.body), { ...NOTE, user_id: 42 });
});

t('a category the person switched off (skipped) still counts as delivered', async () => {
    const fetchImpl = fakeFetch([json(200, { network_user_id: 42 }), json(200, { ok: true, skipped: true })]);
    assert.deepStrictEqual(await createNetworkPush({ config, fetchImpl, tokenClient: fakeTokens() }).push(SUBJECT, NOTE), { sent: true, skipped: true });
});

t('an unknown subject (404) or a deleted account is not pushed to', async () => {
    let fetchImpl = fakeFetch([json(404, { type: 'identity.subject_not_found' })]);
    assert.deepStrictEqual(await createNetworkPush({ config, fetchImpl, tokenClient: fakeTokens() }).push(SUBJECT, NOTE), { sent: false, reason: 'unknown_subject' });
    assert.strictEqual(fetchImpl.calls.length, 1);
    fetchImpl = fakeFetch([json(200, { network_user_id: 42, deleted: true })]);
    assert.deepStrictEqual(await createNetworkPush({ config, fetchImpl, tokenClient: fakeTokens() }).push(SUBJECT, NOTE), { sent: false, reason: 'unknown_subject' });
    assert.strictEqual(fetchImpl.calls.length, 1);
});

t('a 401 throws with the status, drops the cached token and never shows the token', async () => {
    const tokens = fakeTokens();
    const fetchImpl = fakeFetch([json(200, { network_user_id: 42 }), json(401, { error: 'invalid token tok-SECRET' })]);
    const err = await createNetworkPush({ config, fetchImpl, tokenClient: tokens }).push(SUBJECT, NOTE).then(() => null, e => e);
    assert.ok(err instanceof NetworkError);
    assert.strictEqual(err.status, 401);
    assert.strictEqual(tokens.invalidated, 1);
    assert.ok(!/tok-SECRET|client-secret/.test(err.message), err.message);
});

t('a 5xx from resolve throws before any push; a 5xx from push throws', async () => {
    let fetchImpl = fakeFetch([json(503, {})]);
    let err = await createNetworkPush({ config, fetchImpl, tokenClient: fakeTokens() }).push(SUBJECT, NOTE).then(() => null, e => e);
    assert.strictEqual(err.status, 503);
    assert.strictEqual(fetchImpl.calls.length, 1);
    fetchImpl = fakeFetch([json(200, { network_user_id: 42 }), json(500, { error: 'boom' })]);
    err = await createNetworkPush({ config, fetchImpl, tokenClient: fakeTokens() }).push(SUBJECT, NOTE).then(() => null, e => e);
    assert.strictEqual(err.status, 500);
    assert.match(err.message, /notification push: Network answered 500/);
});

t('a timeout or a dropped connection throws a NetworkError', async () => {
    const fetchImpl = fakeFetch([async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; }]);
    const err = await createNetworkPush({ config, fetchImpl, tokenClient: fakeTokens(), timeoutMs: 50 }).push(SUBJECT, NOTE).then(() => null, e => e);
    assert.ok(err instanceof NetworkError);
    assert.match(err.message, /no answer within 50 ms/);
});

t('without an injected client: client-credentials tokens for openvibe.network, one per capability', async () => {
    const forms = [];
    const fetchImpl = async (url, opts = {}) => {
        if (String(url).endsWith('/oauth/token')) {
            const form = new URLSearchParams(String(opts.body));
            forms.push(Object.fromEntries(form));
            return json(200, { access_token: `tok-${form.get('scope')}`, expires_in: 300 });
        }
        if (String(url).includes('/identity/resolve')) {
            assert.strictEqual(opts.headers.Authorization, 'Bearer tok-identity.subject.resolve');
            return json(200, { network_user_id: 42 });
        }
        assert.strictEqual(opts.headers.Authorization, 'Bearer tok-network.notifications.push');
        return json(200, { ok: true });
    };
    assert.deepStrictEqual(await createNetworkPush({ config, fetchImpl }).push(SUBJECT, NOTE), { sent: true, skipped: false });
    assert.deepStrictEqual(forms.map(f => [f.client_id, f.audience, f.scope]), [
        ['search', 'openvibe.network', 'identity.subject.resolve'],
        ['search', 'openvibe.network', 'network.notifications.push'],
    ]);
});

t.run();

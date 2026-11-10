'use strict';
/**
 * The owner's code-source console and its JSON: a service token with search.code.sources reads/updates,
 * a Network staff page toggles, a key is shown only as its environment variable name, and a switch is
 * written to code_source_settings (so it survives a restart).
 */
const assert = require('assert');
const { boot, request, serviceToken, userToken, suite } = require('./helpers');
const { codeFetch, codeEnv } = require('./code-helpers');

const t = suite('code-console');
const admin = userToken({ subjectId: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', role: 'admin', aud: ['openvibe.search'] });
const person = userToken({ subjectId: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', role: 'user', aud: ['openvibe.search'] });
const owner = serviceToken('search', ['search.code.sources']);
const noCap = serviceToken('search', ['search.document.write']);

t('boot', async () => {
    t.svc = await boot({ env: codeEnv(), fetchImpl: codeFetch({}) });
});

t('the owner API needs search.code.sources and never returns a key value', async () => {
    assert.strictEqual((await request(t.svc.base, 'GET', '/api/v1/code/sources')).status, 401);
    assert.strictEqual((await request(t.svc.base, 'GET', '/api/v1/code/sources', { token: noCap })).status, 403);
    const r = await request(t.svc.base, 'GET', '/api/v1/code/sources', { token: owner });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.sources.map((s) => s.id), ['github', 'sourcegraph', 'forge']);
    const github = r.body.sources[0];
    assert.strictEqual(github.key.name, 'GITHUB_CODE_TOKEN');
    assert.strictEqual(github.key.configured, true);
    assert.strictEqual(github.health, 'unknown');
    assert.ok(!r.text.includes('test-token'), 'the value is not in the answer');
});

t('a switch is written and read back by the owner API', async () => {
    const off = await request(t.svc.base, 'PUT', '/api/v1/code/sources/github', { token: owner, body: { enabled: false } });
    assert.strictEqual(off.status, 200, off.text);
    assert.strictEqual(off.body.source.enabled, false);
    const rows = await t.svc.db.prepare('SELECT source_id, enabled FROM code_source_settings WHERE source_id = ?').all('github');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(Number(rows[0].enabled), 0);
    const list = await request(t.svc.base, 'GET', '/api/v1/code/sources', { token: owner });
    assert.strictEqual(list.body.sources.find((s) => s.id === 'github').enabled, false);
    const bad = await request(t.svc.base, 'PUT', '/api/v1/code/sources/github', { token: owner, body: { enabled: 'no' } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await request(t.svc.base, 'PUT', '/api/v1/code/sources/nope', { token: owner, body: { enabled: true } })).status, 404);
    const on = await request(t.svc.base, 'PUT', '/api/v1/code/sources/github', { token: owner, body: { enabled: true } });
    assert.strictEqual(on.body.source.enabled, true);
});

t('the HTML console is for Network staff and shows key names, not values', async () => {
    assert.strictEqual((await request(t.svc.base, 'GET', '/console/code-sources')).status, 403);
    assert.strictEqual((await request(t.svc.base, 'GET', '/console/code-sources', { token: person })).status, 403);
    const r = await request(t.svc.base, 'GET', '/console/code-sources', { token: admin });
    assert.strictEqual(r.status, 200, r.text);
    assert.match(r.text, /GitHub code search/);
    assert.match(r.text, /GITHUB_CODE_TOKEN/);
    assert.match(r.text, /SOURCEGRAPH_TOKEN/);
    assert.match(r.text, /FORGE_TOKEN/);
    assert.ok(!r.text.includes('test-token'), 'the key value is never rendered');
    assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
    assert.match(r.headers.get('content-security-policy') || '', /default-src 'none'/);
});

t('a console POST toggles the source and redirects to the page', async () => {
    const res = await fetch(`${t.svc.base}/console/code-sources/github`, {
        method: 'POST', redirect: 'manual',
        headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'enabled=0',
    });
    assert.strictEqual(res.status, 303, await res.text());
    const list = await request(t.svc.base, 'GET', '/api/v1/code/sources', { token: owner });
    assert.strictEqual(list.body.sources.find((s) => s.id === 'github').enabled, false);
    const turnOn = await fetch(`${t.svc.base}/console/code-sources/github`, {
        method: 'POST', redirect: 'manual',
        headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'enabled=1',
    });
    assert.strictEqual(turnOn.status, 303);
});

t('stop', async () => { await t.svc.stop(); });
t.run();

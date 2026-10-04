'use strict';
// scripts/subscribe.js validates SEARCH_EVENTS_SECRET before it talks to Network or Events: Events
// accepts 32..256 characters, so a secret outside that range is refused here with a clear message
// instead of a late 422. Each case exits before any network call (EVENTS_URL points nowhere useful).
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const { suite } = require('./helpers');

const t = suite('subscribe');
const script = path.join(__dirname, '..', 'scripts', 'subscribe.js');

function run(env) {
    return spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        env: { ...process.env, EVENTS_URL: 'http://127.0.0.1:1', OV_OAUTH_CLIENT_SECRET: 'not-a-real-secret', ...env },
    });
}

t('refuses a secret Events would reject as too long (over 256 characters)', () => {
    const r = run({ SEARCH_EVENTS_SECRET: 'a'.repeat(300) });
    assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /SEARCH_EVENTS_SECRET must be set \(32 to 256 characters\)/);
    assert.doesNotMatch(r.stderr, /token endpoint|fetch failed/, 'must fail before any network call');
});

t('refuses a secret shorter than 32 characters', () => {
    const r = run({ SEARCH_EVENTS_SECRET: 'too-short' });
    assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /SEARCH_EVENTS_SECRET must be set \(32 to 256 characters\)/);
});

t.run();

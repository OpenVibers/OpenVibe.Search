'use strict';
/**
 * What a result's kind is called (server/web/page.js kindOf): Live's guides (type doc, Contracts 0.278.0) read
 * "Guide", not "Doc"; a kind not named falls back to its type in words.
 *
 *   node test/kind-words.test.js
 */
const assert = require('assert');
const { kindOf } = require('../server/web/page');

assert.strictEqual(kindOf('live', 'doc'), 'Guide');
assert.strictEqual(kindOf('live', 'channel'), 'Channel');
assert.strictEqual(kindOf('someone', 'odd_kind'), 'Odd kind');
console.log('kind words: Live guides read "Guide"');

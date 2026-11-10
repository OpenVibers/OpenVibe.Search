'use strict';
/**
 * The contract every code source must pass (docs/code-sources.md): one normalized result per matched
 * file, https links only, line rows with a number (or null when the source cannot place it), and no
 * repository the source could not prove is public. test/code-sources.test.js runs it for each source
 * module against fixtures; a new source is not ready until it passes here.
 */
const assert = require('assert');

function assertResult(row, sourceId) {
    assert.ok(row && typeof row === 'object', `${sourceId}: a result is an object`);
    assert.strictEqual(row.source, sourceId);
    assert.ok(row.repo && typeof row.repo === 'string', `${sourceId}: repo`);
    assert.ok(row.path && typeof row.path === 'string', `${sourceId}: path`);
    assert.ok(row.permalink && /^https:\/\//.test(row.permalink), `${sourceId}: https permalink, got ${row.permalink}`);
    assert.ok(Array.isArray(row.lines) && row.lines.length, `${sourceId}: at least one context line`);
    for (const line of row.lines) {
        assert.ok(line.number === null || Number.isInteger(line.number), `${sourceId}: line number`);
        assert.strictEqual(typeof line.text, 'string', `${sourceId}: line text is text`);
        assert.strictEqual(typeof line.match, 'boolean', `${sourceId}: line match flag`);
    }
    assert.ok(row.line_start === null || Number.isInteger(row.line_start), `${sourceId}: line_start`);
    assert.ok(row.line_end === null || Number.isInteger(row.line_end), `${sourceId}: line_end`);
    assert.strictEqual(typeof row.stars, 'number', `${sourceId}: stars is a number`);
    assert.ok(row.licence === null || typeof row.licence === 'string', `${sourceId}: licence`);
    assert.ok(row.last_commit_at === null || typeof row.last_commit_at === 'string', `${sourceId}: last_commit_at`);
    assert.ok(!JSON.stringify(row).includes('"http://'), `${sourceId}: no http: link`);
}

function assertResults(rows, sourceId) {
    assert.ok(Array.isArray(rows), `${sourceId}: an array`);
    for (const row of rows) assertResult(row, sourceId);
    assert.ok(rows.every((r) => r.repo !== 'secret/private'), `${sourceId}: a private repository never appears`);
}

module.exports = { assertResult, assertResults };

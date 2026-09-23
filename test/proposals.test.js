'use strict';
/**
 * The proposals for OpenVibe.Contracts are valid against the contracts' own schemas, and match
 * what the code enforces and emits.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { CAPS } = require('../server/auth');
const { validate } = require('../server/document');
const { suite, doc } = require('./helpers');

const t = suite('proposals');
const DOCS = path.join(__dirname, '..', 'docs');

t('capability proposals are valid capabilities.capability@1 and cover every enforced id', () => {
    const dir = path.join(DOCS, 'capabilities-proposal');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const ids = [];
    for (const f of files) {
        const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const v = contracts.validate('capabilities.capability@1', m);
        assert.ok(v.valid, `${f}: ${JSON.stringify(v.errors)}`);
        assert.strictEqual(`${m.id}.json`, f);
        assert.strictEqual(m.owner, 'search');
        ids.push(m.id);
    }
    assert.deepStrictEqual(ids.sort(), Object.values(CAPS).sort());
});

t('the service manifest proposal is a valid registry.service-manifest@1', () => {
    const m = JSON.parse(fs.readFileSync(path.join(DOCS, 'service-manifest-proposal.json'), 'utf8'));
    const v = contracts.validate('registry.service-manifest@1', m);
    assert.ok(v.valid, JSON.stringify(v.errors));
    assert.deepStrictEqual([...m.capabilities].sort(), Object.values(CAPS).sort());
    assert.deepStrictEqual(m.eventsProduced, ['search.document.indexed', 'search.document.removed']);
});

t('the index-document schema accepts documents and tombstones and refuses malformed ones', () => {
    assert.ok(validate(doc()).valid);
    assert.ok(validate({ owner: 'wiki', type: 'page', id: 'p1', revision: 3, deleted: true }).valid);
    assert.ok(!validate({ owner: 'wiki', type: 'page', id: 'p1', revision: 3 }).valid, 'a live document needs visibility, state, title, indexability');
    assert.ok(!validate(doc({ revision: -1 })).valid);
    assert.ok(!validate(doc({ owner: 'Wiki' })).valid);
    assert.ok(!validate(doc({ extra: 1 })).valid);
    assert.ok(!validate(doc({ facets: { 'Bad Key': 'x' } })).valid);
    assert.ok(!validate(doc({ acl: { subjects: ['svc:wiki'] } })).valid);
    assert.ok(!validate(doc({ provenance: [{ service: 'sources', type: 'item' }] })).valid);
    assert.ok(!validate(doc({ body: 'x'.repeat(48001) })).valid);
});

t.run();

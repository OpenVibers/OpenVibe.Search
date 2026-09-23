'use strict';
/**
 * Freshness weighting: score = bm25 × (1 + weight × 2^(−age_days / half_life)). Newer documents
 * rank higher between comparably relevant ones; relevance still wins over age; pages of one query
 * rank on the first page's clock.
 */
const assert = require('assert');
const { boot, request, doc, suite } = require('./helpers');
const { freshnessBoost } = require('../server/engine/fts5');

const t = suite('freshness');
const NOW = Date.parse('2026-09-23T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

t('the decay: ×(1+w) today, ×(1+w/2) one half-life ago, → ×1 when old; future = today; none = ×1', () => {
    const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
    close(freshnessBoost(daysAgo(0), NOW, 30, 1), 2);
    close(freshnessBoost(daysAgo(30), NOW, 30, 1), 1.5);
    close(freshnessBoost(daysAgo(60), NOW, 30, 1), 1.25);
    close(freshnessBoost(daysAgo(90), NOW, 30, 1), 1.125);
    assert.ok(freshnessBoost(daysAgo(365), NOW, 30, 1) < 1.001);
    close(freshnessBoost(daysAgo(-10), NOW, 30, 1), 2);
    close(freshnessBoost(null, NOW, 30, 1), 1);
    close(freshnessBoost('not a date', NOW, 30, 1), 1);
    close(freshnessBoost(daysAgo(0), NOW, 30, 0), 1);
    close(freshnessBoost(daysAgo(7), NOW, 7, 0.5), 1.25);
});

async function corpus(env = {}) {
    let clock = NOW;
    const svc = await boot({ env, now: () => clock });
    // Same text, same length: bm25 ties, so only freshness separates them. The old one is indexed
    // first (lower rid), so without freshness it would come first.
    svc.store.apply(doc({ id: 'old', title: 'Aurora report', body: 'aurora seen tonight', published_at: daysAgo(400), updated_at: daysAgo(400) }));
    svc.store.apply(doc({ id: 'mid', title: 'Aurora report', body: 'aurora seen tonight', published_at: daysAgo(20), updated_at: daysAgo(20) }));
    svc.store.apply(doc({ id: 'new', title: 'Aurora report', body: 'aurora seen tonight', published_at: daysAgo(1), updated_at: daysAgo(1) }));
    return { svc, setClock: (c) => { clock = c; } };
}

t('between equally relevant documents the newest ranks first', async () => {
    const { svc } = await corpus();
    try {
        const r = await request(svc.base, 'GET', '/api/v1/search?q=aurora');
        assert.deepStrictEqual(r.body.results.map(x => x.id), ['new', 'mid', 'old']);
    } finally { await svc.stop(); }
});

t('weight 0 turns freshness off (pure bm25, ties by index order)', async () => {
    const { svc } = await corpus({ SEARCH_FRESHNESS_WEIGHT: '0' });
    try {
        const r = await request(svc.base, 'GET', '/api/v1/search?q=aurora');
        assert.deepStrictEqual(r.body.results.map(x => x.id), ['old', 'mid', 'new']);
        assert.deepStrictEqual((await request(svc.base, 'GET', '/api/ready')).body.freshness, { weight: 0, halfLifeDays: 30 });
    } finally { await svc.stop(); }
});

t('relevance still wins: an old title match outranks a fresh passing mention', async () => {
    let clock = NOW;
    const svc = await boot({ now: () => clock });
    try {
        svc.store.apply(doc({ id: 'fresh-mention', title: 'Weekly notes', summary: 'Many topics this week.', body: `${'filler words about other things '.repeat(40)} glacier`, published_at: daysAgo(0) }));
        svc.store.apply(doc({ id: 'old-title', title: 'Glacier glacier retreat', summary: 'The glacier retreat, measured.', body: 'glacier data', published_at: daysAgo(700) }));
        const r = await request(svc.base, 'GET', '/api/v1/search?q=glacier');
        assert.deepStrictEqual(r.body.results.map(x => x.id), ['old-title', 'fresh-mention']);
    } finally { await svc.stop(); }
});

t('pages of one query rank on the first page\'s clock: no duplicates or gaps when time moves on', async () => {
    const { svc, setClock } = await corpus();
    try {
        const p1 = await request(svc.base, 'GET', '/api/v1/search?q=aurora&limit=1');
        assert.deepStrictEqual(p1.body.results.map(x => x.id), ['new']);
        setClock(NOW + 200 * 86400000);
        const p2 = await request(svc.base, 'GET', `/api/v1/search?q=aurora&limit=1&cursor=${p1.body.next_cursor}`);
        const p3 = await request(svc.base, 'GET', `/api/v1/search?q=aurora&limit=1&cursor=${p2.body.next_cursor}`);
        assert.deepStrictEqual([...p2.body.results, ...p3.body.results].map(x => x.id), ['mid', 'old']);
        assert.strictEqual(p3.body.next_cursor, null);
    } finally { await svc.stop(); }
});

t('browse (no q) stays newest first; suggestions prefer fresher titles', async () => {
    const { svc } = await corpus();
    try {
        const b = await request(svc.base, 'GET', '/api/v1/search');
        assert.deepStrictEqual(b.body.results.map(x => x.id), ['new', 'mid', 'old']);
        const s = await request(svc.base, 'GET', '/api/v1/suggest?q=auro');
        assert.deepStrictEqual(s.body.suggestions.map(x => x.id), ['new', 'mid', 'old']);
    } finally { await svc.stop(); }
});

t.run();

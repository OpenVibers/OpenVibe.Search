'use strict';
/**
 * The front page's data sections (server/web/front-data.js, server/web/page.js): the numbers and the sources come from
 * the public, listed documents only; each shelf shows the newest documents of its kind as an anonymous search would,
 * never a private or draft one, and is left out when empty; community pastes are not shelved; the example searches,
 * the API samples and the questions are there, and the FAQPage holds exactly the questions shown.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, request, doc, suite } = require('./helpers');
const { createFrontData } = require('../server/web/front-data');

const t = suite('front');
let svc;
const html = (p) => request(svc.base, 'GET', p, { headers: { Accept: 'text/html' } });

t('boot', async () => {
    svc = await boot();
    for (let i = 0; i < 6; i++) {
        await svc.store.apply(doc({ owner: 'work', type: 'job', id: `job${i}`, title: `Robotics engineer ${i}`, canonical_url: `https://openvibe.work/jobs/job${i}`, updated_at: `2026-10-2${i}T10:00:00Z` }));
    }
    await svc.store.apply(doc({ owner: 'live', type: 'vod', id: 'v1', title: 'Building a rover live', canonical_url: 'https://openvibe.video/v/1', updated_at: '2026-10-21T10:00:00Z' }));
    await svc.store.apply(doc({ owner: 'live', type: 'vod', id: 'v2', visibility: 'private', acl: { subjects: [ids.newId('user')] }, title: 'Secret stream', canonical_url: 'https://openvibe.video/v/2' }));
    await svc.store.apply(doc({ owner: 'live', type: 'vod', id: 'v3', publication_state: 'draft', title: 'Draft stream', canonical_url: 'https://openvibe.video/v/3' }));
    await svc.store.apply(doc({ owner: 'community', type: 'paste', id: 'p1', title: 'A picture of a desk', canonical_url: 'https://openvibe.community/p/1' }));
});

t('the numbers and the sources count public, listed documents only', async () => {
    const data = await createFrontData({ store: svc.store, searcher: svc.searcher, log: { warn() {} } }).read();
    assert.strictEqual(data.total, 8, '6 jobs, 1 public stream, 1 paste');
    assert.strictEqual(data.sources, 3);
    assert.deepStrictEqual(data.coverage[0], { owner: 'work', type: 'job', n: 6 });
});

t('shelves: newest first, four at most, nothing private or draft, no pastes', async () => {
    const r = await html('/');
    assert.strictEqual(r.status, 200);
    const shelves = (/<section class="sc-sec" aria-labelledby="h-new">[\s\S]*?<\/div><\/section>/.exec(r.text) || [''])[0];
    const jobs = (/<section class="fs-shelf" aria-labelledby="h-work-job">[\s\S]*?<\/section>/.exec(shelves) || [''])[0];
    assert.deepStrictEqual([...jobs.matchAll(/>(Robotics engineer \d)</g)].map((m) => m[1]), ['Robotics engineer 5', 'Robotics engineer 4', 'Robotics engineer 3', 'Robotics engineer 2']);
    assert.match(jobs, /href="\/\?owner=work&amp;type=job">More<span class="sr-only"> new jobs<\/span>/);
    assert.match(shelves, /Building a rover live/);
    assert.ok(!r.text.includes('Secret stream') && !r.text.includes('Draft stream'), 'nothing a signed-out visitor may not see');
    assert.ok(!shelves.includes('A picture of a desk'), 'pastes are not shelved');
    assert.ok(!shelves.includes('aria-labelledby="h-host-plan"'), 'an empty shelf is left out');
});

t('the stat row, the sources with their counts, the example searches, the API and the questions', async () => {
    const r = await html('/');
    assert.match(r.text, /<b>8<\/b><span>public documents<\/span>/);
    assert.match(r.text, /<b>3<\/b><span>sites sending<\/span>/);
    assert.match(r.text, /6 job listings\. Job listings from open boards/);
    assert.ok(r.text.indexOf('href="/?owner=work"') < r.text.indexOf('href="/?owner=live"'), 'the source with most documents first');
    assert.match(r.text, /<ul class="fs-try" aria-label="Try a search"><li>Try:<\/li><li><a href="\/\?q=raspberry\+pi">raspberry pi<\/a><\/li>/);
    assert.match(r.text, /id="api"/);
    const ld = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const faq = (/<section class="sc-sec" id="faq"[\s\S]*?<\/section>/.exec(r.text) || [''])[0];
    const shown = [...faq.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1].replace(/&#39;/g, "'"));
    assert.ok(shown.length >= 5);
    assert.deepStrictEqual(ld.find((x) => x['@type'] === 'FAQPage').mainEntity.map((q) => q.name), shown);
    assert.strictEqual(ld.find((x) => x['@type'] === 'ItemList').numberOfItems, 3);
    assert.strictEqual((r.text.match(/<h1[\s>]/g) || []).length, 1);
});

t('a result page keeps none of it', async () => {
    const r = await html('/?q=robotics');
    assert.ok(!r.text.includes('fs-stats') && !r.text.includes('id="faq"') && !r.text.includes('fs-try'));
    assert.ok(r.text.includes('<main id="main" class="results">'), 'a result page is a results page, not the front');
});

t('done', async () => { await svc.stop(); });

t.run();

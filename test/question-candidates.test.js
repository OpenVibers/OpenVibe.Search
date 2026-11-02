'use strict';
/**
 * A question's answer must reach the candidates: on production "how do I stream" matched hundreds of recent VODs titled
 * "… Stream" in the title tier, and Help's older "Can I stream without OBS?" never made the top 100 the page ranks.
 * The engine lifts an article half a tier on a question: above the recordings that share its tier, below the next
 * tier up. A plain query is unchanged.
 */
const assert = require('assert');
const { boot, request, doc, suite } = require('./helpers');

const t = suite('question candidates');
let svc;
const put = (overrides) => svc.store.apply(doc({ summary: '', body: '', ...overrides }));
const ids = (r) => r.body.results.map((x) => x.id);
const q = (text) => request(svc.base, 'GET', `/api/v1/search?q=${encodeURIComponent(text)}&limit=10`);

t('boot and seed', async () => {
    svc = await boot();
    const recent = new Date(Date.now() - 3600e3).toISOString();
    const old = '2026-06-01T00:00:00Z';
    for (let i = 1; i <= 8; i++) {
        await put({ owner: 'live', type: 'vod', id: `vod-${i}`, title: `Late night stream number ${i}`, summary: 'A recorded stream with chat, music and talk about the week and the plans ahead.', canonical_url: `https://openvibe.video/v/${8100 + i}`, published_at: recent, updated_at: recent });
    }
    await put({ owner: 'help', type: 'article', id: 'help-obs', title: 'Can I stream without OBS?', summary: 'Yes. Go live from your browser on OpenVibe.Live: press Go Live and you are live in seconds, no software.', canonical_url: 'https://openvibe.help/a/openvibe.live/can-i-stream-without-obs', published_at: old, updated_at: old });
    await put({ owner: 'wiki', type: 'article', id: 'wiki-body', title: 'Camera notes', summary: 'Lenses and light.', body: 'how to stream with a phone camera', canonical_url: 'https://openvibe.wiki/p/camera-notes', published_at: old, updated_at: old });
});

t('a question puts the answer first, even older than the recordings in its tier', async () => {
    const got = ids(await q('how do I stream'));
    assert.strictEqual(got[0], 'help-obs', `the answer first (${got})`);
    assert.ok(got.indexOf('wiki-body') > got.indexOf('vod-1'), 'an article that only mentions it in its body stays below the title tier');
});

t('a plain query is unchanged: the recordings first, by freshness', async () => {
    const got = ids(await q('stream'));
    assert.ok(got.indexOf('help-obs') > 0, `not lifted without a question (${got})`);
});

t('close', async () => { await svc.stop(); });

t.run();

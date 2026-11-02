'use strict';
/**
 * A question wants an answer: "how do I stream" ranked four VODs titled "… Stream" above Help's "Can I stream without
 * OBS?" (production, 2026-11-02). Inside a tier, an article comes before a recording when the query starts with a
 * question word; a plain query keeps the fused order; the tiers themselves never move.
 */
const assert = require('assert');
const { rankOrder, isQuestion, toMatch } = require('../server/api/query');

const docs = {
    1: { type: 'vod', owner: 'live', title: 'Desktop Stream session with chat', summary: 'A long recorded stream with chat, music and talk about the week, the plans and the people.' },
    2: { type: 'vod', owner: 'live', title: 'Test Stream from the new camera rig', summary: 'Checking the new camera, the light and the sound before the weekend stream with friends.' },
    3: { type: 'article', owner: 'help', title: 'Can I stream without OBS?', summary: 'Yes. Go live from your browser on OpenVibe.Live: press Go Live and you are live in seconds.' },
    4: { type: 'vod', owner: 'live', title: 'Evening chat', summary: 'Talking about how to stream, the gear and the setup that works on a small channel today.' },
};
const store = { byRid: async (rid) => ({ doc: { ...docs[rid], canonical_url: `https://example.test/${rid}` }, row: {} }) };
const fused = [1, 2, 3, 4].map((rid) => ({ rid }));
const order = async (q) => (await rankOrder(fused, { match: toMatch(q), store })).map((h) => h.rid);

(async () => {
    assert.ok(isQuestion(toMatch('how do I stream')) && isQuestion(toMatch('can I go live')), 'questions');
    assert.ok(!isQuestion(toMatch('stream')) && !isQuestion(toMatch('streaming how')), 'not questions');
    const asked = await order('how do I stream');
    assert.strictEqual(asked[0], 3, `the answer first among the title matches (${asked})`);
    assert.ok(asked.indexOf(4) > asked.indexOf(2), 'a summary mention stays below the title tier');
    const plain = await order('stream');
    assert.deepStrictEqual(plain.slice(0, 3), [1, 2, 3], 'a plain query keeps the fused order inside its tier');
    console.log('question answers: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });

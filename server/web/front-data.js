'use strict';
/**
 * What the front page shows of the index, read as an anonymous visitor would see it and kept a few minutes:
 *
 *   createFrontData({ store, searcher, now, ttlMs, log }) → { read() }
 *   read() → { total, week, sources, kinds, coverage: [{ owner, type, n }], shelves: [{ owner, type, title, items }] } | null
 *
 * coverage is the public, listed documents by owner and type (store.publicCoverage). A shelf is one kind of document
 * with its newest few, from the same searcher and anonymous viewer as GET /api/v1/search?owner=&type= (newest first), so
 * the page never shows a document the API would not. A shelf with no documents is left out. read() never throws: a
 * failure keeps the last answer (null before the first), and the page then shows only what does not need data.
 */
const { ANONYMOUS } = require('../auth');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// The shelves, in the order the page shows them: a kind of document people browse, its heading and how many to show.
// Community pastes are left off on purpose: their titles are written by an AI from a picture, and this page is not the
// place to repeat them (they stay searchable).
const SHELVES = [
    ['live', 'vod', 'Recent streams'],
    ['live', 'clip', 'Clips'],
    ['blog', 'post', 'From the blogs'],
    ['work', 'job', 'New jobs'],
    ['host', 'plan', 'Hosting plans'],
    ['coupons', 'coupon', 'Coupons'],
    ['community', 'thread', 'Forum threads'],
    ['help', 'article', 'Help articles'],
    ['reviews', 'entity', 'Places and products'],
    ['rent', 'city', 'Renting in a city'],
    ['quest', 'quest', 'Quests'],
    ['tools', 'tool', 'Tools'],
];
const PER_SHELF = 4;
// Placeholder titles a site gives a document before anyone names it: real, but they tell a visitor nothing, so a shelf
// skips them (they stay searchable).
const PLACEHOLDER = /^(clip from stream|untitled|new paste|stream)$/i;

function createFrontData({ store, searcher, now = () => Date.now(), ttlMs = 5 * 60 * 1000, waitMs = 2000, log = console } = {}) {
    let cached = null;
    let at = 0;
    let pending = null;

    async function shelf([owner, type, title]) {
        const out = await searcher.run({ text: '', query: { owner, type }, viewer: ANONYMOUS, limit: PER_SHELF * 3 });
        const items = (out.results || []).filter((r) => r.title && !PLACEHOLDER.test(String(r.title).trim())).slice(0, PER_SHELF);
        return { owner, type, title, items: items.map((r) => ({ title: r.title, url: r.canonical_url, summary: r.summary || '', date: r.published_at || r.updated_at || null, facets: r.facets || {} })) };
    }

    async function load() {
        const t = now();
        const [coverage, week, shelves] = await Promise.all([
            store.publicCoverage(),
            store.publicIndexedSince(t - WEEK_MS),
            Promise.all(SHELVES.map(shelf)),
        ]);
        return {
            total: coverage.reduce((sum, r) => sum + r.n, 0),
            week,
            sources: new Set(coverage.map((r) => r.owner)).size,
            kinds: coverage.length,
            coverage,
            shelves: shelves.filter((s) => s.items.length),
        };
    }

    function refresh() {
        if (!pending) {
            pending = load()
                .then((v) => { cached = v; at = now(); return v; })
                .catch((e) => { log.warn(`[search] front page data: ${e.message}`); at = now() - ttlMs + 60 * 1000; return cached; })
                .finally(() => { pending = null; });
        }
        return pending;
    }

    async function read() {
        // Fresh, or a failure less than a minute ago (at is moved back so the next try waits a minute, not a request).
        if (at && now() - at < ttlMs) return cached;
        const p = refresh();
        if (cached) return cached;
        return Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(null), waitMs).unref())]);
    }

    return { read };
}

module.exports = { createFrontData, SHELVES };

'use strict';
/**
 * Semantic ranking (SF-2): the pgvector migration's no-op on PGlite, reciprocal rank fusion (k = 60), the
 * embedding job's batching/skip/backoff rules, and the query's hybrid/fallback answers. PGlite has no
 * `vector` type, so the vector store is a fake with the same interface as createPgVectorStore.
 */
const assert = require('assert');
const { boot, request, doc, suite } = require('./helpers');
const { testDb } = require('./db');
const { fuseRrf } = require('../server/fabric/rrf');
const { embeddingText } = require('../server/fabric/embedder');
const { createQueryEmbeddingCache } = require('../server/fabric/embed');
const { identity } = require('../server/fabric/vector-store');

const t = suite('hybrid');

class FakeVectors {
    constructor({ available = true, has = true, model = 'bge-small-en-v1.5', dim = 384 } = {}) {
        this._available = available;
        this._has = has;
        this.model = model;
        this.dim = dim;
        this.embedded = new Map();
        this.puts = [];
        this.hits = [];
    }
    async available() { return this._available; }
    async hasEmbeddings() { return this._has; }
    async existing() { return new Map(this.embedded); }
    async put(row) {
        this.puts.push(row);
        this.embedded.set(identity(row.owner, row.type, row.key), { model: this.model, dim: this.dim, content_hash: row.contentHash });
    }
    async nearest({ limit = 100 }) { return this.hits.slice(0, limit); }
}

function fakeEmbeddings({ fail = false, dim = 384 } = {}) {
    const client = {
        calls: [],
        fail,
        model: 'bge-small-en-v1.5',
        available: () => ({ configured: true, reason: null }),
        async embed(texts) {
            client.calls.push(texts);
            if (client.fail) return { ok: false, error: 'AI down', ms: 1 };
            return {
                ok: true,
                vectors: texts.map((_text, i) => Array.from({ length: dim }, (_, j) => ((i + j) % 17) / 17 + 0.01)),
                dimensions: dim,
                model: client.model,
                ms: 1,
            };
        },
    };
    return client;
}

async function ridMap(db) {
    const rows = await db.prepare('SELECT rid, id FROM documents').all();
    return Object.fromEntries(rows.map((r) => [r.id, Number(r.rid)]));
}

t('the embeddings migration succeeds on PGlite and creates nothing', async () => {
    const tdb = await testDb();
    try {
        const ext = await tdb.db.prepare("SELECT 1 AS ok FROM pg_extension WHERE extname = 'vector'").get();
        assert.ok(!ext, 'PGlite has no vector extension');
        const table = await tdb.db.prepare("SELECT to_regclass('search_embeddings') AS name").get();
        assert.strictEqual(table && table.name, null, 'no table without the extension');
    } finally {
        await tdb.close();
    }
});

t('RRF k=60: a document near the top of both lists wins, ties break by keyword rank', () => {
    const fused = fuseRrf(
        [{ rid: 1 }, { rid: 2 }, { rid: 3 }, { rid: 4 }],
        [{ rid: 3 }, { rid: 4 }, { rid: 1 }, { rid: 5 }],
    );
    assert.deepStrictEqual(fused.map((h) => h.rid), [1, 3, 4, 2, 5]);
    assert.deepStrictEqual(fused.find((h) => h.rid === 1).ranks, { keyword: 1, vector: 3 });
    assert.deepStrictEqual(fused.find((h) => h.rid === 2).ranks, { keyword: 2, vector: null });
    assert.deepStrictEqual(fused.find((h) => h.rid === 5).ranks, { keyword: null, vector: 4 });
    assert.ok(fused[0].score > fused[2].score, 'the shared head beats a document in only one list');
});

t('the query embedding cache normalizes text, keeps 10 minutes and evicts the LRU past 500', async () => {
    const clock = { t: 1000 };
    let calls = 0;
    const client = {
        async embed(texts) {
            calls++;
            return { ok: true, vectors: texts.map(() => Array.from({ length: 384 }, () => calls)), dimensions: 384, model: 'bge-small-en-v1.5' };
        },
    };
    const cache = createQueryEmbeddingCache({ client, now: () => clock.t, ttlMs: 100, max: 2 });
    const first = await cache.get('Hello   World');
    const second = await cache.get('hello world');
    assert.strictEqual(calls, 1, 'the normalized text is one cache entry');
    assert.strictEqual(second.cached, true);
    assert.deepStrictEqual(first.vector, second.vector);
    clock.t += 101;
    await cache.get('hello world');
    assert.strictEqual(calls, 2, 'an expired entry is embedded again');
    await cache.get('third text');
    assert.strictEqual(cache.size(), 2, 'the LRU bound holds');
});

t('the embedder batches 32, skips unchanged and non-public documents, and re-embeds changed ones', async () => {
    const vectors = new FakeVectors();
    const embeddings = fakeEmbeddings();
    const svc = await boot({ env: { SEARCH_EMBED: '1', SEARCH_EMBED_PER_MIN: '120' }, vectorStore: vectors, embeddingClient: embeddings });
    try {
        for (let i = 0; i < 40; i++) await svc.store.apply(doc({ id: `pub-${i}`, title: `Public ${i}`, summary: `Summary ${i}`, body: `Body ${i}` }));
        await svc.store.apply(doc({ id: 'private', visibility: 'private', acl: { subjects: ['usr_test'] }, title: 'Private', body: 'secret' }));
        await svc.store.apply(doc({ id: 'draft', visibility: 'draft', title: 'Draft', body: 'draft' }));
        await svc.store.apply(doc({ id: 'unpublished', publication_state: 'draft', title: 'Unpublished', body: 'unpublished' }));

        const first = await svc.embedder.tick();
        assert.strictEqual(first.embedded, 40);
        assert.deepStrictEqual(embeddings.calls.map((b) => b.length), [32, 8], 'batches of at most 32');
        assert.strictEqual(vectors.puts.length, 40);
        assert.ok(vectors.puts.every((p) => !['private', 'draft', 'unpublished'].includes(p.key)), 'never a non-public document');
        assert.strictEqual(embeddingText(doc({ title: 't', summary: 's', body: 'x'.repeat(3000) })).length, 2000);

        embeddings.calls = [];
        const second = await svc.embedder.tick();
        assert.strictEqual(second.embedded, 0, 'unchanged documents are skipped');
        assert.strictEqual(embeddings.calls.length, 0, 'and cost no AI call');

        await svc.store.apply(doc({ id: 'pub-0', revision: 2, title: 'Changed 0', summary: 'Summary 0', body: 'Body 0' }));
        const third = await svc.embedder.tick();
        assert.strictEqual(third.embedded, 1, 'the changed content hash is re-embedded');
        assert.strictEqual(embeddings.calls.length, 1);
        assert.strictEqual(embeddings.calls[0].length, 1);
    } finally {
        await svc.stop();
    }
});

t('the embedder respects SEARCH_EMBED_PER_MIN per rolling minute', async () => {
    const clock = { t: 1800000000000 };
    const vectors = new FakeVectors();
    const embeddings = fakeEmbeddings();
    const svc = await boot({ env: { SEARCH_EMBED_PER_MIN: '33' }, now: () => clock.t, vectorStore: vectors, embeddingClient: embeddings });
    try {
        for (let i = 0; i < 40; i++) await svc.store.apply(doc({ id: `rate-${i}`, title: `Rate ${i}` }));
        const first = await svc.embedder.tick();
        assert.strictEqual(first.embedded, 33, 'at most 33 documents in the first minute');
        assert.strictEqual(first.pending, 7);
        assert.deepStrictEqual(embeddings.calls.map((b) => b.length), [32, 1]);

        const second = await svc.embedder.tick();
        assert.strictEqual(second.embedded, 0, 'the minute budget is spent');
        assert.strictEqual(second.pending, 7);
        assert.strictEqual(embeddings.calls.length, 2);

        clock.t += 60000;
        const third = await svc.embedder.tick();
        assert.strictEqual(third.embedded, 7, 'the next rolling minute continues');
        assert.strictEqual(third.pending, 0);
    } finally {
        await svc.stop();
    }
});

t('the embedder backs off after a failed AI call and retries after the delay', async () => {
    const clock = { t: 1790000000000 };
    const vectors = new FakeVectors();
    const embeddings = fakeEmbeddings({ fail: true });
    const svc = await boot({ env: { SEARCH_EMBED_PER_MIN: '10' }, now: () => clock.t, vectorStore: vectors, embeddingClient: embeddings });
    try {
        await svc.store.apply(doc({ id: 'retry-me', title: 'Retry me' }));
        const first = await svc.embedder.tick();
        assert.strictEqual(first.failed, 1);
        assert.strictEqual(vectors.puts.length, 0, 'a failed call stores nothing');
        assert.strictEqual(embeddings.calls.length, 1);

        const during = await svc.embedder.tick();
        assert.strictEqual(during.backoff, true, 'the second tick is inside the backoff window');
        assert.strictEqual(embeddings.calls.length, 1, 'no AI call during backoff');

        clock.t += 2500;
        embeddings.fail = false;
        const after = await svc.embedder.tick();
        assert.strictEqual(after.embedded, 1, 'the document is embedded after the backoff');
        assert.strictEqual(vectors.puts.length, 1);
    } finally {
        await svc.stop();
    }
});

t('query falls back to keyword with no_vectors, short_query and ai_unavailable', async () => {
    const noVectors = await boot({ embeddingClient: fakeEmbeddings() });
    try {
        await noVectors.store.apply(doc({ id: 'plain', title: 'Hello plain' }));
        const r = await request(noVectors.base, 'GET', '/api/v1/search?q=hello');
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.body.explain, { ranking: 'keyword', reason: 'no_vectors' });
        assert.deepStrictEqual(r.body.results.map((x) => x.id), ['plain']);
    } finally {
        await noVectors.stop();
    }

    const shortVectors = new FakeVectors();
    const shortEmbeddings = fakeEmbeddings();
    const short = await boot({ vectorStore: shortVectors, embeddingClient: shortEmbeddings });
    try {
        await short.store.apply(doc({ id: 'a-doc', title: 'A' }));
        const r = await request(short.base, 'GET', '/api/v1/search?q=a');
        assert.deepStrictEqual(r.body.explain, { ranking: 'keyword', reason: 'short_query' });
        assert.strictEqual(shortEmbeddings.calls.length, 0, 'a one-character query is never embedded');
    } finally {
        await short.stop();
    }

    const aiDownVectors = new FakeVectors();
    const aiDown = await boot({ vectorStore: aiDownVectors, embeddingClient: fakeEmbeddings({ fail: true }) });
    try {
        await aiDown.store.apply(doc({ id: 'hello-doc', title: 'Hello there' }));
        const r = await request(aiDown.base, 'GET', '/api/v1/search?q=hello');
        assert.deepStrictEqual(r.body.explain, { ranking: 'keyword', reason: 'ai_unavailable' });
        assert.deepStrictEqual(r.body.results.map((x) => x.id), ['hello-doc']);
        assert.deepStrictEqual(r.body.results[0].ranks, { keyword: 1, vector: null });
    } finally {
        await aiDown.stop();
    }
});

t('hybrid: keyword and vector top-100 are fused, ranks are per hit, and a hidden vector hit is dropped', async () => {
    const vectors = new FakeVectors();
    const embeddings = fakeEmbeddings();
    const svc = await boot({ vectorStore: vectors, embeddingClient: embeddings });
    try {
        await svc.store.apply(doc({ id: 'both', title: 'Alpha both', body: 'alpha shared' }));
        await svc.store.apply(doc({ id: 'keyword-only', title: 'Alpha keyword', body: 'alpha only' }));
        await svc.store.apply(doc({ id: 'vector-only', title: 'Gamma vector', body: 'gamma only' }));
        await svc.store.apply(doc({ id: 'private-hit', visibility: 'private', acl: { subjects: ['usr_test'] }, title: 'Alpha secret', body: 'alpha secret' }));
        const rid = await ridMap(svc.db);
        vectors.hits = [
            { rid: rid.both, distance: 0.1 },
            { rid: rid['private-hit'], distance: 0.2 },   // even a stale/incorrect vector hit must not leak
            { rid: rid['vector-only'], distance: 0.3 },
        ];

        const r = await request(svc.base, 'GET', '/api/v1/search?q=alpha&limit=10');
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.body.explain, { ranking: 'hybrid' });
        assert.deepStrictEqual(r.body.results.map((x) => x.id), ['both', 'keyword-only', 'vector-only']);
        assert.deepStrictEqual(r.body.results.find((x) => x.id === 'both').ranks, { keyword: 1, vector: 1 });
        assert.deepStrictEqual(r.body.results.find((x) => x.id === 'keyword-only').ranks, { keyword: 2, vector: null });
        assert.deepStrictEqual(r.body.results.find((x) => x.id === 'vector-only').ranks, { keyword: null, vector: 3 });
        assert.ok(!JSON.stringify(r.body).includes('private-hit'), 'visibility still decides, not the vector list');

        // Paging walks the fused list without duplicates.
        const p1 = await request(svc.base, 'GET', '/api/v1/search?q=alpha&limit=2');
        const p2 = await request(svc.base, 'GET', `/api/v1/search?q=alpha&limit=2&cursor=${encodeURIComponent(p1.body.next_cursor)}`);
        assert.deepStrictEqual([...p1.body.results, ...p2.body.results].map((x) => x.id), ['both', 'keyword-only', 'vector-only']);
        assert.strictEqual(p2.body.next_cursor, null);
    } finally {
        await svc.stop();
    }
});

t.run();

#!/usr/bin/env node
'use strict';
/**
 * Embed every public document once, for a first deploy of semantic ranking (SF-2).
 *
 *   node scripts/embed-backfill.js            # run the job over everything, respecting SEARCH_EMBED_PER_MIN
 *   node scripts/embed-backfill.js --dry      # report what would be embedded; no AI call, no write
 *
 * It uses the same configuration, vector store and embedder as the service (server/fabric/embedder.js), so
 * the model, the 2 000-character text, the public-only rule and the batches are exactly the running job's.
 * On a database without pgvector (PGlite) or with SEARCH_EMBED=0 it says so and exits 0. A failed AI call
 * backs off and is retried; the script exits non-zero only on an unexpected error. No secret is printed.
 */
require('dotenv').config();
const { load } = require('../server/config');
const { openDb } = require('../server/db');
const { createPgVectorStore } = require('../server/fabric/vector-store');
const { createEmbeddingClient } = require('../server/fabric/embed');
const { createEmbedder } = require('../server/fabric/embedder');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(1000, ms)));

async function main() {
    const dry = process.argv.slice(2).includes('--dry');
    const config = load();
    const log = {
        log: (m) => console.log(m),
        warn: (m) => console.warn(m),
        error: (m) => console.error(m),
    };
    const db = await openDb(config, { log });
    try {
        const vectors = createPgVectorStore({ db, model: config.embed.model, dim: config.embed.dim });
        const embeddings = createEmbeddingClient({ config, log });
        const embedder = createEmbedder({ db, vectors, embeddings, config, log });

        const before = await embedder.plan();
        if (before.skipped) {
            console.log(`[embed-backfill] ${before.skipped}`);
            return;
        }
        console.log(`[embed-backfill] ${before.public} public document(s): ${before.embedded} embedded, ${before.pending} pending`);
        if (dry) {
            console.log(`[embed-backfill] --dry: would embed ${before.pending} document(s), batches of 32, at most ${config.embed.perMinute}/minute`);
            return;
        }

        let done = 0;
        for (;;) {
            const r = await embedder.tick();
            if (r.skipped) { console.log(`[embed-backfill] stopped: ${r.skipped}`); break; }
            done += r.embedded || 0;
            console.log(`[embed-backfill] ${done} embedded, ${r.pending || 0} pending${r.failed ? ` (${r.error})` : ''}`);
            if (!r.pending) break;
            if (r.failed) await sleep((r.retry_at || Date.now() + 2000) - Date.now());
            else if (!r.embedded) await sleep(60000);   // the rolling minute's budget is spent
        }
        console.log(`[embed-backfill] done: ${done} document(s) embedded`);
    } finally {
        await db.close();
    }
}

main().catch((err) => {
    console.error(`[embed-backfill] failed: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
});

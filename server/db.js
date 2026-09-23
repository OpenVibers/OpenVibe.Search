'use strict';
/**
 * The Search database (SQLite, WAL). One file owned by this service only; created on boot,
 * idempotently. The FTS5 tables belong to the engine (server/engine/fts5.js).
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const outbox = require('./events/outbox');
const purge = require('./purge');
const saved = require('./saved');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
    rid               INTEGER PRIMARY KEY,
    owner             TEXT NOT NULL,
    type              TEXT NOT NULL,
    id                TEXT NOT NULL,
    revision          INTEGER NOT NULL,
    deleted           INTEGER NOT NULL DEFAULT 0,
    visibility        TEXT,
    publication_state TEXT,
    exposure          INTEGER NOT NULL DEFAULT 0,   -- document.js EXPOSURE (0 none .. 3 public listed)
    index_decision    TEXT NOT NULL,
    noindex_reasons   TEXT NOT NULL DEFAULT '[]',
    canonical_url     TEXT,
    title             TEXT,
    language          TEXT,
    published_at      TEXT,
    updated_at        TEXT,
    sort_at           TEXT NOT NULL DEFAULT '',     -- updated_at, else published_at: browse order
    doc               TEXT NOT NULL,                -- normalized document JSON (tombstone: identity only)
    hash              TEXT NOT NULL,
    via               TEXT NOT NULL,                -- event | api
    event_id          TEXT,
    indexed_at        INTEGER NOT NULL,
    UNIQUE (owner, type, id)
);
CREATE INDEX IF NOT EXISTS idx_documents_exposure ON documents (exposure, sort_at, rid);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents (owner, type, id);

-- ACL keys of servable non-public documents: kind s = subject, g = group, e = entitlement.
CREATE TABLE IF NOT EXISTS doc_acl (
    rid   INTEGER NOT NULL,
    kind  TEXT NOT NULL CHECK (kind IN ('s', 'g', 'e')),
    value TEXT NOT NULL,
    PRIMARY KEY (rid, kind, value)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_doc_acl_value ON doc_acl (kind, value, rid);

CREATE TABLE IF NOT EXISTS doc_facets (
    rid   INTEGER NOT NULL,
    key   TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (rid, key, value)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_doc_facets_value ON doc_facets (key, value, rid);

-- Inbox: one receipt per consumed event (exactly-once effects), with what happened.
CREATE TABLE IF NOT EXISTS idempotency_receipts (
    consumer     TEXT NOT NULL,
    event_id     TEXT NOT NULL,
    outcome      TEXT NOT NULL,
    processed_at INTEGER NOT NULL,
    PRIMARY KEY (consumer, event_id)
);

-- Index-document events Search refused (bad document, wrong owner, subject mismatch). Owners
-- read their own through GET /api/v1/owners/:owner/rejections.
CREATE TABLE IF NOT EXISTS ingest_rejections (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id   TEXT NOT NULL,
    event_type TEXT,
    owner      TEXT,
    type       TEXT,
    id         TEXT,
    revision   INTEGER,
    code       TEXT NOT NULL,
    detail     TEXT,
    at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingest_rejections_owner ON ingest_rejections (owner, seq);
`;

function openDb(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    outbox.ensureSchema(db);
    purge.ensureSchema(db);
    saved.ensureSchema(db);
    return db;
}

module.exports = { openDb };

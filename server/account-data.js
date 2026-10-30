'use strict';
/**
 * Account export and deletion → Search (ADR-033; openvibe-sdk/account-data).
 *
 * What Search keeps of a person's own is their saved searches (saved_searches.subject = usr_…): the query, its
 * filters and when it last ran. They are exported and deleted with the account.
 *
 * The index itself is not a person's: documents, ingest_rejections, removals and search_embeddings are keyed by the
 * publishing owner (a service), and a document is erased when its owner sends index_document.deleted. A person's
 * deletion does not silently remove published pages: their owner does that. Telemetry samples that name a person are
 * covered by the SDK itself (telemetry.json, then subject NULL).
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const TABLES = [
    { table: 'saved_searches', subject: 'subject', file: 'saved-searches.json', columns: ['id', 'name', 'q', 'filters', 'created_at', 'updated_at', 'last_run_at'], order: 'updated_at' },
];

function create({ db, log = console } = {}) {
    return createAccountData({ db, service: 'search', tables: TABLES, log });
}

module.exports = { create, TABLES, TOPICS };

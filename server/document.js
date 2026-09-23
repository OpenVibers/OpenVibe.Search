'use strict';
/**
 * The index document (docs/contracts-proposal/contracts/search/index-document.v1.json):
 * validation, normalization, the effective indexability decision and the audience a document
 * reaches. Pure functions; the store and the engine build on them.
 *
 * The schema file is the proposal for OpenVibe.Contracts (`search.index-document@1`). Once a
 * contracts release ships it, validate() switches to contracts.validate and the file here goes.
 */
const crypto = require('crypto');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const SCHEMA_PATH = path.join(__dirname, '..', 'docs', 'contracts-proposal', 'contracts', 'search', 'index-document.v1.json');
const schema = require(SCHEMA_PATH);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateFn = ajv.compile(schema);

const VISIBILITIES = ['public', 'unlisted', 'members', 'private', 'draft'];

/**
 * How far a document reaches, lowest first. A drop in exposure is a removal (it leaves results
 * or public delivery) and is announced with search.document.removed.
 */
const EXPOSURE = Object.freeze({ none: 0, restricted: 1, public_unlisted: 2, public_listed: 3 });

/** → { valid: true } | { valid: false, errors: [{ path, message }] } */
function validate(doc) {
    const ok = validateFn(doc);
    if (ok) return { valid: true, errors: [] };
    return {
        valid: false,
        errors: (validateFn.errors || []).slice(0, 20).map(e => ({ path: e.instancePath || '/', message: e.message })),
    };
}

// C0/C1 control characters except tab/newline; they have no place in indexed text.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const clean = (s) => (typeof s === 'string' ? s.replace(CONTROL_RE, '').trim() : '');

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function sha256(s) {
    return crypto.createHash('sha256').update(s).digest('hex');
}

/** Facet values as strings (numbers/booleans stringified, arrays flattened), for exact filtering. */
function facetPairs(facets) {
    const out = [];
    for (const [key, v] of Object.entries(facets || {})) {
        const values = Array.isArray(v) ? v : [v];
        for (const x of new Set(values.map(String))) out.push([key, x]);
    }
    return out;
}

/**
 * The effective indexability: the owner's decision plus the reasons Search enforces. It can only
 * get stricter here; nothing the owner sends can make a draft, private or stub document indexable.
 */
function effectiveIndexability(doc) {
    const reasons = new Set((doc.indexability && doc.indexability.reasons) || []);
    if (doc.deleted) reasons.add('deleted');
    else {
        if (doc.visibility === 'draft') reasons.add('draft');
        if (doc.visibility === 'private') reasons.add('private');
        if (doc.visibility === 'members') reasons.add('members_only');
        if (doc.visibility === 'unlisted') reasons.add('unlisted');
        if (doc.publication_state !== 'published') reasons.add('not_published');
        if ((doc.provenance || []).some(p => p.stub === true)) reasons.add('stub_provider');
        if (doc.visibility === 'public' && !doc.canonical_url) reasons.add('missing_canonical_url');
    }
    const ownerSaysIndex = Boolean(doc.indexability && doc.indexability.decision === 'index');
    if (!ownerSaysIndex && !reasons.size) reasons.add('owner_decision');
    const decision = ownerSaysIndex && reasons.size === 0 ? 'index' : 'noindex';
    return { decision, reasons: [...reasons].sort() };
}

/** Is the document served to anyone at all? Drafts, unpublished and deleted documents never are. */
function servable(doc) {
    return !doc.deleted && doc.visibility !== 'draft' && doc.publication_state === 'published';
}

function exposureOf(doc) {
    if (!doc || !servable(doc)) return EXPOSURE.none;
    if (doc.visibility !== 'public') return EXPOSURE.restricted;
    return effectiveIndexability(doc).decision === 'index' ? EXPOSURE.public_listed : EXPOSURE.public_unlisted;
}

/**
 * Normalize a valid document into what the store keeps. A tombstone keeps only its identity.
 * Returns { doc, hash } where hash covers every stored field (same revision + same hash = replay).
 */
function normalize(input) {
    const base = { owner: input.owner, type: input.type, id: input.id, revision: input.revision };
    if (input.deleted === true) {
        const doc = { ...base, deleted: true };
        return { doc, hash: sha256(canonicalJson(doc)) };
    }
    const acl = input.acl || {};
    const doc = {
        ...base,
        deleted: false,
        visibility: input.visibility,
        acl: {
            subjects: [...new Set(acl.subjects || [])].sort(),
            groups: [...new Set(acl.groups || [])].sort(),
            entitlements: [...new Set(acl.entitlements || [])].sort(),
        },
        canonical_url: input.canonical_url || null,
        title: clean(input.title),
        summary: clean(input.summary),
        body: clean(input.body),
        facets: input.facets || {},
        language: input.language || null,
        authorship: input.authorship || null,
        provenance: input.provenance || [],
        publication_state: input.publication_state,
        published_at: input.published_at || null,
        updated_at: input.updated_at || null,
        indexability: {
            decision: input.indexability.decision,
            reasons: [...new Set(input.indexability.reasons || [])].sort(),
        },
    };
    return { doc, hash: sha256(canonicalJson(doc)) };
}

module.exports = {
    schema, SCHEMA_PATH, VISIBILITIES, EXPOSURE,
    validate, normalize, effectiveIndexability, servable, exposureOf, facetPairs, canonicalJson, sha256,
};

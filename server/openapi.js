'use strict';
/**
 * OpenAPI 3.1 for OpenVibe.Search's JSON API, from the route table below.
 *
 * ROUTES is the table: every entry is one method on one path under /api/v1. server/app.js mounts
 * exactly these routers, and test/openapi.test.js walks the mounted stack and fails when the table
 * and the app differ in either direction — so the document cannot advertise an address the service
 * does not answer.
 *
 *   GET /openapi.json            this document (public, Cache-Control 5 minutes)
 *   GET /api/v1/openapi.json     308 to /openapi.json
 *
 * /api/health and /api/ready are probes. The owner-side indexing API (PUT/DELETE /api/v1/documents,
 * GET /api/v1/owners/…) needs a service token and is the network's internal write path, not the
 * public query surface: it stays out. /internal/events (the signed Events webhook) and /mcp are
 * outside /api.
 *
 * Request fields are what server/api/*.js reads; response properties are the projections those
 * handlers and server/saved.js serialize. Nothing is inferred.
 */
const pkg = require('../package.json');

const MOUNT = '/api/v1';
const SITE = 'https://openvibe.search';

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (extra = {}) => ({ type: 'string', ...extra });
const nullable = (type, extra = {}) => ({ type: [type, 'null'], ...extra });
const arrayOf = (items) => ({ type: 'array', items });
const integer = (extra = {}) => ({ type: 'integer', ...extra });

const problem = {
    description: 'A problem (RFC 9457, application/problem+json): type, title, status and a stable code',
    content: {
        'application/problem+json': {
            schema: {
                type: 'object',
                required: ['type', 'title', 'status'],
                properties: { type: str(), title: str(), status: integer(), code: str(), detail: str(), request_id: str() },
            },
        },
    },
};
const errors = (codes = [400, 401, 403, 404, 429]) => ({
    ...Object.fromEntries(codes.map((code) => [code, problem])),
    default: problem,
});

const path = (name, schema, description) => ({ name, in: 'path', required: true, schema, ...(description && { description }) });
const query = (name, schema, description) => ({ name, in: 'query', required: false, schema, ...(description && { description }) });

const ANONYMOUS = [{}, { bearer: [] }, { cookie: [] }];
const PERSON = [{ bearer: [] }, { cookie: [] }];
const SERVICE = [{ bearer: [] }];

const json = (description, schema) => ({ description, ...(schema ? { content: { 'application/json': { schema } } } : {}) });
const body = (schema, required = true) => ({ required, content: { 'application/json': { schema } } });

const owner = str({ pattern: '^[a-z][a-z0-9-]{1,39}$' });
const type = str({ pattern: '^[a-z][a-z0-9_]{1,39}$' });
const id = str({ pattern: '^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$' });
const filterParams = [
    query('owner', owner, 'Only this owner\'s documents'), query('type', type, 'Only this document type'),
    query('lang', str({ pattern: '^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), 'Only this language'),
    query('facet.<key>', str({ maxLength: 200 }), 'A facet filter; repeat for several values'),
    query('facets', str(), 'Comma-separated facet keys to count (at most 5)'),
    query('limit', integer({ minimum: 1 }), 'Page size'), query('cursor', str(), 'The next_cursor from the previous page'),
];
const searchBody = { type: 'object', required: ['results', 'next_cursor', 'explain'], properties: {
    results: arrayOf(ref('DocumentMatch')), next_cursor: nullable('string'),
    explain: { type: 'object', properties: { ranking: { type: 'string', enum: ['keyword', 'hybrid'] }, reason: nullable('string') } },
    facets: { type: 'object', additionalProperties: arrayOf({ type: 'object' }) },
} };

const PATHS = {};
function route(method, p, operation) {
    (PATHS[p] = PATHS[p] || {})[method] = operation;
}

// ── Query ─────────────────────────────────────────────────────────────────────────────────────
route('get', '/search', {
    operationId: 'search', summary: 'Search the index as the caller', tags: ['query'], security: ANONYMOUS,
    description: 'Visible to any origin (Access-Control-Allow-Origin *). Anonymous callers see public, published, indexable documents only; a user token adds documents whose ACL names the person; a service token with search.query.delegate and X-OV-Subject adds that person\'s groups and entitlements.',
    parameters: [query('q', str({ maxLength: 500 }), 'The words; an empty q browses'), ...filterParams],
    responses: { 200: json('A page of matches and how it was ranked', searchBody), ...errors() },
});
route('get', '/suggest', {
    operationId: 'suggest', summary: 'Title suggestions for a search box', tags: ['query'], security: ANONYMOUS,
    description: 'Visible to any origin. At most 20 suggestions; q is at most 100 characters.',
    parameters: [query('q', str({ maxLength: 100 })), query('owner', owner), query('type', type), query('limit', integer({ minimum: 1, maximum: 20 }))],
    responses: { 200: json('Suggestions', { type: 'object', required: ['suggestions'], properties: { suggestions: arrayOf(ref('Suggestion')) } }), ...errors() },
});
route('get', '/documents/{owner}/{type}/{id}', {
    operationId: 'getDocument', summary: 'One document by its exact id', tags: ['query'], security: ANONYMOUS,
    description: 'A document the caller may not see and one that does not exist give the same 404. Nothing here returns an ACL, a draft, an unpublished or deleted document.',
    parameters: [path('owner', owner), path('type', type), path('id', id)],
    responses: { 200: json('The document', { type: 'object', required: ['document'], properties: { document: ref('DocumentMatch') } }), ...errors([400, 404, 429]) },
});

// ── Search Fabric ────────────────────────────────────────────────────────────────────────────
route('post', '/query', {
    operationId: 'fabricQuery', summary: 'One Search Fabric request (index plus the web ladder)', tags: ['fabric'], security: ANONYMOUS,
    description: 'search.fabric.query when a service token presents it; a browser caller is anonymous. The body is search.fabric-request@1.',
    requestBody: body({ type: 'object' }),
    responses: { 200: json('search.fabric-result@1', { type: 'object' }), ...errors([400, 401, 403, 429]) },
});
route('get', '/query', {
    operationId: 'fabricQueryGet', summary: 'The same Fabric request in the query string', tags: ['fabric'], security: ANONYMOUS,
    description: 'Visible to any origin.',
    parameters: [query('q', str()), query('scopes', str({ description: 'Comma-separated scopes' })), query('freshness', str()), query('depth', str()),
        query('cursor', str()), query('limit', integer({ minimum: 1 })), query('owner', owner), query('type', type), query('lang', str()), query('site', str())],
    responses: { 200: json('search.fabric-result@1', { type: 'object' }), ...errors([400, 401, 403, 429]) },
});
route('get', '/query/providers', {
    operationId: 'fabricProviders', summary: 'The web ladder\'s provider offers', tags: ['fabric'], security: ANONYMOUS,
    description: 'Visible to any origin; search.provider-offer@1 items.',
    responses: { 200: json('Providers', { type: 'object', required: ['providers'], properties: { providers: arrayOf({ type: 'object' }) } }), ...errors([429]) },
});

// ── Saved searches ───────────────────────────────────────────────────────────────────────────
route('get', '/saved-searches', {
    operationId: 'listSavedSearches', summary: 'The caller\'s saved searches, newest first', tags: ['saved-searches'], security: PERSON,
    responses: { 200: json('Saved searches and the per-person maximum', { type: 'object', required: ['saved_searches'], properties: {
        saved_searches: arrayOf(ref('SavedSearch')), max: integer(),
    } }), ...errors([401, 403, 429]) },
});
route('post', '/saved-searches', {
    operationId: 'saveSearch', summary: 'Save a query (201 new, 200 already saved)', tags: ['saved-searches'], security: PERSON,
    description: 'A saved search needs words or at least one filter. A cookie-authenticated write must come from this origin.',
    requestBody: body({ type: 'object', properties: {
        name: str({ maxLength: 100 }), q: str({ maxLength: 500 }), owner, type, lang: str(),
        facets: { type: 'object', additionalProperties: { oneOf: [str(), arrayOf(str())] } },
    } }, false),
    responses: { 201: json('The saved search', { type: 'object', required: ['saved_search'], properties: { saved_search: ref('SavedSearch') } }),
        200: json('Already saved: the existing one', { type: 'object', required: ['saved_search'], properties: { saved_search: ref('SavedSearch') } }), ...errors() },
});
route('get', '/saved-searches/{id}', {
    operationId: 'getSavedSearch', summary: 'One of the caller\'s saved searches', tags: ['saved-searches'], security: PERSON,
    parameters: [path('id', str())],
    responses: { 200: json('The saved search', { type: 'object', required: ['saved_search'], properties: { saved_search: ref('SavedSearch') } }), ...errors([401, 403, 404, 429]) },
});
route('delete', '/saved-searches/{id}', {
    operationId: 'deleteSavedSearch', summary: 'Delete one of the caller\'s saved searches', tags: ['saved-searches'], security: PERSON,
    parameters: [path('id', str())],
    responses: { 204: { description: 'Deleted' }, ...errors([401, 403, 404, 429]) },
});
route('get', '/saved-searches/{id}/results', {
    operationId: 'runSavedSearch', summary: 'Run a saved search now, as the caller', tags: ['saved-searches'], security: PERSON,
    description: 'The ACL applies when it runs, never when it was saved.',
    parameters: [path('id', str()), query('limit', integer({ minimum: 1 })), query('cursor', str())],
    responses: { 200: json('The saved search and a page of matches', { allOf: [searchBody, { type: 'object', properties: {
        saved_search: { type: 'object', required: ['id', 'name'], properties: { id: str(), name: str() } },
    } }] }), ...errors([401, 403, 404, 429]) },
});

function openapi() {
    return {
        openapi: '3.1.0',
        info: {
            title: 'OpenVibe.Search API',
            version: pkg.version,
            description: pkg.description,
            license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
            contact: { name: 'OpenVibers', url: 'https://github.com/OpenVibers/OpenVibe.Search', email: 'contact@openvibe.network' },
        },
        servers: [{ url: SITE }],
        tags: ['query', 'fabric', 'saved-searches'].map((name) => ({ name })),
        components: {
            securitySchemes: {
                bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'A Network user JWT (people) or a service token for audience openvibe.search carrying search.query.delegate (acting for X-OV-Subject)' },
                cookie: { type: 'apiKey', in: 'cookie', name: 'ov_token', description: 'The browser session: the same Network user JWT as a host-only cookie' },
            },
            schemas: {
                DocumentMatch: { type: 'object', required: ['owner', 'type', 'id', 'title', 'canonical_url'], properties: {
                    owner, type, id, revision: integer(), visibility: { type: 'string', enum: ['public', 'unlisted', 'members', 'private'] },
                    title: str(), summary: nullable('string'), canonical_url: str({ format: 'uri' }), facets: nullable('object'),
                    language: nullable('string'), authorship: nullable('object'), provenance: nullable('object'),
                    published_at: nullable('string', { format: 'date-time' }), updated_at: nullable('string', { format: 'date-time' }),
                    indexable: { type: 'boolean' }, snippet_html: str(), ranks: { type: 'object', properties: { keyword: nullable('integer'), vector: nullable('integer') } },
                } },
                Suggestion: { type: 'object', required: ['owner', 'type', 'id', 'title'], properties: {
                    owner, type, id, title: str(), canonical_url: str({ format: 'uri' }),
                } },
                SavedSearch: { type: 'object', required: ['id', 'name', 'q', 'filters'], properties: {
                    id: str(), name: str(), q: str(), filters: { type: 'object' },
                    created_at: str({ format: 'date-time' }), updated_at: str({ format: 'date-time' }), last_run_at: nullable('string', { format: 'date-time' }),
                } },
            },
        },
        paths: { ...Object.fromEntries(Object.entries(PATHS).sort(([a], [b]) => a.localeCompare(b)).map(([p, item]) => [MOUNT + p, item])) },
    };
}

/** The documented routes as "METHOD /api/v1/path": what the app must mount. */
function routes() {
    return Object.entries(PATHS).flatMap(([p, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${MOUNT}${p}`)).sort();
}

/** Serve GET /openapi.json here; GET /api/v1/openapi.json redirects to it (308). */
function mount(app, document = openapi()) {
    const send = (_req, res) => {
        res.set('Cache-Control', 'public, max-age=300');
        res.type('application/json; charset=utf-8').send(JSON.stringify(document));
    };
    app.get('/openapi.json', send);
    app.get('/api/v1/openapi.json', (_req, res) => res.redirect(308, '/openapi.json'));
}

module.exports = { openapi, routes, mount, MOUNT };

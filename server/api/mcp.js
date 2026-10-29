'use strict';
/**
 * The Search Fabric as a Model Context Protocol server (revision 2025-06-18), one stateless
 * Streamable HTTP endpoint:
 *
 *   POST /mcp       one JSON-RPC 2.0 request, or a batch array, over the same viewer and the same
 *                   search.fabric per-actor limit as POST /api/v1/query
 *   GET  /mcp       405 (Allow: POST)
 *   DELETE /mcp     405 (Allow: POST)
 *   OPTIONS /mcp    the CORS preflight a browser MCP client sends
 *
 * The two tools are read-only: openvibe_search runs the fabric (network, mine, web, news, video,
 * products, places, code) and openvibe_search_providers lists the web ladder's offers. Their input
 * and output schemas come from the published contracts at boot, so the enums cannot drift from the
 * fabric's request. There are no sessions and no Mcp-Session-Id: every call answers once as JSON.
 * A query is never echoed into any answer, a log line or an error.
 *
 * A call that needs a token and has none answers 401 with WWW-Authenticate: Bearer resource_metadata="…", so the
 * client learns where the protected-resource metadata is (RFC 9728; server/protected-resource.js).
 */
const fs = require('fs');
const express = require('express');
const { http } = require('openvibe-contracts');
const cache = require('openvibe-shared/cache-policy');
const pkg = require('../../package.json');
const { QueryError } = require('./query');
const { AuthError } = require('../auth');
const protectedResource = require('../protected-resource');
const { SEARCH_LIMITS } = require('./fabric');

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = Object.freeze(new Set(['2025-06-18', '2025-03-26']));
const BODY_LIMIT = '64kb';
const CONTRACT_DIR = 'openvibe-contracts/contracts/search';
// The scopes a call gets when it names none: the same default the tool's schema and the fabric use.
const DEFAULT_SCOPES = Object.freeze(['network']);

/** The request/result contracts as JSON Schema objects, read from the package at startup. */
function loadContracts() {
    const request = JSON.parse(fs.readFileSync(require.resolve(`${CONTRACT_DIR}/fabric-request.v1.json`), 'utf8'));
    const result = JSON.parse(fs.readFileSync(require.resolve(`${CONTRACT_DIR}/fabric-result.v1.json`), 'utf8'));
    // MCP's outputSchema is the result object itself; $schema/$id would make it a document, not a shape.
    delete result.$schema;
    delete result.$id;
    return { request, result };
}

const CONTRACTS = loadContracts();
const REQUEST_SCHEMA = CONTRACTS.request;
const RESULT_SCHEMA = CONTRACTS.result;

const INSTRUCTIONS = 'Search OpenVibe\'s permission-aware index and the open web: network covers OpenVibe\'s own sites, mine the caller\'s own documents (needs a signed-in person), web the open index and then DeepSeek for signed-in callers and Wikipedia, and news, video, products, places and code the OpenVibe documents of that kind. Results are grouped by scope and route.explain says what each step did and what it cost; web results carry the provider that found them and the date they were read. A query is never stored with a person\'s name: a Bearer token only decides what that person may see.';

/** A JSON Schema object for the MCP arguments; the enums are the fabric request contract's own. */
function inputSchema() {
    const properties = REQUEST_SCHEMA.properties || {};
    const scopeEnum = properties.scopes && properties.scopes.items && properties.scopes.items.enum;
    const freshnessEnum = properties.freshness && properties.freshness.enum;
    const depthEnum = properties.depth && properties.depth.enum;
    const q = properties.q || {};
    const site = (properties.filters && properties.filters.properties && properties.filters.properties.site) || {};
    return {
        type: 'object',
        required: ['q'],
        properties: {
            q: {
                type: 'string',
                minLength: Number.isInteger(q.minLength) ? q.minLength : 1,
                maxLength: Number.isInteger(q.maxLength) ? q.maxLength : 200,
                description: 'What to find (1-200 characters).',
            },
            scopes: {
                type: 'array',
                minItems: 1,
                maxItems: 10,
                uniqueItems: true,
                items: { enum: [...(scopeEnum || [])] },
                default: ['network'],
                description: 'Where to look; results are grouped by scope in this order. Default: network.',
            },
            freshness: {
                enum: [...(freshnessEnum || [])],
                default: 'any',
                description: 'How recent results must be, where the source dates them.',
            },
            depth: {
                enum: [...(depthEnum || [])],
                default: 'standard',
                description: 'quick: indexes and caches only; standard: the ladder until a step answers; deep: every step, merged.',
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 20,
                default: 8,
                description: 'At most this many results per scope.',
            },
            site: {
                type: 'string',
                maxLength: Number.isInteger(site.maxLength) ? site.maxLength : 253,
                ...(typeof site.pattern === 'string' ? { pattern: site.pattern } : {}),
                description: 'web: results from this host only.',
            },
        },
    };
}

const SEARCH_TOOL = {
    name: 'openvibe_search',
    title: 'Search OpenVibe and the web',
    description: 'Search OpenVibe\'s permission-aware index and the web. Scopes: network (OpenVibe\'s sites), mine (the caller\'s own documents; needs a signed-in person), web (OpenVibe\'s open index, then DeepSeek for signed-in callers, then Wikipedia), and news, video, products, places and code (OpenVibe\'s documents of that kind). Results come grouped by scope with route.explain and cost.',
    inputSchema: inputSchema(),
    outputSchema: RESULT_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: true },
};

const PROVIDERS_TOOL = {
    name: 'openvibe_search_providers',
    title: 'OpenVibe web search providers',
    description: 'The web search providers behind openvibe_search\'s web scope, with their price per call and whether they are available right now.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
};

const TOOLS = Object.freeze([SEARCH_TOOL, PROVIDERS_TOOL]);

function money(usd) {
    return `$${Number(usd || 0).toFixed(5)}`;
}

function stepText(step) {
    const bits = [`${step.scope}:${step.step}`, step.ok ? 'ok' : 'failed'];
    if (Number.isInteger(step.count)) bits.push(String(step.count));
    if (step.cached) bits.push('cached');
    if (Number.isFinite(step.cost_usd) && step.cost_usd > 0) bits.push(money(step.cost_usd));
    if (step.skipped) bits.push(`skipped (${step.skipped})`);
    return bits.join(' ');
}

/** The readable half of a tools/call result: a heading per scope, numbered results, then the route. */
function searchText(answer, limit) {
    const lines = [];
    const results = Array.isArray(answer.results) ? answer.results : [];
    for (const scope of Object.keys(answer.groups || {})) {
        lines.push(`## ${scope}`);
        const inScope = results.filter((r) => r.scope === scope).slice(0, limit);
        if (!inScope.length) lines.push('No results.');
        inScope.forEach((r, i) => {
            lines.push(`${i + 1}. ${r.title} — ${r.url}`);
            if (r.snippet) lines.push(`   ${r.snippet}`);
        });
    }
    const route = answer.route || {};
    const steps = Array.isArray(route.explain) ? route.explain.map(stepText) : [];
    lines.push(`Route: ${steps.length ? steps.join('; ') : 'no steps'}; cost ${money(route.cost_usd)}`);
    return lines.join('\n');
}

/** One line per provider: name, scopes, price, availability and the day's usage. */
function providersText(providers) {
    return (providers || []).map((p) => {
        const price = Number(p.price_usd_per_call) === 0 ? 'free' : `${money(p.price_usd_per_call)} per call`;
        const availability = p.available ? 'available' : `unavailable${p.reason ? `: ${p.reason}` : ''}`;
        const bits = [
            `scopes ${Array.isArray(p.scopes) ? p.scopes.join(', ') : 'unknown'}`,
            price,
            availability,
        ];
        if (p.daily_cap != null) bits.push(`${Number(p.used_today) || 0}/${p.daily_cap} calls today`);
        if (p.answered_rate != null) bits.push(`${Math.round(Number(p.answered_rate) * 100)}% answered`);
        if (p.latency_ms_p50 != null) bits.push(`p50 ${p.latency_ms_p50} ms`);
        if (p.terms_url) bits.push(p.terms_url);
        return `${p.provider}: ${bits.join(' · ')}`;
    }).join('\n');
}

/** The fabric request for the tool's arguments; the MCP default (8) is not the fabric default (20). */
function fabricBody(args) {
    // The tool's schema promises 1-20 where the fabric contract allows 1-50; refuse the gap here
    // rather than return more results than the caller's schema said it could ask for.
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20)) {
        throw new QueryError('search.bad_query', 'limit must be an integer between 1 and 20');
    }
    const body = { q: args.q, limit: args.limit === undefined ? 8 : args.limit };
    if (args.scopes !== undefined) body.scopes = args.scopes;
    if (args.freshness !== undefined) body.freshness = args.freshness;
    if (args.depth !== undefined) body.depth = args.depth;
    if (args.site !== undefined) body.filters = { site: args.site };
    return body;
}

function result(id, value) {
    return { jsonrpc: '2.0', id, result: value };
}

function error(id, code, message) {
    return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function validId(id) {
    return id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

/**
 * Run the fabric's per-actor limiter for one tools/call without letting it write to the real
 * response: the capture is what lets a batch count every call and still answer as one JSON-RPC
 * array. A refusal is copied to the HTTP response exactly as the fabric route sends it (429,
 * Retry-After, problem+json).
 */
function takeBudget(limit, req) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
        const capture = {
            statusCode: 200,
            headers: {},
            body: '',
            setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
            getHeader(name) { return this.headers[String(name).toLowerCase()]; },
            end(body) {
                this.body = body === undefined ? '' : String(body);
                finish({ limited: true, status: this.statusCode, headers: this.headers, body: this.body });
            },
        };
        try {
            limit(req, capture, (err) => {
                if (err) { settled = true; reject(err); return; }
                finish({ limited: false });
            });
        } catch (err) {
            settled = true;
            reject(err);
        }
    });
}

function sendLimited(res, gate) {
    res.statusCode = gate.status || 429;
    for (const [name, value] of Object.entries(gate.headers)) res.setHeader(name, value);
    res.end(gate.body);
}

function sendRpc(res, status, body) {
    return res.status(status).json(body);
}

/** Does this call ask for the caller's own material? The "mine" scope does; it needs a person. */
function wantsTheCallersOwn(args) {
    const scopes = Array.isArray(args.scopes) && args.scopes.length ? args.scopes : DEFAULT_SCOPES;
    return scopes.includes('mine');
}

/** 401 and the challenge: the call needs a token, and this is where to read how to get one. */
function unauthorized(res, id, config) {
    protectedResource.challenge(res, config);
    return res.status(401).json({
        jsonrpc: '2.0',
        id: id === undefined ? null : id,
        error: {
            code: -32001,
            message: 'Unauthorized: this call needs a person. Send a Network user token as a Bearer.',
            data: { resource_metadata: protectedResource.metadataUrl(config) },
        },
    });
}

/**
 * The viewer, with the RFC 9728 challenge on a 401: a client whose token does not verify is told where the
 * protected-resource metadata is. The rest is the query route's withViewer (server/api/query.js).
 */
function withMcpViewer(auth, config, handler) {
    return async (req, res, next) => {
        const ctx = req.ov;
        let viewer;
        try {
            viewer = await auth.viewer(req);
        } catch (err) {
            if (err instanceof AuthError) {
                if (err.status === 401) protectedResource.challenge(res, config);
                return http.sendProblem(res, err.status, err.code, { detail: err.message, ctx });
            }
            return next(err);
        }
        // Never cached: a visibility change or a deletion must leave results immediately.
        res.setHeader('Cache-Control', cache.htmlHeaders({ private: true }));
        res.setHeader('Vary', 'Authorization, Cookie, X-OV-Subject, X-OV-Groups, X-OV-Entitlements');
        req.viewer = viewer;
        return handler(req, res, viewer);
    };
}

async function callTool(id, params, req, viewer, { fabric, searchLimit }) {
    const name = params.name;
    if (name !== SEARCH_TOOL.name && name !== PROVIDERS_TOOL.name) {
        return { response: error(id, -32602, 'Unknown tool') };
    }

    const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments : {};

    // The "mine" scope is the caller's own private material, so it needs a person. An anonymous caller is told how
    // to authenticate (401 and the RFC 9728 challenge) instead of getting an empty answer; a service token keeps
    // its old answer, and with no X-OV-Subject the fabric says the scope needs a signed-in person.
    if (name === SEARCH_TOOL.name && wantsTheCallersOwn(args) && (!viewer || viewer.kind === 'anonymous')) {
        return { unauthorized: true, id };
    }

    const gate = await takeBudget(searchLimit, req);
    if (gate.limited) return { limited: gate };

    if (name === PROVIDERS_TOOL.name) {
        const providers = await fabric.providers();
        return {
            response: result(id, {
                content: [{ type: 'text', text: providersText(providers) }],
                structuredContent: { providers },
                isError: false,
            }),
        };
    }

    let answer;
    try {
        answer = await fabric.query(fabricBody(args), viewer);
    } catch (err) {
        // Per MCP a tool error is a result, not a JSON-RPC error: the caller can read it and retry.
        if (err instanceof QueryError) {
            return { response: result(id, { content: [{ type: 'text', text: err.message }], isError: true }) };
        }
        throw err;
    }
    const limit = Number.isInteger(args.limit) ? args.limit : 8;
    return {
        response: result(id, {
            content: [{ type: 'text', text: searchText(answer, limit) }],
            structuredContent: answer,
            isError: false,
        }),
    };
}

/** One JSON-RPC message: a response, a notification (no response), or a rate-limit stop. */
async function handleMessage(msg, req, viewer, deps) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        return { response: error(null, -32600, 'Invalid Request') };
    }
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
        return { response: error(null, -32600, 'Invalid Request') };
    }
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
    if (hasId && !validId(msg.id)) return { response: error(null, -32600, 'Invalid Request') };
    // MCP notifications carry no id; notifications/initialized is one even if a client labels it.
    if (!hasId || msg.method.startsWith('notifications/')) return { notification: true };

    const id = msg.id;
    const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {};
    switch (msg.method) {
        case 'initialize': {
            const requested = params.protocolVersion;
            const protocolVersion = SUPPORTED_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION;
            return {
                response: result(id, {
                    protocolVersion,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'openvibe-search', title: 'OpenVibe Search', version: pkg.version },
                    instructions: INSTRUCTIONS,
                }),
            };
        }
        case 'ping':
            return { response: result(id, {}) };
        case 'tools/list':
            return { response: result(id, { tools: TOOLS }) };
        case 'tools/call':
            return await callTool(id, params, req, viewer, deps);
        default:
            return { response: error(id, -32601, 'Method not found') };
    }
}

function mcpRouter({ fabric, auth, limits, config }) {
    const router = express.Router();
    const searchLimit = limits('search.fabric', SEARCH_LIMITS);
    // strict: false parses a scalar as JSON too, so "valid JSON, not a JSON-RPC message" is -32600
    // rather than blurring into -32700; dispatch below rejects every non-object.
    const json = express.json({ limit: BODY_LIMIT, type: ['application/json', 'application/*+json'], strict: false });

    // Browser-based MCP clients exist; the endpoint is anonymous or Bearer-token only, never cookies
    // as a cross-site credential (the browser will not send them to `*`).
    router.use('/mcp', (_req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

    router.options('/mcp', (_req, res) => {
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Protocol-Version');
        res.setHeader('Access-Control-Max-Age', '600');
        res.status(204).end();
    });

    router.post('/mcp', json, withMcpViewer(auth, config, async (req, res, viewer) => {
        const version = req.get('mcp-protocol-version');
        if (version && !SUPPORTED_VERSIONS.has(version)) {
            const body = req.body;
            const id = body && !Array.isArray(body) && (typeof body.id === 'string' || typeof body.id === 'number' || body.id === null)
                ? body.id : null;
            return sendRpc(res, 400, error(id, -32600, 'Unsupported protocol version'));
        }

        const offered = req.body;
        if (!offered || typeof offered !== 'object') {
            return sendRpc(res, 200, error(null, -32600, 'Invalid Request'));
        }
        const batch = Array.isArray(offered);
        if (batch && offered.length === 0) {
            return sendRpc(res, 200, error(null, -32600, 'Invalid Request'));
        }
        const messages = batch ? offered : [offered];
        const responses = [];
        for (const message of messages) {
            const out = await handleMessage(message, req, viewer, { fabric, searchLimit });
            if (out.unauthorized) return unauthorized(res, out.id, config);
            if (out.limited) return sendLimited(res, out.limited);
            if (out.response) responses.push(out.response);
        }

        // A notification (or a batch of only notifications) is accepted with no body.
        if (!responses.length) return res.status(202).end();
        return sendRpc(res, 200, batch ? responses : responses[0]);
    }));

    // Everything else is not part of the stateless Streamable HTTP transport this endpoint offers.
    router.all('/mcp', (_req, res) => {
        res.setHeader('Allow', 'POST');
        res.status(405).json(error(null, -32600, 'Method Not Allowed'));
    });

    // JSON parsing is ours, so a malformed body is a JSON-RPC parse error rather than the API's
    // problem+json envelope; a body over 64 KB is refused before any tool runs.
    // eslint-disable-next-line no-unused-vars
    router.use((err, req, res, next) => {
        if (err && err.type === 'entity.parse.failed') return sendRpc(res, 400, error(null, -32700, 'Parse error'));
        if (err && err.type === 'entity.too.large') return sendRpc(res, 413, error(null, -32600, 'Request body too large'));
        return next(err);
    });

    return router;
}

module.exports = {
    mcpRouter,
    TOOLS,
    INSTRUCTIONS,
    PROTOCOL_VERSION,
    SUPPORTED_VERSIONS,
    searchText,
    providersText,
    fabricBody,
};

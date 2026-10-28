'use strict';
/**
 * The Search Fabric (capability search.fabric.query): one search over several scopes, routed the
 * cheapest way that answers.
 *
 *   network   Search's own index, permission-aware exactly as the query API (searcher.run)
 *   mine      the same search as the caller, keeping only what is not public
 *   web       the open index first, then paid/free AI providers in a ladder, cached per step
 *   news, images, video, products, people, places, code
 *             facets of the same index, narrowed to the owner/type Search actually holds
 *
 * Every scope runs in parallel and comes back grouped in the requested order; route.explain has one
 * row per step (what answered, from cache, or why it did not run) and route.cost_usd what the paid
 * steps cost. The query text is never part of the answer: a page renders results without writing it
 * into its HTML.
 */
const contracts = require('openvibe-contracts');
const { QueryError } = require('../api/query');
const { cacheKey } = require('./cache');
const { hostOf, plainText, PRICE_USD } = require('./web');

const DEFAULT_SCOPES = ['network'];
const MAX_RESULTS = 100;
const MAX_EXPLAIN = 20;
const MAX_CITATIONS = 20;
const FRESHNESS_MS = { day: 86400000, week: 7 * 86400000, month: 30 * 86400000, year: 365 * 86400000 };

/**
 * The vertical scopes and the document kinds Search actually indexes for them. A scope with no entry
 * (images and people today) has nothing to narrow yet and says so instead of guessing. Several
 * matchers are allowed where one product has two kinds (a recorded stream and an uploaded video).
 */
const VERTICALS = {
    news: [{ owner: 'news', type: 'story' }],
    video: [{ owner: 'live', type: 'vod' }, { owner: 'media-hub', type: 'video' }],
    products: [{ owner: 'reviews', type: 'entity' }],
    places: [{ owner: 'rent', type: 'city' }, { owner: 'rent', type: 'listing' }, { owner: 'reviews', type: 'entity' }],
    code: [{ owner: 'codes' }],
};

function clip(value, max) {
    return String(value == null ? '' : value).slice(0, max);
}

function msSince(start, now) {
    return Math.max(0, Math.round(now() - start));
}

/** URL identity for de-duplication: no #fragment and no trailing slash. */
function urlKey(url) {
    try {
        const u = new URL(String(url));
        u.hash = '';
        const s = u.toString();
        return s.endsWith('/') ? s.slice(0, -1) : s;
    } catch {
        const s = String(url).split('#')[0];
        return s.endsWith('/') ? s.slice(0, -1) : s;
    }
}

function hostMatches(host, site) {
    const h = String(host || '').toLowerCase();
    const s = String(site || '').toLowerCase();
    return Boolean(h && s) && (h === s || h.endsWith(`.${s}`));
}

function isFresh(publishedAt, freshness, at) {
    const window = FRESHNESS_MS[freshness];
    if (!window || !publishedAt) return true;
    const t = Date.parse(publishedAt);
    return !Number.isFinite(t) || t >= at - window;
}

/** One document from Search's index as a fabric result. `scope` decides the group it belongs to. */
function documentResult(doc, scope) {
    if (!doc || !doc.canonical_url) return null;
    const url = clip(doc.canonical_url, 2048);
    const snippet = doc.snippet_html ? plainText(doc.snippet_html, 600)
        : doc.summary ? plainText(doc.summary, 600) : null;
    const site = hostOf(url);
    return {
        scope,
        kind: 'document',
        title: clip(doc.title || url, 300),
        url,
        snippet: snippet || null,
        site: site ? clip(site, 253) : null,
        image: null,
        published_at: doc.published_at ? clip(doc.published_at, 40) : null,
        retrieved_at: null,
        provider: null,
        owner: doc.owner ? clip(doc.owner, 32) : null,
        type: doc.type ? clip(doc.type, 32) : null,
        id: doc.id ? clip(doc.id, 200) : null,
        score: null,
    };
}

/** An open-index document as a web page: it is in Search's index, but it cites like any web source. */
function openIndexResult(doc, at) {
    const r = documentResult(doc, 'web');
    if (!r) return null;
    return {
        ...r,
        kind: 'page',
        retrieved_at: new Date(at).toISOString(),
        provider: 'open_index',
        owner: null, type: null, id: null,
    };
}

/** Cache TTLs by freshness: a day's news is stale in an hour, the week's in six, the rest in a day. */
function cacheTtl(freshness) {
    if (freshness === 'day') return 3600000;
    if (freshness === 'week') return 6 * 3600000;
    return 24 * 3600000;
}

function createFabric({ config, searcher, cache, web, db, now = () => Date.now(), log = console }) {
    const fabric = config.fabric || {};
    const st = {
        stat: db.prepare('SELECT calls, answered, ms_total FROM query_provider_stats WHERE day = ? AND provider = ?'),
        bump: db.prepare(`INSERT INTO query_provider_stats (day, provider, calls, answered, ms_total)
            VALUES (@day, @provider, 1, @answered, @ms_total)
            ON CONFLICT (day, provider) DO UPDATE SET
                calls = query_provider_stats.calls + 1,
                answered = query_provider_stats.answered + EXCLUDED.answered,
                ms_total = query_provider_stats.ms_total + EXCLUDED.ms_total`),
    };

    const day = () => new Date(now()).toISOString().slice(0, 10);
    const dailyCap = () => {
        const cap = Number(fabric.dailyCap);
        return Number.isFinite(cap) ? cap : 500;
    };

    async function providerStats(provider) {
        const row = await st.stat.get(day(), provider);
        return {
            calls: row ? Number(row.calls) : 0,
            answered: row ? Number(row.answered) : 0,
            ms_total: row ? Number(row.ms_total) : 0,
        };
    }

    /** One provider call: counted whether or not it answered; `answered` only when it returned results. */
    async function recordProvider(provider, r) {
        await st.bump.run({
            day: day(), provider,
            answered: r.ok && r.results.length ? 1 : 0,
            ms_total: Math.max(0, Math.round(Number(r.ms) || 0)),
        });
    }

    function networkFilters(requested) {
        const filters = { facets: [] };
        if (requested.owner) filters.owner = requested.owner;
        if (requested.type) filters.type = requested.type;
        if (requested.lang) filters.language = requested.lang;
        return filters;
    }

    function runNetwork({ q, viewer, limit, cursor, requested }) {
        return (async () => {
            const started = now();
            const page = await searcher.run({ text: q, filters: networkFilters(requested), viewer, limit, cursor });
            const results = [];
            for (const doc of page.results || []) {
                const r = documentResult(doc, 'network');
                if (r) results.push(r);
                if (results.length >= limit) break;
            }
            return {
                results,
                next_cursor: page.next_cursor || null,
                explain: [{ scope: 'network', step: 'index', ok: true, count: results.length, ms: msSince(started, now) }],
            };
        })();
    }

    function runMine({ q, viewer, limit, cursor, requested }) {
        return (async () => {
            if (!viewer.subject) {
                return {
                    results: [], next_cursor: null,
                    explain: [{ scope: 'mine', step: 'index', ok: false, count: 0, skipped: 'needs a signed-in person' }],
                };
            }
            const started = now();
            const page = await searcher.run({ text: q, filters: networkFilters(requested), viewer, limit, cursor });
            const results = [];
            for (const doc of page.results || []) {
                // The scope is the caller's own private material; public hits are the network scope's.
                if (doc.visibility === 'public') continue;
                const r = documentResult(doc, 'mine');
                if (r) results.push(r);
                if (results.length >= limit) break;
            }
            return {
                results,
                next_cursor: page.next_cursor || null,
                explain: [{ scope: 'mine', step: 'index', ok: true, count: results.length, ms: msSince(started, now) }],
            };
        })();
    }

    function runVertical({ scope, q, viewer, limit }) {
        const matchers = VERTICALS[scope];
        if (!matchers || !matchers.length) {
            return Promise.resolve({
                results: [], next_cursor: null,
                explain: [{ scope, step: 'index', ok: false, count: 0, skipped: 'not indexed yet' }],
            });
        }
        return (async () => {
            const started = now();
            const pages = await Promise.all(matchers.map((m) => searcher.run({
                text: q, filters: { facets: [], ...m }, viewer, limit,
            })));
            const results = [];
            const seen = new Set();
            for (const page of pages) {
                for (const doc of page.results || []) {
                    const key = `${doc.owner}/${doc.type}/${doc.id}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const r = documentResult(doc, scope);
                    if (r) results.push(r);
                    if (results.length >= limit) break;
                }
                if (results.length >= limit) break;
            }
            return {
                results, next_cursor: null,
                explain: [{ scope, step: 'index', ok: true, count: results.length, ms: msSince(started, now) }],
            };
        })();
    }

    /** The web ladder and its merged, de-duplicated results (one explain row per step). */
    async function runWeb({ q, viewer, limit, freshness, site, depth }) {
        const explain = [];
        const merged = [];
        const seen = new Set();
        const threshold = Math.min(limit, 3);
        // standard stops climbing once earlier steps found enough; deep runs every step.
        const enough = () => depth !== 'deep' && merged.length >= threshold;

        function add(results) {
            const added = [];
            for (const r of results) {
                if (!r || !r.url) continue;
                const key = urlKey(r.url);
                if (!key || seen.has(key)) continue;
                seen.add(key);
                added.push(r);
                merged.push(r);
            }
            return added;
        }

        function row(step, fields) {
            explain.push({ scope: 'web', step, ...fields });
        }

        // 1. OpenVibe's own open index: free and always first, for anonymous and signed-in callers alike.
        {
            const started = now();
            const owners = (Array.isArray(fabric.openIndexOwners) ? fabric.openIndexOwners : ['sources'])
                .filter((o) => typeof o === 'string' && o);
            const pages = await Promise.all(owners.map((owner) => searcher.run({
                text: q, filters: { facets: [], owner }, viewer, limit,
            })));
            const stepResults = [];
            const at = now();
            for (const page of pages) {
                for (const doc of page.results || []) {
                    const r = openIndexResult(doc, at);
                    if (r) stepResults.push(r);
                    if (stepResults.length >= limit) break;
                }
                if (stepResults.length >= limit) break;
            }
            const added = add(stepResults);
            row('open_index', { ok: true, count: added.length, ms: msSince(started, now) });
        }

        async function ladder(step, providers, { paid }) {
            const started = now();
            const skip = (why) => row(step, { ok: false, count: 0, skipped: why });
            if (enough()) return skip('earlier steps answered');

            // A cached answer costs nothing and is served to anyone the earlier steps did not satisfy.
            const key = cacheKey([q, 'web', step, freshness, site]);
            let cached = null;
            try { cached = await cache.get(key); } catch (err) { log.warn(`[fabric] cache read: ${err.message}`); }
            if (cached) {
                const results = (Array.isArray(cached.results) ? cached.results : []).map((r) => ({ ...r, scope: 'web' }));
                const added = add(results);
                return row(step, { ok: true, count: added.length, ms: msSince(started, now), cached: true, cost_usd: 0 });
            }

            if (depth === 'quick') return skip('quick search reads indexes only');
            if (paid && !(viewer.subject || viewer.kind === 'service')) return skip('paid providers need a signed-in person');
            if (fabric.web === false) return skip('web search is off');
            const availability = web.available();
            if (!availability.configured) return skip(availability.reason || 'not configured');
            if (paid) {
                const stats = await providerStats('deepseek');
                if (stats.calls >= dailyCap()) return skip('daily cap reached');
            }

            const r = await web.research(q, { providers, limit });
            await recordProvider(step, r);
            if (!r.ok) return row(step, { ok: false, count: 0, ms: r.ms });
            const results = r.results.slice(0, limit);
            try {
                await cache.put(key, { scope: 'web', step, results, cost_usd: r.cost_usd }, cacheTtl(freshness));
            } catch (err) {
                log.warn(`[fabric] cache write: ${err.message}`);
            }
            add(results);
            return row(step, { ok: true, count: results.length, ms: r.ms, cost_usd: r.cost_usd });
        }

        await ladder('deepseek', ['deepseek'], { paid: true });
        await ladder('wikipedia', ['wikipedia'], { paid: false });
        return { results: merged.slice(0, limit), next_cursor: null, explain };
    }

    /**
     * Answer one request. Validation, defaults and QueryError are the API's contract; this function
     * never throws for a scope the caller may not use (that is a route.explain row).
     */
    async function query(body, viewer) {
        viewer = viewer || { kind: 'anonymous', subject: null };
        const checked = contracts.validate('search.fabric-request@1', body);
        if (!checked.valid) {
            const first = checked.errors[0];
            const detail = first ? `${first.path === '/' ? '' : `${first.path}: `}${first.message}` : 'body does not match search.fabric-request@1';
            throw new QueryError('search.bad_query', detail);
        }

        const q = body.q;
        const scopes = body.scopes && body.scopes.length ? body.scopes : DEFAULT_SCOPES;
        const freshness = body.freshness || 'any';
        const depth = body.depth || 'standard';
        const limit = body.limit || 20;
        const cursor = body.cursor;
        const requested = body.filters || {};
        const site = requested.site || null;
        const askedForAnswer = body.answer === true;

        const runs = await Promise.all(scopes.map((scope) => {
            if (scope === 'network') return runNetwork({ q, viewer, limit, cursor, requested });
            if (scope === 'mine') return runMine({ q, viewer, limit, cursor, requested });
            if (scope === 'web') return runWeb({ q, viewer, limit, freshness, site, depth });
            return runVertical({ scope, q, viewer, limit });
        }));

        let results = [];
        let explain = [];
        const cursors = {};
        for (let i = 0; i < scopes.length; i++) {
            const run = runs[i];
            results.push(...run.results);
            explain.push(...run.explain);
            if (run.next_cursor) cursors[scopes[i]] = run.next_cursor;
        }

        // Freshness is a property of the result, whichever scope found it; a site filter only narrows web pages.
        const at = now();
        if (freshness !== 'any') results = results.filter((r) => isFresh(r.published_at, freshness, at));
        if (site) results = results.filter((r) => r.scope !== 'web' || hostMatches(r.site, site));
        results = results.slice(0, MAX_RESULTS);

        const groups = {};
        for (const scope of scopes) groups[scope] = results.filter((r) => r.scope === scope).length;

        if (askedForAnswer) {
            explain.push({ scope: scopes[0], step: 'answer', ok: false, skipped: 'answers are not on yet' });
        }

        const citations = results.filter((r) => r.scope === 'web').slice(0, MAX_CITATIONS).map((r, i) => ({
            n: i + 1,
            url: r.url,
            title: r.title,
            provider: r.provider,
            retrieved_at: r.retrieved_at,
        }));

        const cost_usd = explain.reduce((sum, r) => sum + (Number(r.cost_usd) || 0), 0);
        const answer = {
            results,
            groups,
            answer: null,
            citations,
            route: { explain: explain.slice(0, MAX_EXPLAIN), cost_usd },
            next_cursor: scopes.length === 1 && (scopes[0] === 'network' || scopes[0] === 'mine')
                ? (cursors[scopes[0]] || null)
                : null,
        };

        // Development and tests catch a schema drift before it ships; production keeps answering.
        if (!config.isProduction) {
            const valid = contracts.validate('search.fabric-result@1', answer);
            if (!valid.valid) {
                const first = valid.errors[0];
                log.error(`[fabric] answer violates search.fabric-result@1: ${first ? `${first.path} ${first.message}` : 'unknown'}`);
            }
        }
        return answer;
    }

    /** GET /api/v1/query/providers: the ladder's offers, with today's paid-provider usage. */
    async function providers() {
        const checkedAt = new Date(now()).toISOString();
        const stats = await providerStats('deepseek');
        const cap = dailyCap();
        const availability = web.available();
        const reason = !availability.configured ? availability.reason
            : fabric.web === false ? 'web search is off'
                : stats.calls >= cap ? 'daily cap reached' : null;
        return [
            {
                provider: 'open_index', scopes: ['web'], price_usd_per_call: 0,
                independent_index: true, available: true, checked_at: checkedAt,
            },
            {
                provider: 'deepseek', scopes: ['web', 'news'], price_usd_per_call: PRICE_USD,
                independent_index: false, available: !reason, reason: reason || null,
                daily_cap: cap, used_today: stats.calls,
                latency_ms_p50: stats.calls ? Math.round(stats.ms_total / stats.calls) : null,
                answered_rate: stats.calls ? stats.answered / stats.calls : null,
                terms_url: 'https://api-docs.deepseek.com/guides/search',
                checked_at: checkedAt,
            },
            {
                provider: 'wikipedia', scopes: ['web'], price_usd_per_call: 0,
                independent_index: true, available: true,
                terms_url: 'https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use',
                checked_at: checkedAt,
            },
        ];
    }

    return { query, providers };
}

module.exports = { createFabric, VERTICALS, urlKey, cacheTtl };

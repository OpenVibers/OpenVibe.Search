'use strict';
/**
 * The web ladder's paid/free providers, through OpenVibe.AI's research workflow:
 *
 *   POST <config.fabric.aiUrl>/api/v1/research?wait=15000
 *   { query, providers, images: false, max_sources, content_chars }
 *
 * AI answers { run }; run.output is the evidence pack (sources, providers, usage). Each source becomes
 * one Search Fabric page result with its provider, URL and dates. research() never throws: a network
 * failure, a non-2xx answer or a run that did not succeed comes back as { ok: false, error } so a web
 * step can be reported in route.explain without failing the whole query.
 *
 * The token is the SDK's service-token client for audience openvibe.ai; it is fetched lazily and only
 * when the provider is configured, so development and the tests boot without AI.
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const PRICE_USD = 0.00075;
const TIMEOUT_MS = 20000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': '\'', '#x27': '\'', apos: '\'' };

/** Plain text for a snippet: tags out, the five common entities decoded, whitespace collapsed. */
function plainText(value, max = 600) {
    return String(value == null ? '' : value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/&(amp|lt|gt|quot|#39|#x27|apos);/g, (_m, e) => ENTITIES[e])
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

/** A URL's host, lowercased, or null when it does not parse. */
function hostOf(url) {
    try { return new URL(String(url)).hostname.toLowerCase() || null; } catch { return null; }
}

/** Short, safe error text for route.explain/status; never a token or a full response body. */
function shortError(err) {
    const text = String((err && (err.message || err.name)) || 'request failed').replace(/\s+/g, ' ').trim();
    return text.slice(0, 160) || 'request failed';
}

function createWebProviders({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    const fabric = config.fabric || {};
    const oauth = config.oauth || {};
    const aiUrl = String(fabric.aiUrl || '').replace(/\/$/, '');
    let tokens = null;

    function available() {
        const missing = [];
        if (!aiUrl) missing.push('OV_AI_INTERNAL_URL');
        if (!oauth.clientSecret) missing.push('OV_OAUTH_CLIENT_SECRET');
        return { configured: missing.length === 0, reason: missing.length ? `${missing.join(' and ')} unset` : null };
    }

    function tokenClient() {
        if (!tokens) {
            tokens = createServiceTokenClient({
                network: config.networkInternalUrl,
                clientId: oauth.clientId,
                clientSecret: oauth.clientSecret,
                audience: 'openvibe.ai',
                fetch: fetchImpl,
                now,
            });
        }
        return tokens;
    }

    /** One AI research call: { results, ok, ms, cost_usd, error }. */
    async function research(q, { providers = [], limit = 20, signal = null } = {}) {
        const started = now();
        const ms = () => Math.max(0, Math.round(now() - started));
        const fail = (error) => ({ results: [], ok: false, ms: ms(), cost_usd: 0, error });

        const availability = available();
        if (!availability.configured) return fail(availability.reason);
        if (!Array.isArray(providers) || !providers.length) return fail('no providers asked for');

        const body = {
            query: String(q).slice(0, 200),
            providers,
            images: false,
            max_sources: Math.min(Math.max(1, Number(limit) || 20), 20),
            content_chars: 500,
        };

        try {
            const token = await tokenClient().getToken({ audience: 'openvibe.ai' });
            const timeout = AbortSignal.timeout(TIMEOUT_MS);
            const res = await fetchImpl(`${aiUrl}/api/v1/research?wait=15000`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(body),
                signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            });
            if (!res.ok) return fail(`AI answered ${res.status}`);
            let json;
            try { json = await res.json(); } catch { return fail('AI answered no JSON'); }
            const run = json && json.run;
            if (!run) return fail('AI answered no run');
            if (run.status !== 'succeeded' && run.status !== 'cached') return fail(`AI run ${run.status || 'did not finish'}`);
            const output = run.output;
            if (!output || !Array.isArray(output.sources)) return fail('AI run has no sources');

            const mapped = [];
            for (const source of output.sources) {
                if (!source || !source.url) continue;
                const url = String(source.url).slice(0, 2048);
                const site = hostOf(url);
                if (!site) continue;
                const provider = source.provider || (source.provenance && source.provenance.provider) || providers[0] || null;
                const published = source.published_at || source.publishedAt || source.date || null;
                mapped.push({
                    scope: 'web',
                    kind: 'page',
                    title: plainText(source.title || site, 300) || site,
                    url,
                    snippet: plainText(source.snippet || source.summary || source.excerpt || source.content, 600) || null,
                    site: site.slice(0, 253),
                    image: null,
                    published_at: published ? String(published).slice(0, 40) : null,
                    retrieved_at: String(source.retrieved_at || output.retrieved_at || new Date(now()).toISOString()).slice(0, 40),
                    provider: provider ? String(provider).slice(0, 40) : null,
                    owner: null, type: null, id: null,
                    score: null,
                });
            }
            // 1 for the first source, falling evenly to 1/n for the last: order is the provider's rank.
            mapped.forEach((r, i) => { r.score = 1 - i / mapped.length; });

            const deepseek = output.providers && output.providers.deepseek;
            const billed = providers.includes('deepseek') && deepseek && deepseek.ok === true && Number(deepseek.count) > 0;
            return { results: mapped, ok: true, ms: ms(), cost_usd: billed ? PRICE_USD : 0, error: null };
        } catch (err) {
            log.warn(`[fabric] AI research: ${shortError(err)}`);
            return fail(shortError(err));
        }
    }

    return { research, available };
}

module.exports = { createWebProviders, plainText, hostOf, PRICE_USD };

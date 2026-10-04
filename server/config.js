'use strict';
/**
 * OpenVibe.Search configuration. Everything comes from the environment (.env in development,
 * /etc/openvibe/search.env in production); see .env.example for the documented list.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */

const int = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
};
const list = (v, d) => (v == null || v === '' ? d : String(v).split(',').map(s => s.trim()).filter(Boolean));
const strip = (v) => String(v || '').replace(/\/$/, '');
const num = (v, d) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : d;
};

const ZONE_ID_RE = /^[0-9a-f]{32}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * CLOUDFLARE_ZONE_IDS: `host=zoneid` pairs, comma-separated (openvibe.wiki=<32 hex>,...). A URL
 * belongs to the zone whose host equals its hostname or is a parent of it (longest match wins).
 * Malformed pairs throw at boot rather than silently purging nothing.
 */
function parseZones(v) {
    const out = [];
    for (const pair of list(v, [])) {
        const i = pair.indexOf('=');
        const host = (i > 0 ? pair.slice(0, i) : '').trim().toLowerCase().replace(/\.$/, '');
        const zoneId = (i > 0 ? pair.slice(i + 1) : '').trim().toLowerCase();
        if (!HOST_RE.test(host) || !ZONE_ID_RE.test(zoneId)) throw new Error(`CLOUDFLARE_ZONE_IDS: "${pair}" is not host=<32-hex zone id>`);
        out.push({ host, zoneId });
    }
    return out.sort((a, b) => b.host.length - a.host.length);
}

/**
 * Services whose index-document events are accepted from OpenVibe.Events. Events already
 * guarantees an event's `source` is the service that published it; this list decides which
 * sources may feed the index at all. The direct API is decided by the search.document.write grant.
 */
const DEFAULT_EVENT_OWNERS = ['wiki', 'blog', 'news', 'reviews', 'deals', 'coupons', 'trade',
    'community', 'live', 'media', 'codes', 'games', 'tools', 'sources'];

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4710);
    return {
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        serviceId: 'search',
        baseUrl: strip(env.BASE_URL || (isProduction ? 'https://search.openvibe.network' : `http://localhost:${port}`)),

        // Identity: OpenVibe.Network signs service tokens (audience openvibe.search) and user JWTs; the
        // SDK's JWKS client fetches the keys from <networkInternalUrl>/api/.well-known/jwks.
        networkInternalUrl: strip(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        issuer: strip(env.OV_NETWORK_ISSUER || env.OV_NETWORK_URL || 'https://openvibe.network'),
        audience: 'openvibe.search',
        // A browser's user JWT is accepted when its aud contains one of these.
        userAudiences: list(env.SEARCH_USER_AUDIENCES, ['openvibe.search', 'openvibe.network']),
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'search',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
        },

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role).
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '' },

        // Events: the outbox relays only when EVENTS_URL is set (rows wait otherwise).
        events: {
            url: strip(env.EVENTS_URL || ''),
            relayIntervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
            // Subscription secrets for POST /internal/events (comma-separated: rotation keeps both).
            webhookSecrets: list(env.SEARCH_EVENTS_SECRET, []),
            owners: list(env.SEARCH_EVENT_OWNERS, DEFAULT_EVENT_OWNERS),
        },

        query: {
            maxLimit: 50,
            defaultLimit: 20,
            maxTerms: 16,
            maxFacetFilters: 8,
        },
        maxBodyBytes: int(env.SEARCH_MAX_BODY_BYTES, 256 * 1024),

        // Freshness weighting of full-text relevance (README "Ranking"):
        //   score = bm25 × (1 + weight × 2^(−age_days / halfLifeDays)); weight 0 turns it off.
        freshness: {
            weight: Math.max(0, num(env.SEARCH_FRESHNESS_WEIGHT, 1)),
            halfLifeDays: Math.max(0.01, num(env.SEARCH_FRESHNESS_HALF_LIFE_DAYS, 30)),
        },

        savedSearches: {
            maxPerSubject: Math.max(1, int(env.SEARCH_SAVED_MAX_PER_SUBJECT, 50)),
            // Notifications of new matches through OpenVibe.Network (server/saved-notifier.js): off unless
            // SEARCH_SAVED_NOTIFY=1, and then only with OV_OAUTH_CLIENT_SECRET (the Network OAuth client `search`).
            notify: env.SEARCH_SAVED_NOTIFY === '1',
            notifyIntervalMs: Math.max(1000, int(env.SEARCH_SAVED_NOTIFY_INTERVAL_MS, 15 * 60 * 1000)),
            notifyBatch: Math.max(1, int(env.SEARCH_SAVED_NOTIFY_BATCH, 100)),
        },

        // Per-actor limits at the API routes (server/actor-limits.js, roadmap WS-R task 4): the requests
        // one caller may make to a read route per minute and per hour. Indexing, suggest and saved-search
        // changes set their own numbers where they are mounted.
        limits: {
            minute: Math.max(1, int(env.SEARCH_LIMITS_MINUTE, 120)),
            hour: Math.max(1, int(env.SEARCH_LIMITS_HOUR, 3000)),
        },

        // IndexNow (openvibe-shared/indexnow): Search publishes no pages of its own to submit, so
        // there is nothing to ping — only the key file is served, at /<key>.txt, when a key is set.
        // Unset: off, nothing is mounted and nothing is ever sent.
        indexnow: { key: String(env.INDEXNOW_KEY || '').trim() },

        // Removal purge queue (server/purge.js). Every removal is recorded for owners; the
        // Cloudflare purge of a formerly public URL runs only when the token is set.
        purge: {
            cloudflareToken: env.CLOUDFLARE_PURGE_TOKEN || '',
            zones: parseZones(env.CLOUDFLARE_ZONE_IDS),
            // Paths on the removed URL's host purged with it (the product's sitemap, feeds).
            relatedPaths: list(env.CLOUDFLARE_PURGE_RELATED_PATHS, ['/sitemap.xml'])
                .filter(p => /^\/[A-Za-z0-9._~\/-]*$/.test(p)),
            apiBase: strip(env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4'),
            intervalMs: int(env.CLOUDFLARE_PURGE_INTERVAL_MS, 5000),
        },
    };
}

module.exports = { load, parseZones, DEFAULT_EVENT_OWNERS };

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

        // Identity: OpenVibe.Network signs service tokens (audience openvibe.search) and user JWTs.
        networkUrl: strip(env.OV_NETWORK_URL || 'https://openvibe.network'),
        networkInternalUrl: strip(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        issuer: strip(env.OV_NETWORK_ISSUER || env.OV_NETWORK_URL || 'https://openvibe.network'),
        networkPublicKey: env.OV_NETWORK_PUBLIC_KEY ? env.OV_NETWORK_PUBLIC_KEY.replace(/\\n/g, '\n') : null,
        audience: 'openvibe.search',
        // A browser's user JWT is accepted when its aud contains one of these.
        userAudiences: list(env.SEARCH_USER_AUDIENCES, ['openvibe.search', 'openvibe.network']),
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'search',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
        },

        dbPath: env.SEARCH_DB_PATH || './data/search.db',

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
    };
}

module.exports = { load, DEFAULT_EVENT_OWNERS };

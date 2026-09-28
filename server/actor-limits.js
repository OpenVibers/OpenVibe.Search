'use strict';
/**
 * Per-actor rate limits at the API routes (roadmap WS-R task 4; openvibe-sdk/limits).
 *
 * nginx limits by address; these limit by who calls, once the route's credential is checked:
 *   owner routes (requireCap)   the service principal (svc:wiki)
 *   queries (withViewer)        the person: a Network user's subject, or the X-OV-Subject a first-party
 *                               service vouches for (user:usr_…); a signed-out caller by address
 * A first-party service querying for its signed-out visitors (a delegate token without X-OV-Subject)
 * is not counted: it speaks for all of them and limits them itself, so one budget would refuse its
 * whole site. Past a limit the route answers 429 problem+json `rate_limited` with Retry-After before
 * it does any work; the refusal is logged once and counted in search_rate_limited_total{limit,window}.
 * Read routes get SEARCH_LIMITS_MINUTE / SEARCH_LIMITS_HOUR (120 and 3000). Counters live in this
 * process: a restart forgets them.
 *
 * Never limited: /api/health, /api/ready, /release.json, /metrics, and the signed Events deliveries
 * (POST /internal/events: Events pushes at its own pace, and a 429 would only make it retry and fall
 * behind). The HTML page (GET /) stays with nginx's address limits.
 */
const { createActorLimiter, defaultActor } = require('openvibe-sdk/limits');

function actor(req) {
    const v = req.viewer;
    if (!v) return defaultActor(req);                 // owner routes: req.principal.sub
    if (v.subject) return `user:${v.subject}`;
    if (v.kind === 'service') return null;
    return defaultActor(req);                         // signed out: ip:<address>
}

/** limits(name, own) middleware for one app. */
function createLimits({ config, now = () => Date.now(), registry = null, log = console }) {
    const refused = registry
        ? registry.counter({ name: 'search_rate_limited_total', help: 'Requests refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    return createActorLimiter({
        limits: { minute: config.limits.minute, hour: config.limits.hour },
        actor,
        now,
        onLimited(e) {
            // The actor is a principal, a subject id or an address, never a token.
            log.warn(`[limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
}

module.exports = { createLimits, actor };

'use strict';
/**
 * OpenVibe.Network client for saved-search notifications (server/saved-notifier.js):
 *
 *   resolve(subject)              GET  /internal/identity/resolve?subject_id=usr_…   identity.subject.resolve
 *                                 → Network's numeric user id, or null (no such person, or a deleted account)
 *   push(subject, notification)   resolve, then POST /internal/notifications/push    network.notifications.push
 *                                 (network.notification-push-request@1) → { sent: true, skipped } | { sent: false, reason }
 *
 * Client-credentials tokens for audience openvibe.network from the Network OAuth client `search`
 * (config.oauth), one per capability; a 401 drops the cached token so the next call fetches a new one.
 * Any other refusal throws a NetworkError carrying the status only: tokens, the client secret and
 * Network's answer bodies are never logged.
 */
const { serviceAuth } = require('openvibe-contracts');

class NetworkError extends Error {
    constructor(message, status = null) {
        super(message);
        this.name = 'NetworkError';
        this.status = status;
    }
}

/**
 * createNetworkPush({ config, fetchImpl?, tokenClient?, timeoutMs? }). `tokenClient` (tests) replaces
 * both token clients.
 */
function createNetworkPush({ config, fetchImpl = globalThis.fetch, tokenClient = null, timeoutMs = 5000 }) {
    const base = config.networkInternalUrl;
    const tokens = (scope) => tokenClient || serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network', scope, fetchImpl, timeoutMs,
    });
    const resolveTokens = tokens('identity.subject.resolve');
    const pushTokens = tokens('network.notifications.push');

    async function call(what, tokenSource, path, body) {
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, {
                method: body ? 'POST' : 'GET',
                headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokenSource.authHeaders()) },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            throw new NetworkError(`${what}: ${err.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : err.message}`, err.status || null);
        }
        if (res.status === 401) tokenSource.invalidate?.();
        return res;
    }

    async function resolve(subject) {
        const res = await call('identity resolve', resolveTokens, `/internal/identity/resolve?subject_id=${encodeURIComponent(subject)}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new NetworkError(`identity resolve: Network answered ${res.status}`, res.status);
        const body = await res.json().catch(() => null);
        if (!body || body.deleted || body.network_user_id == null) return null;
        return body.network_user_id;
    }

    async function push(subject, notification) {
        const userId = await resolve(subject);
        if (userId == null) return { sent: false, reason: 'unknown_subject' };
        const res = await call('notification push', pushTokens, '/internal/notifications/push', { ...notification, user_id: userId });
        if (!res.ok) throw new NetworkError(`notification push: Network answered ${res.status}`, res.status);
        const body = await res.json().catch(() => ({}));
        // skipped: the person switched the category off; Network made its decision, so it counts as delivered.
        return { sent: true, skipped: Boolean(body && body.skipped) };
    }

    return { resolve, push };
}

module.exports = { createNetworkPush, NetworkError };

'use strict';
/**
 * Adapter for saved-search notifications (server/saved-notifier.js). The SDK resolves the subject,
 * sends one push through OpenVibe.Network, and manages service tokens. Only the HTTP status leaves
 * this adapter on failure; Network's response, tokens and the client secret stay out of logs.
 */
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createNotificationsClient } = require('openvibe-sdk/notifications');

class NetworkError extends Error {
    constructor(status = null) {
        super(status == null ? 'Network request failed' : `Network request failed (${status})`);
        this.name = 'NetworkError';
        this.status = status;
    }
}

/** createNetworkPush({ config, fetchImpl?, tokenClient?, timeoutMs? }) → { push }. */
function createNetworkPush({ config, fetchImpl = globalThis.fetch, tokenClient = null, timeoutMs = 5000 }) {
    const network = config.networkInternalUrl;
    // Built on first use: a Search without the Network OAuth client (development, most tests) boots fine, and only a
    // push it then attempts fails (the notifier is off unless that client is configured anyway).
    let notifications = null;
    function client() {
        if (notifications) return notifications;
        const tokenProvider = tokenClient || createServiceTokenClient({
            network, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl,
        });
        notifications = createNotificationsClient(createClient({ tokenProvider, baseUrls: { network }, fetch: fetchImpl, timeoutMs }));
        return notifications;
    }

    async function push(subject, notification) {
        try {
            return await client().push({ subjectId: subject, ...notification });
        } catch (err) {
            throw new NetworkError(Number.isInteger(err && err.status) && err.status > 0 ? err.status : null);
        }
    }

    return { push };
}

module.exports = { createNetworkPush, NetworkError };

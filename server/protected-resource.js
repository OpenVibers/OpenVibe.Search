'use strict';

/**
 * RFC 9728 protected-resource metadata for Search's MCP endpoint (POST /mcp), and the challenge that points at it.
 *
 * The endpoint takes a Network token as a Bearer: a person's token for the "mine" scope of the Search Fabric (or a
 * service token with the fabric capability). A client that has no token has to learn where to get one, so Search
 * publishes the metadata at /.well-known/oauth-protected-resource and answers a call that needs a token with 401 and
 * WWW-Authenticate: Bearer resource_metadata="<that URL>" (RFC 9728 §5.1).
 *
 * OpenVibe.Network (config.issuer) is the only authorization server: it signs every token Search verifies.
 */

const METADATA_PATH = '/.well-known/oauth-protected-resource';

// The Network's first-party scopes: the ones a person grants when a client asks for them at sign-in.
const SCOPES = Object.freeze(['openid', 'profile', 'email', 'theme']);

function base(config) {
    return String((config && config.baseUrl) || '').replace(/\/+$/, '');
}

/** Where the metadata document lives — the URL the WWW-Authenticate challenge names. */
function metadataUrl(config) {
    return `${base(config)}${METADATA_PATH}`;
}

/** The document RFC 9728 §3 asks for. */
function document(config) {
    const issuer = String((config && config.issuer) || 'https://openvibe.network').replace(/\/+$/, '');
    return {
        resource: base(config),
        authorization_servers: [issuer],
        scopes_supported: [...SCOPES],
        bearer_methods_supported: ['header'],
        resource_documentation: `${base(config)}/openapi.json`,
    };
}

/** The challenge header of a 401: the client is told where the metadata is. */
function challenge(res, config) {
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl(config)}"`);
}

module.exports = { METADATA_PATH, SCOPES, base, metadataUrl, document, challenge };

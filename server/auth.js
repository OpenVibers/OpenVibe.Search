'use strict';
/**
 * Authentication, capabilities and the query viewer.
 *
 *   - Service principals: RS256 client-credentials tokens from OpenVibe.Network (audience
 *     openvibe.search), verified offline with openvibe-contracts serviceAuth.verifyServiceToken.
 *   - Browsers: Network user JWTs (RS256, same key), cookie `ov_token` or Bearer, verified with the
 *     SDK's verifyUserToken.
 *
 * The verification keys come from the SDK's JWKS client (openvibe-sdk/auth): one refresher per URL
 * that keeps the last good keys through an outage, honours a rotation at once and backs off on
 * failure. This service no longer fetches or caches the JWKS itself.
 *
 * search.document.write and search.query.delegate are proposed in docs/capabilities-proposal/ and
 * are not in openvibe-contracts yet. checkCapability() decides them with the library's own grant
 * rule (exact id or a `family.*` grant) until a contracts release knows them; from then on the
 * library decides and nothing changes here.
 */
const { verifyUserToken } = require('openvibe-sdk/auth');
const { serviceAuth, capabilities, http, ids } = require('openvibe-contracts');

const CAPS = Object.freeze({
    write: 'search.document.write',
    delegate: 'search.query.delegate',
});
const PROPOSED = new Set(Object.values(CAPS));

const PRINCIPAL_SUB = /^(svc|app|mod):/;
const GROUP_RE = /^[a-z][a-z0-9_.:-]{0,127}$/;
const MAX_VIEWER_KEYS = 100;

// ── Capabilities ───────────────────────────────────────────

/** → { allowed, code, reason } like capabilities.check(). */
function checkCapability(claims, capabilityId) {
    if (!capabilities.get(capabilityId) && PROPOSED.has(capabilityId)) {
        return capabilities.grants(claims && claims.cap, capabilityId)
            ? { allowed: true, code: null, reason: null }
            : { allowed: false, code: 'capability.denied', reason: `${capabilityId} not granted` };
    }
    return capabilities.check(claims, capabilityId);
}

// ── Tokens ─────────────────────────────────────────────────

const b64json = (s) => JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));

function decodePayload(token) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3) return null;
    try { return b64json(parts[1]); } catch { return null; }
}

function bearer(req) {
    const h = String(req.headers.authorization || '');
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function cookie(req, name) {
    const raw = String(req.headers.cookie || '');
    for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) {
            try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
        }
    }
    return null;
}

/** Service slug for a principal sub: svc:wiki -> 'wiki'; app:/mod: principals have none. */
function serviceSlug(sub) {
    const m = /^svc:([a-z][a-z0-9-]{1,39})$/.exec(String(sub || ''));
    return m ? m[1] : null;
}

class AuthError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

/** Comma-separated group/entitlement keys from a header; a malformed key refuses the request. */
function keyList(value, header) {
    if (value == null || value === '') return [];
    const out = [...new Set(String(value).split(',').map(s => s.trim()).filter(Boolean))];
    if (out.length > MAX_VIEWER_KEYS) throw new AuthError(400, 'search.bad_viewer', `${header}: at most ${MAX_VIEWER_KEYS} keys`);
    for (const k of out) if (!GROUP_RE.test(k)) throw new AuthError(400, 'search.bad_viewer', `${header}: malformed key`);
    return out;
}

const ANONYMOUS = Object.freeze({ kind: 'anonymous', subject: null, groups: [], entitlements: [] });

function createAuth({ config, jwks, log = console }) {
    /**
     * A service principal token. openvibe-contracts keeps the token rules (RS256, issuer, the one
     * audience, expiry, identity.service-token-claims@1, sandbox refusal); the signing key comes from
     * the SDK's JWKS client, which refetches at once for an unknown `kid` (a rotation) and keeps the
     * last good keys while Network is down. Returns { ok, claims } or { ok, code, reason }.
     */
    async function verifyService(token) {
        const parts = String(token || '').split('.');
        let kid = null;
        try { kid = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')).kid || null; } catch { /* contracts refuses a malformed token */ }
        let keys;
        try {
            keys = await jwks.keysForKid(kid);
        } catch (err) {
            // The SDK's message names the internal JWKS URL and the fetch error: the client logs it, nobody is told.
            return { ok: false, code: 'token.unavailable', reason: 'signing key not loaded yet' };
        }
        // The key the token names, else every key (a kid-less token, or a document without kids); first verdict that
        // is not a bad signature wins.
        const byKid = kid ? keys.filter((k) => k.kid === kid) : [];
        let last = { ok: false, code: 'token.unavailable', reason: 'signing key not loaded yet' };
        for (const k of byKid.length ? byKid : keys) {
            last = serviceAuth.verifyServiceToken(token, { publicKey: k.key, issuer: config.issuer, audience: config.audience });
            if (last.ok || last.code !== 'token.bad_signature') return last;
        }
        return last;
    }

    /**
     * A Network user JWT (RS256). Resolves to the claims, or null when it does not verify. Rejects with
     * the SDK's 503-class error while no key has been fetched yet, so the caller can answer 503.
     */
    async function verifyUser(token) {
        try {
            return await verifyUserToken(token, { jwks: jwks.url, issuer: config.issuer, audience: config.userAudiences, log });
        } catch (err) {
            if (err && err.status === 503) throw err;
            return null;
        }
    }

    /**
     * Express guard for service routes: one capability. Sets req.principal = { sub, service, cap }.
     * Only service principals (svc:<slug>) pass: documents are always owned by a service.
     */
    function requireCap(id) {
        return async function capGuard(req, res, next) {
            const ctx = req.ov;
            const token = bearer(req);
            if (!token) return http.sendProblem(res, 401, 'token.missing', { detail: 'a service token is required', ctx });
            let r;
            try { r = await verifyService(token); } catch (err) { return next(err); }
            if (!r.ok) return http.sendProblem(res, r.code === 'token.unavailable' ? 503 : 401, r.code, { detail: r.reason, ctx });
            const c = checkCapability(r.claims, id);
            if (!c.allowed) return http.sendProblem(res, 403, c.code, { detail: c.reason, ctx });
            const service = serviceSlug(r.claims.sub);
            if (!service) return http.sendProblem(res, 403, 'capability.denied', { detail: 'only service principals may do this', ctx });
            req.principal = { sub: r.claims.sub, service, cap: r.claims.cap, jti: r.claims.jti };
            return next();
        };
    }

    function userViewer(claims) {
        const subject = typeof claims.subject_id === 'string' && ids.isSubjectId('user', claims.subject_id) ? claims.subject_id : null;
        // Without a canonical subject the user is treated like anyone else (public only).
        if (!subject) return ANONYMOUS;
        const groups = [];
        if (typeof claims.role === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(claims.role)) groups.push(`role:${claims.role}`);
        return { kind: 'user', subject, groups, entitlements: [] };
    }

    /**
     * Who is asking a query. Identity never comes from a body or query string.
     *   anonymous                          public only
     *   user (Network JWT, subject_id)     + ACL matches on its subject and role:<role>
     *   service with search.query.delegate + X-OV-Subject (usr_/gst_), X-OV-Groups, X-OV-Entitlements
     *                                        vouched for by the calling first-party service
     * A presented Bearer must verify (never downgraded to anonymous); an unverifiable cookie is
     * treated as signed out.
     */
    async function viewer(req) {
        const token = bearer(req);
        if (token) {
            const payload = decodePayload(token);
            if (payload && PRINCIPAL_SUB.test(String(payload.sub))) {
                const r = await verifyService(token);
                if (!r.ok) throw new AuthError(r.code === 'token.unavailable' ? 503 : 401, r.code, r.reason);
                const c = checkCapability(r.claims, CAPS.delegate);
                if (!c.allowed) throw new AuthError(403, c.code, c.reason);
                const subjectHeader = req.get('x-ov-subject');
                if (!subjectHeader) {
                    if (req.get('x-ov-groups') || req.get('x-ov-entitlements')) {
                        throw new AuthError(400, 'search.bad_viewer', 'X-OV-Groups and X-OV-Entitlements need an X-OV-Subject');
                    }
                    return { ...ANONYMOUS, kind: 'service', service: r.claims.sub };
                }
                if (!ids.isSubjectId('user', subjectHeader) && !ids.isSubjectId('guest', subjectHeader)) {
                    throw new AuthError(400, 'subject.invalid', 'X-OV-Subject must be a usr_… or gst_… subject id');
                }
                return {
                    kind: 'service',
                    service: r.claims.sub,
                    subject: subjectHeader,
                    groups: keyList(req.get('x-ov-groups'), 'X-OV-Groups'),
                    entitlements: keyList(req.get('x-ov-entitlements'), 'X-OV-Entitlements'),
                };
            }
            let user;
            try { user = await verifyUser(token); } catch { throw new AuthError(503, 'token.unavailable', 'signing key not loaded yet'); }
            if (!user) throw new AuthError(401, 'token.invalid', 'token does not verify');
            return userViewer(user);
        }
        const fromCookie = cookie(req, 'ov_token');
        const user = fromCookie ? await verifyUser(fromCookie).catch(() => null) : null;
        if (!user) return ANONYMOUS;
        const v = userViewer(user);
        // `via` lets state-changing routes demand a same-origin request for ambient credentials.
        return v.kind === 'user' ? { ...v, via: 'cookie' } : v;
    }

    return { verifyService, verifyUser, requireCap, viewer };
}

module.exports = { CAPS, PROPOSED, ANONYMOUS, AuthError, createAuth, checkCapability, serviceSlug, bearer, cookie };

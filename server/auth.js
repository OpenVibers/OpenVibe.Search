'use strict';
/**
 * Authentication, capabilities and the query viewer.
 *
 *   - Service principals: RS256 client-credentials tokens from OpenVibe.Network (audience
 *     openvibe.search), verified offline with openvibe-contracts serviceAuth.verifyServiceToken.
 *   - Browsers: Network user JWTs (RS256, same key), cookie `ov_token` or Bearer.
 *
 * search.document.write and search.query.delegate are proposed in docs/capabilities-proposal/ and
 * are not in openvibe-contracts yet. checkCapability() decides them with the library's own grant
 * rule (exact id or a `family.*` grant) until a contracts release knows them; from then on the
 * library decides and nothing changes here.
 */
const crypto = require('crypto');
const { serviceAuth, capabilities, http, ids } = require('openvibe-contracts');

const CAPS = Object.freeze({
    write: 'search.document.write',
    delegate: 'search.query.delegate',
});
const PROPOSED = new Set(Object.values(CAPS));

const PRINCIPAL_SUB = /^(svc|app|mod):/;
const GROUP_RE = /^[a-z][a-z0-9_.:-]{0,127}$/;
const MAX_VIEWER_KEYS = 100;

// ── Network public key ─────────────────────────────────────

/**
 * Loads the Network signing key from GET /api/.well-known/jwks ({ keys: [jwk] } or the older
 * { public_key: PEM }), retrying every 30 s until it loads and refreshing every 6 h after that.
 * A PEM given in config (OV_NETWORK_PUBLIC_KEY) is used as is and never fetched.
 */
function createKeyStore({ urls = [], pem = null, fetchImpl = globalThis.fetch, log = console } = {}) {
    let key = pem ? toPem(pem) : null;
    let retryTimer = null;
    let refreshTimer = null;

    function toPem(value) {
        return crypto.createPublicKey(value).export({ type: 'spki', format: 'pem' });
    }

    async function fetchOnce() {
        for (const base of urls) {
            if (!base) continue;
            const url = `${base}/api/.well-known/jwks`;
            try {
                const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const body = await res.json();
                const jwk = (body.keys || []).find(k => k.kty === 'RSA');
                if (jwk) key = toPem({ key: jwk, format: 'jwk' });
                else if (typeof body.public_key === 'string' && body.public_key.includes('BEGIN')) key = toPem(body.public_key);
                else throw new Error('no RSA key in response');
                log.log(`[auth] Network public key loaded from ${base}`);
                return key;
            } catch (err) {
                log.warn(`[auth] key fetch from ${url} failed: ${err.message}`);
            }
        }
        return null;
    }

    function start() {
        if (pem) return Promise.resolve(key);
        const attempt = async () => {
            const k = await fetchOnce();
            if (!k && !key) {
                retryTimer = setTimeout(attempt, 30 * 1000);
                retryTimer.unref?.();
            }
            return k;
        };
        refreshTimer = setInterval(() => { fetchOnce().catch(() => {}); }, 6 * 60 * 60 * 1000);
        refreshTimer.unref?.();
        return attempt();
    }

    function stop() {
        clearTimeout(retryTimer);
        clearInterval(refreshTimer);
    }

    return { get: () => key, loaded: () => Boolean(key), start, stop, fetchOnce };
}

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

/** Network user JWT (RS256). Returns claims or null. Service tokens are never accepted as users. */
function verifyUserJwt(token, { publicKey, issuer, audiences, now = Date.now() }) {
    if (!publicKey || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const header = b64json(parts[0]);
        if (header.alg !== 'RS256') return null;
        const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'));
        if (!ok) return null;
        const claims = b64json(parts[1]);
        const t = Math.floor(now / 1000);
        if (typeof claims.exp !== 'number' || claims.exp + 30 < t) return null;
        if (issuer && claims.iss !== issuer) return null;
        const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (!aud.some(a => audiences.includes(a))) return null;
        if (claims.actor_type || PRINCIPAL_SUB.test(String(claims.sub))) return null;
        return claims;
    } catch {
        return null;
    }
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

function createAuth({ config, keys }) {
    function verifyService(token) {
        const publicKey = keys.get();
        if (!publicKey) return { ok: false, code: 'token.unavailable', reason: 'signing key not loaded yet' };
        return serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.issuer, audience: config.audience });
    }

    function verifyUser(token) {
        return verifyUserJwt(token, { publicKey: keys.get(), issuer: config.issuer, audiences: config.userAudiences });
    }

    /**
     * Express guard for service routes: one capability. Sets req.principal = { sub, service, cap }.
     * Only service principals (svc:<slug>) pass: documents are always owned by a service.
     */
    function requireCap(id) {
        return function capGuard(req, res, next) {
            const ctx = req.ov;
            const token = bearer(req);
            if (!token) return http.sendProblem(res, 401, 'token.missing', { detail: 'a service token is required', ctx });
            const r = verifyService(token);
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
    function viewer(req) {
        const token = bearer(req);
        if (token) {
            const payload = decodePayload(token);
            if (payload && PRINCIPAL_SUB.test(String(payload.sub))) {
                const r = verifyService(token);
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
            if (!keys.get()) throw new AuthError(503, 'token.unavailable', 'signing key not loaded yet');
            const user = verifyUser(token);
            if (!user) throw new AuthError(401, 'token.invalid', 'token does not verify');
            return userViewer(user);
        }
        const fromCookie = cookie(req, 'ov_token');
        const user = fromCookie ? verifyUser(fromCookie) : null;
        return user ? userViewer(user) : ANONYMOUS;
    }

    return { verifyService, verifyUser, requireCap, viewer };
}

module.exports = { CAPS, PROPOSED, ANONYMOUS, AuthError, createKeyStore, createAuth, checkCapability, verifyUserJwt, serviceSlug, bearer, cookie };

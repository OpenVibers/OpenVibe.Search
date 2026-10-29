'use strict';
// The Markdown twins of OpenVibe.Search's public pages (openvibe-shared/agent-layer), rendered by the page
// router itself, anonymously and in-process, so a result twin is the same search an anonymous browser gets (only
// public, published documents). Results pages are noindex for crawlers but still have a twin, as agents need the
// answer; the front page and /updates are indexable and carry the discovery tags in their HTML.
const PUBLIC_PATH_RE = /^\/(?:$|updates$)/;

function anonymousRequest(path, search = '') {
    return {
        method: 'GET', url: path + search, originalUrl: path + search, path, params: {}, query: {},
        headers: { accept: 'text/html', host: 'search.openvibe.network' }, cookies: {},
        protocol: 'https', secure: true, ip: '127.0.0.1', ips: [], subdomains: [], hostname: 'search.openvibe.network',
        get(name) { return this.headers[String(name || '').toLowerCase()] || ''; },
        accepts(types) {
            if (!Array.isArray(types)) return 'text/html';
            return types.some((t) => t === 'html' || t === 'text/html') ? 'html' : false;
        },
        is() { return false; },
    };
}

function captureResponse() {
    return {
        statusCode: 200, headers: {}, body: null, headersSent: false,
        status(code) { this.statusCode = code; return this; },
        set(name, value) { this.headers[String(name)] = value; return this; },
        setHeader(name, value) { this.headers[String(name)] = value; return this; },
        getHeader(name) { return this.headers[String(name)]; },
        removeHeader(name) { delete this.headers[String(name)]; },
        type(value) { this.headers['Content-Type'] = value === 'html' ? 'text/html; charset=utf-8' : String(value); return this; },
        location(url) { this.headers.Location = url; return this; },
        send(body) { this.body = body; this.headersSent = true; return this; },
        json(body) { this.body = JSON.stringify(body); this.headersSent = true; return this; },
        redirect(code, url) { this.statusCode = code; this.headers.Location = url; this.body = ''; this.headersSent = true; return this; },
        end(body) { if (body !== undefined) this.body = body; this.headersSent = true; return this; },
        cookie() { return this; }, clearCookie() { return this; },
    };
}

function createAgentPages({ router }) {
    async function renderPublicPage(path, { query } = {}) {
        const p = String(path || '/').replace(/\/+$/, '') || '/';
        if (!PUBLIC_PATH_RE.test(p)) return null;
        const search = query && query.toString() ? `?${query.toString()}` : '';
        const req = anonymousRequest(p, search);
        const res = captureResponse();
        await new Promise((resolve) => {
            let settled = false;
            const finish = () => { if (!settled) { settled = true; resolve(); } };
            const send = res.send.bind(res);
            res.send = (body) => { send(body); finish(); return res; };
            const redirect = res.redirect.bind(res);
            res.redirect = (code, url) => { redirect(code, url); finish(); return res; };
            try { router(req, res, () => finish()); } catch { finish(); }
            const timer = setTimeout(finish, 10000);
            if (timer.unref) timer.unref();
        });
        if (res.statusCode !== 200 || res.body == null) return null;
        const html = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body);
        if (!/^text\/html/i.test(String(res.headers['Content-Type'] || ''))) return null;
        return { html };
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages, PUBLIC_PATH_RE };

'use strict';
/**
 * The public search page at search.openvibe.network: server-rendered, works without JavaScript,
 * same searcher and visibility rules as GET /api/v1/search (anonymous = public, published,
 * indexable documents only; an ov_token cookie for this host adds its person's ACL matches).
 *
 *   GET /             search form; ?q= results, ?owner= / ?type= filters, ?cursor= next page
 *   GET /robots.txt   the front page may be crawled, result pages and the API not
 *
 * Every answer is no-store (a document that leaves the index leaves this page at once) and result
 * pages are noindex. Clients that do not ask for HTML get the plain-text route index at /.
 */
const express = require('express');
const { AuthError, ANONYMOUS } = require('../auth');
const { QueryError, one } = require('../api/query');

// The OpenVibe Frame (navbar, footer, "shipped" views, themes) comes from openvibe.network; its init is
// /frame-init.js (same origin, no inline script), reading the JSON config in #ov-frame-config.
const NETWORK = 'https://openvibe.network';
const CSP = `default-src 'none'; script-src 'self' ${NETWORK}; connect-src 'self' ${NETWORK}; style-src 'unsafe-inline' ${NETWORK}; img-src 'self' data: https:; frame-src ${NETWORK}; form-action 'self' ${NETWORK}; base-uri 'none'; frame-ancestors 'none'`;
const frame = require('openvibe-shared/frame');
const FRAME_INIT = `(function () {
  var tries = 0;
  function boot() {
    if (!window.OpenVibeNavbar || !window.OpenVibeFooter) { if (++tries < 60) setTimeout(boot, 100); return; }
    var el = document.getElementById('ov-frame-config'); var cfg = {};
    try { cfg = JSON.parse(el ? el.textContent : '{}'); } catch (e) { /* */ }
    try { if (cfg.navbar) OpenVibeNavbar.init(cfg.navbar); } catch (e) { /* the Frame is optional */ }
    try { if (cfg.footer) OpenVibeFooter.init(cfg.footer); } catch (e) { /* */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
`;
const FRAME_CONFIG = {
    navbar: { service: 'search', apiBase: NETWORK, links: [{ label: 'Search', href: '/' }, { label: 'Updates', href: '/updates' }] },
    footer: { service: 'search', variant: 'compact', mount: '#ov-footer', brandName: 'OpenVibe.Search', updates: '/updates' },
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Only http(s) links are rendered as links; anything else is shown as text. */
function safeHref(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
    } catch { return null; }
}

function dateOf(iso) {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
}

const TEXT_INDEX = [
    'OpenVibe.Search: permission-aware search over documents the network\'s services index.',
    '',
    'GET    /?q=                                                   search page (HTML)',
    'GET    /api/v1/search?q=&owner=&type=&facet.<key>=&cursor=   query (anonymous: public only)',
    'GET    /api/v1/suggest?q=                                     title suggestions',
    'GET    /api/v1/documents/:owner/:type/:id                     one document the caller may see',
    'GET    /api/v1/saved-searches, POST, GET/DELETE /:id, GET /:id/results   saved searches (signed in)',
    'PUT    /api/v1/documents/:owner/:type/:id                     index (owner, search.document.write)',
    'DELETE /api/v1/documents/:owner/:type/:id?revision=           tombstone (owner)',
    'GET    /api/v1/owners/:owner/documents                        reconciliation (owner)',
    'GET    /api/v1/owners/:owner/removals?after=                  removal feed for caches and sitemaps (owner)',
    'POST   /internal/events                                       OpenVibe.Events delivery (signed, host-local)',
    'GET    /api/health, /api/ready, /release.json',
    '',
    'Source: https://github.com/OpenVibers/OpenVibe.Search',
    '',
].join('\n');

function layout({ title, q, owner, type, body, noindex }) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${noindex ? '<meta name="robots" content="noindex, nofollow">\n' : ''}<meta name="description" content="Search what the OpenVibe network's services have published.">
<meta name="color-scheme" content="light dark">
<script src="${NETWORK}/shared/theme-loader.js" defer></script>
<script src="${NETWORK}/shared/navbar.js" defer></script>
<script src="${NETWORK}/shared/footer.js" defer></script>
<script src="/frame-init.js" defer></script>
<style>
:root { --bg: #fff; --fg: #1a1a1a; --muted: #5c5c66; --line: #dcdce3; --accent: #2456d6; --mark: #fff2a8; }
@media (prefers-color-scheme: dark) { :root { --bg: #111317; --fg: #e8e8ec; --muted: #a0a0ab; --line: #2c2f36; --accent: #7aa2ff; --mark: #5a4b00; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.4rem; margin: 0 0 4px; }
.lede { color: var(--muted); margin: 0 0 20px; }
form { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
input[type=search] { flex: 1 1 260px; min-width: 0; padding: 10px 12px; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 8px; }
button { padding: 10px 16px; font: inherit; border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer; }
ol { list-style: none; padding: 0; margin: 0; }
li { padding: 14px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
li a.t { color: var(--accent); font-size: 1.05rem; text-decoration: none; }
li a.t:hover { text-decoration: underline; }
.meta { color: var(--muted); font-size: .85rem; }
.snip { margin: 4px 0 0; }
mark { background: var(--mark); color: inherit; }
.empty, .note { color: var(--muted); }
.more { display: inline-block; margin-top: 16px; color: var(--accent); }
.page-note { margin-top: 40px; color: var(--muted); font-size: .85rem; }
.page-note a { color: inherit; }
</style>
</head>
<body>
<div id="navbar-mount"></div>
${frame.noscriptNav({ name: 'OpenVibe.Search', links: [{ label: 'Search', href: '/' }, { label: 'Updates', href: '/updates' }] })}
<main>
<h1><a href="/" style="color:inherit;text-decoration:none">OpenVibe.Search</a></h1>
<p class="lede">Search what the OpenVibe network's services have published. Alpha: the index holds only what they have sent so far.</p>
<form method="get" action="/" role="search">
<input type="search" name="q" value="${esc(q)}" maxlength="500" placeholder="Search the network" aria-label="Search terms" autofocus>
${owner ? `<input type="hidden" name="owner" value="${esc(owner)}">` : ''}${type ? `<input type="hidden" name="type" value="${esc(type)}">` : ''}<button type="submit">Search</button>
</form>
${body}
<section class="page-note">
<p>Private, draft and deleted documents are never shown. A document that is removed or made private leaves these results at once.
JSON API: <a href="/api/v1/search?q=${encodeURIComponent(q || '')}">/api/v1/search</a>.
Source: <a href="https://github.com/OpenVibers/OpenVibe.Search">OpenVibers/OpenVibe.Search</a>.</p>
</section>
</main>
${frame.footer({ service: 'search', variant: 'compact', updates: '/updates' })}
<script type="application/json" id="ov-frame-config">${JSON.stringify(FRAME_CONFIG).replace(/</g, '\\u003c')}</script>
</body>
</html>
`;
}

function resultsHtml(results) {
    return `<ol>${results.map((r) => {
        const href = safeHref(r.canonical_url);
        const title = esc(r.title || `${r.owner}/${r.type}/${r.id}`);
        const date = dateOf(r.published_at || r.updated_at);
        return `<li>${href ? `<a class="t" href="${esc(href)}">${title}</a>` : `<span class="t">${title}</span>`}
<div class="meta">${esc(r.owner)} · ${esc(r.type)}${date ? ` · ${date}` : ''}${r.visibility !== 'public' ? ` · ${esc(r.visibility)}` : ''}</div>
${r.snippet_html ? `<p class="snip">${r.snippet_html}</p>` : r.summary ? `<p class="snip">${esc(r.summary)}</p>` : ''}</li>`;
    }).join('\n')}</ol>`;
}

function pageRouter({ searcher, auth }) {
    const router = express.Router();

    router.get('/frame-init.js', (_req, res) => {
        res.type('application/javascript').set('Cache-Control', 'public, max-age=3600').send(FRAME_INIT);
    });

    // What shipped on OpenVibe.Search: the shared update log every OpenVibe site has.
    router.get('/updates', (_req, res) => {
        res.setHeader('Content-Security-Policy', CSP);
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.type('html').send(layout({ title: 'What shipped on OpenVibe.Search', q: '', owner: '', type: '', body: frame.updatesBody({ service: 'search', siteName: 'OpenVibe.Search' }) + frame.shippedScript() }));
    });

    router.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', 'public, max-age=3600')
            .send('User-agent: *\nAllow: /$\nAllow: /updates\nDisallow: /?\nDisallow: /api/\nDisallow: /internal/\n');
    });

    router.get('/', (req, res, next) => {
        const wantsHtml = /\btext\/html\b/.test(String(req.get('accept') || ''));
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Vary', 'Accept, Cookie');
        if (!wantsHtml) return res.type('text/plain').send(TEXT_INDEX);

        const q = String(one(req.query.q) || '').slice(0, 500);
        const owner = one(req.query.owner) ? String(one(req.query.owner)) : '';
        const type = one(req.query.type) ? String(one(req.query.type)) : '';
        const cursor = one(req.query.cursor);
        const searching = Boolean(q.trim() || owner || type);
        res.setHeader('Content-Security-Policy', CSP);
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        if (searching) res.setHeader('X-Robots-Tag', 'noindex, nofollow');

        let viewer;
        try {
            viewer = auth.viewer(req);
        } catch (err) {
            if (!(err instanceof AuthError)) return next(err);
            viewer = null; // a browser page never 401s: an unverifiable credential searches as anonymous
        }
        let body = '<p class="note">Type some words to search. Filters: <code>?owner=wiki</code>, <code>?type=page</code>.</p>' + frame.shipped({ service: 'search', title: 'Recently shipped on OpenVibe.Search' });
        let status = 200;
        if (searching) {
            try {
                const out = searcher.run({ text: q, query: { ...(owner ? { owner } : {}), ...(type ? { type } : {}) }, viewer: viewer || ANONYMOUS, cursor });
                body = out.results.length
                    ? resultsHtml(out.results)
                    : `<p class="empty">${cursor ? 'No more results.' : 'Nothing found. The index is young: services add documents as they publish them.'}</p>`;
                if (out.next_cursor) {
                    const u = new URLSearchParams();
                    if (q) u.set('q', q);
                    if (owner) u.set('owner', owner);
                    if (type) u.set('type', type);
                    u.set('cursor', out.next_cursor);
                    body += `<a class="more" href="/?${esc(u.toString())}">More results</a>`;
                }
            } catch (err) {
                if (!(err instanceof QueryError)) return next(err);
                status = 400;
                body = `<p class="empty">${esc(err.message)}.</p>`;
            }
        }
        res.status(status).type('html').send(layout({ title: q ? `${q} · OpenVibe.Search` : 'OpenVibe.Search', q, owner, type, body, noindex: searching }));
    });

    return router;
}

module.exports = { pageRouter, TEXT_INDEX };

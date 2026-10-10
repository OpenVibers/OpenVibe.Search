'use strict';
/**
 * The public search page at search.openvibe.network: server-rendered, works without JavaScript,
 * same searcher and visibility rules as GET /api/v1/search (anonymous = public, published,
 * indexable documents only; an ov_token cookie for this host adds its person's ACL matches).
 *
 *   GET /             search form; ?q= results, ?owner= / ?type= filters, ?cursor= next page
 *   GET /robots.txt   the front page and /updates may be crawled, result pages and the API not
 *   GET /llms.txt     what this site is, its public pages and its public endpoints (openvibe-shared/seo)
 *   GET /llms-full.txt the public routes and public JSON endpoints, one line of text each
 *   GET /sitemap.xml  the public pages, with lastmod from the newest public document (never the clock)
 *
 * Search answers are no-store (a document that leaves the index leaves this page at once) and result
 * pages are noindex. Clients that do not ask for HTML get the plain-text route index at /.
 */
const express = require('express');
const ovServe = require('openvibe-shared/serve');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { AuthError, ANONYMOUS } = require('../auth');
const { QueryError, one } = require('../api/query');

const SITE_NAME = 'OpenVibe.Search';
const SITE_DESCRIPTION = "Search what the OpenVibe network's services have published.";

// The deployed release (app.js sets it from openvibe-shared/release): openvibe-shared/boost swaps a page in
// place only between pages of the same release, and does a normal load across a deploy.
let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

// The OpenVibe Frame (navbar, footer, "shipped" views, themes) comes from openvibe.network; openvibe-shared/shell
// renders the document and boots the navbar from one inline script, and FOOTER_INIT upgrades the footer.
const NETWORK = 'https://openvibe.network';
// Cloudflare Web Analytics: Cloudflare injects its beacon at the edge and the privacy text says it may measure
// performance; script-src loads the beacon, connect-src is where it reports.
const CF_BEACON = 'https://static.cloudflareinsights.com', CF_REPORT = 'https://cloudflareinsights.com';
// The Events realtime stream: release notifications (release-watch's EventSource, openvibe-shared 1.17).
const EVENTS = 'https://openvibe.events';
const shell = require('openvibe-shared/shell');
const showcase = require('openvibe-shared/showcase');
const { DEFAULT_EVENT_OWNERS } = require('../config');
const frame = require('openvibe-shared/frame');
const LINKS = [{ label: 'Search', href: '/' }, { label: 'Updates', href: '/updates' }];
// The shell options every page shares: the navbar it boots and the noscript nav and footer it renders.
const FRAME = {
    name: SITE_NAME, lang: 'en', navLinks: LINKS,
    navbar: { service: 'search', apiBase: NETWORK, links: LINKS },
    footer: { service: 'search', variant: 'compact', updates: '/updates' },
};
const FOOTER = { service: 'search', variant: 'compact', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' };
const FOOTER_INIT = `window.addEventListener('DOMContentLoaded', function () { try { OpenVibeFooter.init(${JSON.stringify(FOOTER).replace(/</g, '\\u003c')}); } catch (e) { /* the Frame is optional */ } });`;
// The two inline scripts are constant (the shell's boot depends only on FRAME), so script-src allows exactly
// them by hash and still has no 'unsafe-inline'.
const sha256 = (js) => `'sha256-${require('crypto').createHash('sha256').update(js, 'utf8').digest('base64')}'`;
const INLINE = [...shell.scripts(FRAME).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).concat(FOOTER_INIT);
const CSP = `default-src 'none'; script-src 'self' ${NETWORK} ${CF_BEACON} ${INLINE.map(sha256).join(' ')}; connect-src 'self' ${NETWORK} ${CF_REPORT} ${EVENTS}; style-src 'self' 'unsafe-inline' ${NETWORK}; img-src 'self' data: https:; frame-src ${NETWORK}; form-action 'self' ${NETWORK}; base-uri 'none'; frame-ancestors 'none'`;
const ICON_LINKS = require('openvibe-shared/app-icon').headTags({ site: 'network', iconBase: `${NETWORK}/assets` }).split('\n').filter((l) => l.startsWith('<link') && !/rel="manifest"/.test(l)).join('\n');

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

/**
 * The home page's JSON-LD: the WebSite (with the sitelinks SearchAction that is this site's whole
 * purpose) and OpenVibe.Search as the web application it is. Nothing private: both nodes describe
 * the public front page only.
 */
function homeJsonLd(origin) {
    return [
        seo.jsonLd.website({ name: SITE_NAME, url: `${origin}/`, description: SITE_DESCRIPTION, searchUrl: `${origin}/?q={q}` }),
        seo.jsonLd.softwareApp({ name: SITE_NAME, url: `${origin}/`, description: SITE_DESCRIPTION, category: 'SearchApplication' }),
    ];
}

/** robots.txt: the same Disallows this site already had, plus the sitemap and the AI/search bots by name. */
function robotsTxt(origin) {
    return [
        '# openvibe.search automated-consumer policy: search engines and AI crawlers may read the front',
        '# page and the update log. Result pages carry their own X-Robots-Tag: noindex, and the API, the',
        '# Events webhook and owner writes are not for crawling.',
        seo.robotsTxt({ sitemaps: [`${origin}/sitemap.xml`], allow: ['/$', '/updates'], disallow: ['/?', '/api/', '/internal/'] }),
    ].join('\n');
}

/** /llms.txt: what this site is, its public pages and its public machine-readable endpoints. */
function llmsTxt(origin) {
    return seo.llmsTxt({
        name: SITE_NAME,
        summary: `The search service of the OpenVibe network: one permission-aware index over what the network's services have published. ${SITE_DESCRIPTION}`,
        details: 'The index holds only what the services have sent so far (Alpha: it is young). Anonymous callers see public, published, indexable documents only; a browser with an ov_token cookie also gets that person\'s own restricted matches. Private, draft and deleted documents are never listed or returned, and a document that is removed or made private leaves the results at once. Result pages are noindex; this file lists pages and public endpoints only, never a person\'s saved searches or the owner API.',
        sections: [
            { title: 'Pages', links: [
                { title: 'Search', url: `${origin}/`, note: 'the search page; ?q= and ?owner=/?type= search, results are noindex' },
                { title: 'What shipped', url: `${origin}/updates`, note: "the site's update log" },
            ] },
            { title: 'Machine-readable', links: [
                { title: 'Search API', url: `${origin}/api/v1/search?q=`, note: 'JSON results; anonymous = public documents only' },
                { title: 'Suggest API', url: `${origin}/api/v1/suggest?q=`, note: 'title suggestions (JSON)' },
                { title: 'Sitemap', url: `${origin}/sitemap.xml` },
                { title: 'robots.txt', url: `${origin}/robots.txt` },
                { title: 'Release', url: `${origin}/release.json`, note: 'the deployed release manifest (JSON)' },
            ] },
            { title: 'The network', links: [
                { title: 'OpenVibe.Network', url: 'https://openvibe.network/', note: 'accounts and the network directory' },
                { title: 'Source', url: 'https://github.com/OpenVibers/OpenVibe.Search' },
            ] },
        ],
    });
}

/**
 * /llms-full.txt: the public route index and the public JSON endpoints, one line of text each, so an
 * agent sees what this origin serves without fetching anything. It carries routes only — never a
 * search result, a document or a person's data — and maxBytes caps it like the shared module's other
 * full-text files (the list is fixed, so it sits far under the cap).
 */
function llmsFullTxt(origin) {
    return seo.llmsFull({
        site: SITE_NAME,
        summary: `The public routes and public JSON endpoints of ${SITE_NAME}, one line each. ${SITE_DESCRIPTION}`,
        base: origin,
        maxBytes: 512 * 1024,
        sections: [
            { title: 'Public routes', pages: [
                { title: 'Search page', url: `${origin}/`, text: 'The HTML search page; ?q=, ?owner= and ?type= search. Result pages are noindex.' },
                { title: 'What shipped', url: `${origin}/updates`, text: "This site's update log." },
                { title: 'robots.txt', url: `${origin}/robots.txt`, text: 'Crawl rules: the front page and /updates may be crawled, result pages and the API may not.' },
                { title: 'Sitemap', url: `${origin}/sitemap.xml`, text: 'The public pages, with lastmod from the newest public document.' },
                { title: 'llms.txt', url: `${origin}/llms.txt`, text: "This site's map for language-model crawlers." },
                { title: 'llms-full.txt', url: `${origin}/llms-full.txt`, text: 'This file: the routes above and the JSON endpoints below, one line each.' },
            ] },
            { title: 'Public JSON endpoints', pages: [
                { title: 'Search API', url: `${origin}/api/v1/search?q=`, text: 'JSON results; anonymous callers see public, published, indexable documents only.' },
                { title: 'Suggest API', url: `${origin}/api/v1/suggest?q=`, text: 'JSON title suggestions for the given prefix.' },
                { title: 'Health', url: `${origin}/api/health`, text: 'Liveness: status, service and version (JSON).' },
                { title: 'Readiness', url: `${origin}/api/ready`, text: 'Readiness of the database and the optional dependencies (JSON).' },
                { title: 'Release', url: `${origin}/release.json`, text: 'The deployed release manifest (JSON).' },
            ] },
        ],
    });
}

/**
 * /sitemap.xml over the public pages. lastmod comes from the data, never from the clock: the front
 * page carries the newest content time among the public, indexable documents (so an empty index
 * leaves it off), and /updates carries the deployed release's date.
 */
function sitemapXml(origin, { indexLastmod = null, releasedAt = null } = {}) {
    const entries = [{ loc: `${origin}/`, ...(indexLastmod ? { lastmod: indexLastmod } : {}), changefreq: 'hourly', priority: 1.0 }];
    if (releasedAt) entries.push({ loc: `${origin}/updates`, lastmod: releasedAt, changefreq: 'weekly', priority: 0.5 });
    else entries.push({ loc: `${origin}/updates` });
    return seo.sitemapXml(entries);
}

// The front page's "browse by source" cards: each source the index accepts, with what it sends, linking to its filtered
// search (?owner=, which lists that source's public documents). Names and lines only; nothing here is counted or claimed.
const SOURCES = {
    wiki: ['OpenVibe.Wiki', 'Wiki pages with their sources and history.'],
    blog: ['OpenVibe.Blog', 'Posts from every blog on the network.'],
    news: ['OpenVibe.News', 'Source-backed stories.'],
    reviews: ['OpenVibe.Reviews', 'Reviews and the evidence behind them.'],
    deals: ['OpenVibe.Deals', 'Deals people found.'],
    coupons: ['OpenVibe.Coupons', 'Coupon codes with their restrictions and reports.'],
    trade: ['OpenVibe.Trade', 'Watchlists and sourced market context, with no orders or custody.'],
    community: ['OpenVibe.Community', 'Public pastes and posts.'],
    live: ['OpenVibe.Live', 'Channels, streams and clips.'],
    media: ['OpenVibe.Media', 'Public videos, clips and files.'],
    codes: ['OpenVibe.Codes', 'The developer docs and API reference.'],
    games: ['OpenVibe.Games', 'Browser games.'],
    tools: ['OpenVibe.Tools', 'Every online tool, by what it does.'],
    sources: ['OpenVibe.Sources', 'The registry of news and data sources.'],
    work: ['OpenVibe.Work', 'Job listings from open boards, each linked to the original.'],
    rent: ['OpenVibe.Rent', 'Places and things people offer for rent.'],
    help: ['OpenVibe.Help', 'Answers about every OpenVibe site.'],
    inventory: ['OpenVibe.Inventory', 'Items, badges and effects you can earn and wear.'],
    quest: ['OpenVibe.Quest', 'Quests across the network and the badges they give.'],
};
const ICON_OF = { sources: 'docs' };
// The front page's kit sections sit in this page's 760 px column, which already has its gutter.
const FRONT_CSS = `<style>
main .sc-hero, main .sc-sec { padding-left: 0; padding-right: 0; }
main .sc-hero { padding-top: 16px; }
main .sc-hero h1 { font-size: clamp(30px, 6vw, 44px); }
main .sc-hero + form { margin-top: 20px; }
main .sc-sec { margin-top: 40px; }
</style>`;
function frontShowcase(owners = DEFAULT_EVENT_OWNERS) {
    const items = owners.filter((o) => SOURCES[o]).map((o) => ({ icon: `ov:${ICON_OF[o] || o}`, title: SOURCES[o][0], text: SOURCES[o][1], href: `/?owner=${encodeURIComponent(o)}` }));
    return showcase.features({ id: 'sources', title: 'Browse by source', lede: 'Each service sends what it publishes as it publishes it; open one to see its public documents.', items });
}

function layout({ title, q, owner, type, body, noindex, canonical, jsonLd, front = false }) {
    const url = noindex ? undefined : canonical;
    return shell.page({
        ...FRAME,
        title, description: SITE_DESCRIPTION, canonical: url, jsonLd,
        robots: noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large, max-snippet:-1',
        // The AI summary (and its WebPage JSON-LD) only where the page may be indexed, like the rest of the JSON-LD.
        ...(noindex ? {} : { summary: SITE_DESCRIPTION, url }),
        head: [
            '<meta name="color-scheme" content="light dark">',
            ICON_LINKS,
            `<meta name="ov-boost" content="search@${esc(RELEASE)}">`,
            `<script src="${ovServe.url('boost.js')}" data-main="#main" defer></script>`,
            `<script>${FOOTER_INIT}</script>`,
            // The kit's sheet on the front page only (its hero and source cards); result pages stay as light as before.
            ...(front ? [`<link rel="stylesheet" href="${ovServe.url('showcase.css')}">`, FRONT_CSS] : []),
            `<style>
/* The network theme (the Frame's theme loader sets these tokens on <html>) wins; the values here are the
   defaults when it does not load. Search's own names follow them, so the page and the shared widgets
   (shipped.js, the navbar) always agree on background and text. */
:root { --bg-primary: #fff; --bg-secondary: #f3f4f7; --text-primary: #1a1a1a; --text-secondary: #5c5c66; --border: #dcdce3; --accent: #2456d6; --mark: #fff2a8; }
@media (prefers-color-scheme: dark) { :root { --bg-primary: #111317; --bg-secondary: #1a1d23; --text-primary: #e8e8ec; --text-secondary: #a0a0ab; --border: #2c2f36; --accent: #7aa2ff; --mark: #5a4b00; } }
:root { --bg: var(--bg-primary); --fg: var(--text-primary); --muted: var(--text-secondary); --line: var(--border); }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.4rem; margin: 0 0 4px; }
.lede { color: var(--muted); margin: 0 0 20px; }
form { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
input[type=search] { flex: 1 1 260px; min-width: 0; padding: 10px 12px; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 8px; }
button { padding: 10px 16px; font: inherit; border: 0; border-radius: 8px; background: var(--accent-strong, #1d4ed8); color: var(--on-accent-strong, #fff); cursor: pointer; }
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
</style>`,
        ].join('\n'),
        body: `<div id="navbar-mount"></div>
<main id="main">
${front ? showcase.hero({
        eyebrow: 'OpenVibe.Search',
        title: 'Search the', accent: 'OpenVibe network',
        lede: "Wiki pages, posts, stories, pastes, tools and more from the network's services, in one index. Alpha: it holds only what they have sent so far.",
    }) : `<h1><a href="/" style="color:inherit;text-decoration:none">OpenVibe.Search</a></h1>
<p class="lede">Search what the OpenVibe network's services have published. Alpha: the index holds only what they have sent so far.</p>`}
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
</main>`,
        bodyAttributes: { 'data-page': 'search' },
    });
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

/** baseUrl (config.baseUrl) names the canonical URL of the pages that may be indexed: the front page and /updates.
 *  newestPublic() reads the newest content time among the public indexable documents (the sitemap's real
 *  lastmod); releasedAt is the deployed release's date (/updates' lastmod). */
function pageRouter({ searcher, auth, baseUrl = 'https://search.openvibe.network', newestPublic = null, releasedAt = null, owners = DEFAULT_EVENT_OWNERS }) {
    const origin = String(baseUrl).replace(/\/+$/, '');
    const router = express.Router();

    // What shipped on OpenVibe.Search: the shared update log every OpenVibe site has.
    router.get('/updates', (_req, res) => {
        res.setHeader('Content-Security-Policy', CSP);
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Cache-Control', cache.htmlHeaders({ maxAge: 60 }));
        res.type('html').send(layout({ title: 'What shipped on OpenVibe.Search', q: '', owner: '', type: '', body: frame.updatesBody({ service: 'search', siteName: 'OpenVibe.Search' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`, canonical: `${origin}/updates` }));
    });

    // Crawl files (openvibe-shared/seo): the existing robots rules kept, plus /llms.txt and /sitemap.xml.
    router.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(robotsTxt(origin));
    });

    router.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(llmsTxt(origin));
    });

    router.get('/llms-full.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(llmsFullTxt(origin));
    });

    router.get('/sitemap.xml', async (_req, res, next) => {
        let indexLastmod = null;
        try {
            indexLastmod = newestPublic ? await newestPublic() : null;
        } catch (err) {
            return next(err); // a sitemap that cannot read the index is not a sitemap of this site
        }
        res.type('application/xml').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(sitemapXml(origin, { indexLastmod, releasedAt }));
    });

    router.get('/', async (req, res, next) => {
        const wantsHtml = /\btext\/html\b/.test(String(req.get('accept') || ''));
        res.setHeader('Cache-Control', cache.htmlHeaders({ private: true }));
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
            viewer = await auth.viewer(req);
        } catch (err) {
            if (!(err instanceof AuthError)) return next(err);
            viewer = null; // a browser page never 401s: an unverifiable credential searches as anonymous
        }
        // The plain front page opens with what Search is (openvibe-shared/showcase) and its sources to browse.
        let body = frontShowcase(owners) + '<p class="note">Filters: <code>?owner=wiki</code>, <code>?type=page</code>.</p>' + frame.shipped({ service: 'search', title: 'Recently shipped on OpenVibe.Search' });
        let status = 200;
        if (searching) {
            try {
                const out = await searcher.run({ text: q, query: { ...(owner ? { owner } : {}), ...(type ? { type } : {}) }, viewer: viewer || ANONYMOUS, cursor });
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
        // JSON-LD only where the page may be indexed: the plain front page, never a result page.
        const jsonLd = searching || status !== 200 ? null : homeJsonLd(origin);
        res.status(status).type('html').send(layout({ title: q ? `${q} · OpenVibe.Search` : 'OpenVibe.Search', q, owner, type, body, noindex: searching, canonical: `${origin}/`, jsonLd, front: !searching && status === 200 }));
    });

    return router;
}

module.exports = { pageRouter, setRelease, TEXT_INDEX, robotsTxt, llmsTxt, llmsFullTxt, sitemapXml, homeJsonLd };

'use strict';
/**
 * Ranking helpers shared by the full-text engine (server/engine/pg.js) and the query path
 * (server/api/query.js): which fields a query matches, whether a document belongs to a site the
 * query names, whether its title is a thin streamer name, and the identity that drops duplicate
 * results from a page.
 *
 * The engine's base score is ts_rank with title A (×10), summary B (×4) and body C (×1), times the
 * freshness boost. That ranks term frequency, but not the things a person means by a plain query:
 *
 *   tier = site (10) + field (title 3, summary 2, body 1, none 0)
 *
 * A query naming a site ("openvibe live", "openvibe tools") puts that site's own records first
 * (its home, its help articles, its tool pages), a title match always outranks a summary-only
 * match, and a summary-only match outranks a body-only one. The owner and type are deliberately
 * not text fields: a word that equals a document's owner is not a match (the explicit owner=
 * filter is how an owner narrows a query), and the summary's service boilerplate ("Recorded live
 * stream by … on OpenVibe.Live.") is only summary text, never a title.
 */

/** Sites whose old name still appears in canonical URLs and help paths. */
const SITE_ALIASES = {
    live: ['openvibe.live', 'openre.stream'],
    openre: ['openre.stream', 'openvibe.live'],
    stream: ['openre.stream', 'openvibe.live'],
    restream: ['openre.stream', 'openvibe.live'],
};

/** Diacritics folded, so the index and every query see the same text. */
function fold(s) {
    return String(s || '').normalize('NFKD').replace(/\p{M}+/gu, '').normalize('NFC');
}

/** Word tokens: runs of letters and digits, everything else a separator. */
function words(s) {
    return fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ');
}

function tokens(s) {
    return fold(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The site hosts a query names, if it has "openvibe" plus another word: "openvibe live" names
 * openvibe.live and its old name openre.stream; "openvibe tools" names openvibe.tools. The host of
 * an unknown word simply matches nothing. No site without "openvibe" (a plain "live" is text, not
 * the Live site).
 */
function siteHosts(match) {
    const ws = match && Array.isArray(match.words) ? match.words : [];
    if (!ws.includes('openvibe')) return [];
    const hosts = new Set();
    for (const word of ws) {
        if (word === 'openvibe' || word.length < 2) continue;
        for (const host of (SITE_ALIASES[word] || [`openvibe.${word}`])) hosts.add(host);
    }
    return [...hosts].slice(0, 12);
}

/**
 * The same test as siteHosts(), as a PostgreSQL regex (engine SQL). A document belongs to the
 * site when its host is (a subdomain of) a named host, or when it is a help article under
 * /a/<host>/ for one of them. Null when the query names no site.
 */
function siteUrlPattern(match) {
    const hosts = siteHosts(match);
    if (!hosts.length) return null;
    const alt = hosts.map(escapeRegex).join('|');
    return `^https?://([a-z0-9-]+\\.)*(${alt})(/|$)|^https?://([a-z0-9-]+\\.)*openvibe\\.help/a/(${alt})(/|$)`;
}

/**
 * Is this a two-word site query ("openvibe live", "openvibe tools")? Then the site's own records are
 * candidates even when the page text never says "openvibe" or the site name: the site membership is
 * the second word, like a filter. A title-only (suggest) query never widens this way.
 */
function siteOnlyQuery(match) {
    const ws = match && Array.isArray(match.words) ? match.words : [];
    return !match.column && ws.length === 2 && ws.includes('openvibe');
}

function parseUrl(url) {
    try {
        const u = new URL(String(url));
        return { host: u.hostname.toLowerCase(), path: u.pathname };
    } catch {
        return null;
    }
}

function hostMatches(host, site) {
    return host === site || host.endsWith(`.${site}`);
}

/** Does this canonical URL belong to one of the sites? Mirrors siteUrlPattern() in JS. */
function urlBelongsToSites(url, hosts) {
    if (!hosts || !hosts.length) return false;
    const parsed = parseUrl(url);
    if (!parsed) return false;
    if (hosts.some((host) => hostMatches(parsed.host, host))) return true;
    if (hostMatches(parsed.host, 'openvibe.help')) {
        const m = /^\/a\/([^/]+)\//.exec(parsed.path);
        if (m && hosts.some((host) => hostMatches(m[1].toLowerCase(), host))) return true;
    }
    return false;
}

function wordMatches(token, word, prefix) {
    return token === word || (prefix && token.startsWith(word));
}

/** Does any query word appear in this text? The last word is a prefix when the query says so. */
function textMatches(text, match) {
    if (!match || !Array.isArray(match.words) || !match.words.length) return false;
    const ts = tokens(text);
    return match.words.some((word, i) => ts.some((token) => wordMatches(token, word, Boolean(match.prefix && i === match.words.length - 1))));
}

/** 3 when the title matches, 2 the summary, 1 the body, 0 no text field (a vector-only hit). */
function fieldTier(doc, match) {
    if (!doc) return 0;
    if (textMatches(doc.title, match)) return 3;
    if (textMatches(doc.summary, match)) return 2;
    if (textMatches(doc.body, match)) return 1;
    return 0;
}

/** site (10) + the best matching field: a site's own records first, then title > summary > body. */
function docTier(doc, match, hosts = siteHosts(match)) {
    const site = hosts.length && urlBelongsToSites(doc && doc.canonical_url, hosts) ? 10 : 0;
    return site + fieldTier(doc, match);
}

/**
 * A thin document: a username or a very short title with no real summary ("aaooo.ee", "Omar",
 * "Seattle Maybe 🤔" — a recorded stream whose summary is the site's sentence). It ranks below a
 * document with a real title and summary inside the same tier; the field and site tiers are unchanged.
 */
function isThin(doc) {
    const title = String((doc && doc.title) || '').trim();
    const summary = String((doc && doc.summary) || '').trim();
    if (!title) return true;
    const shortTitle = title.length <= 24;
    const noRealSummary = summary.length === 0 || summary.length <= 80;
    return shortTitle && noRealSummary;
}

/** The one page identity: same title and owner is one result (keep the best-ranked one). */
function dedupeKey(doc) {
    const title = String((doc && doc.title) || '').trim().replace(/\s+/g, ' ').toLowerCase();
    return `${String((doc && doc.owner) || '').toLowerCase()}\u0000${title}`;
}

module.exports = {
    SITE_ALIASES, fold, words, tokens, siteHosts, siteOnlyQuery, siteUrlPattern, urlBelongsToSites,
    textMatches, fieldTier, docTier, isThin, dedupeKey,
};

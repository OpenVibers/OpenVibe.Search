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

// Inside a field tier, a title that holds more of the query's words comes first, up to TITLE_WORDS_MAX of them:
// "central street harbin" put "Harbin Confucius Temple" (one word) above "Central Street (中央大街)" (two), because
// both titles matched and relevance decided (production, 2026-11-02). Capped so it never outweighs the half tier a
// question's answer gets (the engine's 50 against 10 a word).
const TITLE_WORDS_MAX = 4;

/** How many of the query's words the title holds (the last a prefix when the query says so), at most TITLE_WORDS_MAX. */
function titleWords(doc, match) {
    if (!doc || !match || !Array.isArray(match.words) || !match.words.length) return 0;
    const ts = tokens(doc.title);
    const n = match.words.filter((word, i) => ts.some((t) => wordMatches(t, word, Boolean(match.prefix && i === match.words.length - 1)))).length;
    return Math.min(TITLE_WORDS_MAX, n);
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
 * A Live channel is never thin: its title is the handle and its summary the service sentence, and
 * Search orders channels by their activity signal instead (server/engine/pg.js).
 */
function isThin(doc) {
    if (doc && doc.type === 'channel') return false;
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

// A question ("how do I stream", "can I go live without OBS") wants an answer: an article (Help's answers, a site's
// docs) comes before a recording or a post that only shares a word, inside its tier (2026-11-02: "how do I stream"
// ranked hundreds of VODs titled "… Stream" above Help's "Can I stream without OBS?", which never reached the top 100).
const QUESTION_WORDS = new Set(['how', 'what', 'why', 'when', 'where', 'which', 'who', 'can', 'do', 'does', 'is', 'are', 'should', 'will']);
function isQuestion(match) {
    if (match && match.question) return true;
    return Boolean(match && !match.column && Array.isArray(match.words) && match.words.length >= 2 && QUESTION_WORDS.has(match.words[0]));
}

// The words a question is made of that say nothing about what it asks. The index uses the 'simple' configuration
// (no stop words), so "how do I stream" had to find how, do, i and stream all together: long VOD transcripts did,
// Help's "Can I stream without OBS?" did not (production, 2026-11-02).
const FUNCTION_WORDS = new Set([...QUESTION_WORDS, 'could', 'would', 'did', 'was', 'were', 'be', 'i', 'me', 'my', 'we', 'our', 'you',
    'your', 'it', 'its', 'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'with', 'from', 'and', 'or', 'there', 'this', 'that', 'get', 'make']);

/** A question's match on its content words ("how do I stream" → stream), marked as a question; else the match as it is. */
function questionMatch(match) {
    if (!isQuestion(match)) return match;
    const content = match.words.filter((w) => !FUNCTION_WORDS.has(w));
    return content.length ? { ...match, words: content, prefix: match.prefix && content[content.length - 1] === match.words[match.words.length - 1], question: true } : match;
}

/**
 * The words a relaxed (any-word) query keeps: its content words when it has any. "things to do chongqing" found the
 * city page with every word, and fewer than five documents did, so the relaxed answer took any word: "do" alone put
 * seven "Do I need…?" help articles above Chongqing (production, 2026-11-02).
 */
function contentWords(match) {
    if (!match || !Array.isArray(match.words)) return match;
    const content = match.words.filter((w) => !FUNCTION_WORDS.has(w));
    if (!content.length || content.length === match.words.length) return match;
    return { ...match, words: content, prefix: Boolean(match.prefix && content[content.length - 1] === match.words[match.words.length - 1]) };
}

// Where a relaxed query's word is found counts too: in the title fully, in the summary 0.6, only in the body 0.3.
const FIELD_FACTORS = [['title', 1], ['summary', 0.6], ['body', 0.3]];

/**
 * How much of a relaxed query a document holds: for each query word, its weight (match.weights, the engine's
 * wordWeights: a rare word weighs more than a common one) times the factor of the best field holding it, summed and
 * kept to one decimal so near-equal covers tie and the field tiers decide. 0 for a query that is not relaxed or has
 * no weights. The engine ranks with the same sum (server/engine/pg.js).
 */
function coverage(doc, match) {
    if (!doc || !match || !match.any || !match.weights) return 0;
    const fields = FIELD_FACTORS.map(([name, factor]) => [new Set(tokens(doc[name])), factor]);
    let sum = 0;
    match.words.forEach((word, i) => {
        const prefix = Boolean(match.prefix && i === match.words.length - 1);
        const hit = fields.find(([ts]) => ts.has(word) || (prefix && [...ts].some((t) => t.startsWith(word))));
        if (hit) sum += (Number(match.weights[word]) || 0) * hit[1];
    });
    return Math.round(sum * 10) / 10;
}

module.exports = {
    isQuestion, questionMatch, contentWords, coverage, FIELD_FACTORS, titleWords, TITLE_WORDS_MAX,
    SITE_ALIASES, fold, words, tokens, siteHosts, siteOnlyQuery, siteUrlPattern, urlBelongsToSites,
    textMatches, fieldTier, docTier, isThin, dedupeKey,
};

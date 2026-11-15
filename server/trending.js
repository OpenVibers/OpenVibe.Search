'use strict';
/**
 * Trending searches (plan 2026-11-13 §AD.13 (1); migration 0010): what people type into the network's search boxes.
 *
 *   POST /api/v1/searched     { q, site? } (JSON, or text/plain JSON from navigator.sendBeacon): one search, counted.
 *                             The site is the request's Origin when it is one of the network's own domains (the services
 *                             manifests), else the body's site when that is one, else nothing is counted. 204 always
 *                             (a beacon has nobody to read an error); Do Not Track and Global Privacy Control count
 *                             nothing; a visitor counts at most 20 searches a minute.
 *   GET  /api/v1/trending     ?site=&limit= (1..20): the rising searches, the site's first and the network's after them.
 *                             Public and cached (five minutes here, a minute in browsers).
 *   GET  /api/v1/trending/stats ?days= (1..7): searches by day and by site, and the top searches, for OpenVibe.Report.
 *
 * Until enough people search, a site's box still has something to offer: the list is filled with the titles of the
 * site's own public pages (the newest 200, shuffled by the hour), marked `suggested: true`, under the same rules as
 * searches (nothing personal or explicit). The box says "Try …" either way; Report's stats count searches only.
 *
 * What may trend: a query shows only once 5 or more distinct visitors searched it in the last two days, and never one
 * that looks personal (an email, a phone number, a long number, a web address, a token) or explicit. Counting only boxes
 * people type in, never the API or agents. A visitor is sha256(daily salt + address + user agent): the salt changes
 * every UTC day and is deleted after two, so no visitor can be followed from one day to the next.
 */
const crypto = require('crypto');

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MIN_VISITORS = 5;
const PER_MINUTE = 20;
const CACHE_MS = 5 * 60_000;
// Words that never trend in a box everyone sees (the AI text rule allows art; a trending line is not the place).
const EXPLICIT = /\b(porn\w*|xxx|nsfw|nude\w*|naked|sex\w*|hentai|onlyfans|fuck\w*|cum\w*|dick|cock|pussy|tits?|titties|boobs?|anal|rape|incest|loli|shota|cp)\b/i;
const PERSONAL = [
    /\S+@\S+\.\S+/,                          // an email
    /(?:\+?\d[\s().-]*){7,}/,                // a phone number or any long run of digits
    /\d{6,}/,                                // a long number (an account, a card, an id)
    /\b(?:https?:\/\/|www\.)\S+/i,           // a web address
    /\b[A-Za-z0-9_-]{24,}\b/,                // a token or a key
];

/** The form a query is counted under: lower case, single spaces, no edge punctuation; null when it may not count. */
function normalize(q) {
    const shown = String(q == null ? '' : q).normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
        .replace(/^[\s"'`.,;:!?()[\]{}<>-]+|[\s"'`.,;:!?()[\]{}<>-]+$/g, '');
    if (shown.length < 2 || shown.length > 80 || shown.split(' ').length > 8) return null;
    if (PERSONAL.some((re) => re.test(shown)) || EXPLICIT.test(shown)) return null;
    return { query: shown.toLowerCase(), shown };
}

/** The network's own sites (every service's domains, and their www.), from the contracts' services manifests. */
function siteSet(contracts) {
    const out = new Set();
    try {
        const m = contracts.services.manifests;
        for (const s of Array.isArray(m) ? m : Object.values(m || {})) for (const d of s.domains || []) { out.add(String(d).toLowerCase()); out.add(`www.${String(d).toLowerCase()}`); }
    } catch { /* an empty set counts nothing */ }
    return out;
}

function createTrending({ db, now = () => Date.now(), sites = new Set(), log = console }) {
    const st = {
        salt: db.prepare('SELECT salt FROM search_trend_salts WHERE day = ?'),
        putSalt: db.prepare('INSERT INTO search_trend_salts (day, salt) VALUES (?, ?) ON CONFLICT (day) DO NOTHING'),
        count: db.prepare(`INSERT INTO search_trends (hour, site, query, shown, count) VALUES (?, ?, ?, ?, 1)
            ON CONFLICT (hour, site, query) DO UPDATE SET count = search_trends.count + 1`),
        seen: db.prepare('INSERT INTO search_trend_visitors (day, query, visitor) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'),
        rising: db.prepare(`SELECT t.query, max(t.shown) AS shown,
                sum(CASE WHEN t.hour >= ? THEN t.count ELSE 0 END) AS recent,
                sum(CASE WHEN t.hour < ? THEN t.count ELSE 0 END) AS before,
                (SELECT count(DISTINCT v.visitor) FROM search_trend_visitors v WHERE v.query = t.query AND v.day >= ?) AS people
            FROM search_trends t WHERE t.hour >= ? AND (? = '' OR t.site = ?)
            GROUP BY t.query`),
        byDay: db.prepare('SELECT floor(hour / 24) AS day, sum(count) AS n FROM search_trends WHERE hour >= ? GROUP BY 1 ORDER BY 1'),
        bySite: db.prepare('SELECT site, sum(count) AS n FROM search_trends WHERE hour >= ? GROUP BY site ORDER BY 2 DESC LIMIT 40'),
        pruneTrends: db.prepare('DELETE FROM search_trends WHERE hour < ?'),
        pruneVisitors: db.prepare('DELETE FROM search_trend_visitors WHERE day < ?'),
        pruneSalts: db.prepare('DELETE FROM search_trend_salts WHERE day < ?'),
        titlesFor: db.prepare(`SELECT title FROM documents WHERE deleted = 0 AND exposure = 3 AND title IS NOT NULL AND length(title) BETWEEN 3 AND 48
            AND canonical_url LIKE ? ORDER BY sort_at DESC LIMIT 200`),
        titlesAll: db.prepare(`SELECT title FROM documents WHERE deleted = 0 AND exposure = 3 AND title IS NOT NULL AND length(title) BETWEEN 3 AND 48
            ORDER BY sort_at DESC LIMIT 200`),
    };
    const salts = new Map();
    async function saltFor(day) {
        if (salts.has(day)) return salts.get(day);
        await st.putSalt.run(day, crypto.randomBytes(24).toString('base64url'));
        const row = await st.salt.get(day);
        salts.clear();
        salts.set(day, row.salt);
        return row.salt;
    }

    const windows = new Map();
    function allow(visitor) {
        const t = now();
        if (windows.size > 50_000) for (const [k, w] of windows) if (w.until <= t) windows.delete(k);
        const w = windows.get(visitor) || { until: t + 60_000, n: 0 };
        if (w.until <= t) { w.until = t + 60_000; w.n = 0; }
        if (w.n >= PER_MINUTE) return false;
        w.n++;
        windows.set(visitor, w);
        return true;
    }

    /** The site a request speaks for: its Origin's host when that is ours, else the given one when it is ours. */
    function siteOf(origin, given) {
        for (const v of [origin, given]) {
            if (!v) continue;
            let host = String(v).toLowerCase();
            try { if (host.includes('://')) host = new URL(host).hostname; } catch { continue; }
            if (sites.has(host)) return host.replace(/^www\./, '');
        }
        return null;
    }

    /** One search typed into a box: counted under its hour, site and query, with its visitor for the day. */
    async function record({ q, origin = null, site = null, address = '', agent = '', optOut = false }) {
        if (optOut) return { counted: false, reason: 'opted_out' };
        const n = normalize(q);
        if (!n) return { counted: false, reason: 'not_counted' };
        const where = siteOf(origin, site);
        if (!where) return { counted: false, reason: 'unknown_site' };
        const t = now();
        const day = Math.floor(t / DAY);
        const visitor = crypto.createHash('sha256').update(`${await saltFor(day)}|${address}|${agent}`).digest('hex').slice(0, 24);
        if (!allow(visitor)) return { counted: false, reason: 'busy' };
        await st.count.run(Math.floor(t / HOUR), where, n.query, n.shown);
        await st.seen.run(day, n.query, visitor);
        cache.clear();
        return { counted: true };
    }

    const cache = new Map();
    /** The rising searches: last 24 h against the 48 h before, once enough people searched them. */
    async function rising(site, limit) {
        const t = now();
        const h = Math.floor(t / HOUR);
        const rows = await st.rising.all(h - 24, h - 24, Math.floor(t / DAY) - 1, h - 72, site || '', site || '');
        return rows
            .map((r) => ({ query: r.shown, recent: Number(r.recent) || 0, before: (Number(r.before) || 0) / 2, people: Number(r.people) || 0 }))
            .filter((r) => r.recent > 0 && r.people >= MIN_VISITORS)
            .map((r) => ({ ...r, score: r.recent * Math.log2(2 + r.recent / (r.before + 1)) }))
            .sort((a, b) => b.score - a.score || b.recent - a.recent)
            .slice(0, limit)
            .map((r) => ({ query: r.query, searches: r.recent, rising: r.recent > r.before }));
    }
    /** A page title as a search: its first part (before " | ", " — ", " · ", " - "), without a parenthetical or bracketed
     *  tail ("Maticus (@Maticus)", "Fleece (Little Kid/Big Kid)"). */
    function cleanTitle(title) {
        let t = String(title || '').split(/\s+[|—·–]\s+|\s+-\s+/)[0];
        t = t.replace(/\s*[([][^)\]]*[)\]]?\s*$/, '');
        return t.trim();
    }

    /** The site's own public page titles (or the network's), shuffled by the hour: what a box offers before searches trend. */
    async function suggestions(site, n, taken) {
        const rows = site ? await st.titlesFor.all(`https://${site}/%`) : await st.titlesAll.all();
        const hour = Math.floor(now() / HOUR);
        const seen = new Set(taken);
        const out = [];
        for (const r of rows) {
            const norm = normalize(cleanTitle(r.title));
            if (!norm || seen.has(norm.query)) continue;
            seen.add(norm.query);
            out.push({ query: norm.shown, k: crypto.createHash('sha256').update(`${hour}|${norm.query}`).digest('hex') });
        }
        return out.sort((a, b) => (a.k < b.k ? -1 : 1)).slice(0, n).map((x) => ({ query: x.query, suggested: true }));
    }

    async function trending({ site = '', limit = 10 } = {}) {
        const n = Math.max(1, Math.min(20, Number(limit) || 10));
        const where = site ? siteOf(null, site) || '' : '';
        const key = `${where}|${n}`;
        const hit = cache.get(key);
        if (hit && now() - hit.at < CACHE_MS) return hit.body;
        const own = where ? await rising(where, n) : [];
        const all = own.length < n ? await rising('', n) : [];
        const seen = new Set(own.map((x) => x.query.toLowerCase()));
        let list = [...own, ...all.filter((x) => !seen.has(x.query.toLowerCase()))].slice(0, n);
        if (list.length < n) {
            try { list = list.concat(await suggestions(where, n - list.length, list.map((x) => x.query.toLowerCase()))); } catch { /* the people's list alone */ }
        }
        const body = { site: where || null, trending: list, updated_at: new Date(now()).toISOString() };
        cache.set(key, { at: now(), body });
        return body;
    }

    /** Searches by day and by site, and the network's top searches, for Report (no visitor, no person). */
    async function stats({ days = 7 } = {}) {
        const d = Math.max(1, Math.min(7, Number(days) || 7));
        const from = Math.floor(now() / HOUR) - d * 24;
        const [byDay, bySite, top] = await Promise.all([st.byDay.all(from), st.bySite.all(from), rising('', 20)]);
        return {
            days: d,
            by_day: byDay.map((r) => ({ day: new Date(Number(r.day) * DAY).toISOString().slice(0, 10), searches: Number(r.n) })),
            by_site: bySite.map((r) => ({ site: r.site, searches: Number(r.n) })),
            top,
            updated_at: new Date(now()).toISOString(),
        };
    }

    async function prune() {
        const t = now();
        await st.pruneTrends.run(Math.floor(t / HOUR) - 8 * 24);
        await st.pruneVisitors.run(Math.floor(t / DAY) - 2);
        await st.pruneSalts.run(Math.floor(t / DAY) - 1);
    }

    return { record, trending, stats, prune, normalize, siteOf };
}

/** The routes: the beacon, the trending list and the stats. */
function trendingRouter({ trending, express }) {
    const r = express.Router();
    const pub = (res, maxAge) => res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': `public, max-age=${maxAge}` });
    // A JSON beacon's preflight (sendBeacon's text/plain needs none): a middleware, not a documented route.
    r.use('/api/v1/searched', (req, res, next) => {
        if (req.method !== 'OPTIONS') return next();
        res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
        return res.status(204).end();
    });
    r.post('/api/v1/searched', express.text({ type: ['text/plain', 'application/json'], limit: '4kb' }), async (req, res) => {
        res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        let b = req.body;
        if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
        try {
            await trending.record({
                q: b && b.q, site: b && b.site, origin: req.get('origin') || null,
                address: req.ip || '', agent: String(req.get('user-agent') || '').slice(0, 200),
                optOut: req.get('dnt') === '1' || req.get('sec-gpc') === '1',
            });
        } catch { /* a beacon never fails loudly */ }
        res.status(204).end();
    });
    r.get('/api/v1/trending', async (req, res, next) => {
        try { pub(res, 60).json(await trending.trending({ site: String(req.query.site || ''), limit: req.query.limit })); } catch (err) { next(err); }
    });
    r.get('/api/v1/trending/stats', async (req, res, next) => {
        try { pub(res, 300).json(await trending.stats({ days: req.query.days })); } catch (err) { next(err); }
    });
    return r;
}

module.exports = { createTrending, trendingRouter, normalize, siteSet, MIN_VISITORS };

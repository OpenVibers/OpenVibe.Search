'use strict';
/**
 * Small helpers shared by the code sources: safe text, safe links, and the ±2 context window every
 * result carries. Nothing here fetches; a source module owns its own request shape and host.
 */

const MAX_LINE = 400;
const MAX_LINES = 120;

/** Text as data: no control characters (except tab), collapsed, bounded. Never HTML. */
function text(value, max = MAX_LINE) {
    return String(value == null ? '' : value)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/\t/g, '    ')
        .replace(/\r/g, '')
        .slice(0, max);
}

/** An https URL to the source's own host, or null. Never a javascript:/data:/http: link. */
function httpsUrl(value, host = null) {
    try {
        const u = new URL(String(value));
        if (u.protocol !== 'https:') return null;
        if (host && u.hostname.toLowerCase() !== String(host).toLowerCase()) return null;
        return u.toString();
    } catch { return null; }
}

/** A cross-source repository name: `github.com/Owner/Repo` becomes `Owner/Repo` for dedupe/display. */
function repoName(value) {
    const s = String(value || '');
    const m = /^(?:github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)\/(.+)$/i.exec(s);
    return m ? m[1] : s;
}

/** A path that is safe to put in a URL segment-wise (keeps '/', encodes the rest). */
function encodePath(path) {
    return String(path).split('/').map((s) => encodeURIComponent(s)).join('/');
}

/**
 * The matching lines with `radius` lines either side, merged, in file order:
 * [{ number: 12, text: '…', match: true }, …]. `lines` is the whole file split on '\n'.
 */
function context(lines, matchNumbers, radius = 2) {
    const wanted = new Set();
    for (const n of matchNumbers) {
        for (let i = n - radius; i <= n + radius; i += 1) {
            if (i >= 1 && i <= lines.length) wanted.add(i);
        }
    }
    const matches = new Set(matchNumbers);
    return [...wanted].sort((a, b) => a - b).slice(0, MAX_LINES).map((n) => ({
        number: n,
        text: text(lines[n - 1]),
        match: matches.has(n),
    }));
}

/** A run of context rows as one line range (the first and last numbers). */
function rangeOf(rows) {
    if (!rows || !rows.length) return { line_start: null, line_end: null };
    return { line_start: rows[0].number, line_end: rows[rows.length - 1].number };
}

/** Short error text for health and route.explain: no body, no token, no URL credentials. */
function shortError(err) {
    const raw = String((err && (err.message || err.code || err.name)) || 'request failed')
        .replace(/https?:\/\/[^\s)]+/g, (u) => {
            try { const x = new URL(u); return `${x.protocol}//${x.host}${x.pathname}`; } catch { return 'url'; }
        })
        .replace(/\s+/g, ' ')
        .trim();
    return raw.slice(0, 160) || 'request failed';
}

/** The status a source failure should surface as, when it is the caller's fault. */
class SourceError extends Error {
    constructor(message, { code = 'source.failed', status = 502 } = {}) {
        super(message);
        this.name = 'SourceError';
        this.code = code;
        this.status = status;
    }
}

module.exports = { text, httpsUrl, encodePath, repoName, context, rangeOf, shortError, SourceError, MAX_LINE, MAX_LINES };

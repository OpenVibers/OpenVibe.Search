'use strict';
/**
 * Sourcegraph public code search over the Stream API:
 *
 *   GET <sourcegraph>/.api/search/stream?q=<query>&v=V3&t=literal&display=<n>
 *   Accept: text/event-stream  (no token needed on Sourcegraph Cloud; SOURCEGRAPH_TOKEN is optional)
 *
 * The stream is a sequence of `event:`/`data:` blocks ending in `done`. We read only `matches` and
 * `alert`; `progress`/`filters` carry no result. A content match has repository, path, commit,
 * language, repoStars, repoLastFetched and lineMatches with 0-based line numbers. The raw file is
 * fetched from the same host (/r/<repo>@<commit>/-/raw/<path>) for the ±2 context window; when that
 * fails, the matching lines are still returned with their line numbers.
 *
 * Sourcegraph Cloud indexes public repositories. A private self-hosted instance must not be pointed at
 * by this public route without a separate policy: the source keeps only matches whose repository is
 * present, and never receives a token from the request.
 */
const { text, httpsUrl, encodePath, repoName, context, rangeOf, shortError, SourceError } = require('../util');

function createSourcegraphSource({ config, fetchImpl = globalThis.fetch, log = console }) {
    const base = String(config.url || 'https://sourcegraph.com').replace(/\/+$/, '');
    const token = String(config.token || '');
    let host = 'sourcegraph.com';
    try { host = new URL(base).hostname.toLowerCase(); } catch { /* keep the default */ }

    function configured() { return Boolean(base); }

    function parseEvents(raw) {
        const out = [];
        for (const block of String(raw).split(/\n\n+/)) {
            let event = null;
            const data = [];
            for (const line of block.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
            }
            if (!event || !data.length) continue;
            try { out.push({ event, data: JSON.parse(data.join('\n')) }); } catch { /* a partial final block */ }
        }
        return out;
    }

    function qualifiers(q, filters) {
        let out = String(q).slice(0, 200);
        if (filters.lang) out += ` lang:${filters.lang}`;
        if (filters.repo) out += ` repo:${filters.repo}`;
        return out;
    }

    async function rawFile(repo, commit, path, signal) {
        try {
            const timeout = AbortSignal.timeout(config.timeoutMs || 8000);
            const res = await fetchImpl(`${base}/r/${repo}@${commit}/-/raw/${encodePath(path)}`, {
                headers: { Accept: 'text/plain', ...(token ? { Authorization: `token ${token}` } : {}) },
                signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            });
            if (!res.ok) return null;
            return String(await res.text()).split('\n');
        } catch (err) {
            log.warn(`[code:sourcegraph] raw ${repo}/${path} unavailable: ${shortError(err)}`);
            return null;
        }
    }

    async function search({ q, lang = null, repo = null, limit = 10, signal = null }) {
        const display = Math.min(50, Math.max(1, Number(limit) || 10));
        const url = `${base}/.api/search/stream?q=${encodeURIComponent(qualifiers(q, { lang, repo }))}&v=V3&t=literal&display=${display}`;
        const timeout = AbortSignal.timeout(config.timeoutMs || 8000);
        let res;
        try {
            res = await fetchImpl(url, {
                headers: {
                    Accept: 'text/event-stream',
                    'User-Agent': 'openvibe-search-code',
                    ...(token ? { Authorization: `token ${token}` } : {}),
                },
                signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            });
        } catch (err) {
            throw new SourceError(`Sourcegraph could not be reached: ${shortError(err)}`, { code: 'source.failed', status: 503 });
        }
        if (res.status === 401 || res.status === 403) throw new SourceError('Sourcegraph refused the token or the request', { code: 'source.denied', status: 503 });
        if (res.status === 429) throw new SourceError('Sourcegraph is rate-limiting anonymous search', { code: 'source.rate_limited', status: 503 });
        if (!res.ok) throw new SourceError(`Sourcegraph answered ${res.status}`, { code: 'source.failed', status: 502 });
        const events = parseEvents(await res.text());
        const alert = events.find((e) => e.event === 'alert');
        const matches = events.filter((e) => e.event === 'matches').flatMap((e) => (Array.isArray(e.data) ? e.data : []));
        if (!matches.length && alert && alert.data && /rate|auth|forbidden|error/i.test(String(alert.data.title || alert.data.description || ''))) {
            throw new SourceError(String(alert.data.title || 'Sourcegraph returned no matches'), { code: 'source.rate_limited', status: 503 });
        }

        const content = matches.filter((m) => m && m.type === 'content' && m.repository && m.path && m.commit).slice(0, display);
        return (await Promise.all(content.map(async (m) => {
            const path = String(m.path);
            const repository = String(m.repository);
            const commit = String(m.commit);
            const lineMatches = Array.isArray(m.lineMatches) ? m.lineMatches : [];
            const lineNumbers = [...new Set(lineMatches.map((x) => Number(x && x.lineNumber)).filter(Number.isInteger).map((n) => n + 1))];
            const lines = await rawFile(repository, commit, path, signal);
            let rows;
            let lineStart;
            let lineEnd;
            if (lines && lineNumbers.length) {
                rows = context(lines, lineNumbers, 2);
                ({ line_start: lineStart, line_end: lineEnd } = rangeOf(rows));
            } else {
                rows = lineMatches.slice(0, 12).map((x) => ({ number: Number(x.lineNumber) + 1, text: text(x.line), match: true }));
                ({ line_start: lineStart, line_end: lineEnd } = rangeOf(rows));
            }
            const first = lineNumbers[0] || null;
            return {
                source: 'sourcegraph',
                repo: repoName(repository),
                repo_url: httpsUrl(`${base}/${repository}`, host),
                path,
                ref: commit,
                line_start: lineStart,
                line_end: lineEnd,
                lines: rows,
                language: m.language || null,
                stars: Number(m.repoStars) || 0,
                licence: null,
                last_commit_at: null,
                last_commit_source: null,
                fetched_at: m.repoLastFetched || null,
                permalink: httpsUrl(`${base}/${repository}@${encodeURIComponent(commit)}/-/blob/${encodePath(path)}${first ? `?L${first}` : ''}`, host),
            };
        }))).filter((r) => r.permalink && r.lines.length);
    }

    return {
        id: 'sourcegraph',
        kind: 'code',
        label: 'Sourcegraph public',
        cost: 'free public stream; anonymous and rate-limited',
        keyName: 'SOURCEGRAPH_TOKEN',
        requiredKey: false,
        order: 20,
        quota: { perMinute: config.perMinute || 30 },
        configured,
        search,
    };
}

module.exports = { createSourcegraphSource };

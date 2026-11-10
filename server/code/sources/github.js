'use strict';
/**
 * GitHub code search (REST): GET /search/code with the text-match media type.
 *
 *   - requires an authenticated token (GITHUB_CODE_TOKEN), 10 requests/minute, default branch only,
 *     files under 384 KB, archived repositories excluded;
 *   - the API returns repository + path + blob sha + fragments, never line numbers or a file's last
 *     commit. We fetch the blob from raw.githubusercontent.com (not an API request) to turn the
 *     fragment into line numbers with ±2 lines of context; the last-commit field is the repository's
 *     `pushed_at`, which is the honest cheap signal (one commit lookup per file does not fit 10/min).
 *   - private/internal repositories are dropped before they can reach a result, even though the token
 *     may see them: this source is public scopes only.
 */
const { text, httpsUrl, encodePath, context, rangeOf, shortError, SourceError } = require('../util');

const HOST = 'https://github.com';
const RAW = 'https://raw.githubusercontent.com';
const LANG_RE = /^[A-Za-z0-9+#._ -]{1,40}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,80}\/[A-Za-z0-9._-]{1,100}$/;

function createGithubSource({ config, fetchImpl = globalThis.fetch, log = console }) {
    const api = String(config.api || 'https://api.github.com').replace(/\/+$/, '');
    const token = String(config.token || '');

    function configured() {
        return Boolean(token);
    }

    async function request(url, { accept = 'application/json', signal = null, raw = false } = {}) {
        const timeout = AbortSignal.timeout(config.timeoutMs || 8000);
        const signal2 = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const res = await fetchImpl(url, {
            headers: {
                Accept: accept,
                'User-Agent': 'openvibe-search-code',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            signal: signal2,
        });
        if (res.status === 401 || res.status === 403) {
            throw new SourceError('GitHub refused the token or the request', { code: 'source.denied', status: 503 });
        }
        if (res.status === 429) {
            throw new SourceError('GitHub code search is rate-limited', { code: 'source.rate_limited', status: 503 });
        }
        if (!res.ok) throw new SourceError(`GitHub answered ${res.status}`, { code: 'source.failed', status: 502 });
        return raw ? res.text() : res.json();
    }

    /** The blob at the exact sha, split into lines, or null when it cannot be read. */
    async function blob(fullName, sha, path, signal) {
        try {
            const body = await request(`${RAW}/${encodePath(fullName)}/${encodeURIComponent(sha)}/${encodePath(path)}`,
                { accept: 'text/plain', signal, raw: true });
            return String(body).split('\n');
        } catch (err) {
            log.warn(`[code:github] blob ${fullName}/${path} unavailable: ${shortError(err)}`);
            return null;
        }
    }

    /** Line numbers of the fragment lines, found in the blob in order; [] when none can be placed. */
    function locate(lines, fragments) {
        const found = [];
        let cursor = 0;
        for (const fragment of fragments) {
            for (const raw of String(fragment || '').split('\n')) {
                const needle = raw.trim();
                if (needle.length < 2 || needle === '...' || needle.includes('\u2026')) continue;
                for (let i = cursor; i < lines.length; i += 1) {
                    if (lines[i].trim() === needle) { found.push(i + 1); cursor = i + 1; break; }
                }
            }
        }
        return [...new Set(found)];
    }

    function qualifiers(q, filters) {
        let out = String(q).slice(0, 200);
        if (filters.lang && LANG_RE.test(filters.lang)) out += ` language:${filters.lang}`;
        if (filters.repo && REPO_RE.test(filters.repo)) out += ` repo:${filters.repo}`;
        return out;
    }

    async function search({ q, lang = null, repo = null, limit = 10, signal = null }) {
        if (!configured()) throw new SourceError('GITHUB_CODE_TOKEN is unset', { code: 'source.unconfigured', status: 503 });
        const perPage = Math.min(50, Math.max(1, Number(limit) || 10));
        const url = `${api}/search/code?q=${encodeURIComponent(qualifiers(q, { lang, repo }))}&per_page=${perPage}`;
        const body = await request(url, { accept: 'application/vnd.github.text-match+json', signal });
        const items = Array.isArray(body.items) ? body.items : [];
        const kept = items.filter((item) => {
            const r = item && item.repository;
            if (!r || !item.file || !item.file.path) return false;
            if (r.private === true) return false;
            if (r.visibility && r.visibility !== 'public') return false;
            return Boolean(r.full_name && item.file.sha);
        }).slice(0, perPage);

        const out = await Promise.all(kept.map(async (item) => {
            const r = item.repository;
            const path = String(item.file.path);
            const sha = String(item.file.sha);
            const full = String(r.full_name);
            const fragments = (Array.isArray(item.text_matches) ? item.text_matches : []).map((m) => m && m.fragment).filter(Boolean);
            const lines = await blob(full, sha, path, signal);
            const matched = lines ? locate(lines, fragments) : [];
            let rows;
            let lineStart;
            let lineEnd;
            if (lines && matched.length) {
                rows = context(lines, matched, 2);
                ({ line_start: lineStart, line_end: lineEnd } = rangeOf(rows));
            } else {
                // No blob: still a real hit. The fragment has no line numbers, so they stay null.
                rows = fragments.flatMap((f) => String(f).split('\n')).slice(0, 12).map((line) => ({ number: null, text: text(line), match: true }));
                lineStart = null;
                lineEnd = null;
            }
            const first = matched[0] || null;
            const permalink = httpsUrl(`${HOST}/${full}/blob/${encodeURIComponent(sha)}/${encodePath(path)}${first ? `#L${first}` : ''}`, 'github.com');
            return {
                source: 'github',
                repo: full,
                repo_url: httpsUrl(r.html_url || `${HOST}/${full}`, 'github.com'),
                path,
                ref: sha,
                line_start: lineStart,
                line_end: lineEnd,
                lines: rows,
                language: r.language || null,
                stars: Number(r.stargazers_count) || 0,
                licence: (r.license && r.license.spdx_id) || null,
                last_commit_at: r.pushed_at || null,
                last_commit_source: 'repository.push',
                permalink,
            };
        }));
        return out.filter((r) => r.permalink && r.lines.length);
    }

    return {
        id: 'github',
        kind: 'code',
        label: 'GitHub code search',
        cost: 'free with a token; 10 API requests/minute',
        keyName: 'GITHUB_CODE_TOKEN',
        requiredKey: true,
        order: 10,
        quota: { perMinute: config.perMinute || 10 },
        configured,
        search,
    };
}

module.exports = { createGithubSource };

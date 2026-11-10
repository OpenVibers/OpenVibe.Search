'use strict';
/**
 * Our own forge (git.openvibe.codes, OpenVibe Git): public repositories only.
 *
 * There is no global code-search route on the forge today. It exposes
 *   GET /api/v1/repos?limit=100                              public repository metadata
 *   GET /api/v1/repos/:owner/:name/search?q=<1-200 chars>    git-grep on the default branch
 *   GET /:owner/:name/raw?ref=<sha>&path=<path>              the file body (text/plain)
 * so a global query is a fan-out over a bounded list of public repositories (newest pushed first,
 * FORGE_CODE_REPOS to pin an explicit list, SEARCH_FORGE_MAX_REPOS for the cap), cached per query.
 * Each per-repo search has the forge's own 3 s git-grep timeout; a failure in one repository does not
 * fail the others. The last-commit field is the repository's pushed_at.
 */
const { text, httpsUrl, encodePath, context, rangeOf, shortError, SourceError } = require('../util');

const REPOS_MS = 10 * 60 * 1000;
const CONCURRENCY = 6;

function createForgeSource({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    const base = String(config.url || 'https://git.openvibe.codes').replace(/\/+$/, '');
    const token = String(config.token || '');
    const maxRepos = Math.max(1, Number(config.maxRepos) || 20);
    let cache = { at: 0, repos: [] };

    function configured() { return Boolean(base); }

    async function request(url, { accept = 'application/json', signal = null, raw = false } = {}) {
        const timeout = AbortSignal.timeout(config.timeoutMs || 8000);
        const res = await fetchImpl(url, {
            headers: {
                Accept: accept,
                'User-Agent': 'openvibe-search-code',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (res.status === 401 || res.status === 403) throw new SourceError('the forge refused the request', { code: 'source.denied', status: 503 });
        if (res.status === 429) throw new SourceError('the forge is rate-limiting search', { code: 'source.rate_limited', status: 503 });
        if (!res.ok) throw new SourceError(`the forge answered ${res.status}`, { code: 'source.failed', status: 502 });
        return raw ? res.text() : res.json();
    }

    async function repos(signal) {
        if (cache.repos.length && now() - cache.at < REPOS_MS) return cache.repos;
        const body = await request(`${base}/api/v1/repos?limit=100`, { signal });
        const rows = Array.isArray(body.repositories) ? body.repositories : [];
        const publicRows = rows.filter((r) => r && r.full_name && (r.visibility === 'public' || r.visibility == null));
        cache = { at: now(), repos: publicRows };
        return publicRows;
    }

    function configuredRepos(all) {
        const pinned = Array.isArray(config.repos) ? config.repos.map((s) => String(s).toLowerCase()) : [];
        if (pinned.length) return all.filter((r) => pinned.includes(String(r.full_name).toLowerCase()));
        return all
            .slice()
            .sort((a, b) => String(b.pushed_at || '').localeCompare(String(a.pushed_at || ''))
                || (Number(b.github && b.github.stars) || Number(b.stars) || 0) - (Number(a.github && a.github.stars) || Number(a.stars) || 0))
            .slice(0, maxRepos);
    }

    function parseResults(rows) {
        const byPath = new Map();
        for (const row of rows) {
            const m = /^(.*?):(\d+):(.*)$/.exec(String(row || ''));
            if (!m) continue;
            const path = m[1];
            const line = Number(m[2]);
            if (!path || !Number.isInteger(line) || line < 1) continue;
            if (!byPath.has(path)) byPath.set(path, []);
            byPath.get(path).push({ line, text: m[3] });
        }
        return byPath;
    }

    async function rawFile(fullName, ref, path, signal) {
        try {
            return String(await request(`${base}/${encodePath(fullName)}/raw?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
                { accept: 'text/plain', signal, raw: true })).split('\n');
        } catch (err) {
            log.warn(`[code:forge] raw ${fullName}/${path} unavailable: ${shortError(err)}`);
            return null;
        }
    }

    async function searchOne(repo, q, { limit, signal }) {
        const ownerName = String(repo.full_name).split('/');
        if (ownerName.length !== 2) return [];
        const body = await request(`${base}/api/v1/repos/${encodeURIComponent(ownerName[0])}/${encodeURIComponent(ownerName[1])}/search?q=${encodeURIComponent(q)}`, { signal });
        const ref = String(body.ref || '');
        if (!ref) return [];
        const byPath = parseResults(Array.isArray(body.results) ? body.results : []);
        const files = [...byPath.entries()].slice(0, Math.max(1, limit));
        return Promise.all(files.map(async ([path, hits]) => {
            const lines = await rawFile(repo.full_name, ref, path, signal);
            const numbers = [...new Set(hits.map((h) => h.line))];
            let rows;
            let lineStart;
            let lineEnd;
            if (lines) {
                rows = context(lines, numbers, 2);
                ({ line_start: lineStart, line_end: lineEnd } = rangeOf(rows));
            } else {
                rows = hits.slice(0, 12).map((h) => ({ number: h.line, text: text(h.text), match: true }));
                ({ line_start: lineStart, line_end: lineEnd } = rangeOf(rows));
            }
            const first = numbers[0] || null;
            const stars = Number(repo.github && repo.github.stars) || Number(repo.stars) || 0;
            return {
                source: 'forge',
                repo: String(repo.full_name),
                repo_url: httpsUrl(`${base}/${encodePath(repo.full_name)}`, new URL(base).hostname),
                path,
                ref,
                line_start: lineStart,
                line_end: lineEnd,
                lines: rows,
                language: repo.language || null,
                stars,
                licence: null,
                last_commit_at: repo.pushed_at || null,
                last_commit_source: 'repository.push',
                permalink: httpsUrl(`${base}/${encodePath(repo.full_name)}/blob?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}${first ? `#L${first}` : ''}`, new URL(base).hostname),
            };
        }));
    }

    async function search({ q, lang = null, repo = null, limit = 10, signal = null }) {
        const all = await repos(signal);
        const pinned = Array.isArray(config.repos) && config.repos.length;
        let selected = repo || pinned ? all : configuredRepos(all);
        if (repo) {
            const needle = String(repo).toLowerCase();
            selected = selected.filter((r) => String(r.full_name).toLowerCase() === needle || String(r.full_name).toLowerCase().includes(needle));
        } else if (pinned) {
            selected = configuredRepos(all);
        }
        if (lang) selected = selected.filter((r) => String(r.language || '').toLowerCase() === String(lang).toLowerCase());
        if (!pinned) selected = selected.slice(0, maxRepos);
        if (!selected.length) return [];
        // A global search is heavy on purpose bounded: newest/most-starred repos, six at a time.
        const perRepo = Math.max(1, Math.ceil(Math.max(1, Number(limit) || 10) / Math.max(1, selected.length)));
        const out = [];
        for (let i = 0; i < selected.length; i += CONCURRENCY) {
            const chunk = selected.slice(i, i + CONCURRENCY);
            const settled = await Promise.allSettled(chunk.map((r) => searchOne(r, String(q).slice(0, 200), { limit: perRepo, signal })));
            for (const s of settled) {
                if (s.status === 'fulfilled') out.push(...s.value);
                else log.warn(`[code:forge] repository search failed: ${shortError(s.reason)}`);
            }
            if (out.length >= limit * 2) break;
        }
        return out;
    }

    return {
        id: 'forge',
        kind: 'code',
        label: 'OpenVibe Git',
        cost: 'free; our own host (one git grep per public repository)',
        keyName: 'FORGE_TOKEN',
        requiredKey: false,
        order: 30,
        quota: { perMinute: config.perMinute || 60 },
        configured,
        search,
    };
}

module.exports = { createForgeSource };

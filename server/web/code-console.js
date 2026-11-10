'use strict';
/**
 * The owner's code-source console: GET /console/code-sources (HTML, Network staff/owner only) and
 * POST /console/code-sources/:id (the switch). It shows, per source: the label, the on/off state, the
 * key's environment variable name and whether a value is configured (never the value), the per-minute
 * quota, health and the last error. The same data is at GET /api/v1/code/sources for a service token.
 *
 * Staff is a Network user JWT whose role group is `role:admin` or `role:owner` (the same group shape
 * the other services' consoles use). A cookie-authenticated change must come from this origin. The
 * page is server-rendered, no script, and no-store.
 */
const express = require('express');
const cache = require('openvibe-shared/cache-policy');

const CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";
const STAFF = new Set(['role:admin', 'role:owner']);

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; background: #fff; color: #1a1a1a; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 28px 16px 48px; }
h1 { font-size: 1.35rem; margin: 0 0 4px; }
p.lede { color: #5c5c66; margin: 0 0 22px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 8px; border-top: 1px solid #dcdce3; vertical-align: top; }
th { font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; color: #5c5c66; }
code { font: .9em ui-monospace, SFMono-Regular, Menlo, monospace; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid #dcdce3; font-size: .8rem; }
.ok { border-color: #2f7d4f; color: #2f7d4f; }
.ok::before { content: "● "; }
.degraded, .down, .unconfigured, .off { border-color: #8a6d1f; color: #8a6d1f; }
button { padding: 5px 10px; font: inherit; border: 1px solid #dcdce3; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
.muted { color: #5c5c66; }
.empty { color: #5c5c66; }
@media (prefers-color-scheme: dark) {
  body { background: #111317; color: #e8e8ec; }
  p.lede, .muted, th { color: #a0a0ab; }
  th, td { border-color: #2c2f36; }
  .badge, button { border-color: #2c2f36; }
}
`;

function layout({ title, body }) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · OpenVibe.Search</title>
<style>${STYLE}</style>
</head>
<body><main>
<h1>${esc(title)}</h1>
<p class="lede">Code search sources for OpenVibe.Search. Key values are never shown or sent to this page; a switch is saved and survives a restart.</p>
${body}
</main></body></html>`;
}

function sourceRow(s, { origin }) {
    const quota = s.quota && s.quota.per_minute ? `${s.quota.per_minute}/minute` : 'unbounded';
    const key = s.key && s.key.name
        ? `<code>${esc(s.key.name)}</code><br><span class="muted">${s.key.required ? 'required' : 'optional'} · ${s.key.configured ? 'configured' : 'unset'}</span>`
        : '<span class="muted">none</span>';
    const health = `<span class="badge ${esc(s.health)}">${esc(s.health)}</span>${s.last_error ? `<br><span class="muted">${esc(s.last_error)}</span>` : ''}`;
    return `<tr>
<td><strong>${esc(s.label)}</strong><br><span class="muted">${esc(s.id)} · order ${esc(s.order)}</span><br><span class="muted">${esc(s.cost)}</span></td>
<td>${s.enabled ? 'on' : 'off'}<form method="post" action="/console/code-sources/${encodeURIComponent(s.id)}"><input type="hidden" name="enabled" value="${s.enabled ? '0' : '1'}"><button type="submit">${s.enabled ? 'Turn off' : 'Turn on'}</button></form></td>
<td>${key}</td>
<td>${esc(quota)}</td>
<td>${health}</td>
<td>${esc(s.calls)} calls${s.last_ok_at ? `<br><span class="muted">last ok ${esc(s.last_ok_at)}</span>` : ''}${s.last_error_at ? `<br><span class="muted">last error ${esc(s.last_error_at)}</span>` : ''}</td>
</tr>`;
}

function createCodeConsole({ config, auth, registry }) {
    const router = express.Router();
    const origin = (() => { try { return new URL(config.baseUrl).origin; } catch { return null; } })();

    async function staff(req, res) {
        res.setHeader('Cache-Control', cache.htmlHeaders({ private: true }));
        res.setHeader('Content-Security-Policy', CSP);
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        let viewer = null;
        try { viewer = await auth.viewer(req); } catch { viewer = null; }
        const allowed = viewer && viewer.kind === 'user' && (viewer.groups || []).some((g) => STAFF.has(g));
        if (allowed) return viewer;
        const next = `${String(config.baseUrl).replace(/\/+$/, '')}/console/code-sources`;
        const login = `https://openvibe.network/auth/login?next=${encodeURIComponent(next)}`;
        res.status(403).type('html').send(layout({
            title: 'Code sources',
            body: `<p class="empty">The owner console needs a Network account with <code>role:admin</code> or <code>role:owner</code>.</p><p><a href="${esc(login)}">Sign in with OpenVibe</a></p>`,
        }));
        return null;
    }

    router.get('/console/code-sources', async (req, res) => {
        if (!await staff(req, res)) return;
        const rows = registry.list();
        res.type('html').send(layout({
            title: 'Code sources',
            body: rows.length
                ? `<table><thead><tr><th>Source</th><th>Switch</th><th>Key name</th><th>Quota</th><th>Health</th><th>Calls</th></tr></thead><tbody>${rows.map((s) => sourceRow(s, { origin })).join('')}</tbody></table>`
                : '<p class="empty">No code sources are registered.</p>',
        }));
    });

    router.post('/console/code-sources/:id', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
        if (!await staff(req, res)) return;
        const from = req.get('origin');
        if (from && origin && from !== origin) {
            return res.status(403).type('text/plain').send('a change must come from this origin');
        }
        const requested = String((req.body && req.body.enabled) || '') === '1';
        const updated = await registry.setEnabled(req.params.id, requested);
        if (!updated) return res.status(404).type('text/plain').send('no such code source');
        return res.redirect(303, '/console/code-sources');
    });

    return router;
}

module.exports = { createCodeConsole, layout, STAFF };

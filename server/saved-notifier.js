'use strict';
/**
 * Saved-search notifications (README "Saved searches"), off unless SEARCH_SAVED_NOTIFY=1 and the
 * Network OAuth client `search` is configured. Every notifyIntervalMs it takes up to notifyBatch saved
 * searches, longest without a run first (server/saved.js due()), and runs each as its owner
 * (viewer = the usr_ subject, so the ACL applies at that moment) for documents indexed after its
 * watermark (searcher `since`). A search with new hits gets ONE notification through OpenVibe.Network
 * (server/network-push.js): how many, the top title and a link to the search page with that query.
 *
 * The watermark is last_run_at, else created_at: a person opening the results moves it too, so what
 * they have seen is not announced again. It advances to the tick's start only when the push went
 * out, there was nothing new, or the person no longer exists on Network. A failed push (or run)
 * leaves it, so the same hits are retried on the next tick; a delivered batch is never notified twice.
 *
 * Web watches (scope 'web', plan AD.34 item 6): on the same tick, the watches not run for webEveryMs (a day) run their
 * words through the fabric's web scope as their owner. The first run only records what is there; after that, results
 * whose canonical keys the watch has not shown before make ONE notification (how many, the newest's title, and its
 * address). What it has shown is kept as short hashes, at most 300. A failed run leaves the watch due again.
 *
 * createSavedNotifier({ config, saved, searcher, network, fabric?, now?, log? }) → { start, stop, tick, running, state }
 */
const { seenKey } = require('./saved');
const { urlKey } = require('./fabric');

const MAX_TITLE = 120;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Why the notifier stays off for this config, or null when it may run. */
function disabledReason(config) {
    if (!config.savedSearches.notify) return 'off (SEARCH_SAVED_NOTIFY unset)';
    if (!config.networkInternalUrl) return 'off (OV_NETWORK_INTERNAL_URL unset)';
    if (!config.oauth.clientSecret) return 'off (OV_OAUTH_CLIENT_SECRET unset)';
    return null;
}

/**
 * The search page with the saved query and filters, in the query API's parameter names (the page,
 * server/web/page.js, applies q, owner and type today).
 */
function pageUrl(baseUrl, s) {
    const p = new URLSearchParams();
    if (s.q) p.set('q', s.q);
    if (s.filters.owner) p.set('owner', s.filters.owner);
    if (s.filters.type) p.set('type', s.filters.type);
    if (s.filters.language) p.set('lang', s.filters.language);
    for (const [k, vs] of s.filters.facets || []) for (const v of vs) p.append(`facet.${k}`, v);
    const qs = p.toString();
    return `${baseUrl}/${qs ? `?${qs}` : ''}`;
}

function notificationFor(config, s, body) {
    const count = `${body.results.length}${body.next_cursor ? '+' : ''}`;
    const top = body.results[0].title || 'Untitled';
    return {
        type: 'SEARCH_SAVED_MATCH',
        service: 'search',
        category: 'service',
        priority: 'normal',
        icon: '🔍',
        title: clip(`New results for “${s.name}”`, MAX_TITLE),
        message: body.results.length === 1 && !body.next_cursor ? clip(top, 300) : clip(`${count} new results, including “${top}”`, 300),
        url: pageUrl(config.baseUrl, s),
        rich_content: { saved_search_id: s.id, count: body.results.length, more: Boolean(body.next_cursor) },
    };
}

function webNotificationFor(s, fresh) {
    const top = fresh[0].title || fresh[0].url;
    return {
        type: 'SEARCH_WEB_WATCH',
        service: 'search',
        category: 'service',
        priority: 'normal',
        icon: '🔍',
        title: clip(`New on the web for “${s.name}”`, MAX_TITLE),
        message: fresh.length === 1 ? clip(top, 300) : clip(`${fresh.length} new results, including “${top}”`, 300),
        url: fresh[0].url,
        rich_content: { saved_search_id: s.id, count: fresh.length, results: fresh.slice(0, 3).map((r) => ({ title: clip(String(r.title || ''), MAX_TITLE), url: r.url })) },
    };
}

function createSavedNotifier({ config, saved, searcher, network, fabric = null, now = () => Date.now(), log = console }) {
    const fabricNow = () => (typeof fabric === 'function' ? fabric() : fabric);
    const off = disabledReason(config);
    let timer = null;
    let ticking = null;

    async function doTick() {
        const at = now();
        const out = { checked: 0, notified: 0, unchanged: 0, unknown: 0, failed: 0 };
        for (const s of await saved.due(config.savedSearches.notifyBatch)) {
            out.checked++;
            try {
                const body = await searcher.run({
                    text: s.q,
                    filters: { ...s.filters, facets: s.filters.facets || [] },
                    viewer: { subject: s.subject },
                    limit: config.query.maxLimit,
                    since: s.watermark,
                    now: at,
                });
                if (body.results.length) {
                    const sent = await network.push(s.subject, notificationFor(config, s, body));
                    if (sent.sent) out.notified++; else out.unknown++;
                } else {
                    out.unchanged++;
                }
                await saved.advance(s.id, at);
            } catch (err) {
                out.failed++;
                if (out.failed === 1) log.warn(`[saved-notify] ${s.id}: ${err.message}`);
            }
        }
        if (out.failed) log.warn(`[saved-notify] ${out.failed} saved search(es) not notified yet; will retry`);
        const f = fabricNow();
        if (f) {
            const webOut = { checked: 0, notified: 0, baseline: 0, unchanged: 0, failed: 0 };
            const every = (config.savedSearches && config.savedSearches.webEveryMs) || 24 * 3600 * 1000;
            const batch = (config.savedSearches && config.savedSearches.webBatch) || 20;
            for (const s of await saved.dueWeb(batch, at - every)) {
                webOut.checked++;
                try {
                    const body = await f.query({ q: s.q, scopes: ['web'], limit: 10 }, { kind: 'user', subject: s.subject });
                    const rows = (body.results || []).filter((r) => r && r.scope === 'web' && r.url);
                    // Nothing found because a web step failed is a failed run (due again on the next tick), not an empty web.
                    const stepFailed = ((body.route && body.route.explain) || []).some((e) => e && e.scope === 'web' && e.ok === false && !e.skipped);
                    if (!rows.length && stepFailed) throw new Error('the web steps did not answer');
                    const keyed = rows.map((r) => ({ r, k: seenKey(urlKey(r.url) || r.url) }));
                    const known = new Set(s.seen);
                    const fresh = keyed.filter((x) => !known.has(x.k));
                    if (!s.seen.length) webOut.baseline++;
                    else if (fresh.length) {
                        const sent = await network.push(s.subject, webNotificationFor(s, fresh.map((x) => x.r)));
                        if (sent.sent) webOut.notified++;
                    } else webOut.unchanged++;
                    await saved.markWeb(s.id, [...new Set([...fresh.map((x) => x.k), ...s.seen])], at);
                } catch (err) {
                    webOut.failed++;
                    if (webOut.failed === 1) log.warn(`[saved-notify] web ${s.id}: ${err.message}`);
                }
            }
            // Counted only when a web watch ran, so a tick of the network's saved searches reads as it always did.
            if (webOut.checked) out.web = webOut;
        }
        return out;
    }

    /** One pass (overlapping calls share it). */
    function tick() {
        if (!ticking) ticking = doTick().finally(() => { ticking = null; });
        return ticking;
    }

    function start() {
        if (timer || off) return;
        timer = setInterval(() => { tick().catch(err => log.warn(`[saved-notify] ${err.message}`)); }, config.savedSearches.notifyIntervalMs);
        timer.unref?.();
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        return ticking ? ticking.catch(() => {}) : Promise.resolve();
    }

    return {
        start, stop, tick,
        running: () => Boolean(timer),
        /** For readiness: 'running', 'stopped', or why it is off. */
        state: () => off || (timer ? 'running' : 'stopped'),
    };
}

module.exports = { createSavedNotifier, disabledReason, pageUrl, webNotificationFor };

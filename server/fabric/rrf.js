'use strict';
/**
 * Reciprocal rank fusion (RRF, k = 60) for the Search Fabric's network scope. Two ranked lists — the
 * keyword top 100 and the vector top 100 — are merged by
 *
 *     score(d) = 1 / (k + keywordRank(d)) + 1 / (k + vectorRank(d))
 *
 * where a rank is 1-based and a document absent from a list contributes nothing. k = 60 is the
 * standard RRF constant: it flattens the head enough that a document near the top of both lists beats
 * one that is first in only one of them, without letting a single list's first place dominate.
 *
 * Ties are broken by the keyword rank, then the vector rank, then rid, so the order is stable for the
 * same two lists. `fuseRrf` is pure; the query path calls it with the engine's hits and the vector
 * store's nearest hits, both already ordered best first.
 */
const RRF_K = 60;

function rankOf(hit) {
    if (hit && typeof hit === 'object') return hit.rid;
    return hit;
}

function fuseRrf(keywordHits = [], vectorHits = [], { k = RRF_K, limit = null } = {}) {
    const byRid = new Map();

    function entry(rid) {
        let e = byRid.get(rid);
        if (!e) {
            e = { rid, score: 0, ranks: { keyword: null, vector: null } };
            byRid.set(rid, e);
        }
        return e;
    }

    keywordHits.forEach((hit, i) => {
        const rid = rankOf(hit);
        if (rid == null) return;
        const e = entry(rid);
        e.ranks.keyword = i + 1;
        e.score += 1 / (k + i + 1);
    });
    vectorHits.forEach((hit, i) => {
        const rid = rankOf(hit);
        if (rid == null) return;
        const e = entry(rid);
        e.ranks.vector = i + 1;
        e.score += 1 / (k + i + 1);
    });

    const order = [...byRid.values()].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const ka = a.ranks.keyword == null ? Infinity : a.ranks.keyword;
        const kb = b.ranks.keyword == null ? Infinity : b.ranks.keyword;
        if (ka !== kb) return ka - kb;
        const va = a.ranks.vector == null ? Infinity : a.ranks.vector;
        const vb = b.ranks.vector == null ? Infinity : b.ranks.vector;
        if (va !== vb) return va - vb;
        const na = Number(a.rid), nb = Number(b.rid);
        if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
        return String(a.rid).localeCompare(String(b.rid));
    });
    return limit == null ? order : order.slice(0, limit);
}

module.exports = { fuseRrf, RRF_K };

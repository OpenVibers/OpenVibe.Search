'use strict';
// Fixed public network-search probes. `topic` is a deliberately broad relevance label, not a click judgement.
const probes = [
    ['openvibe live', 'live'], ['openvibe chat', 'chat'], ['openvibe codes', 'codes'], ['openvibe design', 'design'], ['openvibe exchange', 'exchange'],
    ['openvibe search', 'search'], ['openvibe wiki', 'wiki'], ['openvibe video', 'video'], ['openvibe pics', 'pics'], ['openvibe music', 'music'],
    ['live channels', 'channel'], ['live recordings', 'record'], ['stream clips', 'clip'], ['video uploads', 'video'], ['community forum', 'forum'],
    ['AI models', 'model'], ['AI providers', 'provider'], ['model benchmarks', 'benchmark'], ['image search', 'image'], ['web search', 'search'],
    ['developer API', 'api'], ['software development', 'software'], ['robot controls', 'robot'], ['open source projects', 'open source'], ['privacy policy', 'privacy'],
    ['live streaming', 'stream'], ['group chat', 'chat'], ['search indexing', 'search'], ['code repositories', 'code'], ['music playlists', 'music'],
    ['video thumbnails', 'thumbnail'], ['user profiles', 'profile'], ['channels on openvibe', 'channel'], ['openvibe network', 'network'], ['openvibe media', 'media'],
    ['openvibe actors', 'actor'], ['openvibe report', 'report'], ['openvibe bench', 'bench'], ['openvibe compare', 'compare'], ['openvibe link', 'link'],
    ['openvib live', 'live'], ['opnvibe chat', 'chat'], ['vidoe thumbnails', 'thumbnail'], ['benchmrk models', 'model'], ['commmunity forums', 'forum'],
    ['busqueda de imagenes', 'imagen'], ['recherche images', 'image'], ['suche modelle', 'modell'], ['動画 検索', '動画'], ['поиск видео', 'видео'],
];
if (probes.length !== 50) throw new Error('Benchmark must contain 50 fixed queries');
const base = process.env.SEARCH_BENCH_URL || 'http://127.0.0.1:14710';
const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
async function main() {
    const rows = [];
    for (const [q, topic] of probes) {
        const start = performance.now();
        try {
            const res = await fetch(`${base}/api/v1/search?q=${encodeURIComponent(q)}&limit=10`, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            const ms = Math.round(performance.now() - start);
            const hits = body.results || [];
            const rank = hits.findIndex((r) => `${r.title || ''} ${r.summary || ''}`.toLowerCase().includes(topic.toLowerCase()));
            rows.push({ q, ms, hits: hits.length, topic_rank: rank < 0 ? null : rank + 1 });
        } catch (err) {
            rows.push({ q, ms: Math.round(performance.now() - start), hits: 0, topic_rank: null, error: err.name || 'error' });
        }
    }
    const times = rows.map((r) => r.ms);
    const summary = { queries: rows.length, p50_ms: percentile(times, .5), p95_ms: percentile(times, .95), timeouts: rows.filter((r) => r.error).length, hit_at_10: rows.filter((r) => r.hits).length,
        topic_at_10: rows.filter((r) => r.topic_rank).length, mean_reciprocal_topic_rank: Number((rows.reduce((n, r) => n + (r.topic_rank ? 1 / r.topic_rank : 0), 0) / rows.length).toFixed(3)) };
    process.stdout.write(JSON.stringify({ summary, rows }) + '\n');
}
main().catch((err) => { process.stderr.write(String(err.message || err) + '\n'); process.exitCode = 1; });

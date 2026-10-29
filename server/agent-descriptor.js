'use strict';
// What search.openvibe.network tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// The public pages are the search page (front, and results for anonymous callers) and the update log; the JSON
// API is /api/v1. No separate documentation page, OpenAPI document or MCP endpoint is published, so none is named.
module.exports = {
    id: 'search',
    name: 'OpenVibe.Search',
    purpose: 'One permission-aware search over everything the OpenVibe network publishes: jobs, streams, clips, posts, tools, help and more, with a JSON API for every site and app.',
    home: 'https://search.openvibe.network',
    site: 'search.openvibe.network',
    api: '/api/v1',
    policy: {
        auth: ['none', 'Network OIDC'],
        rateLimit: '120 read API requests a minute and 3,000 an hour per caller; the Search Fabric query 30 a minute and 600 an hour; the HTML page follows nginx\'s address limits',
    },
};

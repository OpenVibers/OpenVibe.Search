'use strict';
/**
 * The public vhost (deploy/nginx/search.openvibe.network.conf) keeps its promises: the Network
 * wildcard certificate, client address from $remote_addr only, /metrics 404, the owner API, the
 * Events webhook and document writes loopback-only, and the app (its 404 page, or problem+json)
 * for everything else.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { suite } = require('./helpers');

const t = suite('vhost');
const conf = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx', 'search.openvibe.network.conf'), 'utf8');
const loopbackOnly = /allow 127\.0\.0\.1;\s*allow ::1;\s*deny all;/;
const block = (head) => {
    const i = conf.indexOf(head);
    assert.ok(i >= 0, `no ${head}`);
    return conf.slice(i, conf.indexOf('\n    }', i));
};

t('wildcard certificate and client address from $remote_addr only', () => {
    assert.match(conf, /ssl_certificate\s+\/etc\/letsencrypt\/live\/openvibe\.network\/fullchain\.pem;/);
    assert.match(conf, /ssl_certificate_key\s+\/etc\/letsencrypt\/live\/openvibe\.network\/privkey\.pem;/);
    for (const h of ['X-Real-IP', 'X-Forwarded-For', 'CF-Connecting-IP']) assert.match(conf, new RegExp(`proxy_set_header ${h} \\$remote_addr;`));
    assert.ok(!/proxy_add_x_forwarded_for|\$http_cf_connecting_ip|\$http_x_forwarded_for/.test(conf));
});

t('/metrics is 404; owner API, webhook and document writes are loopback-only', () => {
    assert.match(conf, /location ~\* \^\/metrics\(\/\|\$\) \{ return 404; \}/, '/metrics in any letter case');
    assert.match(block('location = /updates'), /limit_except GET \{ deny all; \}/, 'the update log, GET only');
    assert.match(conf, /location = \/release-metrics \{ limit_except POST \{ deny all; \} client_max_body_size 4k; proxy_pass http:\/\/127\.0\.0\.1:4710; \}/, 'open tabs\' release reports reach the app (POST only, small)');
    assert.match(conf, /location \^~ \/shared\/ \{ limit_except GET \{ deny all; \} proxy_pass http:\/\/127\.0\.0\.1:4710; \}/, 'the site\'s own Frame files');
    assert.match(block('location ^~ /internal/'), loopbackOnly);
    assert.match(block('location ^~ /api/v1/owners/'), loopbackOnly);
    assert.match(block('location ^~ /api/v1/documents/'), /limit_except GET \{\s*allow 127\.0\.0\.1;\s*allow ::1;\s*deny all;/);
});

t('the query API is GET-only and never cached by nginx; unknown paths reach the app', () => {
    const q = block('location ~ ^/api/v1/(search|suggest)$');
    assert.match(q, /limit_except GET \{ deny all; \}/);
    assert.match(q, /proxy_no_cache 1;/);
    const f = block('location ~ ^/api/v1/query(/providers)?$');
    assert.match(f, /limit_except GET POST \{ deny all; \}/, 'the Search Fabric: GET or POST');
    assert.match(f, /limit_req zone=ovsearch_query/);
    assert.match(f, /proxy_no_cache 1;/, 'a personalised answer is never cached by nginx');
    const catchAll = block('location / {');
    assert.match(catchAll, /proxy_pass http:\/\/127\.0\.0\.1:4710;/, 'unknown paths reach the app (its 404 page, or problem+json)');
    assert.ok(!/return 404 '\{/.test(conf), 'nginx no longer answers a static JSON 404 for the whole site');
});

t('the MCP endpoint is POST (and preflight OPTIONS) only, small, unbuffered and never cached', () => {
    const m = block('location = /mcp');
    assert.match(m, /limit_except POST OPTIONS \{ deny all; \}/, 'Streamable HTTP POST, plus the browser preflight');
    assert.match(m, /limit_req zone=ovsearch_query burst=20 nodelay;/, 'the query zone, burst 20');
    assert.match(m, /client_max_body_size 64k;/);
    assert.match(m, /proxy_pass http:\/\/127\.0\.0\.1:4710;/);
    assert.match(m, /proxy_buffering off;/);
    assert.match(m, /proxy_no_cache 1;/);
    assert.match(m, /proxy_cache_bypass 1;/);
});

t.run();

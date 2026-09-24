'use strict';
/**
 * The public vhost (deploy/nginx/search.openvibe.network.conf) keeps its promises: the Network
 * wildcard certificate, client address from $remote_addr only, /metrics 404, the owner API, the
 * Events webhook and document writes loopback-only, and a JSON 404 for everything else.
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
    assert.match(conf, /location = \/metrics \{ return 404; \}/);
    assert.match(conf, /location = \/frame-init\.js \{ limit_except GET \{ deny all; \} proxy_pass http:\/\/127\.0\.0\.1:4710; \}/, 'the Frame init script');
    assert.match(block('location = /updates'), /limit_except GET \{ deny all; \}/, 'the update log, GET only');
    assert.match(block('location ^~ /internal/'), loopbackOnly);
    assert.match(block('location ^~ /api/v1/owners/'), loopbackOnly);
    assert.match(block('location ^~ /api/v1/documents/'), /limit_except GET \{\s*allow 127\.0\.0\.1;\s*allow ::1;\s*deny all;/);
});

t('the query API is GET-only and never cached by nginx; unknown paths get a JSON 404', () => {
    const q = block('location ~ ^/api/v1/(search|suggest)$');
    assert.match(q, /limit_except GET \{ deny all; \}/);
    assert.match(q, /proxy_no_cache 1;/);
    const body = /return 404 '(\{.*\})';/.exec(conf)[1];
    assert.strictEqual(JSON.parse(body).code, 'search.not_found');
});

t.run();

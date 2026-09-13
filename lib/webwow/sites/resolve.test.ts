import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __setMainDbForTests, type MainDbLike } from './registry';
import { SITE_COOKIE, hostFromRequest, resolveSiteForRequest, scopeFor } from './resolve';

const rows = [
  { id: 'default', slug: 'default', name: 'My Site', database_name: null, domains: [], is_default: true, editor_password_hash: null, editor_password_version: 0, thumbnail_url: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', last_opened_at: null },
  { id: 's_valeska000', slug: 'valeska', name: 'Valeska', database_name: 'webwow_site_valeska', domains: ['valeska.example.com', 'www.valeska.example.com'], is_default: false, editor_password_hash: 'hash', editor_password_version: 2, thumbnail_url: null, created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-02-01T00:00:00.000Z', last_opened_at: null },
  { id: 's_blank00000', slug: 'blank', name: 'Blank', database_name: 'webwow_site_blank', domains: [], is_default: false, editor_password_hash: null, editor_password_version: 0, thumbnail_url: null, created_at: '2026-03-01T00:00:00.000Z', updated_at: '2026-03-01T00:00:00.000Z', last_opened_at: null },
];

function fakeDb(hasTable: boolean): MainDbLike {
  const builder = {
    select() { return builder; },
    orderBy() { return builder; },
    then(resolve: (rows: unknown) => unknown, reject?: (e: unknown) => unknown) { return Promise.resolve(rows.map((r) => ({ ...r }))).then(resolve, reject); },
  };
  const db = (() => builder) as unknown as MainDbLike;
  (db as unknown as { schema: unknown }).schema = { hasTable: async () => hasTable };
  return db;
}

test('scopeFor table', () => {
  const pub: Array<[string, string]> = [
    ['GET', '/'], ['GET', '/work'], ['GET', '/exhibitions/abc'], ['GET', '/storage/v1/object/public/assets/x.png'], ['GET', '/a/abc/x.png'],
    ['GET', '/dynamic/p_2'], ['GET', '/dynamic'], ['GET', '/.well-known/x'], ['GET', '/sitemap.xml'], ['GET', '/robots.txt'], ['GET', '/llms.txt'],
    ['POST', '/ycode/api/form-submissions'], ['POST', '/ycode/api/collections/x/items/load-more'], ['POST', '/ycode/api/collections/x/items/filter'],
    ['GET', '/ycode/api/v1/collections'], ['POST', '/ycode/api/v1/items'], ['GET', '/ycode/mcp'], ['POST', '/ycode/mcp/abc'],
    ['GET', '/ycode/api/oauth/authorize'], ['POST', '/ycode/api/revalidate'], ['GET', '/api/cron/airtable-webhooks'], ['POST', '/api/page-auth/verify'],
    ['POST', '/api/airtable-webhook'], ['GET', '/ycodex'],
  ];
  for (const [method, path] of pub) assert.equal(scopeFor(path, method), 'public', `${method} ${path}`);
  const builder: Array<[string, string]> = [
    ['GET', '/ycode'], ['GET', '/ycode/'], ['GET', '/ycode/collections'], ['GET', '/ycode/api/pages'], ['GET', '/ycode/api/form-submissions'],
    ['DELETE', '/ycode/api/form-submissions'], ['GET', '/ycode/api/collections/x/items'], ['POST', '/ycode/api/collections/x/items'],
    ['GET', '/ycode/api/collections/x/items/load-more'], ['GET', '/ycode/api/mcp-tokens'], ['GET', '/ycode/api/webwow/sites'], ['GET', '/ycode/preview/x'],
    ['GET', '/api/templates'], ['POST', '/api/templates/x/apply'], ['GET', '/webwow'], ['GET', '/webwow/edit'], ['GET', '/_next/static/x.js'],
  ];
  for (const [method, path] of builder) assert.equal(scopeFor(path, method), 'builder', `${method} ${path}`);
  assert.equal(scopeFor('/ycode/api/form-submissions', 'post'), 'public', 'method is case-insensitive');
});

test('hostFromRequest', () => {
  const h = (init: Record<string, string>) => new Headers(init);
  assert.equal(hostFromRequest(h({ host: 'Valeska.Example.com:3002' }), false), 'valeska.example.com');
  assert.equal(hostFromRequest(h({ host: 'a.example.com', 'x-forwarded-host': 'b.example.com' }), false), 'a.example.com');
  assert.equal(hostFromRequest(h({ host: 'a.example.com', 'x-forwarded-host': 'b.example.com:443' }), true), 'b.example.com');
  assert.equal(hostFromRequest(h({ host: 'a.example.com', 'x-forwarded-host': 'b.example.com, c.example.com' }), true), 'b.example.com');
  assert.equal(hostFromRequest(h({ host: 'a.example.com', 'x-forwarded-host': '' }), true), 'a.example.com');
  assert.equal(hostFromRequest(h({ host: '[::1]:3002' }), false), '[::1]');
  assert.equal(hostFromRequest(h({}), true), '');
  assert.equal(SITE_COOKIE, 'webwow_site');
});

test('public scope: domain exact > subdomain > default', async () => {
  __setMainDbForTests(fakeDb(true));
  try {
    let r = await resolveSiteForRequest({ scope: 'public', host: 'www.valeska.example.com' });
    assert.equal(r.site.id, 's_valeska000'); assert.equal(r.via, 'domain');
    r = await resolveSiteForRequest({ scope: 'public', host: 'VALESKA.example.com' });
    assert.equal(r.via, 'domain');
    r = await resolveSiteForRequest({ scope: 'public', host: 'valeska.sites.test', baseDomain: 'sites.test' });
    assert.equal(r.site.id, 's_valeska000'); assert.equal(r.via, 'subdomain');
    r = await resolveSiteForRequest({ scope: 'public', host: 'blank.localhost' });
    assert.equal(r.site.id, 's_blank00000'); assert.equal(r.via, 'subdomain');
    r = await resolveSiteForRequest({ scope: 'public', host: 'blank.localhost', baseDomain: 'sites.test' });
    assert.equal(r.via, 'default', 'localhost rule only applies without a base domain');
    r = await resolveSiteForRequest({ scope: 'public', host: 'x.blank.sites.test', baseDomain: 'sites.test' });
    assert.equal(r.via, 'default', 'only the first label counts');
    r = await resolveSiteForRequest({ scope: 'public', host: 'unknown.example.com' });
    assert.equal(r.site.id, 'default'); assert.equal(r.via, 'default');
    r = await resolveSiteForRequest({ scope: 'public', host: '' });
    assert.equal(r.via, 'default');
    // public scope ignores cookie and pin
    r = await resolveSiteForRequest({ scope: 'public', host: 'localhost', cookie: 's_blank00000', pinned: { siteId: 's_valeska000', pv: 2 } });
    assert.equal(r.site.id, 'default');
  } finally {
    __setMainDbForTests(null);
  }
});

test('builder scope: pin > cookie > default; invalid pins are flagged', async () => {
  __setMainDbForTests(fakeDb(true));
  try {
    let r = await resolveSiteForRequest({ scope: 'builder', host: 'localhost', pinned: { siteId: 's_valeska000', pv: 2 }, cookie: 's_blank00000' });
    assert.equal(r.site.id, 's_valeska000'); assert.equal(r.via, 'pin'); assert.equal(r.pinInvalid, undefined);
    r = await resolveSiteForRequest({ scope: 'builder', host: 'localhost', pinned: { siteId: 's_gone000000', pv: 0 } });
    assert.equal(r.pinInvalid, 'unknown'); assert.equal(r.site.id, 'default');
    r = await resolveSiteForRequest({ scope: 'builder', host: 'localhost', pinned: { siteId: 's_blank00000', pv: 0 } });
    assert.equal(r.pinInvalid, 'disabled');
    r = await resolveSiteForRequest({ scope: 'builder', host: 'localhost', pinned: { siteId: 's_valeska000', pv: 1 } });
    assert.equal(r.pinInvalid, 'revoked');
    r = await resolveSiteForRequest({ scope: 'builder', host: 'valeska.example.com', cookie: 's_blank00000' });
    assert.equal(r.site.id, 's_blank00000'); assert.equal(r.via, 'cookie');
    r = await resolveSiteForRequest({ scope: 'builder', host: 'valeska.example.com', cookie: 's_unknown000' });
    assert.equal(r.site.id, 'default'); assert.equal(r.via, 'default');
    r = await resolveSiteForRequest({ scope: 'builder', host: 'valeska.example.com' });
    assert.equal(r.via, 'default', 'builder scope never uses the host');
  } finally {
    __setMainDbForTests(null);
  }
});

test('registry missing -> default everywhere', async () => {
  __setMainDbForTests(fakeDb(false));
  try {
    const r = await resolveSiteForRequest({ scope: 'public', host: 'valeska.example.com' });
    assert.equal(r.site.id, 'default'); assert.equal(r.via, 'default'); assert.equal(r.site.is_default, true);
    const b = await resolveSiteForRequest({ scope: 'builder', host: 'x', pinned: { siteId: 's_valeska000', pv: 2 } });
    assert.equal(b.site.id, 'default'); assert.equal(b.pinInvalid, undefined);
  } finally {
    __setMainDbForTests(null);
  }
});

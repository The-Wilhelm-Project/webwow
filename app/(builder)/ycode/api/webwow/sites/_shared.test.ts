import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

// auth-server.ts carries `import 'server-only'`, which throws outside a React server bundle.
{
  const filename = require.resolve('server-only');
  const mod = new Module(filename) as Module & { loaded: boolean };
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = {};
  require.cache[filename] = mod;
}
process.env.PAGE_AUTH_SECRET = process.env.PAGE_AUTH_SECRET || 'sites-shared-test-secret';

import type { SiteRow } from '@/lib/webwow/sites/registry';
import type { CurrentUser } from '@/lib/webwow/auth-server';
import { SiteServiceError } from '@/lib/webwow/sites/service';
import { ToastError } from '@/lib/toast-error';
import {
  __setSitesAccessDepsForTests,
  previewUrlFor,
  readBoolean,
  readJsonBody,
  readString,
  requireSitesAccess,
  roleSatisfies,
  siteErrorResponse,
  siteJson,
} from './_shared';

function row(overrides: Partial<SiteRow> = {}): SiteRow {
  return {
    id: 's_abcdefghij',
    slug: 'valeska',
    name: 'Valeska',
    database_name: 'webwow_site_valeska',
    domains: [],
    is_default: false,
    editor_password_hash: null,
    editor_password_version: 0,
    thumbnail_url: null,
    created_at: '2026-09-13T00:00:00.000Z',
    updated_at: '2026-09-13T00:00:00.000Z',
    last_opened_at: null,
    ...overrides,
  };
}

function currentUser(role: string | undefined, extra: { kind?: 'editor'; editorSite?: string } = {}): CurrentUser {
  const meta: Record<string, unknown> = {};
  if (role) meta.role = role;
  if (extra.editorSite) meta.webwow_editor_site = extra.editorSite;
  return {
    user: {
      id: 'u1',
      email: 'u1@example.com',
      encrypted_password: null,
      raw_app_meta_data: meta,
      raw_user_meta_data: null,
      email_confirmed_at: null,
      last_sign_in_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    token: 't',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    payload: { uid: 'u1', iat: 0, exp: Math.floor(Date.now() / 1000) + 3600, ...(extra.kind ? { kind: extra.kind, site: extra.editorSite ?? 's_abcdefghij', pv: 1 } : {}) },
  };
}

// ---------------------------------------------------------------------------
// siteJson / previewUrlFor
// ---------------------------------------------------------------------------

test('siteJson strips the password hash and reports editorPasswordSet', () => {
  const json = siteJson(row({ editor_password_hash: 'scrypt$x$y', editor_password_version: 3 }), { baseDomain: null, port: '3002' });
  assert.equal('editor_password_hash' in json, false);
  assert.equal(json.editorPasswordSet, true);
  assert.equal(json.editor_password_version, 3);
  assert.equal(json.id, 's_abcdefghij');
  assert.deepEqual(json.domains, []);
  assert.equal(siteJson(row({ editor_password_hash: null })).editorPasswordSet, false);
  assert.equal(siteJson(row({ editor_password_hash: '' })).editorPasswordSet, false);
});

test('previewUrl: first domain > <slug>.<base domain> > <slug>.localhost:<PORT>', () => {
  assert.equal(previewUrlFor(row({ domains: ['Valeska.example', 'other.example'] }), { baseDomain: 'sites.test', port: '4000' }), 'https://valeska.example');
  assert.equal(previewUrlFor(row(), { baseDomain: 'sites.test', port: '4000' }), 'https://valeska.sites.test');
  assert.equal(previewUrlFor(row(), { baseDomain: '.Sites.Test/', port: '4000' }), 'https://valeska.sites.test');
  assert.equal(previewUrlFor(row(), { baseDomain: '', port: '4000' }), 'http://valeska.localhost:4000');
  assert.equal(previewUrlFor(row(), { baseDomain: null, port: null }), 'http://valeska.localhost:3002');
  assert.equal(previewUrlFor(row({ domains: ['  ', 'a.example'] }), {}), 'https://a.example');
});

test('siteJson: publishedUrl is "/" for the default site and previewUrl otherwise', () => {
  const def = siteJson(row({ id: 'default', slug: 'default', is_default: true, database_name: null }), { baseDomain: null, port: '3002' });
  assert.equal(def.publishedUrl, '/');
  assert.equal(def.previewUrl, 'http://default.localhost:3002');
  const defWithDomain = siteJson(row({ id: 'default', slug: 'default', is_default: true, domains: ['www.example.com'] }), {});
  assert.equal(defWithDomain.publishedUrl, '/');
  assert.equal(defWithDomain.previewUrl, 'https://www.example.com');
  const site = siteJson(row({ domains: ['valeska.example'] }), {});
  assert.equal(site.publishedUrl, 'https://valeska.example');
  assert.equal(site.previewUrl, site.publishedUrl);
});

// ---------------------------------------------------------------------------
// body helpers
// ---------------------------------------------------------------------------

test('readJsonBody tolerates missing/invalid/non-object bodies', async () => {
  const mk = (body: string | null, type = 'application/json') =>
    new Request('http://x/', { method: 'POST', body, headers: body === null ? {} : { 'content-type': type } }) as unknown as import('next/server').NextRequest;
  assert.deepEqual(await readJsonBody(mk(null)), {});
  assert.deepEqual(await readJsonBody(mk('not json')), {});
  assert.deepEqual(await readJsonBody(mk('[1,2]')), {});
  assert.deepEqual(await readJsonBody(mk('{"name":" A "}')), { name: ' A ' });
});

test('readString / readBoolean', () => {
  assert.equal(readString({ name: '  Valeska ' }, 'name'), 'Valeska');
  assert.equal(readString({ name: 5 }, 'name'), undefined);
  assert.equal(readString({}, 'name'), undefined);
  assert.equal(readBoolean({ a: true }, 'a'), true);
  assert.equal(readBoolean({ a: 'true' }, 'a'), true);
  assert.equal(readBoolean({ a: 1 }, 'a'), true);
  assert.equal(readBoolean({ a: 'false' }, 'a'), false);
  assert.equal(readBoolean({ a: 0 }, 'a'), false);
  assert.equal(readBoolean({ a: 'yes' }, 'a'), undefined);
  assert.equal(readBoolean({}, 'a'), undefined);
});

// ---------------------------------------------------------------------------
// error mapping
// ---------------------------------------------------------------------------

test('siteErrorResponse maps SiteServiceError status/code, ToastError -> 400, unknown -> 500', async () => {
  const r1 = siteErrorResponse(new SiteServiceError('taken', 409, 'slug_taken'));
  assert.equal(r1.status, 409);
  assert.deepEqual(await r1.json(), { error: 'taken', code: 'slug_taken' });
  assert.equal(r1.headers.get('cache-control')?.includes('no-store'), true);

  const r2 = siteErrorResponse(new SiteServiceError('bad file', 400, 'invalid_file', 'Import failed'));
  assert.equal(r2.status, 400);
  assert.deepEqual(await r2.json(), { error: 'bad file', code: 'invalid_file', errorTitle: 'Import failed' });

  const r3 = siteErrorResponse(new ToastError('Nope', 'wrong password'));
  assert.equal(r3.status, 400);
  assert.deepEqual(await r3.json(), { error: 'wrong password', code: null, errorTitle: 'Nope' });

  const origError = console.error;
  console.error = () => undefined;
  try {
    const r4 = siteErrorResponse(new Error('boom'));
    assert.equal(r4.status, 500);
    assert.deepEqual(await r4.json(), { error: 'boom', code: null });
    const r5 = siteErrorResponse(new SiteServiceError('weird', 999, 'weird'));
    assert.equal(r5.status, 400); // out-of-range status clamped
  } finally {
    console.error = origError;
  }
});

// ---------------------------------------------------------------------------
// access matrix (SPEC-multisite §9)
// ---------------------------------------------------------------------------

test('roleSatisfies', () => {
  assert.equal(roleSatisfies('editor', 'read'), true);
  assert.equal(roleSatisfies('designer', 'admin'), false);
  assert.equal(roleSatisfies('admin', 'admin'), true);
  assert.equal(roleSatisfies('admin', 'owner'), false);
  assert.equal(roleSatisfies('owner', 'owner'), true);
});

async function expectError(fn: () => Promise<unknown>, status: number, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof SiteServiceError, `expected SiteServiceError, got ${String(error)}`);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected ${status} ${code}`);
}

test('requireSitesAccess: role matrix, editor sessions, registry', async () => {
  try {
    __setSitesAccessDepsForTests({ getCurrentUser: async () => null, registryAvailable: async () => true });
    await expectError(() => requireSitesAccess('read'), 401, 'unauthenticated');

    __setSitesAccessDepsForTests({ getCurrentUser: async () => currentUser('editor', { kind: 'editor', editorSite: 's_abcdefghij' }), registryAvailable: async () => true });
    await expectError(() => requireSitesAccess('read'), 403, 'editor_session');

    // synthetic editor account without the editor token kind is refused too
    __setSitesAccessDepsForTests({ getCurrentUser: async () => currentUser('editor', { editorSite: 's_abcdefghij' }), registryAvailable: async () => true });
    await expectError(() => requireSitesAccess('read'), 403, 'editor_session');

    __setSitesAccessDepsForTests({ getCurrentUser: async () => currentUser('designer'), registryAvailable: async () => true });
    assert.equal((await requireSitesAccess('read')).role, 'designer');
    await expectError(() => requireSitesAccess('admin'), 403, 'forbidden');
    await expectError(() => requireSitesAccess('owner'), 403, 'forbidden');

    // unknown / missing role resolves to the default role (designer)
    __setSitesAccessDepsForTests({ getCurrentUser: async () => currentUser(undefined), registryAvailable: async () => true });
    assert.equal((await requireSitesAccess('read')).role, 'designer');
    await expectError(() => requireSitesAccess('admin'), 403, 'forbidden');

    __setSitesAccessDepsForTests({ getCurrentUser: async () => currentUser('admin'), registryAvailable: async () => true });
    assert.equal((await requireSitesAccess('admin')).role, 'admin');
    await expectError(() => requireSitesAccess('owner'), 403, 'forbidden');

    __setSitesAccessDepsForTests({ getCurrentUser: async () => currentUser('owner'), registryAvailable: async () => true });
    const access = await requireSitesAccess('owner');
    assert.equal(access.role, 'owner');
    assert.equal(access.user.id, 'u1');

    __setSitesAccessDepsForTests({ getCurrentUser: async () => currentUser('owner'), registryAvailable: async () => false });
    await expectError(() => requireSitesAccess('read'), 400, 'registry_missing');
  } finally {
    __setSitesAccessDepsForTests(null);
  }
});

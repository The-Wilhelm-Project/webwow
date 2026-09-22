import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetMcpTokenSiteCacheForTests,
  __setClockForTests,
  findMcpTokenSite,
  isMcpPath,
  mcpTokenFromRequest,
  MCP_TOKEN_SITE_TTL_HIT_MS,
  MCP_TOKEN_SITE_TTL_MISS_MS,
} from './mcp-token-site';
import type { SiteRow } from './registry';
import { runInSite } from './context';
import { getCachedToken, invalidateToken, setCachedToken } from '../../mcp/token-cache';

const TOKEN_A = 'ymc_' + 'a'.repeat(48);
const TOKEN_B = 'ymc_' + 'b'.repeat(48);

function site(id: string): SiteRow {
  return {
    id, slug: id, name: id, database_name: id === 'default' ? null : `webwow_site_${id}`, domains: [], is_default: id === 'default',
    editor_password_hash: null, editor_password_version: 0, thumbnail_url: null, created_at: '', updated_at: '', last_opened_at: null,
  };
}
const SITES = [site('default'), site('s_aaaaaaaaaa'), site('s_bbbbbbbbbb')];
const STORE: Record<string, string[]> = { s_aaaaaaaaaa: [TOKEN_A], s_bbbbbbbbbb: [TOKEN_B] };

function lookup(calls: string[]) {
  return async (siteId: string, token: string) => {
    calls.push(siteId);
    return (STORE[siteId] ?? []).includes(token);
  };
}

test('isMcpPath / mcpTokenFromRequest', () => {
  assert.equal(isMcpPath('/ycode/mcp'), true);
  assert.equal(isMcpPath('/ycode/mcp/x'), true);
  assert.equal(isMcpPath('/ycode/mcp-tokens'), false);
  assert.equal(isMcpPath('/ycode/api/mcp-tokens'), false);
  assert.equal(mcpTokenFromRequest(`/ycode/mcp/${TOKEN_A}`, null), TOKEN_A);
  assert.equal(mcpTokenFromRequest(`/ycode/mcp/${TOKEN_A}/extra`, null), TOKEN_A);
  assert.equal(mcpTokenFromRequest('/ycode/mcp', `Bearer ${TOKEN_B}`), TOKEN_B);
  assert.equal(mcpTokenFromRequest('/ycode/mcp', `bearer  ${TOKEN_B} `), TOKEN_B);
  assert.equal(mcpTokenFromRequest('/ycode/mcp', null), null);
  assert.equal(mcpTokenFromRequest('/ycode/mcp', 'Basic abc'), null);
  assert.equal(mcpTokenFromRequest('/ycode/mcp/short', null), null, 'too short');
  assert.equal(mcpTokenFromRequest('/ycode/mcp/%E0%A4%A', null), null, 'malformed escape');
  assert.equal(mcpTokenFromRequest(`/ycode/mcp/${TOKEN_A}'--`, null), null, 'unexpected characters');
  assert.equal(mcpTokenFromRequest(`/ycode/mcp/${TOKEN_A}`, `Bearer ${TOKEN_B}`), TOKEN_A, 'URL token wins on the token route');
});

test('findMcpTokenSite: token decides, preferred site first, misses are null', async () => {
  __resetMcpTokenSiteCacheForTests();
  const calls: string[] = [];
  assert.equal((await findMcpTokenSite(TOKEN_B, SITES, 'default', lookup(calls)))?.id, 's_bbbbbbbbbb');
  assert.deepEqual(calls, ['default', 's_aaaaaaaaaa', 's_bbbbbbbbbb']);
  calls.length = 0;
  assert.equal((await findMcpTokenSite(TOKEN_A, SITES, 's_aaaaaaaaaa', lookup(calls)))?.id, 's_aaaaaaaaaa');
  assert.deepEqual(calls, ['s_aaaaaaaaaa'], 'preferred site is asked first and ends the scan');
  calls.length = 0;
  assert.equal(await findMcpTokenSite('ymc_' + 'c'.repeat(48), SITES, 'default', lookup(calls)), null);
  assert.equal(calls.length, 3);
});

test('findMcpTokenSite: cache TTLs (hit 60 s, miss 5 s)', async () => {
  __resetMcpTokenSiteCacheForTests();
  let now = 1_000_000;
  __setClockForTests(() => now);
  try {
    const calls: string[] = [];
    await findMcpTokenSite(TOKEN_B, SITES, 'default', lookup(calls));
    calls.length = 0;
    now += MCP_TOKEN_SITE_TTL_HIT_MS - 1;
    assert.equal((await findMcpTokenSite(TOKEN_B, SITES, 'default', lookup(calls)))?.id, 's_bbbbbbbbbb');
    assert.deepEqual(calls, [], 'hit served from cache');
    now += 2;
    await findMcpTokenSite(TOKEN_B, SITES, 'default', lookup(calls));
    assert.equal(calls.length, 3, 'hit expired -> rescan');

    const unknown = 'ymc_' + 'd'.repeat(48);
    calls.length = 0;
    await findMcpTokenSite(unknown, SITES, 'default', lookup(calls));
    STORE.default = [unknown]; // token created meanwhile
    calls.length = 0;
    assert.equal(await findMcpTokenSite(unknown, SITES, 'default', lookup(calls)), null, 'miss cached');
    now += MCP_TOKEN_SITE_TTL_MISS_MS + 1;
    assert.equal((await findMcpTokenSite(unknown, SITES, 'default', lookup(calls)))?.id, 'default', 'miss expired -> found');
    delete STORE.default;

    // A cached owner that was deleted from the registry resolves to null (default site, 401 in the route).
    assert.equal(await findMcpTokenSite(TOKEN_B, SITES.filter((s) => s.id !== 's_bbbbbbbbbb'), 'default', lookup(calls)), null);
  } finally {
    __setClockForTests(null);
  }
});

test('findMcpTokenSite: a lookup error counts as "not in this site"', async () => {
  __resetMcpTokenSiteCacheForTests();
  const failing = async (siteId: string, token: string) => {
    if (siteId === 's_aaaaaaaaaa') return false; // what tokenExistsInSiteDb returns on a DB error
    return (STORE[siteId] ?? []).includes(token);
  };
  assert.equal((await findMcpTokenSite(TOKEN_B, SITES, 'default', failing))?.id, 's_bbbbbbbbbb');
});

test('MCP token cache (lib/mcp/token-cache.ts) is keyed by site', async () => {
  // Regression: a token validated for site A was accepted on site B's host for 60 s.
  await runInSite('s_aaaaaaaaaa', async () => setCachedToken(TOKEN_A, true));
  assert.equal((await runInSite('s_aaaaaaaaaa', async () => getCachedToken(TOKEN_A)))?.valid, true);
  assert.equal(await runInSite('s_bbbbbbbbbb', async () => getCachedToken(TOKEN_A)), undefined);
  assert.equal(await runInSite('default', async () => getCachedToken(TOKEN_A)), undefined);
  assert.equal(getCachedToken(TOKEN_A), undefined, 'outside any request = default site');

  // A cached miss in one site does not hide the token in its own site.
  await runInSite('default', async () => setCachedToken(TOKEN_B, false));
  assert.equal(await runInSite('s_bbbbbbbbbb', async () => getCachedToken(TOKEN_B)), undefined);

  // invalidateToken (rotate/delete) drops the token for every site.
  await runInSite('s_bbbbbbbbbb', async () => setCachedToken(TOKEN_A, true));
  invalidateToken(TOKEN_A);
  assert.equal(await runInSite('s_aaaaaaaaaa', async () => getCachedToken(TOKEN_A)), undefined);
  assert.equal(await runInSite('s_bbbbbbbbbb', async () => getCachedToken(TOKEN_A)), undefined);
  assert.equal((await runInSite('default', async () => getCachedToken(TOKEN_B)))?.valid, false, 'other tokens untouched');
});

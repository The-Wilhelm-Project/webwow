/**
 * Site of an MCP request, derived from its token (multi-site, docs/MULTISITE.md §3).
 *
 * MCP tokens live in the `mcp_tokens` table of ONE site database. The builder
 * hands out `http(s)://<builder host>/ycode/mcp/<token>` for the site that is
 * open, but `/ycode/mcp*` is host-resolved, and the builder host is the main
 * host (default site). Without this lookup every token of a non-default site
 * was rejected with 401 on the URL the builder shows.
 *
 * Rule (applied by proxy.ts only when the host did NOT select a site, i.e.
 * `resolved.via === 'default'`): the site whose database stores the token wins.
 * A host that explicitly selects a site (domain, `<slug>.<base>`) keeps it, so
 * a token of site A sent to site B's host is validated in site B and fails.
 * Unknown tokens keep the default site (the MCP route then answers 401).
 *
 * Cache: hits 60 s, misses 5 s (same TTLs as lib/mcp/token-cache.ts), on
 * `globalThis` so proxy and app bundles share it. A cached owner that deleted
 * the token only routes the request to that site, where validation fails.
 */

import { runInSite } from './context';
import { DEFAULT_SITE_ID } from './ids';
import type { SiteRow } from './registry';

export const MCP_TOKEN_SITE_TTL_HIT_MS = 60_000;
export const MCP_TOKEN_SITE_TTL_MISS_MS = 5_000;

/** Opaque token shape accepted for the lookup (upstream issues `ymc_` + 48 hex). */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,200}$/;

export type TokenExists = (siteId: string, token: string) => Promise<boolean>;

interface Entry { siteId: string | null; expires: number }

const KEY = Symbol.for('webwow.mcpTokenSiteCache');
const g = globalThis as unknown as Record<symbol, Map<string, Entry> | undefined>;
const cache: Map<string, Entry> = g[KEY] ?? (g[KEY] = new Map<string, Entry>());

let clock: () => number = () => Date.now();

/** `/ycode/mcp` and `/ycode/mcp/<token>` (the two MCP endpoints). */
export function isMcpPath(pathname: string): boolean {
  return pathname === '/ycode/mcp' || pathname.startsWith('/ycode/mcp/');
}

/** Token of an MCP request: URL segment of `/ycode/mcp/<token>`, else `Authorization: Bearer <token>`. */
export function mcpTokenFromRequest(pathname: string, authorization: string | null | undefined): string | null {
  let token: string | null = null;
  if (pathname.startsWith('/ycode/mcp/')) {
    const segment = pathname.slice('/ycode/mcp/'.length).split('/')[0];
    try {
      token = decodeURIComponent(segment);
    } catch {
      token = null;
    }
  } else if (pathname === '/ycode/mcp' && authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    token = match ? match[1].trim() : null;
  }
  return token && TOKEN_RE.test(token) ? token : null;
}

/** Default lookup: does the site database hold this token (active or not; the route validates)? */
export const tokenExistsInSiteDb: TokenExists = async (siteId, token) => {
  try {
    return await runInSite(siteId, async () => {
      const { getKnexClient } = await import('../../knex-client');
      const db = await getKnexClient();
      const row = await db('mcp_tokens').where({ token }).first('id');
      return !!row;
    });
  } catch {
    return false; // site database missing, table missing, connection refused
  }
};

/**
 * Site that stores `token`, checking `preferredId` first and then the other
 * sites in registry order. `null` when no site knows the token.
 */
export async function findMcpTokenSite(
  token: string,
  sites: SiteRow[],
  preferredId: string = DEFAULT_SITE_ID,
  exists: TokenExists = tokenExistsInSiteDb,
): Promise<SiteRow | null> {
  const now = clock();
  const cached = cache.get(token);
  if (cached && cached.expires > now) {
    return cached.siteId === null ? null : sites.find((s) => s.id === cached.siteId) ?? null;
  }

  const ordered = [
    ...sites.filter((s) => s.id === preferredId),
    ...sites.filter((s) => s.id !== preferredId),
  ];
  let owner: SiteRow | null = null;
  for (const site of ordered) {
    if (await exists(site.id, token)) {
      owner = site;
      break;
    }
  }

  cache.set(token, {
    siteId: owner ? owner.id : null,
    expires: now + (owner ? MCP_TOKEN_SITE_TTL_HIT_MS : MCP_TOKEN_SITE_TTL_MISS_MS),
  });
  if (cache.size > 5000) {
    for (const [key, entry] of cache) {
      if (entry.expires <= now) cache.delete(key);
    }
    if (cache.size > 5000) cache.clear(); // flood of distinct unknown tokens: stay bounded
  }
  return owner;
}

export function __resetMcpTokenSiteCacheForTests(): void {
  cache.clear();
}

export function __setClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

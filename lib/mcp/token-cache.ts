/**
 * In-memory cache for MCP token validation results.
 *
 * AI agents make many requests per minute and each was previously hitting
 * Supabase to revalidate the same token. Cache hits live for 60s (revocations
 * propagate within a minute, fine for static URL tokens). Misses cache for 5s
 * so a token flip from invalid→valid recovers quickly.
 *
 * The cache lives in its own module so both `lib/mcp/handler.ts` and the
 * repository can read/invalidate it without creating a circular import.
 * Rotated/deleted tokens are explicitly invalidated so the old access token
 * stops working immediately, not after the cache TTL expires.
 *
 * Webwow (multi-site, docs/MULTISITE.md): a token is only valid in the site
 * database that stores it, so every entry is keyed by the site of the running
 * request as well. Without that, a token validated for site A was accepted for
 * 60s on site B's host and its tool calls ran against site B's database.
 */

import { getCurrentSiteId } from '@/lib/webwow/sites/request-site';

interface TokenCacheEntry {
  valid: boolean;
  expires: number;
}

const cache = new Map<string, TokenCacheEntry>();

export const TOKEN_CACHE_TTL_VALID_MS = 60_000;
export const TOKEN_CACHE_TTL_INVALID_MS = 5_000;

/** Webwow: cache key = site of the current request + token. */
function cacheKey(token: string): string {
  return `${getCurrentSiteId()}\u0000${token}`;
}

export function getCachedToken(token: string): TokenCacheEntry | undefined {
  const key = cacheKey(token);
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) {
    return entry;
  }
  if (entry) {
    cache.delete(key);
  }
  return undefined;
}

export function setCachedToken(token: string, valid: boolean): void {
  const ttl = valid ? TOKEN_CACHE_TTL_VALID_MS : TOKEN_CACHE_TTL_INVALID_MS;
  cache.set(cacheKey(token), { valid, expires: Date.now() + ttl });
}

export function invalidateToken(token: string): void {
  // Webwow: drop the token for every site (the caller may run outside the token's site).
  const suffix = `\u0000${token}`;
  for (const key of cache.keys()) {
    if (key.endsWith(suffix)) cache.delete(key);
  }
}

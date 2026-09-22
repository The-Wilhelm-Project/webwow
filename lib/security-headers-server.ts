/**
 * Server-side application of configurable security headers.
 *
 * Kept separate from `security-headers.ts` (pure/client-safe) because it reads
 * the database. Both the base middleware (`proxy.ts`) and the cloud middleware
 * import `applySecurityHeaders` so the two stay in sync after an upstream merge.
 *
 * Caching uses stale-while-revalidate keyed by tenant: a fresh value is served
 * from memory, a stale value is served immediately while refreshing in the
 * background, and only a cold cache awaits the DB (bounded) — so the header
 * lookup never blocks a hot request path.
 */

import type { NextResponse } from 'next/server';
import { getSettingByKey } from '@/lib/repositories/settingsRepository';
import { SECURITY_HEADERS_SETTING_KEY, resolveSecurityHeaders } from '@/lib/security-headers';

const CACHE_TTL_MS = 30_000;
const COLD_READ_TIMEOUT_MS = 1_000;

interface CacheEntry {
  at: number;
  headers: Record<string, string>;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<void>>();

/** Refresh a tenant's cached headers from the DB, keeping the last value on error. */
async function refresh(cacheKey: string, tenantId?: string): Promise<void> {
  try {
    const stored = await getSettingByKey(SECURITY_HEADERS_SETTING_KEY, tenantId);
    cache.set(cacheKey, { at: Date.now(), headers: resolveSecurityHeaders(stored) });
  } catch {
    // Pre-setup or DB unavailable — keep any prior value; otherwise cache empty
    // so we don't hammer a failing DB on every request.
    if (!cache.has(cacheKey)) {
      cache.set(cacheKey, { at: Date.now(), headers: {} });
    }
  } finally {
    inFlight.delete(cacheKey);
  }
}

/**
 * Resolve the security headers to send, scoped to a tenant when provided.
 * Never throws and never blocks beyond a short cold-start timeout.
 */
export async function getSecurityHeaders(tenantId?: string): Promise<Record<string, string>> {
  const cacheKey = tenantId || 'default';
  const entry = cache.get(cacheKey);
  const isFresh = entry && Date.now() - entry.at < CACHE_TTL_MS;

  if (isFresh) {
    return entry.headers;
  }

  if (!inFlight.has(cacheKey)) {
    inFlight.set(cacheKey, refresh(cacheKey, tenantId));
  }

  // Stale value available: serve it now, let the refresh finish in the background.
  if (entry) {
    return entry.headers;
  }

  // Cold cache: wait briefly for the first read, then fall back to no headers.
  await Promise.race([
    inFlight.get(cacheKey),
    new Promise((resolve) => setTimeout(resolve, COLD_READ_TIMEOUT_MS)),
  ]);

  return cache.get(cacheKey)?.headers ?? {};
}

/** Apply the resolved security headers to a public page response. */
export async function applySecurityHeaders(
  response: NextResponse,
  tenantId?: string,
): Promise<void> {
  const headers = await getSecurityHeaders(tenantId);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
}

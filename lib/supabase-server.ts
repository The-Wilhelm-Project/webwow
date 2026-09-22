/**
 * Supabase Server Client — Webwow compatibility layer.
 *
 * Upstream ycode obtains a service-role supabase-js client here. Webwow has no
 * Supabase; `getSupabaseAdmin()` returns a client-shaped object backed by knex
 * (PostgREST-like queries), the local disk (storage), `auth.users` (auth) and a
 * no-op realtime implementation. See lib/webwow/* and docs/UPSTREAM-SYNC.md.
 *
 * The exported names mirror upstream so the rest of the code base stays unmodified.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { SupabaseClient } from '@supabase/supabase-js';
import { credentials } from './credentials';
import { parseSupabaseConfig } from './supabase-config-parser';
import type { SupabaseConfig, SupabaseCredentials } from '@/types';
import { createAdminClient } from '@/lib/webwow/server-client';
import { installFetchIntercept } from '@/lib/webwow/fetch-intercept';
import { getDb, testDb } from '@/lib/webwow/db';

// Make relative storage URLs fetchable for upstream server code (asset proxy, static export).
installFetchIntercept();

/**
 * Explicit tenant context for code running outside of a Next.js request
 * (e.g. fire-and-forget webhook processing where headers() is unavailable).
 */
export const tenantStore = new AsyncLocalStorage<string>();

/** Run an async function with an explicit tenant context. */
export function runWithTenantId<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantStore.run(tenantId, fn);
}

/**
 * Get "Supabase" credentials — synthesised from DATABASE_URL (see lib/credentials.ts).
 */
async function getSupabaseCredentials(): Promise<SupabaseCredentials | null> {
  const config = await credentials.get<SupabaseConfig>('supabase_config');
  if (!config) return null;

  try {
    return parseSupabaseConfig(config);
  } catch (error) {
    console.error('[getSupabaseCredentials] Failed to parse config:', error);
    return null;
  }
}

/** Alias kept for upstream compatibility. */
export const getSupabaseConfig = getSupabaseCredentials;

/**
 * Get the admin client (Webwow shim). Returns null only when DATABASE_URL is missing.
 */
export async function getSupabaseAdmin(_tenantId?: string): Promise<SupabaseClient | null> {
  // Re-assert the storage fetch interceptor (Next.js may have re-patched fetch since module load).
  installFetchIntercept();
  if (!(await credentials.exists())) {
    console.error('[getSupabaseAdmin] DATABASE_URL is not configured');
    return null;
  }
  return createAdminClient() as unknown as SupabaseClient;
}

/**
 * Test the database connection (upstream tested the Supabase project here).
 */
export async function testSupabaseConnection(
  _config: SupabaseConfig
): Promise<{ success: boolean; error?: string }> {
  return testDb();
}

/**
 * Get tenant ID from request headers.
 *
 * Base implementation: always returns null (single-tenant, no scoping needed).
 */
export async function getTenantIdFromHeaders(): Promise<string | null> {
  return null;
}

/**
 * Execute raw SQL query
 */
export async function executeSql(sql: string): Promise<{ success: boolean; error?: string }> {
  try {
    const db = await getDb();
    await db.raw(sql);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'SQL execution failed',
    };
  }
}

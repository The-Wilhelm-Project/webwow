/**
 * Route client — Webwow compatibility layer.
 *
 * Upstream creates a cookie-aware supabase-js client for route handlers.
 * Webwow returns the shim from lib/webwow/server-client.ts, whose `auth.*`
 * methods read/write the Webwow session cookie.
 *
 * Returns null only when DATABASE_URL is not configured.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { credentials } from './credentials';
import { createRouteClientShim } from '@/lib/webwow/server-client';

export async function createRouteClient(): Promise<SupabaseClient | null> {
  if (!(await credentials.exists())) return null;
  return createRouteClientShim() as unknown as SupabaseClient;
}

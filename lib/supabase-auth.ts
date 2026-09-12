/**
 * Server-side auth utilities for API routes — Webwow compatibility layer.
 *
 * Upstream verifies a Supabase session from cookies. Webwow verifies its own
 * signed session cookie and loads the user from `auth.users`
 * (see lib/webwow/auth-server.ts). The returned `client` behaves like a
 * cookie-aware supabase-js client (auth.updateUser, auth.signOut, ...).
 */

import type { SupabaseClient, User } from '@supabase/supabase-js';
import { getCurrentUserFromCookies, toSupabaseUser } from '@/lib/webwow/auth-server';
import { createRouteClientShim } from '@/lib/webwow/server-client';

interface AuthResult {
  user: User;
  client: SupabaseClient;
}

/**
 * Get the authenticated user and a client from request cookies.
 * Returns null if not authenticated.
 */
export async function getAuthUser(): Promise<AuthResult | null> {
  try {
    const current = await getCurrentUserFromCookies();
    if (!current) return null;

    return {
      user: toSupabaseUser(current.user),
      client: createRouteClientShim() as unknown as SupabaseClient,
    };
  } catch {
    return null;
  }
}

/**
 * Credentials (Webwow)
 *
 * Upstream ycode stores Supabase credentials here and every "is the app
 * configured?" check asks for `credentials.get('supabase_config')`.
 *
 * Webwow has no Supabase: the database comes from `DATABASE_URL`, auth and
 * storage are provided by the compatibility layer in `lib/webwow/*`. To keep
 * upstream code unmodified we synthesise a `SupabaseConfig` from `DATABASE_URL`
 * so all upstream checks see a "configured" project. `set()`/`del()` are no-ops
 * (the Supabase setup wizard is never shown).
 *
 * SERVER-ONLY: never import from client code.
 */

import 'server-only';

import type { SupabaseConfig } from '@/types';

/** Placeholder values — never sent anywhere, only used to satisfy upstream types. */
export const LOCAL_ANON_KEY = 'webwow-local';
export const LOCAL_SERVICE_ROLE_KEY = 'webwow-local';
export const LOCAL_SUPABASE_URL = 'http://webwow.local';

function getDatabaseUrl(): string | null {
  const url = process.env.DATABASE_URL?.trim();
  return url ? url : null;
}

/**
 * Build a SupabaseConfig-shaped object from DATABASE_URL.
 * `connectionUrl` keeps the real password; `dbPassword` is extracted for the
 * upstream parser which only *replaces* a `[YOUR-PASSWORD]` placeholder.
 */
function getLocalConfig(): SupabaseConfig | null {
  const url = getDatabaseUrl();
  if (!url) return null;

  let dbPassword = '';
  try {
    dbPassword = decodeURIComponent(new URL(url).password || '');
  } catch {
    // Leave empty — the parser tolerates it.
  }

  return {
    anonKey: LOCAL_ANON_KEY,
    serviceRoleKey: LOCAL_SERVICE_ROLE_KEY,
    connectionUrl: url,
    dbPassword,
    supabaseUrl: LOCAL_SUPABASE_URL,
  };
}

/**
 * Get a value from storage.
 * Only `supabase_config` is known; it is derived from DATABASE_URL.
 */
export async function get<T = unknown>(key: string): Promise<T | null> {
  if (key === 'supabase_config') {
    return getLocalConfig() as T;
  }
  return null;
}

/**
 * Set a value in storage — no-op in Webwow (configuration is env based).
 */
export async function set(_key: string, _value: unknown): Promise<void> {
  console.warn('[credentials.set] Ignored: Webwow is configured via environment variables (DATABASE_URL).');
}

/**
 * Delete a value from storage — no-op in Webwow.
 */
export async function del(_key: string): Promise<void> {
  // nothing to delete
}

/**
 * Check if the database is configured.
 */
export async function exists(): Promise<boolean> {
  return getDatabaseUrl() !== null;
}

/** Convenience accessor used by Webwow code. */
export function getDatabaseUrlOrThrow(): string {
  const url = getDatabaseUrl();
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  return url;
}

export const credentials = {
  get,
  set,
  del,
  exists,
};

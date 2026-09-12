/**
 * Browser client — Webwow compatibility layer.
 *
 * Upstream code calls `createBrowserClient()` / `createClient()` and then uses
 * `supabase.auth.*` (session, sign in/out, profile updates) and
 * `supabase.channel()` (realtime collaboration). Webwow provides an object with
 * the same shape:
 *  - auth methods call the Webwow auth routes under /ycode/api/webwow/auth/*
 *    (cookie based sessions)
 *  - realtime channels are no-ops (single-server mode)
 *
 * Both factories always resolve to a client (never null).
 */

import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import { createNoopRealtime } from '@/lib/webwow/realtime';

const AUTH_BASE = '/ycode/api/webwow/auth';

interface ClientAuthError {
  message: string;
  status: number;
  code?: string;
  name: string;
}

type AuthResponse<T> = { data: T; error: ClientAuthError | null };

function makeError(message: string, status = 400, code?: string): ClientAuthError {
  return { message, status, code, name: 'AuthApiError' };
}

async function request<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: { data?: T; error?: string; code?: string } }> {
  const response = await fetch(`${AUTH_BASE}${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  let body: { data?: T; error?: string; code?: string } = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { ok: response.ok, status: response.status, body };
}

type SessionPayload = { session: Session | null; user: User | null };

async function fetchSession(): Promise<SessionPayload> {
  try {
    const { ok, body } = await request<SessionPayload>('/session', { method: 'GET' });
    if (!ok || !body.data) return { session: null, user: null };
    return body.data;
  } catch {
    return { session: null, user: null };
  }
}

type AuthStateCallback = (event: string, session: Session | null) => void;

const listeners = new Set<AuthStateCallback>();

function notify(event: string, session: Session | null): void {
  for (const listener of listeners) {
    try {
      listener(event, session);
    } catch (error) {
      console.error('[webwow auth] listener failed:', error);
    }
  }
}

function createBrowserAuth() {
  return {
    async getSession(): Promise<AuthResponse<{ session: Session | null }>> {
      const { session } = await fetchSession();
      return { data: { session }, error: null };
    },

    async getUser(): Promise<AuthResponse<{ user: User | null }>> {
      const { user } = await fetchSession();
      if (!user) return { data: { user: null }, error: makeError('Auth session missing!', 400, 'session_not_found') };
      return { data: { user }, error: null };
    },

    async refreshSession(): Promise<AuthResponse<{ session: Session | null; user: User | null }>> {
      const payload = await fetchSession();
      return { data: payload, error: null };
    },

    onAuthStateChange(callback: AuthStateCallback) {
      listeners.add(callback);
      fetchSession().then(({ session }) => callback('INITIAL_SESSION', session)).catch(() => undefined);
      return {
        data: {
          subscription: {
            id: `webwow-${listeners.size}`,
            callback,
            unsubscribe: () => {
              listeners.delete(callback);
            },
          },
        },
      };
    },

    async signInWithPassword(credentials: { email?: string; password: string }): Promise<AuthResponse<{ user: User | null; session: Session | null }>> {
      try {
        const { ok, status, body } = await request<SessionPayload>('/login', {
          method: 'POST',
          body: JSON.stringify({ email: credentials.email, password: credentials.password }),
        });
        if (!ok || !body.data) {
          return { data: { user: null, session: null }, error: makeError(body.error ?? 'Invalid login credentials', status, body.code) };
        }
        notify('SIGNED_IN', body.data.session);
        return { data: body.data, error: null };
      } catch (error) {
        return { data: { user: null, session: null }, error: makeError(error instanceof Error ? error.message : 'Sign in failed', 500) };
      }
    },

    async signUp(credentials: { email: string; password: string; options?: { data?: Record<string, unknown>; emailRedirectTo?: string } }): Promise<AuthResponse<{ user: User | null; session: Session | null }>> {
      try {
        const { ok, status, body } = await request<SessionPayload>('/signup', {
          method: 'POST',
          body: JSON.stringify({ email: credentials.email, password: credentials.password, data: credentials.options?.data ?? {} }),
        });
        if (!ok || !body.data) {
          return { data: { user: null, session: null }, error: makeError(body.error ?? 'Sign up failed', status, body.code) };
        }
        notify('SIGNED_IN', body.data.session);
        return { data: body.data, error: null };
      } catch (error) {
        return { data: { user: null, session: null }, error: makeError(error instanceof Error ? error.message : 'Sign up failed', 500) };
      }
    },

    async signOut(_options?: { scope?: string }): Promise<{ error: ClientAuthError | null }> {
      try {
        await request('/logout', { method: 'POST' });
        notify('SIGNED_OUT', null);
        return { error: null };
      } catch (error) {
        return { error: makeError(error instanceof Error ? error.message : 'Sign out failed', 500) };
      }
    },

    async updateUser(attributes: { email?: string; password?: string; data?: Record<string, unknown> }): Promise<AuthResponse<{ user: User | null }>> {
      try {
        const { ok, status, body } = await request<{ user: User | null }>('/update-user', {
          method: 'POST',
          body: JSON.stringify(attributes),
        });
        if (!ok || !body.data) {
          return { data: { user: null }, error: makeError(body.error ?? 'Update failed', status, body.code) };
        }
        const { session } = await fetchSession();
        notify('USER_UPDATED', session);
        return { data: body.data, error: null };
      } catch (error) {
        return { data: { user: null }, error: makeError(error instanceof Error ? error.message : 'Update failed', 500) };
      }
    },

    async setSession(_tokens: { access_token: string; refresh_token: string }): Promise<AuthResponse<{ session: Session | null; user: User | null }>> {
      return { data: { session: null, user: null }, error: makeError('Invitation links are not supported by Webwow', 501, 'not_supported') };
    },

    async exchangeCodeForSession(_code: string): Promise<AuthResponse<{ session: Session | null; user: User | null }>> {
      return { data: { session: null, user: null }, error: makeError('OAuth is not supported by Webwow', 501, 'not_supported') };
    },

    async resetPasswordForEmail(_email: string): Promise<AuthResponse<null>> {
      return { data: null, error: makeError('Password reset e-mails are not supported by Webwow. Ask an owner to reset the password.', 501, 'not_supported') };
    },
  };
}

function createClientShim() {
  const realtime = createNoopRealtime();
  const client = {
    __webwow: true as const,
    auth: createBrowserAuth(),
    channel: realtime.channel,
    removeChannel: realtime.removeChannel,
    removeAllChannels: realtime.removeAllChannels,
    getChannels: realtime.getChannels,
    realtime,
    storage: {
      from: (bucket: string) => ({
        getPublicUrl: (objectPath: string) => ({
          data: { publicUrl: `/storage/v1/object/public/${encodeURIComponent(bucket)}/${objectPath.split('/').map(encodeURIComponent).join('/')}` },
        }),
      }),
    },
    from: () => {
      throw new Error('Database queries from the browser are not supported by Webwow');
    },
  };
  return client as unknown as SupabaseClient;
}

let browserClient: SupabaseClient | null = null;

/** Reset cached client (kept for upstream compatibility). */
export function resetBrowserClient(): void {
  browserClient = null;
}

function getOrCreateClient(): SupabaseClient {
  if (!browserClient) browserClient = createClientShim();
  return browserClient;
}

/**
 * Get browser client (null-safe signature kept for upstream compatibility; never null in Webwow).
 */
export async function createBrowserClient(): Promise<SupabaseClient | null> {
  return getOrCreateClient();
}

/**
 * Get browser client (throws-if-unconfigured signature kept for upstream compatibility).
 */
export async function createClient(): Promise<SupabaseClient> {
  return getOrCreateClient();
}

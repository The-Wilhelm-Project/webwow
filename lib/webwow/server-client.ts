/**
 * Supabase-client-shaped objects for server code (Webwow compatibility layer).
 *
 * `createAdminClient()`  – what `getSupabaseAdmin()` returns: PostgREST-like
 *                          query builder on knex, local storage, no-op realtime,
 *                          `auth.admin.*` on `auth.users`.
 * `createRouteClient()`  – what `createRouteClient()` / `getAuthUser().client`
 *                          return: same, plus cookie-aware `auth.*` methods
 *                          (getSession, signInWithPassword, updateUser, ...).
 *
 * Everything is typed loosely and cast to `SupabaseClient` at the seam modules.
 */

import 'server-only';

import type { Session, User } from '@supabase/supabase-js';
import { getDb } from '@/lib/webwow/db';
import { PostgrestQueryBuilder, createRpcCall } from '@/lib/webwow/postgrest';
import { createStorageApi } from '@/lib/webwow/storage';
import { createNoopRealtime } from '@/lib/webwow/realtime';
import {
  authError,
  authenticateWithPassword,
  clearSessionCookie,
  countUsers,
  createUser,
  deleteUser,
  ensureBootstrapAdmin,
  findUserById,
  getCurrentUserFromCookies,
  listUserRows,
  setSessionCookie,
  toSupabaseSession,
  toSupabaseUser,
  updateUser,
  type AuthError,
  type UpdateUserInput,
} from '@/lib/webwow/auth-server';

type AuthResponse<T> = { data: T; error: AuthError | null };

function errorResult<T>(error: unknown, empty: T): AuthResponse<T> {
  if (error && typeof error === 'object' && 'status' in (error as AuthError)) {
    return { data: empty, error: error as AuthError };
  }
  return { data: empty, error: authError(error instanceof Error ? error.message : String(error), 500) };
}

// ---------------------------------------------------------------------------
// auth.admin
// ---------------------------------------------------------------------------

function createAdminAuthApi() {
  return {
    async listUsers(options?: { page?: number; perPage?: number }): Promise<AuthResponse<{ users: User[]; aud: string; total?: number; nextPage?: number | null; lastPage?: number }>> {
      try {
        await ensureBootstrapAdmin();
        const { users, total } = await listUserRows(options);
        const perPage = options?.perPage ?? 50;
        const page = options?.page ?? 1;
        return {
          data: {
            users: users.map(toSupabaseUser),
            aud: 'authenticated',
            total,
            nextPage: page * perPage < total ? page + 1 : null,
            lastPage: Math.max(1, Math.ceil(total / perPage)),
          },
          error: null,
        };
      } catch (error) {
        return errorResult(error, { users: [], aud: 'authenticated' });
      }
    },

    async getUserById(id: string): Promise<AuthResponse<{ user: User | null }>> {
      try {
        const row = await findUserById(id);
        if (!row) return { data: { user: null }, error: authError('User not found', 404, 'user_not_found') };
        return { data: { user: toSupabaseUser(row) }, error: null };
      } catch (error) {
        return errorResult(error, { user: null });
      }
    },

    async createUser(attributes: { email: string; password?: string; email_confirm?: boolean; user_metadata?: Record<string, unknown>; app_metadata?: Record<string, unknown>; role?: string }): Promise<AuthResponse<{ user: User | null }>> {
      try {
        const row = await createUser(attributes);
        return { data: { user: toSupabaseUser(row) }, error: null };
      } catch (error) {
        return errorResult(error, { user: null });
      }
    },

    async updateUserById(id: string, attributes: UpdateUserInput): Promise<AuthResponse<{ user: User | null }>> {
      try {
        const row = await updateUser(id, attributes);
        return { data: { user: toSupabaseUser(row) }, error: null };
      } catch (error) {
        return errorResult(error, { user: null });
      }
    },

    async deleteUser(id: string): Promise<AuthResponse<{ user: User | null }>> {
      try {
        const row = await deleteUser(id);
        if (!row) return { data: { user: null }, error: authError('User not found', 404, 'user_not_found') };
        return { data: { user: toSupabaseUser(row) }, error: null };
      } catch (error) {
        return errorResult(error, { user: null });
      }
    },

    async inviteUserByEmail(email: string, _options?: Record<string, unknown>): Promise<AuthResponse<{ user: User | null }>> {
      void email;
      return {
        data: { user: null },
        error: authError(
          'Webwow does not send e-mail invitations. Create the account with `npm run webwow:user -- create <email> <password> [role]` and share the credentials directly.',
          501,
          'not_supported',
        ),
      };
    },

    async generateLink(): Promise<AuthResponse<{ properties: null; user: null }>> {
      return { data: { properties: null, user: null }, error: authError('generateLink is not supported by Webwow', 501, 'not_supported') };
    },
  };
}

// ---------------------------------------------------------------------------
// auth (cookie aware)
// ---------------------------------------------------------------------------

function createSessionAuthApi() {
  const admin = createAdminAuthApi();

  const currentSession = async (): Promise<Session | null> => {
    const current = await getCurrentUserFromCookies();
    if (!current) return null;
    return toSupabaseSession(toSupabaseUser(current.user), current.token, current.expiresAt);
  };

  return {
    admin,

    async getSession(): Promise<AuthResponse<{ session: Session | null }>> {
      try {
        return { data: { session: await currentSession() }, error: null };
      } catch (error) {
        return errorResult(error, { session: null });
      }
    },

    async getUser(_jwt?: string): Promise<AuthResponse<{ user: User | null }>> {
      try {
        const session = await currentSession();
        if (!session) return { data: { user: null }, error: authError('Auth session missing!', 400, 'session_not_found') };
        return { data: { user: session.user }, error: null };
      } catch (error) {
        return errorResult(error, { user: null });
      }
    },

    async refreshSession(): Promise<AuthResponse<{ session: Session | null; user: User | null }>> {
      const session = await currentSession();
      return { data: { session, user: session?.user ?? null }, error: null };
    },

    async signInWithPassword(credentials: { email?: string; password: string; phone?: string }): Promise<AuthResponse<{ user: User | null; session: Session | null }>> {
      try {
        const result = await authenticateWithPassword(credentials.email ?? '', credentials.password);
        if ('error' in result) return { data: { user: null, session: null }, error: result.error };
        const user = toSupabaseUser(result.user);
        const { token, expiresAt } = await setSessionCookie(result.user.id);
        return { data: { user, session: toSupabaseSession(user, token, expiresAt) }, error: null };
      } catch (error) {
        return errorResult(error, { user: null, session: null });
      }
    },

    async signUp(credentials: { email: string; password: string; options?: { data?: Record<string, unknown> } }): Promise<AuthResponse<{ user: User | null; session: Session | null }>> {
      try {
        await ensureBootstrapAdmin();
        const existing = await countUsers();
        // Self sign-up is only allowed for the very first account (the owner).
        if (existing > 0) {
          return { data: { user: null, session: null }, error: authError('Signups are disabled. Ask an owner or admin to create your account.', 403, 'signup_disabled') };
        }
        const row = await createUser({ email: credentials.email, password: credentials.password, role: 'owner', user_metadata: credentials.options?.data ?? {} });
        const user = toSupabaseUser(row);
        const { token, expiresAt } = await setSessionCookie(row.id);
        return { data: { user, session: toSupabaseSession(user, token, expiresAt) }, error: null };
      } catch (error) {
        return errorResult(error, { user: null, session: null });
      }
    },

    async signOut(_options?: { scope?: string }): Promise<{ error: AuthError | null }> {
      try {
        await clearSessionCookie();
        return { error: null };
      } catch (error) {
        return { error: authError(error instanceof Error ? error.message : String(error), 500) };
      }
    },

    async updateUser(attributes: UpdateUserInput): Promise<AuthResponse<{ user: User | null }>> {
      try {
        const current = await getCurrentUserFromCookies();
        if (!current) return { data: { user: null }, error: authError('Auth session missing!', 401, 'session_not_found') };
        const row = await updateUser(current.user.id, attributes);
        return { data: { user: toSupabaseUser(row) }, error: null };
      } catch (error) {
        return errorResult(error, { user: null });
      }
    },

    async setSession(_tokens: { access_token: string; refresh_token: string }): Promise<AuthResponse<{ session: Session | null; user: User | null }>> {
      return { data: { session: null, user: null }, error: authError('setSession is not supported by Webwow (no token-based invites)', 501, 'not_supported') };
    },

    async exchangeCodeForSession(_code: string): Promise<AuthResponse<{ session: Session | null; user: User | null }>> {
      return { data: { session: null, user: null }, error: authError('OAuth code exchange is not supported by Webwow', 501, 'not_supported') };
    },

    onAuthStateChange(_callback: (event: string, session: Session | null) => void) {
      return { data: { subscription: { id: 'webwow', callback: _callback, unsubscribe: () => undefined } } };
    },
  };
}

// ---------------------------------------------------------------------------
// Client assembly
// ---------------------------------------------------------------------------

export interface WebwowServerClient {
  from: (table: string) => PostgrestQueryBuilder;
  rpc: (name: string, params?: Record<string, unknown>) => ReturnType<typeof createRpcCall>;
  schema: (name: string) => WebwowServerClient;
  storage: ReturnType<typeof createStorageApi>;
  auth: ReturnType<typeof createSessionAuthApi>;
  channel: ReturnType<typeof createNoopRealtime>['channel'];
  removeChannel: ReturnType<typeof createNoopRealtime>['removeChannel'];
  removeAllChannels: ReturnType<typeof createNoopRealtime>['removeAllChannels'];
  getChannels: ReturnType<typeof createNoopRealtime>['getChannels'];
  realtime: ReturnType<typeof createNoopRealtime>;
  /** Marker so callers can detect the shim. */
  readonly __webwow: true;
}

/**
 * Lazily-resolving builder: `client.from(...)` is synchronous in supabase-js, but
 * our knex instance is obtained asynchronously. The builder captures a promise
 * for the knex instance and resolves it on execution.
 *
 * IMPORTANT: PostgrestFilterBuilder is thenable, so it must never be the direct
 * resolution value of a Promise (the Promise would "adopt" it and execute the
 * query too early). It is therefore always wrapped in `{ fb }`.
 */
class LazyQueryBuilder {
  constructor(private readonly table: string) {}

  private async builder(): Promise<PostgrestQueryBuilder> {
    return new PostgrestQueryBuilder(await getDb(), this.table);
  }

  select(...args: Parameters<PostgrestQueryBuilder['select']>) {
    return deferred(this.builder().then((b) => ({ fb: b.select(...args) })));
  }

  insert(...args: Parameters<PostgrestQueryBuilder['insert']>) {
    return deferred(this.builder().then((b) => ({ fb: b.insert(...args) })));
  }

  upsert(...args: Parameters<PostgrestQueryBuilder['upsert']>) {
    return deferred(this.builder().then((b) => ({ fb: b.upsert(...args) })));
  }

  update(...args: Parameters<PostgrestQueryBuilder['update']>) {
    return deferred(this.builder().then((b) => ({ fb: b.update(...args) })));
  }

  delete(...args: Parameters<PostgrestQueryBuilder['delete']>) {
    return deferred(this.builder().then((b) => ({ fb: b.delete(...args) })));
  }
}

/**
 * Wrap a promise of a filter builder in a proxy that records chained calls
 * (`.eq().is().order()...`) and replays them once the builder is available.
 * The proxy is thenable, so `await client.from('x').select('*').eq(...)` works.
 */
function deferred(builderPromise: Promise<{ fb: any }>): any {
  const calls: Array<{ method: string; args: unknown[] }> = [];

  // Returning the (thenable) builder from an async function makes the returned
  // promise adopt it, i.e. execute the query — exactly what `await proxy` needs.
  const execute = async () => {
    const { fb } = await builderPromise;
    let builder = fb;
    for (const call of calls) {
      if (typeof builder[call.method] !== 'function') {
        throw new Error(`Webwow PostgREST shim: unsupported builder method '${call.method}'`);
      }
      builder = builder[call.method](...call.args);
    }
    return builder;
  };

  const proxy: any = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (onfulfilled?: (value: unknown) => unknown, onrejected?: (reason: unknown) => unknown) =>
            execute().then(onfulfilled, onrejected);
        }
        if (property === 'catch') {
          return (onrejected?: (reason: unknown) => unknown) => execute().catch(onrejected);
        }
        if (property === 'finally') {
          return (onfinally?: () => void) => execute().finally(onfinally);
        }
        if (typeof property === 'symbol' || property === 'toJSON' || property === 'constructor') return undefined;
        return (...args: unknown[]) => {
          calls.push({ method: String(property), args });
          return proxy;
        };
      },
    },
  );

  return proxy;
}

let cachedDbPromise: ReturnType<typeof getDb> | null = null;
function dbPromise() {
  if (!cachedDbPromise) cachedDbPromise = getDb();
  return cachedDbPromise;
}

function assembleClient(auth: ReturnType<typeof createSessionAuthApi>): WebwowServerClient {
  const realtime = createNoopRealtime();
  const storage = createStorageApi();

  const client: WebwowServerClient = {
    __webwow: true,
    from: (table: string) => new LazyQueryBuilder(table) as unknown as PostgrestQueryBuilder,
    rpc: (name: string, params?: Record<string, unknown>) => {
      // rpc() must return synchronously (used as a value marker for 'increment');
      // wrap the async knex lookup in a thenable.
      const thenable: any = {
        then(onfulfilled?: (value: unknown) => unknown, onrejected?: (reason: unknown) => unknown) {
          return dbPromise().then((db) => createRpcCall(db, name, params)).then(onfulfilled, onrejected);
        },
      };
      if (name === 'increment') {
        thenable.__webwowRpc = 'increment';
        thenable.x = Number(params?.x ?? 1);
      }
      return thenable;
    },
    schema: () => client,
    storage,
    auth,
    channel: realtime.channel,
    removeChannel: realtime.removeChannel,
    removeAllChannels: realtime.removeAllChannels,
    getChannels: realtime.getChannels,
    realtime,
  };

  return client;
}

/** Admin client — equivalent of the Supabase service-role client (cheap to create; not cached so dev HMR never serves stale closures). */
export function createAdminClient(): WebwowServerClient {
  return assembleClient(createSessionAuthApi());
}

/** Route client — cookie aware (same capabilities). */
export function createRouteClientShim(): WebwowServerClient {
  return assembleClient(createSessionAuthApi());
}

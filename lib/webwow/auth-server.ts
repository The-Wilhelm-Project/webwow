/**
 * Webwow authentication (server side).
 *
 * Replaces Supabase Auth with a small local implementation:
 *  - users live in `auth.users` (created by the Webwow bootstrap migration, same
 *    column names Supabase uses so upstream migrations keep working)
 *  - passwords are hashed with scrypt
 *  - sessions are signed cookies (`webwow_session`), verified here and in proxy.ts
 *  - `ADMIN_EMAIL` / `ADMIN_PASSWORD` bootstrap the first owner account
 *
 * The functions return Supabase-shaped `User` / `Session` objects so the
 * unmodified upstream code (roles, profile routes, stores) keeps working.
 */

import 'server-only';

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { hashPassword, verifyPasswordHash } from '@/lib/webwow/password';
import type { Session, User } from '@supabase/supabase-js';
import { getDb } from '@/lib/webwow/db';
import { getSessionSecret } from '@/lib/webwow/secret';

export const SESSION_COOKIE_NAME = 'webwow_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const DEFAULT_ADMIN_EMAIL = 'admin@webwow.local';

export { hashPassword, verifyPasswordHash };

export interface AuthError {
  message: string;
  status: number;
  code?: string;
  name?: string;
}

export interface UserRow {
  id: string;
  email: string | null;
  encrypted_password: string | null;
  raw_app_meta_data: Record<string, unknown> | null;
  raw_user_meta_data: Record<string, unknown> | null;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
  created_at: string;
  updated_at: string;
}

export function authError(message: string, status = 400, code?: string): AuthError {
  return { message, status, code, name: 'AuthApiError' };
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

interface SessionPayload {
  uid: string;
  iat: number;
  exp: number;
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function createSessionToken(userId: string, ttlSeconds = SESSION_TTL_SECONDS): { token: string; expiresAt: number } {
  const iat = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { uid: userId, iat, exp: iat + ttlSeconds };
  const encoded = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', getSessionSecret()).update(encoded).digest('hex');
  return { token: `${encoded}.${signature}`, expiresAt: payload.exp };
}

export function verifySessionToken(token: string | undefined | null): SessionPayload | null {
  if (!token) return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  const expected = createHmac('sha256', getSessionSecret()).update(encoded).digest('hex');
  if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try {
    const payload = JSON.parse(fromBase64url(encoded)) as SessionPayload;
    if (!payload.uid || typeof payload.exp !== 'number') return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toSupabaseUser(row: UserRow): User {
  const appMetadata = { provider: 'email', providers: ['email'], ...(row.raw_app_meta_data ?? {}) };
  return {
    id: row.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: row.email ?? undefined,
    email_confirmed_at: row.email_confirmed_at ?? undefined,
    phone: '',
    confirmed_at: row.email_confirmed_at ?? undefined,
    last_sign_in_at: row.last_sign_in_at ?? undefined,
    app_metadata: appMetadata,
    user_metadata: row.raw_user_meta_data ?? {},
    identities: [],
    created_at: row.created_at,
    updated_at: row.updated_at,
    is_anonymous: false,
    factors: [],
  } as User;
}

export function toSupabaseSession(user: User, token: string, expiresAt: number): Session {
  return {
    access_token: token,
    refresh_token: '',
    token_type: 'bearer',
    expires_in: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
    expires_at: expiresAt,
    user,
  } as Session;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  if (!id) return null;
  const db = await getDb();
  const row = await db('auth.users').where('id', id).first();
  return (row as UserRow | undefined) ?? null;
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const db = await getDb();
  const row = await db('auth.users').whereRaw('lower(email) = ?', [normalizeEmail(email)]).first();
  return (row as UserRow | undefined) ?? null;
}

export async function listUserRows(options?: { page?: number; perPage?: number }): Promise<{ users: UserRow[]; total: number }> {
  const db = await getDb();
  const perPage = Math.max(1, Math.min(options?.perPage ?? 50, 1000));
  const page = Math.max(1, options?.page ?? 1);
  const rows = await db('auth.users').orderBy('created_at', 'asc').limit(perPage).offset((page - 1) * perPage);
  const countRow = await db('auth.users').count<{ count: number | string }[]>('* as count').first();
  return { users: rows as UserRow[], total: countRow ? Number(countRow.count) : rows.length };
}

export async function countUsers(): Promise<number> {
  const db = await getDb();
  const row = await db('auth.users').count<{ count: number | string }[]>('* as count').first();
  return row ? Number(row.count) : 0;
}

export interface CreateUserInput {
  email: string;
  password?: string | null;
  role?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
  email_confirm?: boolean;
}

export async function createUser(input: CreateUserInput): Promise<UserRow> {
  const db = await getDb();
  const email = normalizeEmail(input.email);
  if (!email || !email.includes('@')) {
    throw authError('A valid email address is required', 422, 'validation_failed');
  }
  if (await findUserByEmail(email)) {
    throw authError('A user with this email address has already been registered', 422, 'email_exists');
  }
  if (input.password !== undefined && input.password !== null && input.password.length < 6) {
    throw authError('Password should be at least 6 characters', 422, 'weak_password');
  }

  const now = new Date().toISOString();
  const row: UserRow = {
    id: randomUUID(),
    email,
    encrypted_password: input.password ? hashPassword(input.password) : null,
    raw_app_meta_data: { provider: 'email', providers: ['email'], ...(input.app_metadata ?? {}), ...(input.role ? { role: input.role } : {}) },
    raw_user_meta_data: input.user_metadata ?? {},
    email_confirmed_at: input.email_confirm === false ? null : now,
    last_sign_in_at: null,
    created_at: now,
    updated_at: now,
  };

  await db('auth.users').insert({
    ...row,
    raw_app_meta_data: JSON.stringify(row.raw_app_meta_data),
    raw_user_meta_data: JSON.stringify(row.raw_user_meta_data),
  });

  return row;
}

export interface UpdateUserInput {
  email?: string;
  password?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
  /** supabase-js `updateUser({ data })` alias for user_metadata */
  data?: Record<string, unknown>;
  email_confirm?: boolean;
}

export async function updateUser(id: string, input: UpdateUserInput): Promise<UserRow> {
  const db = await getDb();
  const existing = await findUserById(id);
  if (!existing) throw authError('User not found', 404, 'user_not_found');

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (input.email !== undefined) {
    const email = normalizeEmail(input.email);
    if (!email.includes('@')) throw authError('A valid email address is required', 422, 'validation_failed');
    const other = await findUserByEmail(email);
    if (other && other.id !== id) throw authError('A user with this email address has already been registered', 422, 'email_exists');
    patch.email = email;
  }
  if (input.password !== undefined) {
    if (input.password.length < 6) throw authError('Password should be at least 6 characters', 422, 'weak_password');
    patch.encrypted_password = hashPassword(input.password);
  }
  const userMetadata = input.user_metadata ?? input.data;
  if (userMetadata !== undefined) {
    patch.raw_user_meta_data = JSON.stringify({ ...(existing.raw_user_meta_data ?? {}), ...userMetadata });
  }
  if (input.app_metadata !== undefined) {
    patch.raw_app_meta_data = JSON.stringify({ ...(existing.raw_app_meta_data ?? {}), ...input.app_metadata });
  }
  if (input.email_confirm) {
    patch.email_confirmed_at = new Date().toISOString();
  }

  await db('auth.users').where('id', id).update(patch);
  return (await findUserById(id))!;
}

export async function deleteUser(id: string): Promise<UserRow | null> {
  const db = await getDb();
  const existing = await findUserById(id);
  if (!existing) return null;
  await db('auth.users').where('id', id).delete();
  return existing;
}

export async function touchLastSignIn(id: string): Promise<void> {
  const db = await getDb();
  await db('auth.users').where('id', id).update({ last_sign_in_at: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Bootstrap from environment
// ---------------------------------------------------------------------------

const globalForBootstrap = globalThis as unknown as { __webwowAdminBootstrapped?: boolean };

export function getAdminEmailFromEnv(): string {
  return normalizeEmail(process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL);
}

/**
 * Create the owner account from ADMIN_EMAIL/ADMIN_PASSWORD when the users
 * table is empty. Idempotent and cheap after the first successful run.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  if (globalForBootstrap.__webwowAdminBootstrapped) return;
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return;

  try {
    if ((await countUsers()) > 0) {
      globalForBootstrap.__webwowAdminBootstrapped = true;
      return;
    }
    await createUser({ email: getAdminEmailFromEnv(), password, role: 'owner', user_metadata: { full_name: 'Admin', display_name: 'Admin' } });
    globalForBootstrap.__webwowAdminBootstrapped = true;
    console.log(`[webwow] Created owner account ${getAdminEmailFromEnv()} from ADMIN_EMAIL/ADMIN_PASSWORD`);
  } catch (error) {
    // Table may not exist yet (migrations pending) — retry on the next call.
    console.warn('[webwow] Could not bootstrap admin user yet:', error instanceof Error ? error.message : error);
  }
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

export async function authenticateWithPassword(email: string, password: string): Promise<{ user: UserRow } | { error: AuthError }> {
  await ensureBootstrapAdmin();
  const user = await findUserByEmail(email);
  const invalid = { error: authError('Invalid login credentials', 400, 'invalid_credentials') };
  if (!user) return invalid;

  let ok = verifyPasswordHash(password, user.encrypted_password);

  // Recovery path: the env password always works for the owner configured via ADMIN_EMAIL.
  if (!ok && process.env.ADMIN_PASSWORD && normalizeEmail(user.email ?? '') === getAdminEmailFromEnv()) {
    const envPassword = Buffer.from(process.env.ADMIN_PASSWORD);
    const given = Buffer.from(password);
    ok = envPassword.length === given.length && timingSafeEqual(envPassword, given);
  }

  if (!ok) return invalid;
  await touchLastSignIn(user.id);
  return { user };
}

// ---------------------------------------------------------------------------
// Cookies (Next.js request context)
// ---------------------------------------------------------------------------

/**
 * Whether the session cookie should carry the `Secure` flag.
 *
 * Self-hosted Webwow is often reached over plain http on a LAN or behind a
 * reverse proxy. A `Secure` cookie is silently dropped by browsers on http
 * (except localhost), which would make every login "not stick". So the flag
 * follows the actual request protocol (`x-forwarded-proto` from a reverse
 * proxy, otherwise the request URL) and can be forced with
 * `WEBWOW_SECURE_COOKIES=true|false`.
 */
export async function isSecureRequest(): Promise<boolean> {
  const forced = process.env.WEBWOW_SECURE_COOKIES;
  if (forced === 'true' || forced === '1') return true;
  if (forced === 'false' || forced === '0') return false;
  try {
    const { headers } = await import('next/headers');
    const requestHeaders = await headers();
    const proto = requestHeaders.get('x-forwarded-proto')?.split(',')[0].trim().toLowerCase();
    if (proto) return proto === 'https';
    const origin = requestHeaders.get('origin') || requestHeaders.get('referer') || '';
    if (origin.startsWith('https://')) return true;
    if (origin.startsWith('http://')) return false;
  } catch {
    // outside a request context
  }
  return false;
}

export function sessionCookieOptions(expiresAt: number, secure = false) {
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
    expires: new Date(expiresAt * 1000),
  };
}

/** Read the session cookie of the current request and resolve the user. */
export async function getCurrentUserFromCookies(): Promise<{ user: UserRow; token: string; expiresAt: number } | null> {
  try {
    const { cookies } = await import('next/headers');
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    const payload = verifySessionToken(token);
    if (!payload || !token) return null;
    const user = await findUserById(payload.uid);
    if (!user) return null;
    return { user, token, expiresAt: payload.exp };
  } catch {
    return null;
  }
}

/** Set the session cookie for the current request (route handlers / server actions only). */
export async function setSessionCookie(userId: string): Promise<{ token: string; expiresAt: number }> {
  const session = createSessionToken(userId);
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  cookieStore.set({ ...sessionCookieOptions(session.expiresAt, await isSecureRequest()), value: session.token });
  return session;
}

export async function clearSessionCookie(): Promise<void> {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  cookieStore.set({ ...sessionCookieOptions(0, await isSecureRequest()), value: '', expires: new Date(0) });
}

/**
 * Webwow authentication (server side).
 *
 * Replaces Supabase Auth with a small local implementation:
 *  - users live in `auth.users` (created by the Webwow bootstrap migration, same
 *    column names Supabase uses so upstream migrations keep working)
 *  - passwords are hashed with scrypt
 *  - sessions are signed cookies (`webwow_session`), verified here and in proxy.ts
 *  - `ADMIN_EMAIL` / `ADMIN_PASSWORD` bootstrap the first owner account
 *  - users are GLOBAL (multi-site): every query goes through `getMainDb()`,
 *    never through the site-aware pool (docs/MULTISITE.md)
 *  - `?edit` editor sessions (docs/EDITOR.md) carry `kind: 'editor'`, the pinned
 *    `site` and the site's `editor_password_version` (`pv`); they map to a
 *    synthetic `editor@<slug>.sites.webwow.local` account that can never log in
 *    with a password and can never be re-purposed
 *
 * The functions return Supabase-shaped `User` / `Session` objects so the
 * unmodified upstream code (roles, profile routes, stores) keeps working.
 */

import 'server-only';

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { hashPassword, verifyPasswordHash } from '@/lib/webwow/password';
import type { Session, User } from '@supabase/supabase-js';
import { getMainDb } from '@/lib/webwow/sites/main-db';
import { getSite } from '@/lib/webwow/sites/registry';
import { SITE_COOKIE } from '@/lib/webwow/sites/resolve';
import { SITE_ID_RE } from '@/lib/webwow/sites/ids';
import { getSessionSecret } from '@/lib/webwow/secret';

export const SESSION_COOKIE_NAME = 'webwow_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
/** `?edit` editor sessions: 12 hours, no renewal (docs/EDITOR.md). */
export const EDITOR_SESSION_TTL_SECONDS = 60 * 60 * 12;
export const SITE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const DEFAULT_ADMIN_EMAIL = 'admin@webwow.local';
/** Synthetic editor accounts live under this domain: `editor@<slug>.sites.webwow.local`. */
export const EDITOR_EMAIL_DOMAIN = 'sites.webwow.local';

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

export interface SessionPayload {
  uid: string;
  iat: number;
  exp: number;
  /** absent = regular user session (every pre-existing cookie) */
  kind?: 'editor';
  /** pinned site id (editor sessions only) */
  site?: string;
  /** `webwow_sites.editor_password_version` at issue time (editor sessions only; revocation) */
  pv?: number;
  /** return path on the public site, e.g. `/work` (editor sessions only) */
  ret?: string;
}

export type SessionExtra = Partial<Pick<SessionPayload, 'kind' | 'site' | 'pv' | 'ret'>>;

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function createSessionToken(userId: string, ttlSeconds = SESSION_TTL_SECONDS, extra: SessionExtra = {}): { token: string; expiresAt: number } {
  const iat = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { uid: userId, iat, exp: iat + ttlSeconds };
  if (extra.kind !== undefined) payload.kind = extra.kind;
  if (extra.site !== undefined) payload.site = extra.site;
  if (extra.pv !== undefined) payload.pv = extra.pv;
  if (extra.ret !== undefined) payload.ret = extra.ret;
  const encoded = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', getSessionSecret()).update(encoded).digest('hex');
  return { token: `${encoded}.${signature}`, expiresAt: payload.exp };
}

/** Editor-kind payload with a pinned site and password version. */
export function isEditorSession(p: SessionPayload | null | undefined): p is SessionPayload & { kind: 'editor'; site: string; pv: number } {
  return !!p && p.kind === 'editor' && typeof p.site === 'string' && SITE_ID_RE.test(p.site) && typeof p.pv === 'number' && Number.isFinite(p.pv);
}

/**
 * Verify a session token. Legacy `{ uid, iat, exp }` payloads keep verifying;
 * `kind` values other than `'editor'` are rejected, and an editor token must
 * carry a well-formed `site` and a numeric `pv` (otherwise it would be treated
 * as a regular session — a pin escape).
 */
export function verifySessionToken(token: string | undefined | null): SessionPayload | null {
  if (!token) return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  const expected = createHmac('sha256', getSessionSecret()).update(encoded).digest('hex');
  if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try {
    const payload = JSON.parse(fromBase64url(encoded)) as SessionPayload;
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.uid || typeof payload.uid !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (payload.kind !== undefined) {
      if (payload.kind !== 'editor') return null;
      if (!isEditorSession(payload)) return null;
    }
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

/** Site id a synthetic editor account is bound to (`raw_app_meta_data.webwow_editor_site`), if any. */
export function editorSiteOf(row: Pick<UserRow, 'raw_app_meta_data'> | null | undefined): string | null {
  const v = row?.raw_app_meta_data?.webwow_editor_site;
  return typeof v === 'string' && v ? v : null;
}

/** `editor@<slug>.sites.webwow.local` */
export function editorEmailFor(slug: string): string {
  return `editor@${slug}.${EDITOR_EMAIL_DOMAIN}`;
}

function isEditorEmail(email: string): boolean {
  return normalizeEmail(email).endsWith(`.${EDITOR_EMAIL_DOMAIN}`);
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
  const db = await getMainDb();
  const row = await db('auth.users').where('id', id).first();
  return (row as UserRow | undefined) ?? null;
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const db = await getMainDb();
  const row = await db('auth.users').whereRaw('lower(email) = ?', [normalizeEmail(email)]).first();
  return (row as UserRow | undefined) ?? null;
}

export async function listUserRows(options?: { page?: number; perPage?: number }): Promise<{ users: UserRow[]; total: number }> {
  const db = await getMainDb();
  const perPage = Math.max(1, Math.min(options?.perPage ?? 50, 1000));
  const page = Math.max(1, options?.page ?? 1);
  const rows = await db('auth.users').orderBy('created_at', 'asc').limit(perPage).offset((page - 1) * perPage);
  const countRow = await db('auth.users').count<{ count: number | string }[]>('* as count').first();
  return { users: rows as UserRow[], total: countRow ? Number(countRow.count) : rows.length };
}

export async function countUsers(): Promise<number> {
  const db = await getMainDb();
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
  const db = await getMainDb();
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
  const db = await getMainDb();
  const existing = await findUserById(id);
  if (!existing) throw authError('User not found', 404, 'user_not_found');

  // Synthetic site editor accounts can never get a password, a real e-mail or another role
  // (a shared-password editor could otherwise turn the account into a regular login).
  if (editorSiteOf(existing)) {
    const roleChange = input.app_metadata !== undefined && 'role' in input.app_metadata && input.app_metadata.role !== 'editor';
    const siteChange = input.app_metadata !== undefined && 'webwow_editor_site' in input.app_metadata && input.app_metadata.webwow_editor_site !== editorSiteOf(existing);
    const emailChange = input.email !== undefined && !isEditorEmail(input.email);
    if (input.password !== undefined || roleChange || siteChange || emailChange) {
      throw authError('Site editor accounts cannot be changed', 400, 'editor_account_locked');
    }
  }

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
  const db = await getMainDb();
  const existing = await findUserById(id);
  if (!existing) return null;
  await db('auth.users').where('id', id).delete();
  return existing;
}

export async function touchLastSignIn(id: string): Promise<void> {
  const db = await getMainDb();
  await db('auth.users').where('id', id).update({ last_sign_in_at: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Synthetic site editor accounts (`?edit` flow, docs/EDITOR.md)
// ---------------------------------------------------------------------------

async function findSiteEditorRow(siteId: string): Promise<UserRow | null> {
  const db = await getMainDb();
  const row = await db('auth.users').whereRaw("raw_app_meta_data->>'webwow_editor_site' = ?", [siteId]).first();
  return (row as UserRow | undefined) ?? null;
}

/**
 * The synthetic editor account of a site (idempotent): looked up by site id,
 * created with no password (cannot use the normal login), role `editor`,
 * display name `Editor (<site name>)`; name/e-mail/role are re-synced on every
 * call and `last_sign_in_at` is touched (it shows up in Settings -> Users).
 */
export async function ensureSiteEditorUser(site: { id: string; slug: string; name: string }): Promise<UserRow> {
  const email = editorEmailFor(site.slug);
  const displayName = `Editor (${site.name})`;
  let row = await findSiteEditorRow(site.id);
  if (!row) {
    const byEmail = await findUserByEmail(email); // stale row from an older slug / manual creation
    if (byEmail && editorSiteOf(byEmail) !== site.id) {
      // an admin created a real account with this address (or another site's editor) — do not hijack it
      throw authError(`The address ${email} is already used by another account`, 409, 'editor_email_conflict');
    }
    if (byEmail) {
      row = byEmail;
    } else {
      try {
        row = await createUser({
          email,
          password: null,
          role: 'editor',
          email_confirm: true,
          user_metadata: { display_name: displayName, full_name: displayName, webwow_synthetic: true },
          app_metadata: { webwow_editor_site: site.id },
        });
      } catch (error) {
        // two first logins raced on createUser: re-query
        if ((error as AuthError | null)?.code !== 'email_exists') throw error;
        row = (await findSiteEditorRow(site.id)) ?? (await findUserByEmail(email));
        if (!row) throw error;
      }
    }
  }

  const needsUpdate = row.email !== email
    || row.raw_app_meta_data?.role !== 'editor'
    || row.raw_app_meta_data?.webwow_editor_site !== site.id
    || row.raw_user_meta_data?.display_name !== displayName;
  if (needsUpdate) {
    // Direct write: updateUser() refuses every change on editor accounts (including e-mail moves between slugs).
    const db = await getMainDb();
    const now = new Date().toISOString();
    await db('auth.users').where('id', row.id).update({
      email,
      encrypted_password: null,
      raw_app_meta_data: JSON.stringify({ ...(row.raw_app_meta_data ?? {}), role: 'editor', webwow_editor_site: site.id }),
      raw_user_meta_data: JSON.stringify({ ...(row.raw_user_meta_data ?? {}), display_name: displayName, full_name: displayName, webwow_synthetic: true }),
      updated_at: now,
    });
    row = (await findUserById(row.id))!;
  }
  await touchLastSignIn(row.id);
  return row;
}

/** Delete the synthetic editor account of a site (deleteSite). Returns the number of rows removed. */
export async function deleteSiteEditorUser(siteId: string): Promise<number> {
  const db = await getMainDb();
  return db('auth.users').whereRaw("raw_app_meta_data->>'webwow_editor_site' = ?", [siteId]).delete();
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
  // Synthetic site editor accounts only ever get a session through the `?edit` password flow.
  if (editorSiteOf(user)) return invalid;

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

export interface CurrentUser {
  user: UserRow;
  token: string;
  expiresAt: number;
  payload: SessionPayload;
}

/**
 * Read the session cookie of the current request and resolve the user.
 *
 * Editor sessions (`payload.kind === 'editor'`) are additionally bound to their
 * site: an unknown site, a site whose editor access was disabled, a stale
 * password version, or a synthetic user that no longer matches the site make
 * the session worthless (null) — the same checks the proxy applies.
 */
export async function getCurrentUserFromCookies(): Promise<CurrentUser | null> {
  try {
    const { cookies } = await import('next/headers');
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    const payload = verifySessionToken(token);
    if (!payload || !token) return null;
    const user = await findUserById(payload.uid);
    if (!user) return null;
    if (payload.kind === 'editor') {
      if (!isEditorSession(payload)) return null;
      const site = await getSite(payload.site);
      if (!site || site.editor_password_hash === null || site.editor_password_version !== payload.pv) return null;
      const meta = user.raw_app_meta_data ?? {};
      if (meta.role !== 'editor' || meta.webwow_editor_site !== payload.site) return null; // pinned user was re-purposed
    }
    return { user, token, expiresAt: payload.exp, payload };
  } catch {
    return null;
  }
}

/** Set the session cookie for the current request (route handlers / server actions only). Cookie `expires` = payload `exp`. */
export async function setSessionCookie(userId: string, options: { ttlSeconds?: number; extra?: SessionExtra } = {}): Promise<{ token: string; expiresAt: number }> {
  const session = createSessionToken(userId, options.ttlSeconds ?? SESSION_TTL_SECONDS, options.extra ?? {});
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

export function siteCookieOptions(secure = false) {
  return {
    name: SITE_COOKIE,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
    maxAge: SITE_COOKIE_MAX_AGE_SECONDS,
  };
}

/** Pin the builder to a site (`webwow_site` cookie, 30 days). */
export async function setSiteCookie(siteId: string): Promise<void> {
  if (!SITE_ID_RE.test(siteId)) throw authError('Invalid site id', 400, 'invalid_site');
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  cookieStore.set({ ...siteCookieOptions(await isSecureRequest()), value: siteId });
}

export async function clearSiteCookie(): Promise<void> {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  cookieStore.set({ ...siteCookieOptions(await isSecureRequest()), value: '', maxAge: 0, expires: new Date(0) });
}

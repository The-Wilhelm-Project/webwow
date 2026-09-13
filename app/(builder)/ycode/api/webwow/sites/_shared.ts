/**
 * Shared helpers for the sites API (`/ycode/api/webwow/sites/**`, multi-site).
 *
 * - `requireSitesAccess(level)`: session + role gate (SPEC-multisite §9). Editor
 *   sessions (`?edit` logins, synthetic editor accounts) are always refused.
 * - `siteJson(row)`: public JSON shape of a registry row (never leaks the
 *   editor password hash; adds `editorPasswordSet`, `previewUrl`, `publishedUrl`).
 * - `siteErrorResponse(error)`: maps `SiteServiceError` (status + code) and
 *   `ToastError` to `noCache()` JSON responses.
 *
 * The pure helpers (`siteJson`, `previewUrlFor`, `readBody*`) are unit tested in
 * `_shared.test.ts`; the session gate is testable through `__setSitesAccessDepsForTests`.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { noCache } from '@/lib/api-response';
import { resolveRole, type UserRole } from '@/lib/roles';
import { ToastError } from '@/lib/toast-error';
import { editorSiteOf, getCurrentUserFromCookies, type CurrentUser } from '@/lib/webwow/auth-server';
import { DEFAULT_SITE_ID } from '@/lib/webwow/sites/ids';
import { registryAvailable, type SiteRow } from '@/lib/webwow/sites/registry';
import { SiteServiceError, isSiteServiceError } from '@/lib/webwow/sites/service';

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

/** `read`: any regular user session; `admin`: owner|admin; `owner`: owner only. */
export type SitesAccessLevel = 'read' | 'admin' | 'owner';

export interface SitesAccess {
  user: CurrentUser['user'];
  role: UserRole;
  payload: CurrentUser['payload'];
}

interface SitesAccessDeps {
  getCurrentUser: () => Promise<CurrentUser | null>;
  registryAvailable: () => Promise<boolean>;
}

const defaultDeps: SitesAccessDeps = { getCurrentUser: getCurrentUserFromCookies, registryAvailable };
let deps: SitesAccessDeps = defaultDeps;

/** Test hook: replace the session/registry lookups (pass `null` to restore). */
export function __setSitesAccessDepsForTests(override: Partial<SitesAccessDeps> | null): void {
  deps = override ? { ...defaultDeps, ...override } : defaultDeps;
}

export function roleSatisfies(role: UserRole, level: SitesAccessLevel): boolean {
  if (level === 'read') return true;
  if (level === 'admin') return role === 'owner' || role === 'admin';
  return role === 'owner';
}

/**
 * Resolve the current session and check the required level.
 * Throws `SiteServiceError` (401 unauthenticated, 403 `editor_session` /
 * `forbidden`, 400 `registry_missing`) — route handlers map it with `siteErrorResponse()`.
 */
export async function requireSitesAccess(level: SitesAccessLevel): Promise<SitesAccess> {
  const current = await deps.getCurrentUser();
  if (!current) throw new SiteServiceError('Not authenticated', 401, 'unauthenticated');
  if (current.payload.kind === 'editor' || editorSiteOf(current.user)) {
    throw new SiteServiceError('Not available in editor mode', 403, 'editor_session');
  }
  const role = resolveRole(current.user.raw_app_meta_data?.role as string | undefined);
  if (!roleSatisfies(role, level)) {
    throw new SiteServiceError(level === 'owner' ? 'Only the owner can do this' : 'Only owners and admins can do this', 403, 'forbidden');
  }
  if (!(await deps.registryAvailable())) {
    throw new SiteServiceError('The site registry is missing — run the database migrations (npm run migrate:latest) first', 400, 'registry_missing');
  }
  return { user: current.user, role, payload: current.payload };
}

// ---------------------------------------------------------------------------
// JSON shape
// ---------------------------------------------------------------------------

/** Registry row as returned by the sites API (no password hash). */
export interface SiteJson {
  id: string;
  slug: string;
  name: string;
  database_name: string | null;
  domains: string[];
  is_default: boolean;
  editorPasswordSet: boolean;
  editor_password_version: number;
  thumbnail_url: string | null;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
  /** Where the site is served: first domain, `<slug>.<base domain>` or `<slug>.localhost:<port>`. */
  previewUrl: string;
  /** Same as `previewUrl`, except `/` for the default site (served on the app's own host). */
  publishedUrl: string;
}

export interface PreviewUrlEnv {
  baseDomain?: string | null;
  port?: string | null;
}

function envForPreviewUrl(): PreviewUrlEnv {
  return { baseDomain: process.env.WEBWOW_SITES_BASE_DOMAIN ?? null, port: process.env.PORT ?? null };
}

/**
 * Public URL of a site: `https://<first domain>` -> `https://<slug>.<WEBWOW_SITES_BASE_DOMAIN>`
 * -> `http://<slug>.localhost:<PORT>` (the proxy's first-label rule also applies to `localhost`).
 */
export function previewUrlFor(row: Pick<SiteRow, 'slug' | 'domains'>, env: PreviewUrlEnv = envForPreviewUrl()): string {
  const domain = row.domains.find((d) => typeof d === 'string' && d.trim())?.trim().toLowerCase();
  if (domain) return `https://${domain}`;
  const base = env.baseDomain?.trim().toLowerCase().replace(/^\.+/, '').replace(/\/+$/, '');
  if (base) return `https://${row.slug}.${base}`;
  const port = (env.port ?? '').trim() || '3002';
  return `http://${row.slug}.localhost:${port}`;
}

/** Strip `editor_password_hash`, add `editorPasswordSet`, `previewUrl`, `publishedUrl`. */
export function siteJson(row: SiteRow, env: PreviewUrlEnv = envForPreviewUrl()): SiteJson {
  const { editor_password_hash, ...rest } = row;
  const previewUrl = previewUrlFor(row, env);
  const isDefault = row.is_default || row.id === DEFAULT_SITE_ID;
  return {
    ...rest,
    editorPasswordSet: editor_password_hash !== null && editor_password_hash !== undefined && editor_password_hash !== '',
    previewUrl,
    publishedUrl: isDefault ? '/' : previewUrl,
  };
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/** JSON body as a plain object (`{}` when missing or invalid). */
export async function readJsonBody(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Trimmed string field or `undefined` (non-strings are ignored). */
export function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value.trim() : undefined;
}

/** Boolean field (`true`, `'true'`, `1`) or `undefined`. */
export function readBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return undefined;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface SiteErrorBody {
  error: string;
  code: string | null;
  errorTitle?: string;
}

/** `SiteServiceError` -> its status/code; `ToastError` -> 400; anything else -> 500 (logged). */
export function siteErrorResponse(error: unknown, context = 'sites api'): NextResponse<SiteErrorBody> {
  if (isSiteServiceError(error)) {
    const body: SiteErrorBody = { error: error.message, code: error.code };
    if (error.title) body.errorTitle = error.title;
    const status = error.status >= 400 && error.status < 600 ? error.status : 400;
    if (status >= 500) console.error(`[webwow ${context}] ${error.code}:`, error.message);
    return noCache(body, status);
  }
  if (error instanceof ToastError) {
    return noCache({ error: error.description, code: null, errorTitle: error.title }, 400);
  }
  console.error(`[webwow ${context}] failed:`, error);
  return noCache({ error: error instanceof Error ? error.message : 'Request failed', code: null }, 500);
}

/**
 * Run a handler behind the access gate; every thrown error becomes a JSON error
 * response (route handlers stay small and cannot leak stack traces).
 */
export async function withSitesAccess(
  level: SitesAccessLevel,
  context: string,
  handler: (access: SitesAccess) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const access = await requireSitesAccess(level);
    return await handler(access);
  } catch (error) {
    return siteErrorResponse(error, context);
  }
}

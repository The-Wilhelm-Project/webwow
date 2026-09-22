/**
 * Typed fetch helpers for the sites API (`/ycode/api/webwow/sites/**`).
 *
 * Every call is same-origin with the session cookie; errors are normalised to
 * `SitesApiError { status, code, message, title }` from the JSON body
 * (`{ error, code, errorTitle }`) the routes return.
 */

import type { SiteJson } from '@/app/(builder)/ycode/api/webwow/sites/_shared';

export type { SiteJson };

const BASE = '/ycode/api/webwow/sites';

export class SitesApiError extends Error {
  status: number;
  code: string | null;
  title?: string;

  constructor(message: string, status: number, code: string | null = null, title?: string) {
    super(message);
    this.name = 'SitesApiError';
    this.status = status;
    this.code = code;
    this.title = title;
  }
}

export function isSitesApiError(error: unknown): error is SitesApiError {
  return error instanceof SitesApiError || (!!error && typeof error === 'object' && (error as { name?: string }).name === 'SitesApiError');
}

export function errorMessage(error: unknown, fallback = 'Something went wrong'): string {
  if (isSitesApiError(error)) return error.title ? `${error.title}: ${error.message}` : error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

async function parseError(response: Response): Promise<SitesApiError> {
  let body: { error?: unknown; code?: unknown; errorTitle?: unknown } = {};
  try {
    body = await response.json();
  } catch {
    // non-JSON error (proxy redirect, HTML error page)
  }
  const message = typeof body.error === 'string' && body.error ? body.error : `Request failed (${response.status})`;
  const code = typeof body.code === 'string' ? body.code : null;
  const title = typeof body.errorTitle === 'string' ? body.errorTitle : undefined;
  return new SitesApiError(message, response.status, code, title);
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  headers.set('accept', 'application/json');
  const response = await fetch(`${BASE}${path}`, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw await parseError(response);
  const json = (await response.json()) as { data?: T };
  return json.data as T;
}

export interface SitesListResult {
  sites: SiteJson[];
  currentSiteId: string;
  multiSite: boolean;
}

export interface CurrentSiteResult {
  site: SiteJson;
  kind: 'editor' | 'user';
  multiSite: boolean;
  siteCount: number;
}

export interface EditorPasswordResult {
  editorPasswordSet: boolean;
  editor_password_version: number;
  site: SiteJson;
}

export const sitesApi = {
  list: () => requestJson<SitesListResult>(''),
  current: () => requestJson<CurrentSiteResult>('/current'),
  get: (id: string) => requestJson<SiteJson>(`/${encodeURIComponent(id)}`),
  create: (input: { name: string; slug?: string }) => requestJson<SiteJson>('', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, patch: { name?: string; slug?: string; domains?: string[] }) =>
    requestJson<SiteJson>(`/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) => requestJson<{ deleted: boolean; id: string }>(`/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  open: (id: string) => requestJson<{ redirect: string; siteId: string }>(`/${encodeURIComponent(id)}/open`, { method: 'POST' }),
  duplicate: (id: string, input: { name: string; slug?: string; confirmMainCopy?: boolean }) =>
    requestJson<SiteJson>(`/${encodeURIComponent(id)}/duplicate`, { method: 'POST', body: JSON.stringify(input) }),
  setEditorPassword: (id: string, password: string | null) =>
    requestJson<EditorPasswordResult>(`/${encodeURIComponent(id)}/editor-password`, { method: 'PUT', body: JSON.stringify({ password }) }),
  importFile: (id: string, file: File, password?: string) => {
    const form = new FormData();
    form.append('file', file, file.name);
    if (password) form.append('password', password);
    return requestJson<{ stats: unknown }>(`/${encodeURIComponent(id)}/import`, { method: 'POST', body: form });
  },
  /** Streams the `.ycode` export; returns the blob and the server's file name. */
  exportFile: async (id: string, password?: string): Promise<{ blob: Blob; filename: string }> => {
    const response = await fetch(`${BASE}/${encodeURIComponent(id)}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(password ? { password } : {}),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) throw await parseError(response);
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    return { blob: await response.blob(), filename: match?.[1] ?? 'export.ycode' };
  },
};

/** Trigger a browser download for a blob (object URL is revoked afterwards). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------------------
// Client-side mirrors of lib/webwow/sites/ids.ts (that module needs node `crypto`)
// ---------------------------------------------------------------------------

export const SITE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
export const RESERVED_SLUGS = new Set(['default', 'www', 'api', 'mail', 'localhost', 'ycode', 'webwow', 'admin', 'static', 'storage', 'a']);
export const SITE_NAME_MAX_LENGTH = 80;
export const EDITOR_PASSWORD_MIN_LENGTH = 10;

/** Same rule as the server's `slugify()`: lower-case ASCII, `-` separators, max 50 chars, empty -> `site`. */
export function slugifyClient(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/æ/gi, 'ae')
    .replace(/ø/gi, 'o')
    .replace(/œ/gi, 'oe')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return slug || 'site';
}

/** Client-side validation message for a slug, or `null` when it looks fine (the server has the final say). */
export function slugProblem(slug: string): string | null {
  if (!slug) return 'A slug is required';
  if (!SITE_SLUG_RE.test(slug)) return 'Lower-case letters, digits and hyphens only (1-50 characters, no leading/trailing hyphen)';
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved`;
  return null;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", else a short date. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  const diff = Math.max(0, now - t);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Deterministic hue (0-359) from a site id, for the thumbnail placeholder gradient. */
export function hueFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Up to two initials from a site name ("Valeska von Brase" -> "VB"). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

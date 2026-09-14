/**
 * Site resolution for the proxy (multi-site).
 *
 * Scope table (`scopeFor`): `public` paths are host-resolved (published pages,
 * storage, asset proxy, visitor-facing API routes such as form submissions,
 * collection filter/load-more, `/ycode/api/v1/*`, MCP, OAuth, revalidate);
 * `builder` paths (`/ycode/**`, `/api/templates/**`, `/webwow/**`, `/_next/**`)
 * are resolved from the editor pin (session token) or the `webwow_site` cookie.
 * Everything else falls back to the default site.
 *
 * No `server-only`, no `@/` imports.
 */

import { DEFAULT_SITE_ID } from './ids';
import { listSites, registryAvailable, type SiteRow } from './registry';

export const SITE_COOKIE = 'webwow_site';

export type Scope = 'public' | 'builder';

export interface ResolveInput {
  scope: Scope;
  host: string;
  pinned?: { siteId: string; pv: number } | null;
  cookie?: string | null;
  baseDomain?: string | null;
}

export interface Resolved {
  site: SiteRow;
  via: 'pin' | 'cookie' | 'domain' | 'subdomain' | 'default';
  pinInvalid?: 'unknown' | 'disabled' | 'revoked';
}

/** Visitor-facing routes under /ycode that must follow the host, not the builder cookie. */
const PUBLIC_YCODE_RULES: Array<{ method?: string; re: RegExp }> = [
  { method: 'POST', re: /^\/ycode\/api\/form-submissions\/?$/ },
  { method: 'POST', re: /^\/ycode\/api\/collections\/[^/]+\/items\/(filter|load-more)\/?$/ },
  { re: /^\/ycode\/api\/v1(\/|$)/ },
  { re: /^\/ycode\/mcp(\/|$)/ },
  { re: /^\/ycode\/api\/oauth(\/|$)/ },
  { re: /^\/ycode\/api\/revalidate\/?$/ },
];

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** `public` = host-resolved, `builder` = cookie/pin-resolved. */
export function scopeFor(pathname: string, method: string): Scope {
  const m = (method || 'GET').toUpperCase();
  if (underPrefix(pathname, '/ycode')) {
    for (const rule of PUBLIC_YCODE_RULES) {
      if ((!rule.method || rule.method === m) && rule.re.test(pathname)) return 'public';
    }
    return 'builder';
  }
  if (underPrefix(pathname, '/api/templates') || underPrefix(pathname, '/webwow') || pathname.startsWith('/_next')) return 'builder';
  // published pages, /storage/*, /a/*, /dynamic*, /.well-known/*, sitemap/robots/llms, /api/cron/*, /api/page-auth/*, ...
  return 'public';
}

/** Request host (lower-case, port stripped, first entry of a comma list); `x-forwarded-host` only behind a trusted proxy. */
export function hostFromRequest(headers: Headers, trustedProxy: boolean): string {
  const forwarded = trustedProxy ? headers.get('x-forwarded-host') : null;
  const raw = (forwarded && forwarded.trim()) || headers.get('host') || '';
  let host = raw.split(',')[0].trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    host = end === -1 ? host : host.slice(0, end + 1);
  } else {
    host = host.replace(/:\d+$/, '');
  }
  return host;
}

function fallbackDefaultRow(): SiteRow {
  const now = new Date(0).toISOString();
  return {
    id: DEFAULT_SITE_ID,
    slug: 'default',
    name: 'My Site',
    database_name: null,
    domains: [],
    is_default: true,
    editor_password_hash: null,
    editor_password_version: 0,
    thumbnail_url: null,
    created_at: now,
    updated_at: now,
    last_opened_at: null,
  };
}

export async function resolveSiteForRequest(input: ResolveInput): Promise<Resolved> {
  if (!(await registryAvailable())) return { site: fallbackDefaultRow(), via: 'default' };
  const sites = await listSites();
  const def = sites.find((s) => s.is_default) ?? sites.find((s) => s.id === DEFAULT_SITE_ID) ?? fallbackDefaultRow();

  if (input.scope === 'builder') {
    if (input.pinned) {
      const site = sites.find((s) => s.id === input.pinned!.siteId);
      if (!site) return { site: def, via: 'default', pinInvalid: 'unknown' };
      if (site.editor_password_hash === null) return { site: def, via: 'default', pinInvalid: 'disabled' };
      if (site.editor_password_version !== input.pinned.pv) return { site: def, via: 'default', pinInvalid: 'revoked' };
      return { site, via: 'pin' };
    }
    if (input.cookie) {
      const site = sites.find((s) => s.id === input.cookie);
      if (site) return { site, via: 'cookie' };
    }
    return { site: def, via: 'default' };
  }

  const host = (input.host || '').toLowerCase();
  if (host) {
    const byDomain = sites.find((s) => s.domains.some((d) => d.toLowerCase() === host));
    if (byDomain) return { site: byDomain, via: 'domain' };
    const base = input.baseDomain ? input.baseDomain.trim().toLowerCase().replace(/^\.+/, '') : '';
    // WEBWOW_SITES_BASE_DOMAIN unset: the first-label rule still applies to *.localhost so dev works.
    const suffix = base || 'localhost';
    if (host.endsWith(`.${suffix}`)) {
      const slug = host.slice(0, -(suffix.length + 1));
      if (slug && !slug.includes('.')) {
        const bySlug = sites.find((s) => s.slug === slug);
        if (bySlug) return { site: bySlug, via: 'subdomain' };
      }
    }
  }
  return { site: def, via: 'default' };
}

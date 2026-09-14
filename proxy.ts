import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { applySecurityHeaders } from '@/lib/security-headers-server';
import { prefetchYcodePublishedAt } from '@/lib/ycode-html-comment';
import { getSessionSecret } from '@/lib/webwow/secret';
import { SITE_COOKIE, hostFromRequest, resolveSiteForRequest, scopeFor, type Resolved } from '@/lib/webwow/sites/resolve';
import { registryAvailable, type SiteRow } from '@/lib/webwow/sites/registry';
import { signSiteHeaderWebCrypto } from '@/lib/webwow/sites/site-header';
import { runInSite } from '@/lib/webwow/sites/context';
import { DEFAULT_SITE_ID, SITE_ID_RE } from '@/lib/webwow/sites/ids';
import { EDITOR_HOME, SESSION_REQUIRED_PUBLIC_PATHS, evaluateEditorPolicy, isApiPath } from '@/lib/webwow/proxy-policy';

/**
 * Webwow proxy (middleware).
 *
 * Identical to upstream ycode's proxy.ts in structure (keep the section order
 * in sync when merging), plus the Webwow layers:
 *  - authentication: verifies Webwow's own HMAC-signed session cookie
 *    (`webwow_session`, see lib/webwow/auth-server.ts) instead of a Supabase session
 *  - multi-site (docs/MULTISITE.md): resolves the site of every request (host for
 *    published pages and visitor-facing routes, editor pin / `webwow_site` cookie
 *    for the builder) and forwards it as the SIGNED request header `x-webwow-site`
 *    through one `forward()` helper that strips client-supplied `x-webwow-*` headers
 *  - `?edit` editor sessions (docs/EDITOR.md): `?edit` redirect on public pages,
 *    editor pin + revocation, the allow/deny/rewrite policy of lib/webwow/proxy-policy.ts
 *    evaluated BEFORE the public-prefix check
 *  - inherited holes closed: `/ycode/api/auth/(users|invite|set-role)` need a session,
 *    unauthenticated `POST /ycode/api/setup/migrate` is pinned to the default site,
 *    `x-forwarded-host` is trusted only with `WEBWOW_TRUSTED_PROXY=1`
 */

const SESSION_COOKIE_NAME = 'webwow_session';
const SITE_HEADER = 'x-webwow-site';
const SESSION_KIND_HEADER = 'x-webwow-session-kind';

/**
 * Public API routes that skip authentication.
 */
const PUBLIC_API_PREFIXES = [
  '/ycode/api/setup/',          // Setup wizard — needed before any user exists
  '/ycode/api/supabase/',       // Supabase config — kept for upstream compatibility (returns local placeholders)
  '/ycode/api/auth/',           // Auth callbacks and session checks (routes verify roles themselves)
  '/ycode/api/webwow/auth/',    // Webwow login/logout/session/signup/edit-login (routes verify themselves)
  '/ycode/api/webwow/storage/', // Signed upload target (token protected)
  '/ycode/api/v1/',             // Public API — has own API key auth
];

/**
 * Patterns for collection item endpoints that must be accessible on published pages
 * (load-more pagination, filter). Matched via regex since the collection ID is dynamic.
 */
const PUBLIC_COLLECTION_ITEM_SUFFIXES = ['/items/filter', '/items/load-more'];

const PUBLIC_API_EXACT = [
  '/ycode/api/revalidate', // Cache revalidation — has own secret token auth
  '/ycode/api/oauth/register', // RFC 7591 Dynamic Client Registration — anonymous
  '/ycode/api/oauth/token',    // OAuth token exchange — auth is via PKCE/refresh
];

interface SessionPayload {
  uid: string;
  iat: number;
  exp: number;
  kind?: 'editor';
  site?: string;
  pv?: number;
  ret?: string;
}

/**
 * Forward the request to the app (pass-through or rewrite) with the Webwow
 * request headers. Every incoming `x-webwow-*` header is dropped first so a
 * client can never pick the site (the signed value is verified downstream anyway).
 * This is the ONLY place that calls NextResponse.next()/rewrite().
 */
function forward(request: NextRequest, extra: Record<string, string>, rewriteTo?: URL): NextResponse {
  const requestHeaders = new Headers(request.headers);
  for (const key of [...requestHeaders.keys()]) {
    if (key.startsWith('x-webwow-')) requestHeaders.delete(key);
  }
  for (const [key, value] of Object.entries(extra)) requestHeaders.set(key, value);
  const response = rewriteTo
    ? NextResponse.rewrite(rewriteTo, { request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('x-pathname', extra['x-pathname']);
  return response;
}

function isPublicApiRoute(pathname: string, method: string): boolean {
  // POST to form-submissions is public (website visitors submitting forms)
  if (pathname === '/ycode/api/form-submissions' && method === 'POST') {
    return true;
  }

  if (PUBLIC_API_EXACT.includes(pathname)) return true;

  // Webwow: user management under the public /ycode/api/auth/ prefix still needs a session (M12).
  if (SESSION_REQUIRED_PUBLIC_PATHS.includes(pathname)) return false;

  if (PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;

  // Collection item endpoints for published pages (POST only — filter, load-more)
  if (method === 'POST' && pathname.startsWith('/ycode/api/collections/') &&
      PUBLIC_COLLECTION_ITEM_SUFFIXES.some(suffix => pathname.endsWith(suffix))) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Webwow session cookie verification (Web Crypto, works in Node and Edge runtimes)
// ---------------------------------------------------------------------------

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64urlDecode(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  return atob(base64);
}

/** Editor-kind payload with a pinned site and password version (same rule as auth-server isEditorSession). */
function isEditorPayload(payload: SessionPayload | null): payload is SessionPayload & { kind: 'editor'; site: string; pv: number } {
  return !!payload && payload.kind === 'editor' && typeof payload.site === 'string' && SITE_ID_RE.test(payload.site) && typeof payload.pv === 'number' && Number.isFinite(payload.pv);
}

/**
 * Verify the session cookie and return its payload (null when missing, tampered
 * or expired). Mirrors `verifySessionToken()` in lib/webwow/auth-server.ts:
 * legacy `{ uid, iat, exp }` tokens verify; `kind` other than `'editor'` is
 * rejected; editor tokens must carry a valid `site` and numeric `pv`.
 */
async function verifySessionCookie(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(getSessionSecret()),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded));
    const expected = toHex(mac);
    if (expected.length !== signature.length) return null;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    if (diff !== 0) return null;

    const payload = JSON.parse(base64urlDecode(encoded)) as Partial<SessionPayload> | null;
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.uid !== 'string' || !payload.uid || typeof payload.exp !== 'number') return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (payload.kind !== undefined) {
      if (payload.kind !== 'editor') return null;
      if (!isEditorPayload(payload as SessionPayload)) return null;
    }
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

function clearAuthCookies(response: NextResponse): NextResponse {
  response.cookies.set(SESSION_COOKIE_NAME, '', { expires: new Date(0), path: '/' });
  response.cookies.set(SITE_COOKIE, '', { expires: new Date(0), path: '/' });
  return response;
}

/** Synthetic default row used when the registry is not available (single-site behaviour). */
function defaultOnly(): Resolved {
  return { site: { id: DEFAULT_SITE_ID, slug: 'default', is_default: true } as SiteRow, via: 'default' };
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method;

  // --- Session (used by everything below) ---
  const session = await verifySessionCookie(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  const isEditor = isEditorPayload(session);

  // --- Site (docs/MULTISITE.md) ---
  const multi = !!process.env.DATABASE_URL && await registryAvailable();
  // Unauthenticated POST /ycode/api/setup/migrate is pinned to the default site (M12): cookie ignored.
  const ignoreSiteCookie = method === 'POST' && pathname === '/ycode/api/setup/migrate' && !session;
  let resolved: Resolved = multi
    ? await resolveSiteForRequest({
      scope: scopeFor(pathname, method),
      host: hostFromRequest(request.headers, process.env.WEBWOW_TRUSTED_PROXY === '1'),
      pinned: isEditor ? { siteId: session.site, pv: session.pv } : null,
      cookie: ignoreSiteCookie ? null : request.cookies.get(SITE_COOKIE)?.value ?? null,
      baseDomain: process.env.WEBWOW_SITES_BASE_DOMAIN ?? null,
    })
    : defaultOnly();
  if (isEditor && !multi) resolved = { ...resolved, pinInvalid: 'unknown' }; // no registry -> no editor sessions
  const siteId = resolved.site.id;

  const extra: Record<string, string> = {
    'x-pathname': pathname,
    [SITE_HEADER]: await signSiteHeaderWebCrypto(siteId, getSessionSecret()),
    [SESSION_KIND_HEADER]: isEditor ? 'editor' : session ? 'user' : 'none',
  };

  // --- Editor pin no longer valid (site deleted, editor access disabled, password changed) ---
  if (isEditor && resolved.pinInvalid) {
    if (pathname.startsWith('/ycode/api')) {
      return clearAuthCookies(NextResponse.json({ error: 'Editor session is no longer valid', code: 'editor_session_invalid' }, { status: 401 }));
    }
    return clearAuthCookies(NextResponse.redirect(new URL('/', request.url), 302));
  }

  const isDashboard = pathname === '/webwow' || pathname.startsWith('/webwow/');
  // Published pages (no builder/API/asset paths and not the sites dashboard): security headers + published stamp.
  const isPublicPage = !pathname.startsWith('/ycode')
    && !pathname.startsWith('/_next')
    && !pathname.startsWith('/api')
    && !pathname.startsWith('/dynamic')
    && !pathname.startsWith('/storage/')
    && !isDashboard;

  // --- `?edit` on a published page -> editor login (docs/EDITOR.md) ---
  // Builder-internal uses of `?edit` (/ycode/pages/<id>?edit, /ycode/collections/<id>?edit=<item>) are excluded by isPublicPage.
  if (isPublicPage && !pathname.startsWith('/a/') && !pathname.startsWith('/.well-known/')
      && (method === 'GET' || method === 'HEAD') && request.nextUrl.searchParams.has('edit')) {
    const params = new URLSearchParams(request.nextUrl.searchParams);
    params.delete('edit');
    const query = params.toString();
    const target = new URL('/webwow/edit', request.url);
    target.searchParams.set('site', siteId);
    target.searchParams.set('return', query ? `${pathname}?${query}` : pathname);
    return NextResponse.redirect(target, 302);
  }

  // MCP endpoints use their own token-based authentication — skip session auth.
  //   - `/ycode/mcp/<token>`: legacy URL-token endpoint (Cursor, Windsurf, etc.)
  //   - `/ycode/mcp`: OAuth Bearer-token endpoint (Claude.ai web, ChatGPT)
  if (pathname === '/ycode/mcp' || pathname.startsWith('/ycode/mcp/')) {
    return forward(request, extra);
  }

  // --- Editor policy: evaluated BEFORE the public-prefix check (findings-editor-flow §6.1) ---
  if (isEditor && (pathname.startsWith('/ycode') || pathname.startsWith('/api/templates') || isDashboard)) {
    const decision = evaluateEditorPolicy(method, pathname);
    if (decision.kind === 'deny') {
      if (isApiPath(pathname)) {
        return NextResponse.json({ error: 'Not available in editor mode' }, { status: 403 });
      }
      return NextResponse.redirect(new URL(decision.redirect ?? EDITOR_HOME, request.url));
    }
    if (decision.kind === 'rewrite') {
      return forward(request, extra, new URL(decision.to + request.nextUrl.search, request.url));
    }
    // allow -> normal session auth below
  }

  // Debug escape hatch: skip auth on preview routes when explicitly enabled.
  const skipPreviewAuth = process.env.DISABLE_PREVIEW_AUTH === 'true'
    && pathname.startsWith('/ycode/preview');

  // Protect API and preview routes with auth. `/api/templates` lives outside the
  // `/ycode` tree (public site route group) but exposes destructive builder-only
  // operations (apply/export), so it must be gated here too.
  if (!skipPreviewAuth && (pathname.startsWith('/ycode/api') || pathname.startsWith('/ycode/preview') || pathname.startsWith('/api/templates'))) {
    // Without a database there is nothing to protect yet (setup state).
    if (!isPublicApiRoute(pathname, method) && process.env.DATABASE_URL) {
      if (!session) {
        if (pathname.startsWith('/ycode/preview')) {
          return NextResponse.redirect(new URL('/ycode', request.url));
        }
        return NextResponse.json(
          { error: 'Not authenticated' },
          { status: 401 }
        );
      }
      // Authenticated — pass through
      return forward(request, extra);
    }
  }

  const hasPaginationParams = Array.from(request.nextUrl.searchParams.keys())
    .some((key) => key.startsWith('p_'));

  if (isPublicPage && hasPaginationParams) {
    const rewriteUrl = request.nextUrl.clone();
    rewriteUrl.pathname = pathname === '/' ? '/dynamic' : `/dynamic${pathname}`;

    const rewriteResponse = forward(request, extra, rewriteUrl);
    await runInSite(siteId, async () => {
      await applySecurityHeaders(rewriteResponse, siteId === DEFAULT_SITE_ID ? undefined : siteId);
      await prefetchYcodePublishedAt();
    });
    return rewriteResponse;
  }

  // Create response
  const response = forward(request, extra);

  // Cache-Control for public pages is configured centrally via next.config.ts headers().

  // Apply configurable security headers to public pages only (not builder/API/dashboard).
  // The settings reads run inside the site context (site-aware knex client); the site id
  // doubles as the per-site cache key of the header cache (ignored by the data layer).
  if (isPublicPage) {
    await runInSite(siteId, async () => {
      await applySecurityHeaders(response, siteId === DEFAULT_SITE_ID ? undefined : siteId);
      await prefetchYcodePublishedAt();
    });
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { applySecurityHeaders } from '@/lib/security-headers-server';
import { prefetchYcodePublishedAt } from '@/lib/ycode-html-comment';
import { getSessionSecret } from '@/lib/webwow/secret';

/**
 * Webwow proxy (middleware).
 *
 * Identical to upstream ycode's proxy.ts except for authentication: instead of
 * refreshing a Supabase session, Webwow verifies its own HMAC-signed session
 * cookie (`webwow_session`, see lib/webwow/auth-server.ts). Keep the structure
 * in sync with upstream when merging.
 */

const SESSION_COOKIE_NAME = 'webwow_session';

/**
 * Public API routes that skip authentication.
 */
const PUBLIC_API_PREFIXES = [
  '/ycode/api/setup/',          // Setup wizard — needed before any user exists
  '/ycode/api/supabase/',       // Supabase config — kept for upstream compatibility (returns local placeholders)
  '/ycode/api/auth/',           // Auth callbacks and session checks (routes verify roles themselves)
  '/ycode/api/webwow/auth/',    // Webwow login/logout/session/signup (routes verify themselves)
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

/** Attach x-pathname on the request (readable via headers()) and the response. */
function withPathname(response: NextResponse, request: NextRequest, pathname: string): NextResponse {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', pathname);
  const next = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.cookies.getAll().forEach((cookie) => {
    next.cookies.set(cookie.name, cookie.value);
  });
  response.headers.forEach((value, key) => {
    next.headers.set(key, value);
  });
  next.headers.set('x-pathname', pathname);
  return next;
}

function isPublicApiRoute(pathname: string, method: string): boolean {
  // POST to form-submissions is public (website visitors submitting forms)
  if (pathname === '/ycode/api/form-submissions' && method === 'POST') {
    return true;
  }

  if (PUBLIC_API_EXACT.includes(pathname)) return true;

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

async function verifySessionCookie(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return false;

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
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    if (diff !== 0) return false;

    const payload = JSON.parse(base64urlDecode(encoded)) as { uid?: string; exp?: number };
    if (!payload.uid || typeof payload.exp !== 'number') return false;
    return payload.exp >= Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

/**
 * Verify the Webwow session for protected API routes.
 * Returns a 401 response if not authenticated, or null to continue.
 */
async function verifyApiAuth(request: NextRequest): Promise<NextResponse | null> {
  if (isPublicApiRoute(request.nextUrl.pathname, request.method)) {
    return null;
  }

  // Without a database there is nothing to protect yet (setup state).
  if (!process.env.DATABASE_URL) return null;

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const valid = await verifySessionCookie(token);

  if (!valid) {
    return NextResponse.json(
      { error: 'Not authenticated' },
      { status: 401 }
    );
  }

  return NextResponse.next({ request });
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // MCP endpoints use their own token-based authentication — skip session auth.
  //   - `/ycode/mcp/<token>`: legacy URL-token endpoint (Cursor, Windsurf, etc.)
  //   - `/ycode/mcp`: OAuth Bearer-token endpoint (Claude.ai web, ChatGPT)
  if (pathname === '/ycode/mcp' || pathname.startsWith('/ycode/mcp/')) {
    return withPathname(NextResponse.next(), request, pathname);
  }

  // Debug escape hatch: skip auth on preview routes when explicitly enabled.
  const skipPreviewAuth = process.env.DISABLE_PREVIEW_AUTH === 'true'
    && pathname.startsWith('/ycode/preview');

  // Protect API and preview routes with auth. `/api/templates` lives outside the
  // `/ycode` tree (public site route group) but exposes destructive builder-only
  // operations (apply/export), so it must be gated here too.
  if (!skipPreviewAuth && (pathname.startsWith('/ycode/api') || pathname.startsWith('/ycode/preview') || pathname.startsWith('/api/templates'))) {
    const authResponse = await verifyApiAuth(request);
    if (authResponse) {
      if (authResponse.status === 401) {
        if (pathname.startsWith('/ycode/preview')) {
          return NextResponse.redirect(new URL('/ycode', request.url));
        }
        return authResponse;
      }
      // Authenticated — pass through
      return withPathname(authResponse, request, pathname);
    }
  }

  const isPublicPage = !pathname.startsWith('/ycode')
    && !pathname.startsWith('/_next')
    && !pathname.startsWith('/api')
    && !pathname.startsWith('/dynamic')
    && !pathname.startsWith('/storage/');
  const hasPaginationParams = Array.from(request.nextUrl.searchParams.keys())
    .some((key) => key.startsWith('p_'));

  if (isPublicPage && hasPaginationParams) {
    const rewriteUrl = request.nextUrl.clone();
    rewriteUrl.pathname = pathname === '/' ? '/dynamic' : `/dynamic${pathname}`;

    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-pathname', pathname);
    const rewriteResponse = NextResponse.rewrite(rewriteUrl, {
      request: { headers: requestHeaders },
    });
    rewriteResponse.headers.set('x-pathname', pathname);
    await applySecurityHeaders(rewriteResponse);
    await prefetchYcodePublishedAt();
    return rewriteResponse;
  }

  // Create response
  const response = withPathname(NextResponse.next(), request, pathname);

  // Cache-Control for public pages is configured centrally via next.config.ts headers().

  // Apply configurable security headers to public pages only (not builder/API).
  if (isPublicPage) {
    await applySecurityHeaders(response);
    await prefetchYcodePublishedAt();
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

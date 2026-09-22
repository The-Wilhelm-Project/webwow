import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import {
  EDITOR_SESSION_TTL_SECONDS,
  ensureSiteEditorUser,
  getCurrentUserFromCookies,
  isEditorSession,
  setSessionCookie,
  setSiteCookie,
  toSupabaseSession,
  toSupabaseUser,
  verifyPasswordHash,
} from '@/lib/webwow/auth-server';
import { getSite, registryAvailable } from '@/lib/webwow/sites/registry';
import { clientIpKey, loginThrottle } from '@/lib/webwow/editor/throttle';
import { validateReturnPath } from '@/lib/webwow/editor/return-path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/webwow/auth/edit-login
 *
 * Content-editor entry point for `<site>/<page>?edit` (see docs/EDITOR.md).
 * Body: `{ site, password?, return? }`.
 *
 * A visitor who knows the site's editor password gets a 12 h session pinned to
 * that site and bound to the password version, so changing or clearing the
 * password ends every open editor session. Someone who is already signed in as a
 * regular user skips the password and just gets the site cookie.
 */
export async function POST(request: NextRequest) {
  try {
    if (!(await registryAvailable())) {
      return noCache({ error: 'Sites are not set up yet', code: 'registry_missing' }, 503);
    }

    const body = await request.json().catch(() => ({}));
    const siteId = typeof body?.site === 'string' ? body.site : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const returnPath = validateReturnPath(body?.return) ?? '/';

    const site = siteId ? await getSite(siteId) : null;
    if (!site) {
      return noCache({ error: 'Unknown site', code: 'site_not_found' }, 404);
    }

    // Already signed in as a real user: no password needed, just switch site.
    const current = await getCurrentUserFromCookies();
    if (current && !isEditorSession(current.payload)) {
      await setSiteCookie(site.id);
      return noCache({ data: { redirect: '/ycode/collections', mode: 'user' } });
    }

    const keys = { site: site.id, ip: clientIpKey(request.headers) };
    const decision = loginThrottle.check(keys);
    if (!decision.allowed) {
      const response = noCache({ error: 'Too many attempts. Try again in a minute.', code: 'throttled' }, 429);
      if (decision.retryAfterSeconds) response.headers.set('Retry-After', String(decision.retryAfterSeconds));
      return response;
    }

    if (!site.editor_password_hash) {
      loginThrottle.fail(keys);
      return noCache(
        {
          error: 'Editor access is not enabled for this site — set an editor password in the Sites dashboard (/webwow → site → Settings).',
          code: 'editor_disabled',
        },
        403,
      );
    }

    if (!password || !verifyPasswordHash(password, site.editor_password_hash)) {
      loginThrottle.fail(keys);
      console.warn(`[webwow edit-login] wrong password for site ${site.id}`);
      return noCache({ error: 'Wrong password', code: 'invalid_credentials' }, 400);
    }

    loginThrottle.succeed(keys);

    const row = await ensureSiteEditorUser({ id: site.id, slug: site.slug, name: site.name });
    const { token, expiresAt } = await setSessionCookie(row.id, {
      ttlSeconds: EDITOR_SESSION_TTL_SECONDS,
      extra: { kind: 'editor', site: site.id, pv: site.editor_password_version, ret: returnPath },
    });
    await setSiteCookie(site.id);

    const user = toSupabaseUser(row);
    return noCache({
      data: { redirect: '/ycode/collections', mode: 'editor', user, session: toSupabaseSession(user, token, expiresAt) },
    });
  } catch (error) {
    console.error('[webwow auth/edit-login] failed:', error);
    return noCache({ error: 'Could not open the editor' }, 500);
  }
}

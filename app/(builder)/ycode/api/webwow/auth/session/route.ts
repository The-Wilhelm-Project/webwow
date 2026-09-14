import { noCache } from '@/lib/api-response';
import { getCurrentUserFromCookies, toSupabaseSession, toSupabaseUser } from '@/lib/webwow/auth-server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/webwow/auth/session
 *
 * Current Webwow session (cookie based). Always 200; `session`/`user` are null
 * when not signed in.
 */
export async function GET() {
  try {
    const current = await getCurrentUserFromCookies();
    if (!current) {
      return noCache({ data: { session: null, user: null } });
    }
    const user = toSupabaseUser(current.user);
    return noCache({ data: { session: toSupabaseSession(user, current.token, current.expiresAt), user } });
  } catch (error) {
    console.error('[webwow auth/session] failed:', error);
    return noCache({ data: { session: null, user: null } });
  }
}

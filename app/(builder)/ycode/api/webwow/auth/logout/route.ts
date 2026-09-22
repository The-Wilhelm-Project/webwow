import { noCache } from '@/lib/api-response';
import { clearSessionCookie } from '@/lib/webwow/auth-server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/webwow/auth/logout
 */
export async function POST() {
  try {
    await clearSessionCookie();
    return noCache({ data: { success: true } });
  } catch (error) {
    console.error('[webwow auth/logout] failed:', error);
    return noCache({ error: 'Logout failed' }, 500);
  }
}

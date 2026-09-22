import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { getCurrentUserFromCookies, toSupabaseUser, updateUser, type AuthError } from '@/lib/webwow/auth-server';
import { authErrorResponse } from '../_shared';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/webwow/auth/update-user
 * Body: { email?, password?, data? }  (current user only)
 */
export async function POST(request: NextRequest) {
  try {
    const current = await getCurrentUserFromCookies();
    if (!current) {
      return noCache({ error: 'Not authenticated' }, 401);
    }

    const body = await request.json().catch(() => ({}));
    const patch: { email?: string; password?: string; data?: Record<string, unknown> } = {};
    if (typeof body?.email === 'string') patch.email = body.email;
    if (typeof body?.password === 'string') patch.password = body.password;
    if (body?.data && typeof body.data === 'object') patch.data = body.data as Record<string, unknown>;

    const row = await updateUser(current.user.id, patch);
    return noCache({ data: { user: toSupabaseUser(row) } });
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in (error as AuthError)) {
      return authErrorResponse(error as AuthError);
    }
    console.error('[webwow auth/update-user] failed:', error);
    return noCache({ error: 'Update failed' }, 500);
  }
}

import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { authenticateWithPassword, setSessionCookie, toSupabaseSession, toSupabaseUser } from '@/lib/webwow/auth-server';
import { authErrorResponse } from '../_shared';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/webwow/auth/login
 * Body: { email, password }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const email = typeof body?.email === 'string' ? body.email : '';
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!email || !password) {
      return noCache({ error: 'Email and password are required' }, 400);
    }

    const result = await authenticateWithPassword(email, password);
    if ('error' in result) {
      return authErrorResponse(result.error);
    }

    const user = toSupabaseUser(result.user);
    const { token, expiresAt } = await setSessionCookie(result.user.id);
    return noCache({ data: { user, session: toSupabaseSession(user, token, expiresAt) } });
  } catch (error) {
    console.error('[webwow auth/login] failed:', error);
    return noCache({ error: 'Login failed' }, 500);
  }
}

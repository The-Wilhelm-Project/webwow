import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { countUsers, createUser, ensureBootstrapAdmin, setSessionCookie, toSupabaseSession, toSupabaseUser, type AuthError } from '@/lib/webwow/auth-server';
import { authErrorResponse } from '../_shared';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/webwow/auth/signup
 * Body: { email, password, data? }
 *
 * Creates the FIRST account (owner). Once any user exists, self sign-up is
 * disabled — owners/admins create accounts via the CLI (`npm run webwow:user`).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const email = typeof body?.email === 'string' ? body.email : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const data = body?.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : {};

    if (!email || !password) {
      return noCache({ error: 'Email and password are required' }, 400);
    }

    await ensureBootstrapAdmin();
    if ((await countUsers()) > 0) {
      return noCache({ error: 'Signups are disabled. Ask an owner or admin to create your account.', code: 'signup_disabled' }, 403);
    }

    const row = await createUser({ email, password, role: 'owner', user_metadata: data });
    const user = toSupabaseUser(row);
    const { token, expiresAt } = await setSessionCookie(row.id);
    return noCache({ data: { user, session: toSupabaseSession(user, token, expiresAt) } });
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in (error as AuthError)) {
      return authErrorResponse(error as AuthError);
    }
    console.error('[webwow auth/signup] failed:', error);
    return noCache({ error: 'Sign up failed' }, 500);
  }
}

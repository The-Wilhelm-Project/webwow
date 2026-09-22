import { NextRequest, NextResponse } from 'next/server';
import { createRouteClient } from '@/lib/supabase-route-client';

/**
 * GET /ycode/api/auth/callback
 *
 * Handle OAuth callback from Supabase Auth
 */
export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');

  if (code) {
    try {
      const supabase = await createRouteClient();

      if (!supabase) {
        return NextResponse.redirect(
          new URL('/login?error=config', request.url)
        );
      }

      const { error } = await supabase.auth.exchangeCodeForSession(code);

      if (error) {
        console.error('Auth callback error:', error);
        return NextResponse.redirect(
          new URL('/login?error=auth', request.url)
        );
      }

      return NextResponse.redirect(new URL('/ycode', request.url));
    } catch (error) {
      console.error('Auth callback failed:', error);
      return NextResponse.redirect(
        new URL('/login?error=server', request.url)
      );
    }
  }

  return NextResponse.redirect(new URL('/login', request.url));
}

import { createRouteClient } from '@/lib/supabase-route-client';
import { noCache } from '@/lib/api-response';

/**
 * GET /ycode/api/auth/session
 *
 * Get current user session
 */
export async function GET() {
  try {
    const supabase = await createRouteClient();

    if (!supabase) {
      return noCache(
        { error: 'Supabase not configured' },
        500
      );
    }

    const { data: { session }, error } = await supabase.auth.getSession();

    if (error) {
      return noCache(
        { error: error.message },
        401
      );
    }

    return noCache({
      data: {
        session,
        user: session?.user || null,
      },
    });
  } catch (error) {
    console.error('Session check failed:', error);

    return noCache(
      { error: 'Session check failed' },
      500
    );
  }
}

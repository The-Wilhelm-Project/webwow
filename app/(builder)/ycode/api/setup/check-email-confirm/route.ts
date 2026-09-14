import { noCache } from '@/lib/api-response';
import { getSupabaseConfig } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/setup/check-email-confirm
 *
 * Checks whether the Supabase "Confirm email" setting is disabled
 * by querying GoTrue's public /settings endpoint which exposes
 * the mailer autoconfirm flag.
 */
export async function GET() {
  try {
    const creds = await getSupabaseConfig();

    if (!creds) {
      return noCache(
        { error: 'Supabase not configured' },
        500
      );
    }

    const settingsResponse = await fetch(
      `${creds.projectUrl}/auth/v1/settings`,
      {
        headers: { 'apikey': creds.anonKey },
      }
    );

    if (!settingsResponse.ok) {
      return noCache(
        { error: 'Failed to fetch auth settings from Supabase' },
        500
      );
    }

    const settings = await settingsResponse.json();
    const isAutoconfirm = settings.mailer_autoconfirm === true;

    return noCache({
      autoconfirm: isAutoconfirm,
    });
  } catch (error) {
    console.error('Check email confirm failed:', error);
    return noCache(
      { error: 'Failed to check email confirmation setting' },
      500
    );
  }
}

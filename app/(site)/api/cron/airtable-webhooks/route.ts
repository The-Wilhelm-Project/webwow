import { NextRequest, NextResponse } from 'next/server';
import { refreshActiveWebhooks } from '@/lib/apps/airtable/sync-service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/cron/airtable-webhooks
 * Daily cron to refresh Airtable webhooks before they expire.
 * Secured via CRON_SECRET or Vercel's Authorization header.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await refreshActiveWebhooks();
    return NextResponse.json({ data: result });
  } catch (error) {
    console.error('[Cron] Airtable webhook refresh error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to refresh webhooks' },
      { status: 500 }
    );
  }
}

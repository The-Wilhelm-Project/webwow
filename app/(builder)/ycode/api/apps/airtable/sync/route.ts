import { NextRequest } from 'next/server';
import { requireConnectionFromBody, fullSync } from '@/lib/apps/airtable/sync-service';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/apps/airtable/sync
 * Trigger a full sync for a specific connection
 */
export async function POST(request: NextRequest) {
  try {
    const connection = await requireConnectionFromBody(request);
    const result = await fullSync(connection);
    return noCache({ data: result });
  } catch (error) {
    console.error('Error syncing Airtable:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Sync failed' },
      500
    );
  }
}

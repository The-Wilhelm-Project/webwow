import { NextRequest } from 'next/server';
import { listTables } from '@/lib/apps/airtable';
import { requireAirtableToken } from '@/lib/apps/airtable/sync-service';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/apps/airtable/bases/[baseId]/tables
 * List tables and fields for a specific base
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ baseId: string }> }
) {
  try {
    const { baseId } = await params;
    const token = await requireAirtableToken();
    const tables = await listTables(token, baseId);
    return noCache({ data: tables });
  } catch (error) {
    console.error('Error fetching Airtable tables:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch tables' },
      500
    );
  }
}

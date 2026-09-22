import { listBases } from '@/lib/apps/airtable';
import { requireAirtableToken } from '@/lib/apps/airtable/sync-service';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/apps/airtable/bases
 * List all accessible Airtable bases using the stored token
 */
export async function GET() {
  try {
    const token = await requireAirtableToken();
    const bases = await listBases(token);
    return noCache({ data: bases });
  } catch (error) {
    console.error('Error fetching Airtable bases:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch bases' },
      500
    );
  }
}

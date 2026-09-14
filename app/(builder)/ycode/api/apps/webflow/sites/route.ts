import { listSites } from '@/lib/apps/webflow';
import { requireWebflowToken } from '@/lib/apps/webflow/migration-service';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/apps/webflow/sites
 * List all Webflow sites the stored token has access to.
 */
export async function GET() {
  try {
    const token = await requireWebflowToken();
    const sites = await listSites(token);
    return noCache({ data: sites });
  } catch (error) {
    console.error('Error fetching Webflow sites:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch sites' },
      500
    );
  }
}

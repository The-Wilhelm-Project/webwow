import { NextRequest } from 'next/server';
import { listCollectionsWithFields } from '@/lib/apps/webflow';
import { requireWebflowToken } from '@/lib/apps/webflow/migration-service';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/apps/webflow/sites/[siteId]/collections
 * Preview the collection schema for a Webflow site — used by the UI to
 * show "X collections, Y total fields" before the user kicks off a migration.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ siteId: string }> }
) {
  try {
    const { siteId } = await params;
    const token = await requireWebflowToken();
    const collections = await listCollectionsWithFields(token, siteId);

    const summary = collections.map((c) => ({
      id: c.id,
      displayName: c.displayName,
      slug: c.slug,
      fieldCount: c.fields?.length ?? 0,
    }));

    return noCache({ data: summary });
  } catch (error) {
    console.error('Error fetching Webflow collections:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch collections' },
      500
    );
  }
}

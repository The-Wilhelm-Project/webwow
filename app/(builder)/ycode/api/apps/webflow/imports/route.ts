import { getImports } from '@/lib/apps/webflow/migration-service';
import { noCache } from '@/lib/api-response';
import { getAllCollections } from '@/lib/repositories/collectionRepository';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/apps/webflow/imports
 * List all Webflow site imports stored in app_settings, with stale collection
 * mappings filtered out so the UI only shows YCode collections that still
 * exist (the underlying mapping is preserved so re-sync can recreate any
 * deleted ones on demand).
 */
export async function GET() {
  try {
    const [imports, existingCollections] = await Promise.all([
      getImports(),
      getAllCollections({ is_published: false }),
    ]);

    const existingIds = new Set(existingCollections.map((c) => c.id));
    const visibleImports = imports
      .map((record) => ({
        ...record,
        collectionMappings: record.collectionMappings.filter((m) =>
          existingIds.has(m.ycodeCollectionId)
        ),
      }))
      .filter((record) => record.collectionMappings.length > 0);

    return noCache({ data: visibleImports });
  } catch (error) {
    console.error('Error fetching Webflow imports:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch imports' },
      500
    );
  }
}

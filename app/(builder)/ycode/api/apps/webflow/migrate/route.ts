import { NextRequest } from 'next/server';
import { runMigration } from '@/lib/apps/webflow/migration-service';
import { noCache } from '@/lib/api-response';
import { clearAllCache, getAllPublishedRoutes, warmRoutes } from '@/lib/services/cacheService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
/** Migrations involve N item-list calls + asset downloads — give them headroom. */
export const maxDuration = 300;

/**
 * POST /ycode/api/apps/webflow/migrate
 * Body: { siteId: string }
 *
 * Runs a one-click full migration for a Webflow site: creates YCode
 * collections + fields, imports items as drafts, resolves references, and
 * publishes items currently live on Webflow.
 */
export async function POST(request: NextRequest) {
  try {
    const { siteId } = await request.json();

    if (!siteId || typeof siteId !== 'string') {
      return noCache({ error: 'siteId is required' }, 400);
    }

    const { import: importRecord, result } = await runMigration(siteId);

    // Migration publishes every Webflow-live item directly into the published
    // tables — outside the normal publish flow that does selective
    // invalidation. Without a full purge, any pages already cached against
    // the empty/old collections will keep serving stale HTML.
    try {
      await clearAllCache();
      const routes = await getAllPublishedRoutes();
      const warmResult = await warmRoutes(routes, request);
      if (warmResult) {
        console.log(
          `[Cache] webflow migrate: warming ${warmResult.warmed}${warmResult.total > warmResult.warmed ? ` of ${warmResult.total}` : ''} route(s) in background`,
        );
      }
    } catch (cacheError) {
      console.error('[Cache] webflow migrate: invalidation failed:', cacheError);
    }

    return noCache({ data: { import: importRecord, result } }, 201);
  } catch (error) {
    console.error('Error running Webflow migration:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Migration failed' },
      500
    );
  }
}

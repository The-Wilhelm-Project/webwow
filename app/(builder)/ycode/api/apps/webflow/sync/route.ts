import { NextRequest } from 'next/server';
import { runResync } from '@/lib/apps/webflow/migration-service';
import { noCache } from '@/lib/api-response';
import { clearAllCache, getAllPublishedRoutes, warmRoutes } from '@/lib/services/cacheService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

/**
 * POST /ycode/api/apps/webflow/sync
 * Body: { importId: string }
 *
 * Re-sync items + publish state for an existing import. Schema diffs are
 * NOT applied to keep re-sync safe — use a fresh migration to capture them.
 */
export async function POST(request: NextRequest) {
  try {
    const { importId } = await request.json();

    if (!importId || typeof importId !== 'string') {
      return noCache({ error: 'importId is required' }, 400);
    }

    const result = await runResync(importId);

    // Re-sync calls publishItem on every Webflow-live item, mutating published
    // rows outside the normal publish flow. Mirror the migrate route: full
    // purge + background warm so the CDN reflects the synced content.
    try {
      await clearAllCache();
      const routes = await getAllPublishedRoutes();
      const warmResult = await warmRoutes(routes, request);
      if (warmResult) {
        console.log(
          `[Cache] webflow sync: warming ${warmResult.warmed}${warmResult.total > warmResult.warmed ? ` of ${warmResult.total}` : ''} route(s) in background`,
        );
      }
    } catch (cacheError) {
      console.error('[Cache] webflow sync: invalidation failed:', cacheError);
    }

    return noCache({ data: result });
  } catch (error) {
    console.error('Error re-syncing Webflow import:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Re-sync failed' },
      500
    );
  }
}

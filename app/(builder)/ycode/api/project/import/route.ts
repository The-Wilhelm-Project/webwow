import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { importProject, unpackImport } from '@/lib/services/projectService';
import { clearAllCache, getAllPublishedRoutes, warmRoutes } from '@/lib/services/cacheService';
import { ToastError } from '@/lib/toast-error';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/project/import
 *
 * Import a project dump (.ycode file).
 * Accepts multipart form-data with:
 *   - "file" (required): the .ycode file
 *   - "password" (optional): decryption password if the file is encrypted
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const password = formData.get('password');

    if (!file || !(file instanceof Blob)) {
      return noCache({ error: 'No file provided. Upload a .ycode file as form-data with field name "file".' }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const passwordStr = typeof password === 'string' && password ? password : undefined;

    let parsed;
    try {
      parsed = unpackImport(buffer, passwordStr);
    } catch (err) {
      if (err instanceof ToastError) {
        return noCache({ errorTitle: err.title, error: err.description }, 400);
      }
      return noCache({ error: err instanceof Error ? err.message : 'Invalid .ycode file.' }, 400);
    }

    const result = await importProject(parsed.manifest, parsed.data, parsed.files);

    if (!result.success) {
      return noCache({ error: result.error }, 500);
    }

    // Project import swaps in a new published site. Without warming, the
    // first visit to each page after import is a cold render.
    try {
      await clearAllCache();
      const routes = await getAllPublishedRoutes();
      const warmResult = await warmRoutes(routes, request);
      if (warmResult) {
        console.log(
          `[Cache] project import: warming ${warmResult.warmed}${warmResult.total > warmResult.warmed ? ` of ${warmResult.total}` : ''} route(s) in background`,
        );
      }
    } catch (cacheError) {
      console.error('[Cache] project import: cache invalidation failed:', cacheError);
    }

    return noCache({
      success: true,
      message: 'Project imported successfully',
      stats: result.stats,
    });
  } catch (error) {
    console.error('[POST /ycode/api/project/import] Error:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Import failed' },
      500
    );
  }
}

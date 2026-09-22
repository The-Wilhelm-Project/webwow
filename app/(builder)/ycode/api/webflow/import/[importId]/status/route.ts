import { noCache } from '@/lib/api-response';
import { getWebflowImportById } from '@/lib/repositories/webflowImportRepository';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/webflow/import/[importId]/status
 *
 * Webwow-only. Returns the status/result of a `webflow_imports` job.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ importId: string }> }
) {
  try {
    const { importId } = await params;
    const importJob = await getWebflowImportById(importId);

    if (!importJob) {
      return noCache({ error: 'Webflow import job not found' }, 404);
    }

    return noCache({
      data: {
        id: importJob.id,
        status: importJob.status,
        warnings: importJob.warnings || [],
        errors: importJob.errors || [],
        result: importJob.result,
        created_at: importJob.created_at,
        updated_at: importJob.updated_at,
      },
    });
  } catch (error) {
    console.error('[GET /ycode/api/webflow/import/[importId]/status] Error:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch Webflow import status' },
      500
    );
  }
}

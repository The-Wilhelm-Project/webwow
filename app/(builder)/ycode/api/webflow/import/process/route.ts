import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { clearAllCache } from '@/lib/services/cacheService';
import {
  completeWebflowImport,
  getPendingWebflowImports,
  getWebflowImportById,
  updateWebflowImportProgress,
  updateWebflowImportStatus,
} from '@/lib/repositories/webflowImportRepository';
import { processWebflowImport } from '@/lib/services/webflowImportService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

/**
 * POST /ycode/api/webflow/import/process
 *
 * Webwow-only. Processes a pending `webflow_imports` job whose payload was
 * stored in the database (legacy two-step flow; `/ycode/api/webflow/import`
 * now processes synchronously and stores no payload).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const importId = typeof body.importId === 'string' ? body.importId : null;

    const importJob = importId
      ? await getWebflowImportById(importId)
      : (await getPendingWebflowImports(1))[0];

    if (!importJob) {
      return noCache({ error: 'Webflow import job not found' }, 404);
    }

    if (importJob.status === 'completed' || importJob.status === 'failed') {
      return noCache({
        data: {
          importId: importJob.id,
          status: importJob.status,
          message: 'Import already finished',
        },
      });
    }

    await updateWebflowImportStatus(importJob.id, 'processing');

    const payload = typeof importJob.payload === 'string'
      ? JSON.parse(importJob.payload)
      : importJob.payload;

    const processingResult = await processWebflowImport(payload);

    await updateWebflowImportProgress(importJob.id, processingResult.warnings, processingResult.errors);
    await completeWebflowImport(
      importJob.id,
      processingResult.result,
      processingResult.warnings,
      processingResult.errors
    );

    if (processingResult.success) {
      await clearAllCache();
    }

    return noCache({
      data: {
        importId: importJob.id,
        status: processingResult.success ? 'completed' : 'failed',
        result: processingResult.result,
        warnings: processingResult.warnings,
        errors: processingResult.errors,
      },
    });
  } catch (error) {
    console.error('[POST /ycode/api/webflow/import/process] Error:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to process Webflow import job' },
      500
    );
  }
}

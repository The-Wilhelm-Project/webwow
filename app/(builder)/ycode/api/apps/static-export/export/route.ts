import { randomUUID } from 'crypto';

import { NextRequest } from 'next/server';
import { exportSite, saveLastExportJob } from '@/lib/apps/static-export';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/apps/static-export/export
 * Trigger a static export of all published pages.
 *
 * Fire-and-forget: starts the export async and returns immediately with the
 * initial job status. The engine itself persists the final job to
 * app_settings (key `last_export_job`); poll /status to read it back.
 */
export async function POST(_request: NextRequest) {
  try {
    // Generate the job id in the route handler and persist the `running`
    // job synchronously BEFORE returning. The client polls /status by
    // job id; if we let the engine generate it on its own (deferred via
    // setImmediate), the client's initial /status fetch races ahead of
    // the engine's first write and pulls the previous completed job —
    // it then polls that stale id forever.
    const jobId = randomUUID();
    const startedAt = new Date().toISOString();

    await saveLastExportJob({
      id: jobId,
      status: 'running',
      startedAt,
      completedAt: null,
      error: null,
      pagesExported: 0,
      filesWritten: 0,
    }).catch(() => { /* non-fatal — engine will retry the write */ });

    // Detach via setImmediate so the engine Promise isn't part of the
    // request's async context. Without this, Next.js / the Node runtime
    // keeps the response stream open until the engine settles, leaving
    // the client `await response.json()` hanging.
    setImmediate(() => {
      exportSite(jobId).catch((err) => {
        console.error('[Static Export] Export job failed:', err);
      });
    });

    return noCache({
      data: {
        message: 'Export started',
        status: 'running',
        jobId,
      },
    });
  } catch (error) {
    console.error('Error starting static export:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to start export' },
      500
    );
  }
}

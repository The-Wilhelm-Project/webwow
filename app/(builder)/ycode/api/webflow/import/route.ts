import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { clearAllCache } from '@/lib/services/cacheService';
import {
  createWebflowImport,
  completeWebflowImport,
  updateWebflowImportStatus,
} from '@/lib/repositories/webflowImportRepository';
import { processWebflowImport } from '@/lib/services/webflowImportService';
import type { WebflowCsvFile, WebflowImportPayload } from '@/types/webwow';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

async function parsePayload(request: NextRequest): Promise<WebflowImportPayload> {
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const body = await request.json();
    if (!body?.zipBase64 || !body?.zipFilename) {
      throw new Error('Invalid JSON payload: zipFilename and zipBase64 are required');
    }
    const csvFiles: WebflowCsvFile[] = Array.isArray(body.csvFiles)
      ? (body.csvFiles as unknown[]).filter((f): f is WebflowCsvFile => (
        typeof (f as Record<string, unknown>)?.filename === 'string'
        && typeof (f as Record<string, unknown>)?.content === 'string'
      ))
      : [];
    return {
      zipFilename: String(body.zipFilename),
      zipBase64: String(body.zipBase64),
      csvFiles,
    };
  }

  const formData = await request.formData();
  const zipFile = formData.get('webflowZip');
  const csvFilesRaw = formData.getAll('csvFiles');

  if (!zipFile || !(zipFile instanceof Blob)) {
    throw new Error('webflowZip is required');
  }

  const zipFilename = zipFile instanceof File ? zipFile.name : 'webflow-export.zip';
  const zipBuffer = Buffer.from(await zipFile.arrayBuffer());
  const csvFiles: WebflowCsvFile[] = [];

  for (const csvFile of csvFilesRaw) {
    if (!(csvFile instanceof Blob)) continue;
    const filename = csvFile instanceof File ? csvFile.name : `collection-${csvFiles.length + 1}.csv`;
    const content = await csvFile.text();
    csvFiles.push({ filename, content });
  }

  return {
    zipFilename,
    zipBase64: zipBuffer.toString('base64'),
    csvFiles,
  };
}

/**
 * POST /ycode/api/webflow/import
 *
 * Webwow-only. Imports a Webflow site export ZIP (+ optional CMS CSV files)
 * into the current project. Processing happens synchronously in this request
 * (the ZIP is never stored in the database — only a minimal job record).
 */
export async function POST(request: NextRequest) {
  let importId: string | null = null;

  try {
    const payload = await parsePayload(request);

    // Create a minimal job record (no large payload stored in DB)
    const importJob = await createWebflowImport({ payload: { zipFilename: payload.zipFilename, zipBase64: '', csvFiles: [] } });
    importId = importJob.id;
    await updateWebflowImportStatus(importId, 'processing');

    // Process synchronously – avoids large-payload DB roundtrip that caused JSON parse errors
    const processingResult = await processWebflowImport(payload);

    await completeWebflowImport(
      importId,
      processingResult.result,
      processingResult.warnings,
      processingResult.errors,
    );

    if (processingResult.success) {
      await clearAllCache();
    }

    return noCache({
      data: {
        importId,
        status: processingResult.success ? 'completed' : 'failed',
        result: processingResult.result,
        warnings: processingResult.warnings,
        errors: processingResult.errors,
      },
    }, 200);
  } catch (error) {
    console.error('[POST /ycode/api/webflow/import] Error:', error);
    if (importId) {
      try {
        await completeWebflowImport(importId, { pages: 0, collections: 0, items: 0, assets: 0 }, [], [
          error instanceof Error ? error.message : 'Import failed',
        ]);
      } catch { /* ignore cleanup errors */ }
    }
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to create Webflow import job' },
      500,
    );
  }
}

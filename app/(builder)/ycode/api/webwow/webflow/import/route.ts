import { NextRequest } from 'next/server';

import { noCache } from '@/lib/api-response';
import {
  completeWebflowImport,
  createWebflowImport,
  updateWebflowImportStatus,
} from '@/lib/repositories/webflowImportRepository';
import { canManageSettings, extractRoleFromUser } from '@/lib/roles';
import { getAuthUser } from '@/lib/supabase-auth';
import { importWebflowZip, WfImportError } from '@/lib/webwow/import/webflow-zip';
import { ZIP_LIMITS } from '@/lib/webwow/import/webflow-zip/zip';

import type { WfImportOptions, WfWarning } from '@/lib/webwow/import/webflow-zip/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

function formatWarning(warning: WfWarning): string {
  const suffix = (warning.count ?? 1) > 1 ? ` (x${warning.count})` : '';
  return `${warning.code}: ${warning.message}${suffix}`;
}

/**
 * POST /ycode/api/webwow/webflow/import  (owner|admin)
 *
 * Webwow-only v2 importer. Translates a Webflow site export (+ optional CMS CSV
 * exports) into native ycode pages, layer styles, components, collections and
 * interactions. Additive: nothing existing is truncated, and a page-slug
 * collision aborts the run before the first write unless `pageSlugConflict` is
 * `suffix`.
 *
 * multipart/form-data:
 *   webflowZip        File     required
 *   csvFiles          File[]   optional
 *   remoteAssets      'download' | 'skip'   (default 'download')
 *   pageSlugConflict  'fail' | 'suffix'     (default 'fail')
 *   webflowApiToken   string   optional — a Webflow Data API token. When given,
 *                              collection items are read from the REST v2 API
 *                              as typed JSON instead of the CSV export. The
 *                              token is used for this request only: it is never
 *                              written to the import job row (whose payload is
 *                              deliberately empty), never logged and never part
 *                              of the response.
 *   webflowSiteId     string   optional — defaults to the `data-wf-site` id in
 *                              the export.
 */
export async function POST(request: NextRequest) {
  let importId: string | null = null;

  try {
    const auth = await getAuthUser();
    if (!auth) return noCache({ error: 'Not authenticated' }, 401);

    const role = extractRoleFromUser(auth.user);
    const isEditorSession = Boolean((auth.user.app_metadata as Record<string, unknown> | undefined)?.webwow_editor_site);
    if (!role || !canManageSettings(role) || isEditorSession) {
      return noCache({ error: 'Not available for editors' }, 403);
    }

    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return noCache({ error: 'Send the export as multipart/form-data with a "webflowZip" file' }, 415);
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return noCache({ error: 'Could not read the multipart body' }, 400);
    }

    const zipFile = formData.get('webflowZip');
    if (!zipFile || !(zipFile instanceof Blob)) {
      return noCache({ error: 'webflowZip is required' }, 400);
    }
    if (zipFile.size > ZIP_LIMITS.maxUploadBytes) {
      return noCache({ error: `The ZIP is larger than ${Math.round(ZIP_LIMITS.maxUploadBytes / 2 ** 20)} MB` }, 413);
    }

    const zipFilename = zipFile instanceof File ? zipFile.name : 'webflow-export.zip';
    const zip = Buffer.from(await zipFile.arrayBuffer());
    if (zip.length === 0) return noCache({ error: 'The uploaded ZIP is empty' }, 400);

    const csvFiles: { filename: string; content: string }[] = [];
    for (const entry of formData.getAll('csvFiles')) {
      if (!(entry instanceof Blob)) continue;
      const filename = entry instanceof File ? entry.name : `collection-${csvFiles.length + 1}.csv`;
      csvFiles.push({ filename, content: await entry.text() });
    }

    const options: Partial<WfImportOptions> = {};
    const remoteAssets = formData.get('remoteAssets');
    if (remoteAssets === 'skip' || remoteAssets === 'download') options.remoteAssets = remoteAssets;
    const pageSlugConflict = formData.get('pageSlugConflict');
    if (pageSlugConflict === 'fail' || pageSlugConflict === 'suffix') options.pageSlugConflict = pageSlugConflict;

    // Request-scoped only. Nothing below this line persists, logs or echoes it:
    // the job payload stays empty and the response carries counts and warnings.
    const apiToken = formData.get('webflowApiToken');
    if (typeof apiToken === 'string' && apiToken.trim()) {
      const siteId = formData.get('webflowSiteId');
      options.webflowApi = {
        token: apiToken.trim(),
        ...(typeof siteId === 'string' && siteId.trim() ? { siteId: siteId.trim() } : {}),
      };
    }

    const job = await createWebflowImport({ payload: { zipFilename, zipBase64: '', csvFiles: [] } });
    importId = job.id;
    await updateWebflowImportStatus(importId, 'processing');

    const result = await importWebflowZip({ zip, csvFiles, options });

    await completeWebflowImport(
      importId,
      {
        pages: result.counts.pages,
        collections: result.counts.collections,
        items: result.counts.items,
        assets: result.counts.assets.images + result.counts.assets.videos + result.counts.assets.documents + result.counts.assets.cmsImages,
      },
      result.warnings.map(formatWarning),
      result.errors,
    );

    return noCache({
      data: {
        importId,
        status: result.ok ? 'completed' : 'failed',
        counts: result.counts,
        warnings: result.warnings,
        warningSummary: result.warningSummary,
        errors: result.errors,
        pageIds: result.pageIds,
        collectionIds: result.collectionIds,
        cmsSource: result.cmsSource,
        webflowSiteId: result.webflowSiteId,
        durationMs: result.durationMs,
      },
    }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Import failed';
    console.error('[POST /ycode/api/webwow/webflow/import] Error:', error);

    if (importId) {
      try {
        await completeWebflowImport(importId, { pages: 0, collections: 0, items: 0, assets: 0 }, [], [message]);
      } catch {
        // the job record is diagnostics only
      }
    }

    if (error instanceof WfImportError) {
      return noCache({ error: message, code: error.code }, 400);
    }
    return noCache({ error: message }, 500);
  }
}

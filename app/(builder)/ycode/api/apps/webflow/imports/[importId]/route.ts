import { NextRequest } from 'next/server';
import { removeImport } from '@/lib/apps/webflow/migration-service';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * DELETE /ycode/api/apps/webflow/imports/[importId]
 * Remove an import record. The YCode collections that were created by the
 * migration are NOT deleted — they stay around for the user to keep using.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ importId: string }> }
) {
  try {
    const { importId } = await params;
    const removed = await removeImport(importId);

    if (!removed) {
      return noCache({ error: 'Import not found' }, 404);
    }

    return noCache({ data: { success: true } });
  } catch (error) {
    console.error('Error removing Webflow import:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to remove import' },
      500
    );
  }
}

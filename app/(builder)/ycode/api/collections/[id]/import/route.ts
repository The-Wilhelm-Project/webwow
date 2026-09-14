import { NextRequest } from 'next/server';
import { createImport, cleanupStaleImports } from '@/lib/repositories/collectionImportRepository';
import { getCollectionById } from '@/lib/repositories/collectionRepository';
import { noCache } from '@/lib/api-response';
import { getErrorMessage } from '@/lib/csv-utils';

// Disable caching for this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/collections/[id]/import
 * Create a new CSV import job for a collection.
 * The CSV file must already be uploaded to Supabase Storage;
 * the client passes the storage path so the server can read it directly.
 *
 * Body:
 *  - columnMapping: Record<string, string> - Maps CSV column names to field IDs
 *  - totalRows: number - Total number of rows to import
 *  - csvStoragePath: string - Path to the CSV file in Supabase Storage
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Verify collection exists
    const collection = await getCollectionById(id, false);
    if (!collection) {
      return noCache(
        { error: 'Collection not found' },
        404
      );
    }

    const body = await request.json();
    const { columnMapping, totalRows, csvStoragePath } = body;

    // Validate required fields
    if (!columnMapping || typeof columnMapping !== 'object') {
      return noCache(
        { error: 'Column mapping is required' },
        400
      );
    }

    if (!totalRows || typeof totalRows !== 'number' || totalRows <= 0) {
      return noCache(
        { error: 'totalRows is required and must be a positive number' },
        400
      );
    }

    if (!csvStoragePath || typeof csvStoragePath !== 'string') {
      return noCache(
        { error: 'csvStoragePath is required' },
        400
      );
    }

    // Clean up orphaned CSV files from abandoned imports (fire-and-forget)
    cleanupStaleImports().catch(() => {});

    const importJob = await createImport({
      collection_id: id,
      column_mapping: columnMapping,
      total_rows: totalRows,
      csv_storage_path: csvStoragePath,
    });

    return noCache(
      { data: { importId: importJob.id } },
      201
    );
  } catch (error) {
    console.error('Error creating import job:', error);
    return noCache(
      { error: getErrorMessage(error) },
      500
    );
  }
}

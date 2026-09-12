/**
 * Webwow-only type definitions
 *
 * Types for features that exist only in the Webwow fork (not upstream ycode).
 * Kept out of `types/index.ts` so that upstream file stays byte-identical.
 */

// ─── Webflow ZIP export importer ────────────────────────────────────
// Used by lib/services/webflowImportService.ts, lib/repositories/webflowImportRepository.ts
// and app/(builder)/ycode/api/webflow/**. Backed by the `webflow_imports` table
// (database/migrations/20260324000001_create_webflow_imports_table.ts).

export type WebflowImportStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface WebflowCsvFile {
  filename: string;
  content: string;
}

export interface WebflowImportPayload {
  zipFilename: string;
  zipBase64: string;
  csvFiles: WebflowCsvFile[];
}

export interface WebflowImportResult {
  pages: number;
  collections: number;
  items: number;
  assets: number;
}

export interface WebflowImport {
  id: string;
  status: WebflowImportStatus;
  payload: WebflowImportPayload;
  warnings: string[] | null;
  errors: string[] | null;
  result: WebflowImportResult | null;
  created_at: string;
  updated_at: string;
}

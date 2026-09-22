'use client';

/**
 * CSVImportDialog Component
 *
 * Multi-step dialog for importing CSV data into CMS collections.
 * Steps:
 *  1. Upload CSV file
 *  2. Map CSV columns to collection fields
 *  3. Confirm and start import
 *  4. Progress view with polling
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import Icon from '@/components/ui/icon';
import { parseCSVFile, suggestColumnMapping, getFieldTypeLabel, SKIP_COLUMN, AUTO_FIELD_KEYS } from '@/lib/csv-utils';
import type { CollectionField } from '@/types';
import { Label } from '@/components/ui/label';

type ImportStep = 'upload' | 'mapping' | 'confirm' | 'progress' | 'complete';

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mt-4 rounded-lg bg-destructive/10 p-3 text-destructive">
      {message}
    </div>
  );
}

interface ImportStatus {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  totalRows: number;
  processedRows: number;
  failedRows: number;
  errors: string[];
}

interface CSVImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collectionId: string;
  fields: CollectionField[];
  onImportComplete?: () => void;
}

export function CSVImportDialog({
  open,
  onOpenChange,
  collectionId,
  fields,
  onImportComplete,
}: CSVImportDialogProps) {
  // Step state
  const [step, setStep] = useState<ImportStep>('upload');

  // Upload state
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);

  // Mapping state
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});

  // Import state
  const [importId, setImportId] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef(false);

  // Filter out auto-generated and computed fields that shouldn't be mapped
  const mappableFields = fields.filter(
    f => !AUTO_FIELD_KEYS.includes(f.key as typeof AUTO_FIELD_KEYS[number]) && !f.is_computed
  );

  // Reset state when dialog closes
  const resetState = useCallback(() => {
    setStep('upload');
    setFile(null);
    setHeaders([]);
    setRows([]);
    setParseError(null);
    setColumnMapping({});
    setImportId(null);
    setImportStatus(null);
    setImporting(false);
    setError(null);

    abortRef.current = true;
  }, []);

  // Reset on open so the dialog always starts fresh
  useEffect(() => {
    if (open) resetState();
  }, [open, resetState]);

  // Handle close — blocked while import is in progress
  const handleClose = () => {
    if (importing && step === 'progress') return;
    onOpenChange(false);
  };

  // Handle file selection
  const handleFileSelect = useCallback(async (selectedFile: File) => {
    setFile(selectedFile);
    setParseError(null);

    try {
      const parsed = await parseCSVFile(selectedFile);

      if (parsed.headers.length === 0) {
        setParseError('CSV file is empty or has no headers');
        return;
      }

      if (parsed.rows.length === 0) {
        setParseError('CSV file has no data rows');
        return;
      }

      setHeaders(parsed.headers);
      setRows(parsed.rows);

      // Auto-suggest column mapping
      const suggested = suggestColumnMapping(parsed.headers, mappableFields);
      setColumnMapping(suggested);

      setStep('mapping');
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Failed to parse CSV file');
    }
  }, [mappableFields]);

  // Handle drag and drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile && droppedFile.name.endsWith('.csv')) {
      handleFileSelect(droppedFile);
    } else {
      setParseError('Please upload a CSV file');
    }
  }, [handleFileSelect]);

  // Handle file input change
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      handleFileSelect(selectedFile);
    }
  }, [handleFileSelect]);

  // Update column mapping
  const updateMapping = (csvColumn: string, fieldId: string) => {
    setColumnMapping(prev => ({
      ...prev,
      [csvColumn]: fieldId,
    }));
  };

  // Get set of field IDs that are already mapped (for disabling in dropdowns)
  const getMappedFieldIds = (excludeColumn?: string): Set<string> => {
    const mapped = new Set<string>();
    Object.entries(columnMapping).forEach(([col, fieldId]) => {
      if (col !== excludeColumn && fieldId && fieldId !== SKIP_COLUMN) {
        mapped.add(fieldId);
      }
    });
    return mapped;
  };

  const hasMappedColumns = getMappedFieldIds().size > 0;

  // Upload the CSV file to Supabase Storage via presigned URL
  const uploadCSVToStorage = async (): Promise<string> => {
    if (!file) throw new Error('No file selected');

    // 1. Get a presigned upload URL from the server
    const presignResponse = await fetch('/ycode/api/files/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        mimeType: 'text/csv',
        fileSize: file.size,
        category: 'documents',
      }),
    });

    if (!presignResponse.ok) {
      const errorData = await presignResponse.json();
      throw new Error(errorData.error || 'Failed to get upload URL');
    }

    const { data: presignData } = await presignResponse.json();

    // 2. Upload directly to Supabase Storage (bypasses serverless body limit)
    const uploadResponse = await fetch(presignData.signedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      body: file,
    });

    if (!uploadResponse.ok) {
      throw new Error('Failed to upload CSV file to storage');
    }

    return presignData.storagePath;
  };

  // Start import: upload file → create job → poll for progress
  const startImport = async () => {
    setImporting(true);
    setError(null);

    try {
      // Upload CSV to storage first
      const csvStoragePath = await uploadCSVToStorage();

      // Create import job with the storage reference
      const response = await fetch(`/ycode/api/collections/${collectionId}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          columnMapping,
          totalRows: rows.length,
          csvStoragePath,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create import job');
      }

      setImportId(data.data.importId);
      setStep('progress');

      processImport(data.data.importId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start import');
      setImporting(false);
    }
  };

  const MAX_BODY_BYTES = 3_500_000;
  const MAX_BATCH_SIZE = 15;

  /** Strip columns mapped to __skip__ so we only send data the server needs. */
  const stripSkippedColumns = (row: Record<string, string>): Record<string, string> => {
    const stripped: Record<string, string> = {};
    for (const [col, fieldId] of Object.entries(columnMapping)) {
      if (fieldId && fieldId !== SKIP_COLUMN && col in row) {
        stripped[col] = row[col];
      }
    }
    return stripped;
  };

  /** Build the next batch of stripped rows that fits within the body size limit. */
  const buildBatch = (startIndex: number): Record<string, string>[] => {
    const batch: Record<string, string>[] = [];
    let estimatedSize = 0;

    for (let i = startIndex; i < rows.length && batch.length < MAX_BATCH_SIZE; i++) {
      const stripped = stripSkippedColumns(rows[i]);
      const rowSize = Object.values(stripped).reduce((sum, v) => sum + v.length, 0) * 2;
      if (estimatedSize + rowSize > MAX_BODY_BYTES) break;
      batch.push(stripped);
      estimatedSize += rowSize;
    }

    return batch;
  };

  /**
   * Upload a batch of rows as a JSON file to storage via presigned URL.
   * Used when rows are too large for Vercel's request body limit.
   */
  const uploadBatchToStorage = async (batch: Record<string, string>[]): Promise<string> => {
    const json = JSON.stringify(batch);
    const blob = new Blob([json], { type: 'application/json' });

    const presignRes = await fetch('/ycode/api/files/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: `batch-${Date.now()}.json`,
        mimeType: 'application/json',
        fileSize: blob.size,
      }),
    });

    if (!presignRes.ok) {
      const err = await presignRes.json();
      throw new Error(err.error || 'Failed to get batch upload URL');
    }

    const { data: presignData } = await presignRes.json();

    const uploadRes = await fetch(presignData.signedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: blob,
    });

    if (!uploadRes.ok) {
      throw new Error('Failed to upload batch to storage');
    }

    return presignData.storagePath;
  };

  /**
   * Send row batches from local state to the server for processing.
   * Small batches go directly in the body; oversized rows are uploaded
   * to storage so the server downloads only that batch file (not the full CSV).
   */
  const processImport = async (id: string) => {
    abortRef.current = false;
    let currentIndex = 0;

    while (!abortRef.current && currentIndex < rows.length) {
      const batch = buildBatch(currentIndex);

      try {
        let requestBody: Record<string, unknown>;

        if (batch.length > 0) {
          requestBody = { importId: id, rows: batch };
        } else {
          // Row is too large for the body — upload just this single row to storage
          const oversizedRow = stripSkippedColumns(rows[currentIndex]);
          const batchStoragePath = await uploadBatchToStorage([oversizedRow]);
          requestBody = { importId: id, batchStoragePath };
        }

        const response = await fetch('/ycode/api/collections/import/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        if (response.ok) {
          const data = await response.json();
          setImportStatus(data.data);

          const serverProcessed = (data.data.processedRows ?? 0) + (data.data.failedRows ?? 0);
          currentIndex = serverProcessed;

          if (data.data.status === 'completed' || data.data.status === 'failed' || data.data.isComplete) {
            setImporting(false);
            setStep('complete');
            onImportComplete?.();
            return;
          }
        } else {
          // Server returned an error (e.g. 500/OOM) — skip this batch and continue
          console.error(`Process request failed with status ${response.status}`);
          currentIndex += batch.length || 1;
        }

        await new Promise(resolve => setTimeout(resolve, 0));
      } catch (err) {
        // Network error or server crash — skip batch and continue
        console.error('Process error:', err);
        currentIndex += batch.length || 1;
      }
    }

    if (!abortRef.current) {
      try {
        const response = await fetch('/ycode/api/collections/import/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ importId: id }),
        });
        const data = await response.json();
        if (response.ok) setImportStatus(data.data);
      } catch { /* best-effort finalization */ }
      setImporting(false);
      setStep('complete');
      onImportComplete?.();
    }
  };

  // Calculate progress percentage
  const progressPercent = importStatus
    ? Math.round((importStatus.processedRows / importStatus.totalRows) * 100)
    : 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        showCloseButton={!importing}
        className="sm:max-w-lg max-h-[85vh]"
        onInteractOutside={(e) => { if (importing) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (importing) e.preventDefault(); }}
      >
        {/* Step 1: Upload */}
        {step === 'upload' && (
          <>
            <DialogHeader>
              <DialogTitle>Import CSV</DialogTitle>
              <DialogDescription>
                Upload a CSV file to import items into this collection.
              </DialogDescription>
            </DialogHeader>

            <div
              className="mt-4 flex min-h-50 flex-col items-center justify-center rounded-lg border border-dashed border-border p-6 transition-colors hover:border-muted-foreground/50"
              onDragOver={handleDragOver}
              onDrop={handleDrop}
            >
              <input
                type="file"
                accept=".csv"
                onChange={handleInputChange}
                className="hidden"
                id="csv-file-input"
              />

              <Empty>
                <EmptyMedia variant="icon">
                  <Icon name="upload" className="size-4" />
                </EmptyMedia>
                <EmptyTitle>Upload CSV file</EmptyTitle>
                <EmptyDescription>
                  Drag and drop a CSV file here, or click to browse.
                </EmptyDescription>
              </Empty>

              <Button
                variant="secondary"
                onClick={() => document.getElementById('csv-file-input')?.click()}
              >
                Select file
              </Button>
            </div>

            <ErrorBanner message={parseError} />
          </>
        )}

        {/* Step 2: Mapping */}
        {step === 'mapping' && (
          <>
            <DialogHeader>
              <DialogTitle>Map columns to fields</DialogTitle>
              <DialogDescription>
                Match CSV columns to collection fields. {rows.length} rows found.
              </DialogDescription>
            </DialogHeader>

            <div className="overflow-y-auto -my-4 min-h-0 no-scrollbar">
              <div className="divide-y">
                {headers.map(header => {
                  const mappedFieldIds = getMappedFieldIds(header);
                  return (
                    <div key={header} className="flex items-center gap-3 py-4">
                      <div className="w-1/3 truncate">
                        <Label>{header}</Label>
                      </div>
                      <Icon name="chevronRight" className="size-3 text-muted-foreground" />
                      <div className="flex-1">
                        <Select
                          value={columnMapping[header] || SKIP_COLUMN}
                          onValueChange={(value) => updateMapping(header, value)}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Skip this column" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={SKIP_COLUMN}>
                              <span className="opacity-50">—</span>
                            </SelectItem>
                            {mappableFields.map(field => (
                              <SelectItem
                                key={field.id}
                                value={field.id}
                                disabled={mappedFieldIds.has(field.id)}
                              >
                                {field.name} ({getFieldTypeLabel(field.type)})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <ErrorBanner message={error} />

            <DialogFooter className="sm:justify-between">
              <Button variant="secondary" onClick={() => setStep('upload')}>
                Back
              </Button>
              <Button
                onClick={() => setStep('confirm')}
                disabled={!hasMappedColumns}
              >
                Continue
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Step 3: Confirm */}
        {step === 'confirm' && (
          <>
            <DialogHeader>
              <DialogTitle>Confirm import</DialogTitle>
              <DialogDescription>
                Review your import settings before starting.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="rounded-lg bg-input/50 p-4">
                <dl className="space-y-2">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">File</dt>
                    <dd className="font-medium">{file?.name}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Rows to import</dt>
                    <dd className="font-medium">{rows.length}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Columns mapped</dt>
                    <dd className="font-medium">
                      {getMappedFieldIds().size} of {headers.length}
                    </dd>
                  </div>
                </dl>
              </div>

              <p className="text-xs text-muted-foreground">
                Once the import starts, please do not reload the page as it would
                prevent the import from processing remaining rows in the uploaded CSV file.
              </p>
            </div>

            <ErrorBanner message={error} />

            <DialogFooter className="sm:justify-between">
              <Button
                variant="secondary"
                onClick={() => setStep('mapping')}
                disabled={importing}
              >
                Back
              </Button>
              <Button onClick={startImport} disabled={importing}>
                {importing && <Spinner />}
                {importing ? 'Starting...' : 'Start import'}
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Step 4: Progress */}
        {step === 'progress' && (
          <>
            <DialogHeader>
              <DialogTitle>Importing data...</DialogTitle>
              <DialogDescription>
                Please wait, do not reload this page.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {/* Progress bar */}
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Processed <span className="text-foreground">{importStatus?.processedRows ?? 0}</span> out of <span className="text-foreground">{importStatus?.totalRows ?? rows.length} items</span>
                  </span>
                  <span className="font-medium">{progressPercent}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-input">
                  {progressPercent === 0 ? (
                    <div className="h-full w-1/3 animate-indeterminate rounded-full bg-primary/70" />
                  ) : (
                    <div
                      className="h-full bg-primary/70 transition-all duration-300"
                      style={{ width: `${progressPercent}%` }}
                    />
                  )}
                </div>
              </div>

              {importStatus && importStatus.failedRows > 0 && (
                <dl className="space-y-1">
                  <div className="flex justify-between text-destructive">
                    <dt>Failed</dt>
                    <dd>{importStatus.failedRows}</dd>
                  </div>
                </dl>
              )}
            </div>
          </>
        )}

        {/* Step 5: Complete */}
        {step === 'complete' && (
          <>
            <div className="pt-8 text-center">
              <Empty>
                <EmptyMedia variant="icon">
                  <Icon
                    name={importStatus?.status === 'failed' ? 'x' : 'check'}
                    className="size-4"
                  />
                </EmptyMedia>
                <EmptyTitle>
                  {importStatus?.status === 'failed'
                    ? 'Import failed'
                    : 'Import complete'}
                </EmptyTitle>
                <EmptyDescription>
                  {importStatus?.status === 'failed' ? (
                    <>
                      Failed to import items. {importStatus.failedRows} errors occurred.
                    </>
                  ) : (
                    <>
                      Successfully imported {importStatus?.processedRows || 0} items.
                      {(importStatus?.failedRows || 0) > 0 && (
                        <> {importStatus?.failedRows} rows failed.</>
                      )}
                    </>
                  )}
                </EmptyDescription>
              </Empty>

              {importStatus?.errors && importStatus.errors.length > 0 && (
                <div className="mt-6 max-h-48 overflow-y-auto rounded-lg bg-destructive/10 p-3 text-left text-xs text-destructive">
                  <p className="mb-2 font-medium">Issues ({importStatus.errors.length}):</p>
                  <ul className="space-y-1">
                    {importStatus.errors.slice(0, 20).map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                    {importStatus.errors.length > 20 && (
                      <li className="opacity-70">...and {importStatus.errors.length - 20} more</li>
                    )}
                  </ul>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                onClick={() => {
                  onImportComplete?.();
                  handleClose();
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default CSVImportDialog;

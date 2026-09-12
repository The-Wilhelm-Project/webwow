'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

type Step = 'upload' | 'processing' | 'complete';

interface ImportResult {
  importId?: string;
  status: 'completed' | 'failed';
  warnings: string[];
  errors: string[];
  result?: {
    pages: number;
    collections: number;
    items: number;
    assets: number;
  } | null;
}

async function parseResponseSafely(response: Response): Promise<any> {
  const contentType = response.headers.get('content-type') || '';
  const rawText = await response.text();

  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(rawText);
    } catch {
      return { error: rawText || 'Invalid JSON response' };
    }
  }

  return { error: rawText || `HTTP ${response.status}: ${response.statusText}` };
}

interface WebflowImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WebflowImportDialog({
  open,
  onOpenChange,
}: WebflowImportDialogProps) {
  const [step, setStep] = useState<Step>('upload');
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [csvFiles, setCsvFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Abort controller for cancellation
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [open]);

  const resetState = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStep('upload');
    setZipFile(null);
    setCsvFiles([]);
    setLoading(false);
    setResult(null);
    setError(null);
  };

  const handleClose = () => {
    if (loading && step === 'processing') return;
    resetState();
    onOpenChange(false);
  };

  const startImport = async () => {
    if (!zipFile) {
      setError('Bitte ein Webflow ZIP auswählen');
      return;
    }

    setLoading(true);
    setError(null);
    setStep('processing');

    abortRef.current = new AbortController();

    try {
      const formData = new FormData();
      formData.append('webflowZip', zipFile);
      csvFiles.forEach((csvFile) => formData.append('csvFiles', csvFile));

      const response = await fetch('/ycode/api/webflow/import', {
        method: 'POST',
        body: formData,
        signal: abortRef.current.signal,
      });

      const data = await parseResponseSafely(response);

      if (!response.ok) {
        throw new Error(data.error || 'Import fehlgeschlagen');
      }

      setResult({
        importId: data.data?.importId,
        status: data.data?.status ?? 'failed',
        warnings: data.data?.warnings ?? [],
        errors: data.data?.errors ?? [],
        result: data.data?.result ?? null,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Import fehlgeschlagen');
      setResult({ status: 'failed', warnings: [], errors: [] });
    } finally {
      setLoading(false);
      setStep('complete');
    }
  };

  const isCompleted = result?.status === 'completed';

  return (
    <Dialog open={open} onOpenChange={loading && step === 'processing' ? undefined : handleClose}>
      <DialogContent
        showCloseButton={!(loading && step === 'processing')}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Webflow importieren</DialogTitle>
          <DialogDescription>
            Importiert Webflow ZIP + CMS CSV in Webwow (Seiten, Collections, Relationen und Assets).
          </DialogDescription>
        </DialogHeader>

        {step === 'upload' && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="webflow-zip">Webflow ZIP</Label>
              <Input
                id="webflow-zip"
                type="file"
                accept=".zip"
                onChange={(event) => setZipFile(event.target.files?.[0] || null)}
              />
              <p className="text-xs text-muted-foreground">
                Export aus Webflow Site Export.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="webflow-csv">CMS CSV-Dateien</Label>
              <Input
                id="webflow-csv"
                type="file"
                accept=".csv"
                multiple
                onChange={(event) => setCsvFiles(Array.from(event.target.files || []))}
              />
              <p className="text-xs text-muted-foreground">
                Optional mehrere CSVs aus dem Webflow CMS Export.
              </p>
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>
        )}

        {step === 'processing' && (
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2 text-sm">
              <Spinner />
              Import läuft, bitte warten...
            </div>
          </div>
        )}

        {step === 'complete' && (
          <div className="space-y-3">
            {isCompleted ? (
              <p className="text-sm text-emerald-600">Import erfolgreich abgeschlossen.</p>
            ) : (
              <p className="text-sm text-destructive">Import fehlgeschlagen.</p>
            )}

            {result?.result && (
              <div className="text-xs text-muted-foreground space-y-1">
                <p>Seiten: {result.result.pages}</p>
                <p>Collections: {result.result.collections}</p>
                <p>Items: {result.result.items}</p>
                <p>Assets: {result.result.assets}</p>
              </div>
            )}

            {result?.warnings && result.warnings.length > 0 && (
              <div className="text-xs text-amber-600 max-h-32 overflow-y-auto space-y-1">
                {result.warnings.slice(0, 10).map((warning, index) => (
                  <p key={`${warning}-${index}`}>- {warning}</p>
                ))}
              </div>
            )}

            {(error || (result?.errors && result.errors.length > 0)) && (
              <div className="text-xs text-destructive max-h-32 overflow-y-auto space-y-1">
                {error && <p>- {error}</p>}
                {result?.errors?.slice(0, 10).map((item, index) => (
                  <p key={`${item}-${index}`}>- {item}</p>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <Button
            variant="secondary"
            onClick={handleClose}
            disabled={loading && step === 'processing'}
          >
            {step === 'complete' ? 'Schließen' : 'Abbrechen'}
          </Button>
          {step === 'upload' && (
            <Button onClick={startImport} disabled={loading || !zipFile}>
              {loading && <Spinner />}
              Import starten
            </Button>
          )}
          {step === 'complete' && isCompleted && (
            <Button
              onClick={() => {
                window.location.href = '/ycode';
              }}
            >
              Builder neu laden
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

/**
 * Webflow-Import-Dialog.
 *
 * Ruft den **Importer v2** (`/ycode/api/webwow/webflow/import`) auf. v2 übersetzt
 * den Export in das native Modell von ycode (Layer-Styles mit Design-Werten,
 * Komponenten, Collections, Interaktionen), statt das Webflow-Stylesheet daneben
 * auszuliefern. Die alte Route `/ycode/api/webflow/import` (v1) bleibt für
 * Skripte erreichbar, wird aus der Oberfläche aber nicht mehr aufgerufen —
 * siehe docs/IMPORTER.md.
 */

const IMPORT_ENDPOINT = '/ycode/api/webwow/webflow/import';

type Step = 'upload' | 'processing' | 'complete';

interface WfWarning {
  code: string;
  message: string;
  page?: string;
  count?: number;
}

interface WfCounts {
  pages: number;
  folders: number;
  dynamicPages: number;
  collections: number;
  fields: number;
  items: number;
  itemsPublishable: number;
  assets: {
    images: number;
    videos: number;
    documents: number;
    fontFiles: number;
    cmsImages: number;
    failed: number;
    skipped: number;
  };
  styles: number;
  comboStyles: number;
  components: number;
  componentInstances: number;
  interactions: { mappedDefinitions: number; mappedInstances: number; generated: number };
  fonts: number;
  residualCss: { rules: number; bytes: number };
  warnings: number;
}

interface ImportResult {
  importId?: string;
  status: 'completed' | 'failed';
  counts: WfCounts | null;
  warnings: WfWarning[];
  errors: string[];
  durationMs?: number;
}

/** Warnungen nach Ursache gruppiert — jede Gruppe sagt, was der Hinweis bedeutet. */
const WARNING_GROUPS: { id: string; title: string; hint: string; codes: string[] }[] = [
  {
    id: 'css',
    title: 'CSS ohne Entsprechung im Design-Panel',
    hint: 'Bleibt als eingegrenztes Rest-CSS erhalten und wirkt weiter, ist im Builder aber nicht editierbar.',
    codes: ['css_residual', 'css_dropped', 'css_neutralised'],
  },
  {
    id: 'cms',
    title: 'CMS-Zuordnung geraten',
    hint: 'Collection, Feld oder Bindung wurde anhand der Namen erraten — im Builder am Layer prüfen.',
    codes: [
      'collection_guess',
      'field_guess',
      'binding_guess',
      'binding_unbound',
      'reference_unresolved',
      'csv_type_guess',
    ],
  },
  {
    id: 'assets',
    title: 'Dateien und Assets',
    hint: 'Nicht übernommene Dateien. CMS-Bilder liegen nur als CDN-Adresse in den CSVs.',
    codes: ['asset_download_failed', 'asset_skipped', 'asset_missing', 'zip_entry_skipped'],
  },
  {
    id: 'html',
    title: 'HTML und Widgets',
    hint: 'Elemente ohne direkte Entsprechung; Skripte aus dem Export werden nicht übernommen.',
    codes: ['html_unmapped', 'embed_script', 'embed_dropped', 'video_missing_file', 'link_broken', 'page_empty'],
  },
  {
    id: 'ix2',
    title: 'Animationen',
    hint: 'Webflow-Interaktionen ohne Gegenstück in den ycode-Animationen.',
    codes: ['ix2_unsupported_event', 'ix2_unsupported_action', 'ix2_no_targets', 'ix2_ease_approximated'],
  },
  {
    id: 'other',
    title: 'Sonstiges',
    hint: 'Komponenten, Schriftschnitte und umbenannte Seiten.',
    codes: ['component_skipped', 'font_extra_weight', 'slug_suffixed'],
  },
];

const MAX_WARNINGS_PER_GROUP = 6;

function occurrences(warnings: WfWarning[]): number {
  return warnings.reduce((sum, warning) => sum + (warning.count ?? 1), 0);
}

function groupWarnings(warnings: WfWarning[]): { id: string; title: string; hint: string; items: WfWarning[] }[] {
  const known = new Set(WARNING_GROUPS.flatMap((group) => group.codes));
  const groups = WARNING_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    hint: group.hint,
    items: warnings.filter((warning) => group.codes.includes(warning.code)),
  }));
  const rest = warnings.filter((warning) => !known.has(warning.code));
  if (rest.length > 0) {
    const other = groups.find((group) => group.id === 'other');
    if (other) other.items = [...other.items, ...rest];
  }
  return groups.filter((group) => group.items.length > 0);
}

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
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
  const [downloadRemoteAssets, setDownloadRemoteAssets] = useState(true);
  const [suffixSlugConflicts, setSuffixSlugConflicts] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

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
    setDownloadRemoteAssets(true);
    setSuffixSlugConflicts(false);
    setLoading(false);
    setResult(null);
    setError(null);
    setOpenGroups({});
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
      formData.append('remoteAssets', downloadRemoteAssets ? 'download' : 'skip');
      formData.append('pageSlugConflict', suffixSlugConflicts ? 'suffix' : 'fail');

      const response = await fetch(IMPORT_ENDPOINT, {
        method: 'POST',
        body: formData,
        signal: abortRef.current.signal,
      });

      const data = await parseResponseSafely(response);

      if (!response.ok) {
        if (data?.code === 'slug_conflict') {
          throw new Error(
            `${data.error} — Import erneut starten und „Seiten mit belegtem Slug umbenennen“ anhaken, oder die bestehenden Seiten vorher löschen.`,
          );
        }
        throw new Error(data.error || 'Import fehlgeschlagen');
      }

      setResult({
        importId: data.data?.importId,
        status: data.data?.status ?? 'failed',
        counts: data.data?.counts ?? null,
        warnings: data.data?.warnings ?? [],
        errors: data.data?.errors ?? [],
        durationMs: data.data?.durationMs,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Import fehlgeschlagen');
      setResult({ status: 'failed', counts: null, warnings: [], errors: [] });
    } finally {
      setLoading(false);
      setStep('complete');
    }
  };

  const isCompleted = result?.status === 'completed';
  const counts = result?.counts ?? null;
  const groups = groupWarnings(result?.warnings ?? []);

  return (
    <Dialog open={open} onOpenChange={loading && step === 'processing' ? undefined : handleClose}>
      <DialogContent
        showCloseButton={!(loading && step === 'processing')}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Webflow importieren</DialogTitle>
          <DialogDescription>
            Übersetzt einen Webflow-Export in Webwow: Seiten, Layer-Styles mit Design-Werten,
            Komponenten, Collections, Bindungen und Interaktionen.
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
                Optional mehrere CSVs aus dem Webflow CMS Export. Ohne sie bleiben Collection-Listen leer.
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <Checkbox
                  id="webflow-remote-assets"
                  className="mt-0.5"
                  checked={downloadRemoteAssets}
                  onCheckedChange={(checked) => setDownloadRemoteAssets(checked === true)}
                />
                <Label htmlFor="webflow-remote-assets" className="text-xs font-normal leading-snug">
                  <span className="block">
                    CMS-Bilder von Webflows CDN laden
                    <span className="block text-muted-foreground">
                      Aus, wenn der Server das CDN nicht erreicht — der Import läuft dann deutlich schneller.
                    </span>
                  </span>
                </Label>
              </div>

              <div className="flex items-start gap-2">
                <Checkbox
                  id="webflow-slug-suffix"
                  className="mt-0.5"
                  checked={suffixSlugConflicts}
                  onCheckedChange={(checked) => setSuffixSlugConflicts(checked === true)}
                />
                <Label htmlFor="webflow-slug-suffix" className="text-xs font-normal leading-snug">
                  <span className="block">
                    Seiten mit belegtem Slug umbenennen
                    <span className="block text-muted-foreground">
                      Aus: Der Import bricht ab, bevor etwas geschrieben wird. An: Die Seite bekommt -2, -3, …
                    </span>
                  </span>
                </Label>
              </div>
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
            <p className="text-xs text-muted-foreground">
              Der Export wird vollständig übersetzt (CSS → Layer-Styles, wiederkehrende Bereiche →
              Komponenten, CSV → Collections). Das dauert bei großen Sites einige Minuten.
            </p>
          </div>
        )}

        {step === 'complete' && (
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            {isCompleted ? (
              <p className="text-sm text-emerald-600">
                Import abgeschlossen
                {typeof result?.durationMs === 'number'
                  ? ` (${(result.durationMs / 1000).toFixed(1)} s)`
                  : ''}
                .
              </p>
            ) : (
              <p className="text-sm text-destructive">Import fehlgeschlagen.</p>
            )}

            {counts && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Seiten</dt>
                <dd>
                  {counts.pages}
                  {counts.dynamicPages > 0 ? ` (${counts.dynamicPages} dynamisch)` : ''}
                  {counts.folders > 0 ? `, ${counts.folders} Ordner` : ''}
                </dd>

                <dt className="text-muted-foreground">Collections</dt>
                <dd>
                  {counts.collections} mit {counts.fields} Feldern, {counts.items} Einträgen
                </dd>

                <dt className="text-muted-foreground">Layer-Styles</dt>
                <dd>
                  {counts.styles}
                  {counts.comboStyles > 0 ? ` (${counts.comboStyles} Combo)` : ''}
                </dd>

                <dt className="text-muted-foreground">Komponenten</dt>
                <dd>
                  {counts.components}
                  {counts.componentInstances > 0 ? ` (${counts.componentInstances} Instanzen)` : ''}
                </dd>

                <dt className="text-muted-foreground">Interaktionen</dt>
                <dd>
                  {counts.interactions.mappedInstances + counts.interactions.generated}
                  {` (${counts.interactions.mappedInstances} aus Webflow, ${counts.interactions.generated} erzeugt)`}
                </dd>

                <dt className="text-muted-foreground">Assets</dt>
                <dd>
                  {counts.assets.images +
                    counts.assets.videos +
                    counts.assets.documents +
                    counts.assets.fontFiles +
                    counts.assets.cmsImages}
                  {counts.assets.failed > 0 ? `, ${counts.assets.failed} fehlgeschlagen` : ''}
                  {counts.assets.skipped > 0 ? `, ${counts.assets.skipped} übersprungen` : ''}
                </dd>

                <dt className="text-muted-foreground">Schriften</dt>
                <dd>{counts.fonts}</dd>

                <dt className="text-muted-foreground">Rest-CSS</dt>
                <dd>
                  {counts.residualCss.rules === 0
                    ? 'keins'
                    : `${counts.residualCss.rules} Regeln, ${formatKb(counts.residualCss.bytes)}`}
                </dd>
              </dl>
            )}

            {groups.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium">
                  {occurrences(result?.warnings ?? [])} Hinweise
                </p>
                {groups.map((group) => {
                  const isOpen = openGroups[group.id] === true;
                  return (
                    <div key={group.id} className="rounded-md border border-border/60">
                      <button
                        type="button"
                        className="flex w-full cursor-pointer items-center justify-between gap-2 px-2 py-1.5 text-left text-xs"
                        onClick={() =>
                          setOpenGroups((current) => ({ ...current, [group.id]: !current[group.id] }))
                        }
                      >
                        <span className="text-amber-600">{group.title}</span>
                        <span className="text-muted-foreground">
                          {occurrences(group.items)} {isOpen ? '▾' : '▸'}
                        </span>
                      </button>
                      {isOpen && (
                        <div className="space-y-1 border-t border-border/60 px-2 py-1.5 text-xs">
                          <p className="text-muted-foreground">{group.hint}</p>
                          {group.items.slice(0, MAX_WARNINGS_PER_GROUP).map((warning, index) => (
                            <p key={`${warning.code}-${index}`} className="text-muted-foreground">
                              <span className="font-mono">{warning.code}</span>
                              {warning.page ? ` · ${warning.page}` : ''} — {warning.message}
                              {(warning.count ?? 1) > 1 ? ` (${warning.count}×)` : ''}
                            </p>
                          ))}
                          {group.items.length > MAX_WARNINGS_PER_GROUP && (
                            <p className="text-muted-foreground">
                              … und {group.items.length - MAX_WARNINGS_PER_GROUP} weitere
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
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

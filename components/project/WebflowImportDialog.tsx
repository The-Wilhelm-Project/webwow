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
import { buildImportFormData, describeSources } from '@/lib/webwow/import/webflow-zip/import-form';

/**
 * Webflow-Import-Dialog.
 *
 * Ruft den **Importer v2** (`/ycode/api/webwow/webflow/import`) auf. v2 übersetzt
 * den Export in das native Modell von ycode (Layer-Styles mit Design-Werten,
 * Komponenten, Collections, Interaktionen), statt das Webflow-Stylesheet daneben
 * auszuliefern. Die alte Route `/ycode/api/webflow/import` (v1) bleibt für
 * Skripte erreichbar, wird aus der Oberfläche aber nicht mehr aufgerufen —
 * siehe docs/IMPORTER.md.
 *
 * Ablauf wie im alten Dialog: **Website → Export-ZIP → CMS-CSV-Dateien →
 * Erweitert**, davor eine Zusammenfassung der Quellen. Die Website ist
 * optional und liefert, was der Export nicht hat (CMS-Werte, Bilder,
 * Detailseiten, die exakte Feld-Zuordnung).
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

interface WfSiteCounts {
  pages: number;
  failed: number;
  valuesFilled: number;
  itemsAdded: number;
  collectionsBuilt: number;
  slotsBound: number;
}

interface ImportResult {
  importId?: string;
  status: 'completed' | 'failed';
  counts: WfCounts | null;
  warnings: WfWarning[];
  errors: string[];
  durationMs?: number;
  cmsSource?: 'csv' | 'api' | 'mixed' | 'site';
  webflowSiteId?: string;
  site?: WfSiteCounts;
}

/** Warnungen nach Ursache gruppiert — jede Gruppe sagt, was der Hinweis bedeutet. */
const WARNING_GROUPS: { id: string; title: string; hint: string; codes: string[] }[] = [
  {
    id: 'css',
    title: 'CSS ohne Entsprechung im Design-Panel',
    hint: 'Bleibt als eingegrenztes Rest-CSS erhalten und wirkt weiter, ist im Builder aber nicht editierbar.',
    codes: ['css_residual', 'css_dropped', 'css_neutralised', 'css_state_dropped'],
  },
  {
    id: 'cms',
    title: 'CMS-Zuordnung geraten',
    hint: 'Collection, Feld oder Bindung wurde anhand der Namen erraten — im Builder am Layer prüfen. Mit Website-Adresse entfällt das Raten für jeden Slot, der auf der Live-Seite einen Wert zeigt.',
    codes: [
      'collection_guess',
      'field_guess',
      'binding_guess',
      'binding_unbound',
      'reference_unresolved',
      'csv_type_guess',
      'timezone_set',
    ],
  },
  {
    id: 'site',
    title: 'Website (Live-Seite)',
    hint: 'Was von der veröffentlichten Seite geholt wurde — und was nicht erreichbar war. Fehler auf der Website brechen den Import nicht ab.',
    codes: [
      'site_unreachable',
      'site_page_failed',
      'site_page_skipped',
      'cms_site_only',
      'cms_site_item_added',
      'cms_site_value_filled',
      'seo_from_site',
      'locales_collapsed',
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
    codes: [
      'html_unmapped',
      'embed_script',
      'embed_dropped',
      'video_missing_file',
      'link_broken',
      'page_empty',
      'widget_partial',
      'widget_skipped',
      'widget_unsupported',
    ],
  },
  {
    id: 'ix2',
    title: 'Animationen',
    hint: 'Webflow-Interaktionen ohne Gegenstück in den ycode-Animationen.',
    codes: ['ix2_unsupported_event', 'ix2_unsupported_action', 'ix2_no_targets', 'ix2_ease_approximated'],
  },
  {
    id: 'api',
    title: 'Webflow-API',
    hint: 'Meldungen zur optionalen CMS-Quelle „Webflow Data API“ — welche Collections zusätzlich kamen und welche Felder nicht 1:1 abbildbar waren.',
    codes: ['cms_api_extra', 'cms_api_partial'],
  },
  {
    id: 'other',
    title: 'Sonstiges',
    hint: 'Komponenten, Schriftschnitte und umbenannte Seiten.',
    codes: ['component_skipped', 'font_extra_weight', 'slug_suffixed'],
  },
];

const MAX_WARNINGS_PER_GROUP = 6;

/** Die abschaltbaren Widget-Übersetzer (`options.widgets`, siehe widgets-native.ts). */
const WIDGET_SWITCHES: { key: string; label: string }[] = [
  { key: 'slider', label: 'Slider' },
  { key: 'tabs', label: 'Tabs' },
  { key: 'lightbox', label: 'Lightbox' },
  { key: 'form', label: 'Formulare' },
  { key: 'columns', label: 'Spalten' },
  { key: 'richText', label: 'Rich Text' },
  { key: 'video', label: 'Video (YouTube/Vimeo)' },
  { key: 'lottie', label: 'Lottie' },
  { key: 'codeBlock', label: 'Code-Block' },
  { key: 'fileUpload', label: 'Datei-Upload' },
  { key: 'map', label: 'Karte' },
  { key: 'search', label: 'Suche' },
  { key: 'locales', label: 'Sprachwahl' },
  { key: 'pagination', label: 'Paginierung' },
  { key: 'conditionalVisibility', label: 'Bedingte Sichtbarkeit' },
  { key: 'bgVideoControl', label: 'Video-Steuerung' },
  { key: 'iconFont', label: 'Webflow-Icons' },
  { key: 'navbarVariants', label: 'Navbar-Varianten' },
  { key: 'unsupportedWidgets', label: 'Users/Ecommerce melden' },
  { key: 'badge', label: 'Webflow-Badge entfernen' },
];

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

function formatSize(bytes: number): string {
  if (bytes >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function isZipFile(file: File): boolean {
  return /\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}

function isCsvFile(file: File): boolean {
  return /\.csv$/i.test(file.name) || file.type === 'text/csv';
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
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [csvFiles, setCsvFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [downloadRemoteAssets, setDownloadRemoteAssets] = useState(true);
  const [suffixSlugConflicts, setSuffixSlugConflicts] = useState(false);
  const [useDataApi, setUseDataApi] = useState(false);
  const [apiToken, setApiToken] = useState('');
  const [apiSiteId, setApiSiteId] = useState('');
  const [widgets, setWidgets] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(WIDGET_SWITCHES.map((w) => [w.key, true])),
  );
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  // Abort controller for cancellation
  const abortRef = useRef<AbortController | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);
  const csvInputRef = useRef<HTMLInputElement | null>(null);

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
    setWebsiteUrl('');
    setZipFile(null);
    setCsvFiles([]);
    setDragOver(false);
    setAdvancedOpen(false);
    setDownloadRemoteAssets(true);
    setSuffixSlugConflicts(false);
    setUseDataApi(false);
    setApiToken('');
    setApiSiteId('');
    setWidgets(Object.fromEntries(WIDGET_SWITCHES.map((w) => [w.key, true])));
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

  const addCsvFiles = (files: File[]) => {
    const accepted = files.filter(isCsvFile);
    if (accepted.length === 0) return;
    setCsvFiles((current) => {
      const names = new Set(current.map((f) => f.name));
      return [...current, ...accepted.filter((f) => !names.has(f.name))];
    });
  };

  const removeCsvFile = (index: number) => {
    setCsvFiles((current) => current.filter((_, i) => i !== index));
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    const files = Array.from(event.dataTransfer.files || []);
    const zip = files.find(isZipFile);
    if (zip) {
      setZipFile(zip);
      setError(null);
    }
    addCsvFiles(files);
  };

  const startImport = async () => {
    if (!zipFile) {
      setError('Bitte ein Webflow-Export-ZIP auswählen');
      return;
    }

    setLoading(true);
    setError(null);
    setStep('processing');

    abortRef.current = new AbortController();

    try {
      const formData = buildImportFormData({
        zipFile,
        csvFiles,
        websiteUrl,
        downloadRemoteAssets,
        suffixSlugConflicts,
        useDataApi,
        apiToken,
        apiSiteId,
        widgets,
      });

      const response = await fetch(IMPORT_ENDPOINT, {
        method: 'POST',
        body: formData,
        signal: abortRef.current.signal,
      });

      const data = await parseResponseSafely(response);

      if (!response.ok) {
        if (typeof data?.code === 'string' && data.code.startsWith('webflow_api_')) {
          throw new Error(
            `${data.error} — oder das Häkchen „CMS-Inhalte über die Webflow-API laden“ entfernen und mit den CSVs importieren.`,
          );
        }
        if (data?.code === 'website_invalid') {
          throw new Error(
            `${data.error} — die Website-Adresse prüfen (zum Beispiel https://www.beispiel.de) oder das Feld leer lassen.`,
          );
        }
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
        cmsSource: data.data?.cmsSource,
        webflowSiteId: data.data?.webflowSiteId,
        site: data.data?.site,
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
  const sources = describeSources({
    hasZip: !!zipFile,
    websiteUrl,
    csvCount: csvFiles.length,
    useDataApi: useDataApi && apiToken.trim().length > 0,
    downloadRemoteAssets,
  });
  const cmsSourceLabel =
    result?.cmsSource === 'api'
      ? ' — aus der Webflow-API'
      : result?.cmsSource === 'mixed'
        ? ' — aus Webflow-API und CSVs'
        : result?.cmsSource === 'site'
          ? ' — von der Website'
          : '';

  return (
    <Dialog open={open} onOpenChange={loading && step === 'processing' ? undefined : handleClose}>
      <DialogContent
        showCloseButton={!(loading && step === 'processing')}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Webflow importieren</DialogTitle>
          <DialogDescription>
            Website angeben, Export-ZIP und CMS-CSV-Dateien hochladen — Webwow übersetzt alles in
            Seiten, Layer-Styles mit Design-Werten, Komponenten, Collections, Bindungen und Interaktionen.
          </DialogDescription>
        </DialogHeader>

        {step === 'upload' && (
          <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
            {/* 1. Website */}
            <div className="space-y-2">
              <Label htmlFor="webflow-website">1. Website</Label>
              <Input
                id="webflow-website"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://www.beispiel.de (optional)"
                value={websiteUrl}
                onChange={(event) => setWebsiteUrl(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Von der Live-Seite holt Webwow CMS-Inhalte, Bilder und Detailseiten, die im Export fehlen.
              </p>
            </div>

            {/* 2. Export ZIP */}
            <div className="space-y-2">
              <Label htmlFor="webflow-zip">2. Webflow-Export (ZIP)</Label>
              <div
                role="button"
                tabIndex={0}
                data-testid="webflow-zip-dropzone"
                className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed px-3 py-4 text-center text-xs transition-colors ${
                  dragOver ? 'border-primary bg-primary/5' : 'border-border/80 hover:bg-muted/40'
                }`}
                onClick={() => zipInputRef.current?.click()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    zipInputRef.current?.click();
                  }
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
              >
                {zipFile ? (
                  <>
                    <span className="font-medium">{zipFile.name}</span>
                    <span className="text-muted-foreground">{formatSize(zipFile.size)}</span>
                  </>
                ) : (
                  <>
                    <span className="font-medium">ZIP hierher ziehen oder klicken</span>
                    <span className="text-muted-foreground">Export aus Webflow: Site settings → Export code</span>
                  </>
                )}
              </div>
              <input
                ref={zipInputRef}
                id="webflow-zip"
                type="file"
                accept=".zip,application/zip"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0] || null;
                  setZipFile(file);
                  if (file) setError(null);
                }}
              />
              {zipFile && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setZipFile(null);
                      if (zipInputRef.current) zipInputRef.current.value = '';
                    }}
                  >
                    Entfernen
                  </Button>
                </div>
              )}
            </div>

            {/* 3. CMS CSVs */}
            <div className="space-y-2">
              <Label htmlFor="webflow-csv">3. CMS-CSV-Dateien</Label>
              <Input
                ref={csvInputRef}
                id="webflow-csv"
                type="file"
                accept=".csv,text/csv"
                multiple
                onChange={(event) => {
                  addCsvFiles(Array.from(event.target.files || []));
                  if (csvInputRef.current) csvInputRef.current.value = '';
                }}
              />
              <p className="text-xs text-muted-foreground">
                Optional, mehrere Dateien aus dem Webflow-CMS-Export. Ohne CSV und ohne Website bleiben
                Collection-Listen leer.
              </p>
              {csvFiles.length > 0 && (
                <ul className="space-y-1 text-xs" data-testid="webflow-csv-list">
                  {csvFiles.map((file, index) => (
                    <li key={`${file.name}-${index}`} className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2 py-1">
                      <span className="truncate">
                        {file.name} <span className="text-muted-foreground">({formatSize(file.size)})</span>
                      </span>
                      <Button
                        type="button" variant="ghost"
                        size="sm" onClick={() => removeCsvFile(index)}
                      >
                        Entfernen
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 4. Erweitert */}
            <div className="rounded-md border border-border/60">
              <button
                type="button"
                data-testid="webflow-advanced-toggle"
                className="flex w-full cursor-pointer items-center justify-between gap-2 px-2 py-1.5 text-left text-xs"
                onClick={() => setAdvancedOpen((current) => !current)}
              >
                <span className="font-medium">4. Erweitert</span>
                <span className="text-muted-foreground">{advancedOpen ? '▾' : '▸'}</span>
              </button>
              {advancedOpen && (
                <div className="space-y-3 border-t border-border/60 p-2">
                  <div className="space-y-2">
                    <div className="flex items-start gap-2">
                      <Checkbox
                        id="webflow-use-api"
                        className="mt-0.5"
                        checked={useDataApi}
                        onCheckedChange={(checked) => setUseDataApi(checked === true)}
                      />
                      <Label htmlFor="webflow-use-api" className="text-xs font-normal leading-snug">
                        <span className="block">
                          CMS-Inhalte über die Webflow-API laden
                          <span className="block text-muted-foreground">
                            Genauer als die CSVs: jedes Feld kommt mit seinem echten Typ (Mehrfachbilder,
                            Referenzen, Auswahllisten, Datum, Zahl, Schalter) und echten Bild-URLs. Die API hat
                            Vorrang vor CSV und Website.
                          </span>
                        </span>
                      </Label>
                    </div>

                    {useDataApi && (
                      <div className="space-y-2 pl-6">
                        <div className="space-y-1">
                          <Label htmlFor="webflow-api-token">Webflow API-Token</Label>
                          <Input
                            id="webflow-api-token"
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="Site-Token aus Webflow"
                            value={apiToken}
                            onChange={(event) => setApiToken(event.target.value)}
                          />
                          <p className="text-xs text-muted-foreground">
                            In Webflow unter <span className="font-mono">Site settings → Apps &amp; integrations → API access</span>{' '}
                            erzeugen. Benötigte Rechte: <span className="font-mono">CMS: read</span> und{' '}
                            <span className="font-mono">Sites: read</span> — der Import liest ausschließlich.
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Der Token wird <strong>nicht gespeichert</strong>: er gilt nur für diesen einen
                            Import, steht in keiner Datenbank, in keinem Log und in keiner Antwort.
                          </p>
                        </div>

                        <div className="space-y-1">
                          <Label htmlFor="webflow-api-site">Site-ID (optional)</Label>
                          <Input
                            id="webflow-api-site"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="wird aus dem Export gelesen"
                            value={apiSiteId}
                            onChange={(event) => setApiSiteId(event.target.value)}
                          />
                          <p className="text-xs text-muted-foreground">
                            Leer lassen — die Site-ID steht im Export (<span className="font-mono">data-wf-site</span>).
                            Nur nötig, wenn der Token auf eine andere Site zeigt.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex items-start gap-2">
                    <Checkbox
                      id="webflow-remote-assets"
                      className="mt-0.5"
                      checked={downloadRemoteAssets}
                      onCheckedChange={(checked) => setDownloadRemoteAssets(checked === true)}
                    />
                    <Label htmlFor="webflow-remote-assets" className="text-xs font-normal leading-snug">
                      <span className="block">
                        Assets aus dem Webflow-CDN laden
                        <span className="block text-muted-foreground">
                          CMS-Bilder aus CSV, API und Website. Aus, wenn der Server das CDN nicht erreicht — der
                          Import läuft dann deutlich schneller.
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

                  <div className="space-y-1">
                    <p className="text-xs">Widget-Übersetzer</p>
                    <p className="text-xs text-muted-foreground">
                      Ein abgeschaltetes Widget wird generisch übernommen (Box mit Hinweis) statt nativ nachgebaut.
                    </p>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                      {WIDGET_SWITCHES.map((widget) => (
                        <div key={widget.key} className="flex items-center gap-2">
                          <Checkbox
                            id={`webflow-widget-${widget.key}`}
                            checked={widgets[widget.key] !== false}
                            onCheckedChange={(checked) =>
                              setWidgets((current) => ({ ...current, [widget.key]: checked === true }))
                            }
                          />
                          <Label htmlFor={`webflow-widget-${widget.key}`} className="text-xs font-normal">
                            {widget.label}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 5. Quellen */}
            <p className="text-xs text-muted-foreground" data-testid="webflow-sources">
              <span className="font-medium text-foreground">Quellen:</span> Design: {sources.design} · CMS-Daten:{' '}
              {sources.cms} · Bilder: {sources.images}
            </p>

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
              Komponenten, CSV → Collections{websiteUrl.trim() ? ', Live-Seite → CMS-Werte und Bilder' : ''}).
              Das dauert bei großen Sites einige Minuten.
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
                  {cmsSourceLabel}
                </dd>

                {result?.site && (
                  <>
                    <dt className="text-muted-foreground">Website</dt>
                    <dd>
                      {result.site.pages} Seiten gelesen
                      {result.site.failed > 0 ? ` (${result.site.failed} nicht)` : ''}
                      {result.site.valuesFilled > 0 ? `, ${result.site.valuesFilled} Werte ergänzt` : ''}
                      {result.site.itemsAdded > 0 ? `, ${result.site.itemsAdded} Einträge hinzugefügt` : ''}
                      {result.site.collectionsBuilt > 0 ? `, ${result.site.collectionsBuilt} Collections aufgebaut` : ''}
                      {result.site.slotsBound > 0 ? `, ${result.site.slotsBound} Bindungen aus der Live-Seite` : ''}
                    </dd>
                  </>
                )}

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
                  {counts.assets.cmsImages > 0 ? ` (${counts.assets.cmsImages} CMS-Bilder)` : ''}
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

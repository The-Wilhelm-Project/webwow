/**
 * Webflow ZIP export importer
 *
 * WEBWOW-ONLY FEATURE — this module does not exist upstream (ycode). Keep it
 * free of fork copies of upstream helpers; it must only consume upstream's
 * current public API so `git merge upstream/main` stays conflict-free.
 *
 * Converts a Webflow "site export" ZIP (HTML/CSS/assets) plus optional CMS CSV
 * exports into a Ycode project dump (`ProjectExportData`) and either imports it
 * through upstream's `importProject()` or hands it back for download as a
 * `.ycode` file (routes: `app/(builder)/ycode/api/webflow/**`).
 *
 * Upstream integration points:
 * - `lib/services/projectService`: `importProject(manifest, data, files)` —
 *   asset binaries are passed as `ExportFile[]`; upstream's `restoreAssetFiles`
 *   uploads them to storage and rewrites `assets.storage_path`/`public_url`.
 *   `manifest.lastMigration` is set like upstream's `exportProject()` does so
 *   no migrations are replayed on import.
 * - `lib/asset-utils#getAssetProxyUrl`: `/a/<hash>/<slug>.<ext>` URLs used when
 *   rewriting `url()` references in imported CSS / inline styles.
 * - `lib/csv-utils#parseCSVText`, `lib/text-format-utils#stringToTiptapContent`,
 *   `lib/sitemap-utils#getDefaultSitemapSettings`, `lib/asset-constants`.
 * - Inline CMS bindings use upstream's canonical `<ycode-inline-variable>` tag,
 *   layers reference styles via `styleIds`, and the imported settings rows use
 *   upstream's `ycode_version` / `ycode_badge` keys.
 *
 * NOTE: `importProject()` truncates all content tables — a Webflow import
 * replaces the current project (same semantics as importing a `.ycode` file).
 */

import { randomUUID } from 'crypto';
import path from 'path';
import JSZip from 'jszip';
import { parse, type HTMLElement, type Node as HtmlNode, NodeType } from 'node-html-parser';
import { noCache } from '@/lib/api-response';
import { STORAGE_FOLDERS } from '@/lib/asset-constants';
import { parseCSVText } from '@/lib/csv-utils';
import { getAssetProxyUrl } from '@/lib/asset-utils';
import { getKnexClient } from '@/lib/knex-client';
import { mergeClassStack } from '@/lib/layer-style-resolve';
import { getDefaultSitemapSettings } from '@/lib/sitemap-utils';
import { stringToTiptapContent } from '@/lib/text-format-utils';
import {
  getLatestMigrationName,
  importProject,
  type ExportFile,
  type ProjectExportData,
  type ProjectManifest,
} from '@/lib/services/projectService';
import type { Breakpoint, CollectionFieldType, FieldVariable, Layer, LayerInteraction } from '@/types';
import type { WebflowImportPayload, WebflowImportResult } from '@/types/webwow';

interface ParsedWebflowCsv {
  name: string;
  headers: string[];
  rows: Record<string, string>[];
  webflowCollectionId: string;
}

interface NormalizedCollection {
  id: string;
  webflowCollectionId: string;
  name: string;
  headers: string[];
  rows: Record<string, string>[];
}

interface NormalizedField {
  id: string;
  collectionId: string;
  csvHeader: string;
  name: string;
  key: string | null;
  type: CollectionFieldType;
  order: number;
  referenceCollectionId: string | null;
  /** Asset column holding several URLs per row (Webflow multi-image gallery). */
  isMultiAsset: boolean;
}

interface ImportedAsset {
  id: string;
  storagePath: string;
  /** Upstream asset proxy URL (`/a/<hash>/<slug>.<ext>`), used for CSS `url()` rewriting. */
  proxyUrl: string | null;
}

/**
 * Collects asset binaries (as upstream `ExportFile`s) and the matching `assets`
 * rows while the ZIP is processed. Nothing is written to storage or the
 * database here — upstream's `importProject()`/`restoreAssetFiles()` does that,
 * which keeps the pure `convert` path free of side effects.
 */
interface AssetCollector {
  files: ExportFile[];
  rows: Record<string, unknown>[];
}

interface ProcessWebflowImportResponse {
  success: boolean;
  result: WebflowImportResult;
  warnings: string[];
  errors: string[];
}

interface ConvertWebflowToProjectExportResponse extends ProcessWebflowImportResponse {
  exportData?: ProjectExportData;
}

interface BuiltPageEntry {
  page: Record<string, unknown>;
  pageLayers: Record<string, unknown>;
}

interface LayerStyleBuildResult {
  layerStyleRows: Record<string, unknown>[];
  styleIdByClassSignature: Map<string, string>;
}

const CSV_META_COLUMNS = new Set([
  'Collection ID',
  'Locale ID',
  'Item ID',
  'Archived',
  'Draft',
  'Created On',
  'Updated On',
  'Published On',
]);

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.avif', '.bmp', '.tif', '.tiff']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.avi', '.ogg']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.flac']);
const SAFE_HTML_TAGS = new Set([
  'div',
  'section',
  'header',
  'footer',
  'main',
  'nav',
  'article',
  'aside',
  'ul',
  'ol',
  'li',
  'form',
  'span',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'em',
  'small',
  'label',
  'input',
  'textarea',
  'select',
  'option',
  'button',
  'blockquote',
  'figure',
  'figcaption',
]);

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function stripTopLevelFolder(filePath: string): string {
  const parts = normalizeSlashes(filePath).split('/').filter(Boolean);
  if (parts.length <= 1) {
    return parts[0] || '';
  }
  return parts.slice(1).join('/');
}

function detectTopLevelFolder(zip: JSZip): string | null {
  const entries = Object.keys(zip.files);
  const topLevels = new Set<string>();
  for (const entry of entries) {
    const first = entry.split('/')[0];
    if (first) topLevels.add(first);
  }
  if (topLevels.size === 1) {
    const candidate = [...topLevels][0];
    if (zip.files[candidate + '/']?.dir) return candidate;
  }
  return null;
}

function inferMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) {
    if (extension === '.svg') return 'image/svg+xml';
    if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
    return `image/${extension.slice(1)}`;
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    if (extension === '.mov') return 'video/quicktime';
    return `video/${extension.slice(1)}`;
  }
  if (AUDIO_EXTENSIONS.has(extension)) {
    return `audio/${extension.slice(1)}`;
  }
  if (extension === '.css') return 'text/css';
  if (extension === '.js') return 'application/javascript';
  if (extension === '.woff') return 'font/woff';
  if (extension === '.woff2') return 'font/woff2';
  if (extension === '.ttf') return 'font/ttf';
  if (extension === '.otf') return 'font/otf';
  return 'application/octet-stream';
}

function inferAssetFieldType(urlOrPath: string): CollectionFieldType {
  const lower = urlOrPath.toLowerCase();
  const extension = path.extname(lower);
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return 'document';
}

function isAssetFieldType(type: CollectionFieldType): boolean {
  return type === 'image' || type === 'video' || type === 'audio' || type === 'document';
}

/**
 * A Webflow multi-image column exports as one cell holding several URLs separated
 * by `;` (or `,`). ycode's asset fields hold a single asset, so the importer keeps
 * the first URL and flags the field so the binder can recognise a gallery list.
 */
function splitAssetUrls(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(/[;,]\s*(?=https?:\/\/)/g).map(part => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [trimmed];
}

/**
 * Webflow rich-text columns export as HTML. ycode's text fields render their value
 * verbatim, so the markup would show up as literal `<p>` tags; flatten it to text
 * with blank lines between blocks instead.
 */
function htmlToPlainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|blockquote)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeHtml(value: string): boolean {
  return /<(p|div|h[1-6]|ul|ol|li|br|strong|em|span|a|img)\b[^>]*>/i.test(value);
}

function sanitizeCollectionName(name: string): string {
  return name.replace(/\s+/g, ' ').trim() || `Collection ${randomUUID().slice(0, 6)}`;
}

function mapFieldKeyFromHeader(header: string): string | null {
  const normalized = header.trim().toLowerCase();
  if (normalized === 'name') return 'name';
  if (normalized === 'slug') return 'slug';
  if (normalized === 'created on') return 'created_at';
  if (normalized === 'updated on') return 'updated_at';
  return null;
}

function splitReferenceCandidates(value: string): string[] {
  if (!value.trim()) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map(v => String(v).trim()).filter(Boolean);
      }
    } catch {
      // fall through
    }
  }

  if (trimmed.includes(',')) {
    return trimmed.split(',').map(v => v.trim()).filter(Boolean);
  }

  if (trimmed.includes(';')) {
    return trimmed.split(';').map(v => v.trim()).filter(Boolean);
  }

  return [trimmed];
}

function slugFromFilename(filename: string): string {
  const base = path.basename(filename, '.html').toLowerCase();
  if (base === 'index') return '';
  return base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function resolveHref(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '#';
  if (trimmed.startsWith('#') || trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('mailto:') || trimmed.startsWith('tel:')) {
    return trimmed;
  }
  if (trimmed.endsWith('.html')) {
    return `/${slugFromFilename(trimmed)}`;
  }
  return trimmed;
}

function classifyPrimitiveType(values: string[]): CollectionFieldType | null {
  if (values.length === 0) return 'text';

  const boolLike = values.every(v => ['true', 'false', '0', '1', 'yes', 'no'].includes(v.trim().toLowerCase()));
  if (boolLike) return 'boolean';

  const numberLike = values.every(v => /^-?\d+(\.\d+)?$/.test(v.trim()));
  if (numberLike) return 'number';

  const dateLike = values.every(v => !Number.isNaN(Date.parse(v)));
  if (dateLike) return 'date';

  const urlLike = values.every(v => /^https?:\/\//.test(v.trim()));
  if (urlLike) {
    return inferAssetFieldType(values[0]);
  }

  return null;
}

function inferRelationType(
  values: string[],
  itemIdsByCollection: Map<string, Set<string>>
): { type: CollectionFieldType | null; targetCollectionId: string | null } {
  if (values.length === 0) {
    return { type: null, targetCollectionId: null };
  }

  const candidateMap = new Map<string, number>();
  let hasMulti = false;
  let tokenCount = 0;

  for (const value of values) {
    const tokens = splitReferenceCandidates(value);
    if (tokens.length > 1) {
      hasMulti = true;
    }
    for (const token of tokens) {
      tokenCount++;
      for (const [collectionId, itemSet] of itemIdsByCollection.entries()) {
        if (itemSet.has(token)) {
          candidateMap.set(collectionId, (candidateMap.get(collectionId) || 0) + 1);
        }
      }
    }
  }

  if (tokenCount === 0 || candidateMap.size === 0) {
    return { type: null, targetCollectionId: null };
  }

  let bestCollectionId: string | null = null;
  let bestScore = 0;
  for (const [collectionId, score] of candidateMap.entries()) {
    if (score > bestScore) {
      bestCollectionId = collectionId;
      bestScore = score;
    }
  }

  if (!bestCollectionId) {
    return { type: null, targetCollectionId: null };
  }

  const relationCoverage = bestScore / tokenCount;
  if (relationCoverage < 0.7) {
    return { type: null, targetCollectionId: null };
  }

  return {
    type: hasMulti ? 'multi_reference' : 'reference',
    targetCollectionId: bestCollectionId,
  };
}

function registerAsset(
  collector: AssetCollector,
  filename: string,
  buffer: Buffer,
  mimeType: string
): ImportedAsset {
  const extension = path.extname(filename).toLowerCase() || '.bin';
  const id = randomUUID();
  // Placeholder path with the right extension: `restoreAssetFiles` uploads the
  // file under a fresh `generateStoragePath()` and rewrites storage_path /
  // public_url on the row by matching this value.
  const storagePath = `${STORAGE_FOLDERS.WEBSITE}/${Date.now()}-${id}${extension}`;
  const displayName = filename.replace(/\.[^/.]+$/, '') || filename;

  collector.rows.push({
    id,
    source: 'webflow-import',
    filename: displayName,
    storage_path: storagePath,
    public_url: null,
    file_size: buffer.byteLength,
    mime_type: mimeType,
    is_published: false,
  });
  collector.files.push({
    storagePath,
    base64: buffer.toString('base64'),
    mimeType,
  });

  return {
    id,
    storagePath,
    proxyUrl: getAssetProxyUrl({ id, filename: displayName, mime_type: mimeType, storage_path: storagePath }),
  };
}

/**
 * An asset the importer could not fetch (a CMS image on a CDN this server cannot
 * reach). No bytes are stored: the row keeps the original URL in `public_url` and
 * leaves `storage_path` empty, which is exactly what `getAssetProxyUrl()` falls
 * back on — so the image renders on any server that can reach the CDN, and the
 * layout keeps a real asset reference instead of an empty field.
 */
function registerRemoteAsset(collector: AssetCollector, url: string): ImportedAsset {
  const id = randomUUID();
  let filename = 'asset';
  try {
    filename = path.basename(new URL(url).pathname) || 'asset';
  } catch {
    filename = path.basename(url) || 'asset';
  }
  const displayName = filename.replace(/\.[^/.]+$/, '') || filename;

  collector.rows.push({
    id,
    source: 'webflow-import',
    filename: displayName,
    storage_path: null,
    public_url: url,
    file_size: null,
    mime_type: inferMimeType(filename),
    is_published: false,
  });

  return { id, storagePath: '', proxyUrl: url };
}

/**
 * Latest applied migration, like upstream's `exportProject()` records it. The
 * dump is generated against the current schema, so `importProject()` must not
 * replay any migration `up()`s over the imported data.
 */
async function resolveLatestMigrationName(): Promise<string | undefined> {
  try {
    const knex = await getKnexClient();
    return (await getLatestMigrationName(knex)) || undefined;
  } catch {
    return undefined;
  }
}

async function downloadRemoteAsset(url: string): Promise<{ buffer: Buffer; filename: string; mimeType: string } | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = response.headers.get('content-type') || inferMimeType(url);
    const pathname = new URL(url).pathname;
    const filename = path.basename(pathname) || `asset-${Date.now()}`;
    return { buffer, filename, mimeType };
  } catch {
    return null;
  }
}

function extractCssUrls(content: string): string[] {
  const matches = [...content.matchAll(/url\(([^)]+)\)/g)];
  return matches
    .map(match => match[1].trim().replace(/^["']|["']$/g, ''))
    .filter(value => value && !value.startsWith('data:'));
}

function extractCssClassNames(content: string): Set<string> {
  const result = new Set<string>();
  const classRegex = /\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)(?=[\s.:#,[>+~{])/g;
  const skipTokens = new Set([
    'jpg',
    'jpeg',
    'png',
    'webp',
    'gif',
    'svg',
    'woff',
    'woff2',
    'ttf',
    'otf',
    'mp4',
    'webm',
    'mov',
    'css',
    'js',
  ]);

  for (const match of content.matchAll(classRegex)) {
    const className = (match[1] || '').trim();
    if (!className || skipTokens.has(className.toLowerCase())) {
      continue;
    }
    result.add(className);
  }

  return result;
}

function decodeCssClassToken(token: string): string {
  let decoded = token;
  decoded = decoded.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_match, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16))
  );
  decoded = decoded.replace(/\\(.)/g, '$1');
  return decoded;
}

function extractCssClassSignatures(content: string): Set<string> {
  const signatures = new Set<string>();
  const blockRegex = /([^{]+)\{/g;
  const classRegex = /\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[_a-zA-Z0-9-])+)/g;

  for (const blockMatch of content.matchAll(blockRegex)) {
    const selectorBlock = (blockMatch[1] || '').trim();
    if (!selectorBlock || selectorBlock.startsWith('@')) {
      continue;
    }

    const selectors = selectorBlock.split(',');
    for (const selectorRaw of selectors) {
      const selector = selectorRaw.trim();
      if (!selector) continue;

      const tokens: string[] = [];
      for (const classMatch of selector.matchAll(classRegex)) {
        const token = decodeCssClassToken((classMatch[1] || '').trim());
        if (token) {
          tokens.push(token);
        }
      }

      if (tokens.length === 0) {
        continue;
      }

      const uniqueTokens = [...new Set(tokens)];
      signatures.add(normalizeClassSignature(uniqueTokens.join(' ')));
    }
  }

  return signatures;
}

function getLayerClasses(layer: Layer): string {
  if (Array.isArray(layer.classes)) {
    return layer.classes.join(' ');
  }
  return layer.classes || '';
}

function normalizeClassSignature(value: string): string {
  return value
    .split(/\s+/)
    .map(part => part.trim())
    .filter(Boolean)
    .join(' ');
}

function collectLayerClassNames(layers: Layer[]): Set<string> {
  const classNames = new Set<string>();

  const visit = (layer: Layer) => {
    for (const className of getLayerClasses(layer).split(/\s+/).filter(Boolean)) {
      classNames.add(className);
    }
    for (const child of layer.children || []) {
      visit(child);
    }
  };

  for (const layer of layers) {
    visit(layer);
  }

  return classNames;
}

/**
 * Whether linking a layer to a shared style with this class signature would
 * silently drop one of its classes.
 *
 * Publishing runs `syncLayerStyleChangesToDrafts`, which rebuilds
 * `layer.classes` from the style stack through `mergeClassStack`. That merge is
 * Tailwind-aware, and Webflow class names are not Tailwind: `text-weight-medium`
 * and `text-size-medium` both parse as font-size utilities, so the first is
 * evicted and the element silently loses its weight — the same trap that eats
 * `w-background-video`. When the merge is not lossless the layer keeps its own
 * verbatim class string and no style link, which is what makes it render like
 * the Webflow original (the exported stylesheet matches on those names).
 */
function classSignatureSurvivesMerge(classSignature: string): boolean {
  const tokens = classSignature.split(/\s+/).filter(Boolean);
  return mergeClassStack(tokens).length === tokens.length;
}

function applyLayerStylesToTree(
  layers: Layer[],
  styleIdByClassSignature: Map<string, string>,
  lossySignatures?: Set<string>
): Layer[] {
  const visit = (layer: Layer): Layer => {
    const classSignature = normalizeClassSignature(getLayerClasses(layer));
    let matchedStyleId = classSignature ? styleIdByClassSignature.get(classSignature) : undefined;
    if (matchedStyleId && !classSignatureSurvivesMerge(classSignature)) {
      lossySignatures?.add(classSignature);
      matchedStyleId = undefined;
    }

    const updated: Layer = {
      ...layer,
      ...(matchedStyleId ? { styleIds: [matchedStyleId] } : {}),
    };

    if (layer.children?.length) {
      updated.children = layer.children.map(visit);
    }

    return updated;
  };

  return layers.map(visit);
}

function buildLayerStyles(
  cssFiles: Array<{ filePath: string; content: string }>,
  pageLayerRows: Array<{ layers: Layer[] }>
): LayerStyleBuildResult {
  const classNames = new Set<string>();
  const classSignatures = new Set<string>();

  for (const cssFile of cssFiles) {
    for (const className of extractCssClassNames(cssFile.content)) {
      classNames.add(className);
    }
    for (const classSignature of extractCssClassSignatures(cssFile.content)) {
      if (classSignature) {
        classSignatures.add(classSignature);
      }
    }
  }

  for (const pageLayerRow of pageLayerRows) {
    for (const className of collectLayerClassNames(pageLayerRow.layers || [])) {
      classNames.add(className);
    }
    const visit = (layer: Layer) => {
      const signature = normalizeClassSignature(getLayerClasses(layer));
      if (signature) {
        classSignatures.add(signature);
      }
      for (const child of layer.children || []) {
        visit(child);
      }
    };
    for (const layer of pageLayerRow.layers || []) {
      visit(layer);
    }
  }

  const styleIdByClassSignature = new Map<string, string>();
  const layerStyleRows: Record<string, unknown>[] = [];

  for (const classSignature of [...classSignatures].sort((a, b) => a.localeCompare(b))) {
    const styleId = randomUUID();
    styleIdByClassSignature.set(classSignature, styleId);
    layerStyleRows.push({
      id: styleId,
      name: classSignature,
      classes: classSignature,
      design: null,
      is_published: false,
    });
  }

  for (const className of [...classNames].sort((a, b) => a.localeCompare(b))) {
    layerStyleRows.push({
      id: randomUUID(),
      name: className,
      classes: className,
      design: null,
      is_published: false,
    });
  }

  return {
    layerStyleRows,
    styleIdByClassSignature,
  };
}

function dedupeLayerStyles(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const deduped: Record<string, unknown>[] = [];

  for (const row of rows) {
    const classes = String(row.classes || '');
    if (!classes || seen.has(classes)) {
      continue;
    }
    seen.add(classes);
    deduped.push(row);
  }

  return deduped;
}

function layerHasClass(layer: Layer, className: string): boolean {
  const classes = getLayerClasses(layer);
  return classes.split(/\s+/).filter(Boolean).includes(className);
}

function createFieldInlineVariableTag(
  fieldId: string,
  fieldType: CollectionFieldType,
  source: 'page' | 'collection',
  collectionLayerId?: string,
  format?: string
): string {
  const variable: Record<string, unknown> = {
    type: 'field',
    data: {
      field_id: fieldId,
      field_type: fieldType,
      relationships: [],
      source,
    },
  };

  if (collectionLayerId) {
    (variable.data as Record<string, unknown>).collection_layer_id = collectionLayerId;
  }
  if (format) {
    (variable.data as Record<string, unknown>).format = format;
  }

  return `<ycode-inline-variable>${JSON.stringify(variable)}</ycode-inline-variable>`;
}

function inferCollectionForPageSlug(
  pageSlug: string,
  collections: NormalizedCollection[]
): NormalizedCollection | null {
  const slug = pageSlug.toLowerCase();
  const byName = (needle: string) =>
    collections.find(collection => collection.name.toLowerCase().includes(needle));

  if (slug.includes('werk') || slug.includes('work')) {
    return byName('werk') || byName('work') || null;
  }

  if (slug.includes('exhibition')) {
    return byName('exhibition') || null;
  }

  return null;
}

function layerTreeHasDynItems(layers: Layer[]): boolean {
  for (const layer of layers) {
    if (layerHasClass(layer, 'w-dyn-item')) return true;
    if (layer.children?.length && layerTreeHasDynItems(layer.children)) return true;
  }
  return false;
}

function isLikelyDetailPageSlug(pageSlug: string): boolean {
  const slug = pageSlug.toLowerCase();
  return slug.startsWith('detail-') || slug.includes('detail_') || slug.includes('/detail-');
}

/**
 * ─── CMS binding ─────────────────────────────────────────────────────────────
 *
 * A Webflow static export carries no CMS values: every bound leaf is an empty
 * `w-dyn-bind-empty` slot, every collection list holds exactly one template
 * item and item links are `href="#"`. Which CSV column belongs in which slot has
 * to be recovered from structure and names. The rules below are ported from the
 * v2 pipeline (`lib/webwow/import/webflow-zip/binding.ts`):
 *
 *  1. Collection per list — a rich-text slot or a nested list narrows it to the
 *     collection that has a rich-text / multi-image field; otherwise name
 *     similarity (page name, wrapper classes, preceding heading, `work ~ Werke`),
 *     then "same item template as an already bound list", then the largest
 *     collection.
 *  2. Field per slot, in this order — images and CMS-bound backgrounds to the
 *     image field, the first heading to Name, rich text to the rich-text field,
 *     then the remaining text slots: a class name or an adjacent label that
 *     resembles a field name wins, otherwise the best-filled text-like columns in
 *     CSV order. Columns that are empty in every row are never bound (that is
 *     what made imported lists render blank rows).
 *
 * Every slot that is bound also loses its `w-dyn-bind-empty` class: Webflow's
 * `components.css` carries `.w-dyn-bind-empty { display: none !important }`, so a
 * bound-but-still-marked slot renders its value into a hidden box — the reason
 * the imported exhibition rows looked empty.
 */

const CMS_TEXT_FIELD_TYPES = new Set<CollectionFieldType>([
  'text', 'date', 'date_only', 'number', 'option', 'email', 'phone', 'link',
]);
const IMAGE_FIELD_NAME_RE = /werk|bild|image|cover|foto|photo|main/i;
const ORDER_FIELD_NAME_RE = /order|reihenfolge|sort/i;
const FEATURE_FIELD_NAME_RE = /feature|highlight/i;
/** Webflow's placeholder for a background image that is bound to a CMS field. */
const WEBFLOW_CMS_BACKGROUND_MARKER = 'background-image.svg';
const CMS_NAME_SYNONYMS: Record<string, string[]> = {
  work: ['werke', 'works', 'arbeiten'],
  exhibitions: ['ausstellungen'],
  artist: ['kuenstler', 'artists'],
};

function normaliseName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  const x = normaliseName(a);
  const y = normaliseName(b);
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

function synonymsOf(value: string): string[] {
  const normalized = normaliseName(value);
  const out = new Set<string>([normalized]);
  for (const [key, list] of Object.entries(CMS_NAME_SYNONYMS)) {
    const group = [key, ...list].map(normaliseName);
    if (group.includes(normalized)) for (const entry of group) out.add(entry);
  }
  return [...out];
}

function nameSimilarity(a: string, b: string): number {
  let best = 0;
  for (const x of synonymsOf(a)) for (const y of synonymsOf(b)) best = Math.max(best, similarity(x, y));
  return best;
}

function phraseSimilarity(phrase: string, name: string): number {
  const words = phrase.split(/[\s_-]+/).filter(word => word.length >= 3);
  return Math.max(nameSimilarity(phrase, name), ...words.map(word => nameSimilarity(word, name)), 0);
}

function stripTrailingDigits(className: string): string {
  return className.replace(/[-_]?\d+$/g, '').replace(/[-_]+/g, ' ').trim();
}

interface LayerIndex {
  nodes: Layer[];
  parent: Map<string, Layer>;
}

function indexLayerTree(layers: Layer[]): LayerIndex {
  const nodes: Layer[] = [];
  const parent = new Map<string, Layer>();
  const walk = (list: Layer[], parentLayer?: Layer) => {
    for (const layer of list) {
      nodes.push(layer);
      if (parentLayer) parent.set(layer.id, parentLayer);
      if (layer.children?.length) walk(layer.children, layer);
    }
  };
  walk(layers);
  return { nodes, parent };
}

function layerAncestors(layer: Layer, index: LayerIndex): Layer[] {
  const out: Layer[] = [];
  let current = index.parent.get(layer.id);
  while (current) {
    out.push(current);
    current = index.parent.get(current.id);
  }
  return out;
}

/** Pre-order descendants; subtrees matching `stopAt` are skipped (their root optionally kept). */
function layerDescendants(
  layer: Layer,
  stopAt?: (candidate: Layer) => boolean,
  includeStop = false
): Layer[] {
  const out: Layer[] = [];
  const walk = (list: Layer[]) => {
    for (const child of list) {
      if (stopAt?.(child)) {
        if (includeStop) out.push(child);
        continue;
      }
      out.push(child);
      if (child.children?.length) walk(child.children);
    }
  };
  walk(layer.children || []);
  return out;
}

function firstLayerDescendant(layer: Layer, predicate: (candidate: Layer) => boolean): Layer | undefined {
  for (const child of layer.children || []) {
    if (predicate(child)) return child;
    const found = firstLayerDescendant(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function tiptapPlainText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const typed = node as { text?: unknown; content?: unknown };
  let out = typeof typed.text === 'string' ? typed.text : '';
  if (Array.isArray(typed.content)) {
    for (const child of typed.content) out += tiptapPlainText(child);
  }
  return out;
}

function layerPlainText(layer: Layer): string {
  const content = (layer.variables?.text as { data?: { content?: unknown } } | undefined)?.data?.content;
  if (typeof content === 'string') return content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (content) return tiptapPlainText(content).replace(/\s+/g, ' ').trim();
  return '';
}

function layerTagName(layer: Layer): string {
  const tag = layer.settings?.tag;
  if (typeof tag === 'string' && tag) return tag.toLowerCase();
  const name = String(layer.name || 'div').toLowerCase();
  if (name === 'image') return 'img';
  if (SAFE_HTML_TAGS.has(name)) return name;
  return 'div';
}

function isBindEmptySlot(layer: Layer): boolean {
  return layerHasClassToken(layer, 'w-dyn-bind-empty');
}

function isDynListLayer(layer: Layer): boolean {
  return layerHasClassToken(layer, 'w-dyn-list');
}

function isDynItemLayer(layer: Layer): boolean {
  return layerHasClassToken(layer, 'w-dyn-item');
}

/**
 * Class groups whose CSS rule paints Webflow's CMS background placeholder
 * (`…/img/background-image.svg`). Inside a collection item such an element is a
 * CMS-bound background image, not a decorative one — Webflow binds the field to
 * `background-image`, so there is no `<img>` and no `w-dyn-bind-empty` marker.
 */
function extractCmsBackgroundClassGroups(
  cssFiles: Array<{ filePath: string; content: string }>
): string[][] {
  const groups: string[][] = [];
  const seen = new Set<string>();
  for (const file of cssFiles) {
    for (const match of file.content.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const body = match[2];
      if (!/background(-image)?\s*:/.test(body) || !body.includes(WEBFLOW_CMS_BACKGROUND_MARKER)) continue;
      const selectorList = (match[1].split('{').pop() || '').trim();
      for (const selector of selectorList.split(',')) {
        const trimmed = selector.trim();
        if (!/^(\.[A-Za-z0-9_-]+)+$/.test(trimmed)) continue;
        const tokens = trimmed.split('.').filter(Boolean);
        const key = tokens.join('.');
        if (seen.has(key)) continue;
        seen.add(key);
        groups.push(tokens);
      }
    }
  }
  return groups;
}

function hasCmsBackground(layer: Layer, groups: string[][]): boolean {
  if (groups.length === 0) return false;
  const tokens = new Set(classTokens(layer));
  if (tokens.size === 0) return false;
  return groups.some(group => group.every(token => tokens.has(token)));
}

function getCollectionFields(
  collectionId: string,
  fields: NormalizedField[]
): NormalizedField[] {
  return fields
    .filter(field => field.collectionId === collectionId)
    .sort((a, b) => a.order - b.order);
}

function customCollectionFields(fields: NormalizedField[]): NormalizedField[] {
  return fields.filter(field => field.key === null);
}

function fieldFillRatio(collection: NormalizedCollection, field: NormalizedField): number {
  if (collection.rows.length === 0) return 0;
  let filled = 0;
  for (const row of collection.rows) {
    if ((row[field.csvHeader] || '').trim()) filled++;
  }
  return filled / collection.rows.length;
}

function singleImageFieldOf(fields: NormalizedField[]): NormalizedField | undefined {
  const images = customCollectionFields(fields).filter(field => field.type === 'image' && !field.isMultiAsset);
  return images.find(field => IMAGE_FIELD_NAME_RE.test(field.name)) || images[0];
}

function multiImageFieldOf(fields: NormalizedField[]): NormalizedField | undefined {
  return customCollectionFields(fields).find(field => field.type === 'image' && field.isMultiAsset);
}

function anyImageFieldOf(fields: NormalizedField[]): NormalizedField | undefined {
  return singleImageFieldOf(fields) || multiImageFieldOf(fields);
}

interface BindScope {
  source: 'page' | 'collection';
  collection: NormalizedCollection;
  fields: NormalizedField[];
  used: Set<string>;
  collectionLayerId?: string;
  detailPageId: string | null;
  cmsBackgroundGroups: string[][];
  index: LayerIndex;
  label: string;
  warnings: string[];
}

function fieldBindingFor(field: NormalizedField, scope: BindScope) {
  const data: Record<string, unknown> = {
    field_id: field.id,
    field_type: field.type,
    relationships: [] as string[],
    source: scope.source,
  };
  if (scope.collectionLayerId) data.collection_layer_id = scope.collectionLayerId;
  if (field.type === 'date' || field.type === 'date_only') data.format = 'date-eu-dot';
  return { type: 'field' as const, data } as unknown as FieldVariable;
}

function dropBindEmptyClass(layer: Layer): void {
  const tokens = classTokens(layer).filter(token => token !== 'w-dyn-bind-empty');
  layer.classes = tokens.join(' ');
}

function bindTextSlot(layer: Layer, field: NormalizedField, scope: BindScope): void {
  dropBindEmptyClass(layer);
  const tag = layerTagName(layer);
  layer.name = 'text';
  layer.restrictions = { ...(layer.restrictions || {}), editText: true };
  layer.settings = { ...(layer.settings || {}), tag };
  layer.variables = {
    ...(layer.variables || {}),
    text: {
      type: 'dynamic_text',
      data: {
        content: createFieldInlineVariableTag(
          field.id,
          field.type,
          scope.source,
          scope.collectionLayerId,
          field.type === 'date' || field.type === 'date_only' ? 'date-eu-dot' : undefined
        ),
      },
    },
  } as Layer['variables'];
  layer.children = undefined;
  scope.used.add(field.id);
}

function bindImageSlot(layer: Layer, field: NormalizedField, scope: BindScope): void {
  dropBindEmptyClass(layer);
  const existingAlt = (layer.variables?.image as { alt?: unknown } | undefined)?.alt;
  layer.name = 'image';
  layer.settings = { ...(layer.settings || {}), tag: 'img' };
  layer.variables = {
    ...(layer.variables || {}),
    image: {
      src: fieldBindingFor(field, scope),
      alt: (existingAlt || { type: 'dynamic_text', data: { content: '' } }),
    },
  } as Layer['variables'];
  layer.children = undefined;
  scope.used.add(field.id);
}

/**
 * A CMS-bound background. The resolved URL travels as the `--bg-img` custom
 * property, which only paints where something reads it — so the rule is written
 * into the layer's own inline style, where it also outranks the site CSS rule
 * that still points at Webflow's placeholder SVG.
 */
function bindBackgroundSlot(layer: Layer, field: NormalizedField, scope: BindScope): void {
  layer.variables = {
    ...(layer.variables || {}),
    backgroundImage: { src: fieldBindingFor(field, scope) },
  } as Layer['variables'];
  const existingStyle = (layer.attributes?.style as string | undefined) || '';
  if (!/background-image\s*:\s*var\(--bg-img\)/.test(existingStyle)) {
    layer.attributes = {
      ...(layer.attributes || {}),
      style: `${existingStyle ? `${existingStyle.replace(/;\s*$/, '')}; ` : ''}background-image: var(--bg-img)`,
    };
  }
  scope.used.add(field.id);
}

/**
 * The collection item's own root carries the bound background on some templates
 * (Webflow's "Featured painting" block). A field variable sitting on that root is
 * never resolved — `injectCollectionData` only walks the item's children, so the
 * published page falls back to ycode's grey placeholder. The binding therefore
 * goes onto an inserted, absolutely positioned first child that covers the root.
 */
function addBackgroundFillerChild(itemRoot: Layer, field: NormalizedField, scope: BindScope): void {
  const filler: Layer = {
    id: randomUUID(),
    name: 'div',
    classes: 'absolute inset-0 bg-cover bg-center pointer-events-none',
    attributes: { style: 'background-image: var(--bg-img)' },
    variables: { backgroundImage: { src: fieldBindingFor(field, scope) } } as Layer['variables'],
    children: [],
  };
  if (!classTokens(itemRoot).includes('relative')) {
    itemRoot.classes = `${getLayerClasses(itemRoot)} relative`.trim();
  }
  itemRoot.children = [filler, ...(itemRoot.children || [])];
  scope.used.add(field.id);
}

/** Text-like candidates: Name first, then filled custom columns (fill ratio desc, CSV order). */
function textFieldCandidates(scope: BindScope): NormalizedField[] {
  const out: NormalizedField[] = [];
  const nameField = scope.fields.find(field => field.key === 'name');
  if (nameField && !scope.used.has(nameField.id)) out.push(nameField);
  const custom = customCollectionFields(scope.fields)
    .filter(field => CMS_TEXT_FIELD_TYPES.has(field.type) && !scope.used.has(field.id))
    .map((field, order) => ({ field, order, ratio: fieldFillRatio(scope.collection, field) }))
    .filter(entry => entry.ratio > 0)
    .sort((a, b) => b.ratio - a.ratio || a.order - b.order)
    .map(entry => entry.field);
  return [...out, ...custom];
}

/** Class names plus an adjacent literal label ("Order:") — hints for which field a slot wants. */
function slotFieldHints(layer: Layer, scope: BindScope): string[] {
  const hints = classTokens(layer)
    .filter(token => !token.startsWith('w-'))
    .map(stripTrailingDigits)
    .filter(Boolean);
  const parent = scope.index.parent.get(layer.id);
  const siblings = parent?.children || [];
  const position = siblings.indexOf(layer);
  for (let i = position - 1; i >= 0 && i >= position - 2; i--) {
    const text = layerPlainText(siblings[i]) || (siblings[i].children || []).map(layerPlainText).join(' ').trim();
    if (text && text.length <= 24) hints.push(text.replace(/[:：]\s*$/, '').trim());
  }
  return hints.filter(Boolean);
}

function bindSlots(roots: Layer[], scope: BindScope): void {
  const nodes: Layer[] = [];
  for (const root of roots) {
    if (isDynListLayer(root)) nodes.push(root);
    else nodes.push(root, ...layerDescendants(root, isDynListLayer, true));
  }

  const imageField = anyImageFieldOf(scope.fields);
  const nameField = scope.fields.find(field => field.key === 'name');
  const itemRoot = scope.source === 'collection' ? roots[0] : undefined;

  // 1. <img> slots and CMS-bound backgrounds -> the collection's image field.
  for (const node of nodes) {
    if (String(node.name) === 'image' && isBindEmptySlot(node)) {
      if (imageField) bindImageSlot(node, imageField, scope);
    } else if (String(node.name) !== 'image' && hasCmsBackground(node, scope.cmsBackgroundGroups)) {
      if (!imageField) continue;
      if (node === itemRoot) addBackgroundFillerChild(node, imageField, scope);
      else bindBackgroundSlot(node, imageField, scope);
    }
  }

  // 1b. A nested list inside an item is Webflow's gallery over a multi-image
  //     column; ycode holds one asset per field, so its single template item
  //     shows the first image.
  for (const node of nodes) {
    if (!isDynListLayer(node) || node === roots[0]) continue;
    const nestedItem = firstLayerDescendant(node, isDynItemLayer);
    if (!nestedItem || !imageField) continue;
    for (const inner of [nestedItem, ...layerDescendants(nestedItem)]) {
      if (String(inner.name) === 'image' && isBindEmptySlot(inner)) {
        bindImageSlot(inner, imageField, scope);
      }
    }
  }

  // 2. The first heading slot -> Name.
  let nameBound = false;
  for (const node of nodes) {
    if (!isBindEmptySlot(node) || !/^h[1-6]$/.test(layerTagName(node))) continue;
    if (nameField && !nameBound) {
      bindTextSlot(node, nameField, scope);
      nameBound = true;
    }
  }

  // 3. Rich text slots -> the rich-text field when the collection has one.
  const richField = customCollectionFields(scope.fields).find(field => field.type === 'rich_text');
  for (const node of nodes) {
    if (!isBindEmptySlot(node) || !layerHasClassToken(node, 'w-richtext')) continue;
    if (richField) bindTextSlot(node, richField, scope);
  }

  // 4. Remaining text slots.
  for (const node of nodes) {
    if (!isBindEmptySlot(node)) continue;
    if (String(node.name) === 'image') continue;
    let chosen: NormalizedField | undefined;
    let bestScore = 0;
    for (const hint of slotFieldHints(node, scope)) {
      for (const field of customCollectionFields(scope.fields)) {
        if (scope.used.has(field.id) || !CMS_TEXT_FIELD_TYPES.has(field.type)) continue;
        if (fieldFillRatio(scope.collection, field) === 0) continue;
        const score = phraseSimilarity(hint, field.name);
        if (score >= 0.7 && score > bestScore) {
          chosen = field;
          bestScore = score;
        }
      }
    }
    if (!chosen) {
      const candidates = textFieldCandidates(scope).filter(field => nameBound ? field.key !== 'name' : true);
      chosen = candidates[0];
    }
    if (!chosen) continue;
    bindTextSlot(node, chosen, scope);
    if (chosen.key === 'name') nameBound = true;
  }

  // 5. Placeholder links (href="#") inside an item -> that item's detail page.
  if (scope.source === 'collection' && scope.detailPageId) {
    for (const node of nodes) {
      if (layerTagName(node) !== 'a') continue;
      const href = ((node.variables?.link as { url?: { data?: { content?: string } } } | undefined)?.url?.data?.content || '').trim();
      if (href && href !== '#') continue;
      node.variables = {
        ...(node.variables || {}),
        link: {
          type: 'page',
          page: { id: scope.detailPageId, collection_item_id: 'current-collection' },
        },
      } as Layer['variables'];
    }
  }
}

interface CollectionChoice {
  collection: NormalizedCollection;
  confidence: number;
  reason: string;
}

interface ListEntry {
  pageName: string;
  /** Collection this page is the detail page of, when it is one. */
  detailCollectionId?: string;
  index: LayerIndex;
  list: Layer;
  item: Layer;
  heading?: string;
  wrapperClasses: string[];
  signature: string;
  choice: CollectionChoice | null;
  /** Collection the list was bound to (set once the choice is applied). */
  boundCollectionId?: string;
}

/** How many items a "related items" list on a detail page shows. */
const RELATED_LIST_LIMIT = 3;

/** Site classes of the item and its first two descendants — the template's identity across pages. */
function itemTemplateSignature(item: Layer): string {
  return [item, ...layerDescendants(item).slice(0, 2)]
    .map(layer => `${layerTagName(layer)}:${classTokens(layer).filter(token => !token.startsWith('w-')).join('.')}`)
    .join('|');
}

function precedingHeadingText(index: LayerIndex, list: Layer): string | undefined {
  const position = index.nodes.indexOf(list);
  const inside = new Set(layerDescendants(list).map(layer => layer.id));
  for (let i = position - 1; i >= 0; i--) {
    const node = index.nodes[i];
    if (inside.has(node.id)) continue;
    if (!/^h[1-6]$/.test(layerTagName(node))) continue;
    const text = layerPlainText(node);
    if (text) return text;
  }
  return undefined;
}

function chooseCollectionForList(
  entry: ListEntry,
  collections: NormalizedCollection[],
  fieldsByCollection: Map<string, NormalizedField[]>
): CollectionChoice | null {
  if (collections.length === 0) return null;

  const inner = layerDescendants(entry.item);
  if (inner.some(node => layerHasClassToken(node, 'w-richtext'))) {
    const withRich = collections.filter(collection =>
      customCollectionFields(fieldsByCollection.get(collection.id) || []).some(field => field.type === 'rich_text'));
    if (withRich.length === 1) {
      return { collection: withRich[0], confidence: 0.8, reason: 'template has a rich-text slot and only this collection has a rich-text field' };
    }
  }
  if (inner.some(isDynListLayer)) {
    const withMulti = collections.filter(collection => multiImageFieldOf(fieldsByCollection.get(collection.id) || []));
    if (withMulti.length === 1) {
      return { collection: withMulti[0], confidence: 0.8, reason: 'template has a nested list and only this collection has a multi-image field' };
    }
  }

  const candidates = [entry.pageName, ...entry.wrapperClasses.map(stripTrailingDigits), entry.heading || ''];
  let best: { collection: NormalizedCollection; score: number; via: string } | null = null;
  for (const collection of collections) {
    for (const candidate of candidates) {
      if (!candidate) continue;
      const score = phraseSimilarity(candidate, collection.name);
      if (score >= 0.6 && (!best || score > best.score)) best = { collection, score, via: candidate };
    }
  }
  if (best) {
    return { collection: best.collection, confidence: 0.7, reason: `"${best.via}" ~ collection "${best.collection.name}"` };
  }

  const largest = [...collections].sort((a, b) => b.rows.length - a.rows.length)[0];
  return { collection: largest, confidence: 0.5, reason: `fallback: largest collection (${largest.rows.length} items)` };
}

/** Sorting, the "Featured" filter and its limit, read off the list's own class names. */
function listCollectionSettings(
  entry: ListEntry,
  fields: NormalizedField[]
): Record<string, unknown> {
  const custom = customCollectionFields(fields);
  // Only the list's OWN classes decide the filter — a parent called
  // `.feature-block` must not silently filter the works list down to the
  // featured ones.
  const ownClasses = classTokens(entry.list).filter(token => !token.startsWith('w-'));
  const settings: Record<string, unknown> = { sort_by: 'manual', sort_order: 'asc' };

  const orderField = custom.find(field => field.type === 'number' && ORDER_FIELD_NAME_RE.test(field.name));
  if (orderField) {
    settings.sort_by = orderField.id;
    settings.sort_order = 'asc';
  }

  // "More from this collection" on a detail page is a teaser, not the archive.
  if (entry.detailCollectionId && entry.detailCollectionId === entry.boundCollectionId) {
    settings.limit = RELATED_LIST_LIMIT;
  }

  if (ownClasses.some(token => FEATURE_FIELD_NAME_RE.test(token))) {
    const flag = custom.find(field => field.type === 'boolean' && FEATURE_FIELD_NAME_RE.test(field.name));
    if (flag) {
      settings.filters = {
        groups: [{
          id: randomUUID(),
          conditions: [{
            id: randomUUID(),
            source: 'collection_field',
            fieldId: flag.id,
            fieldType: 'boolean',
            operator: 'is',
            value: 'true',
          }],
        }],
      };
      if (ownClasses.includes('feature')) settings.limit = 1;
    }
  }

  return settings;
}

/** Webflow shows `.w-dyn-empty` only while a list is empty; ours never is. */
function hideEmptyStates(layers: Layer[]): void {
  for (const layer of indexLayerTree(layers).nodes) {
    if (!layerHasClassToken(layer, 'w-dyn-empty')) continue;
    if (layerHasClassToken(layer, 'hidden')) continue;
    layer.classes = `${getLayerClasses(layer)} hidden`.trim();
  }
}

function enhancePagesWithCmsBindings(
  builtPages: BuiltPageEntry[],
  collections: NormalizedCollection[],
  fields: NormalizedField[],
  cmsBackgroundGroups: string[][],
  warnings: string[]
): BuiltPageEntry[] {
  const pages = builtPages.map(entry => ({
    page: { ...entry.page },
    pageLayers: { ...entry.pageLayers },
  }));
  if (collections.length === 0) return pages;

  const fieldsByCollection = new Map<string, NormalizedField[]>();
  for (const collection of collections) {
    fieldsByCollection.set(collection.id, getCollectionFields(collection.id, fields));
  }

  const detailPageIdByCollectionId = new Map<string, string>();
  const detailCollectionIdByPageId = new Map<string, string>();

  // Pass 1: dynamic detail pages — mark them, then bind their page-level slots.
  for (const entry of pages) {
    const pageSlug = String(entry.page.slug || '');
    const collection = inferCollectionForPageSlug(pageSlug, collections);
    if (!collection || !isLikelyDetailPageSlug(pageSlug)) continue;

    const collectionFields = fieldsByCollection.get(collection.id) || [];
    const slugField = collectionFields.find(field => field.key === 'slug')
      || collectionFields.find(field => field.name.trim().toLowerCase() === 'slug');
    if (!slugField) continue;

    entry.page.is_dynamic = true;
    entry.page.settings = {
      ...(entry.page.settings as Record<string, unknown> || {}),
      cms: { collection_id: collection.id, slug_field_id: slugField.id },
    };
    detailPageIdByCollectionId.set(collection.id, String(entry.page.id));
    detailCollectionIdByPageId.set(String(entry.page.id), collection.id);
  }

  for (const entry of pages) {
    const pageSlug = String(entry.page.slug || '');
    if (!isLikelyDetailPageSlug(pageSlug)) continue;
    const collection = inferCollectionForPageSlug(pageSlug, collections);
    if (!collection || !entry.page.is_dynamic) continue;
    const layers = (entry.pageLayers.layers as Layer[]) || [];
    bindSlots(layers, {
      source: 'page',
      collection,
      fields: fieldsByCollection.get(collection.id) || [],
      used: new Set<string>(),
      detailPageId: null,
      cmsBackgroundGroups,
      index: indexLayerTree(layers),
      label: `page ${pageSlug}`,
      warnings,
    });
  }

  // Pass 2: every top-level collection list, on every page.
  const entries: ListEntry[] = [];
  for (const entry of pages) {
    const layers = (entry.pageLayers.layers as Layer[]) || [];
    const index = indexLayerTree(layers);
    for (const list of index.nodes) {
      if (!isDynListLayer(list)) continue;
      if (layerAncestors(list, index).some(isDynItemLayer)) continue;
      const item = firstLayerDescendant(list, isDynItemLayer);
      if (!item) continue;
      const parent = index.parent.get(list.id);
      const wrapperClasses = [...classTokens(list), ...(parent ? classTokens(parent) : [])]
        .filter(token => !token.startsWith('w-'));
      entries.push({
        pageName: String(entry.page.slug || entry.page.name || ''),
        detailCollectionId: detailCollectionIdByPageId.get(String(entry.page.id)),
        index,
        list,
        item,
        heading: precedingHeadingText(index, list),
        wrapperClasses,
        signature: itemTemplateSignature(item),
        choice: null,
      });
    }
  }

  for (const entry of entries) {
    entry.choice = chooseCollectionForList(entry, collections, fieldsByCollection);
  }
  // A list whose item template matches a confidently bound one inherits its collection.
  const confident = entries.filter(entry => entry.choice && entry.choice.confidence >= 0.6);
  for (const entry of entries) {
    if (entry.choice && entry.choice.confidence >= 0.6) continue;
    const twin = confident.find(other => other.signature === entry.signature && other !== entry);
    if (twin?.choice) {
      entry.choice = {
        collection: twin.choice.collection,
        confidence: 0.9,
        reason: `same item template as the list bound to ${twin.choice.collection.name}`,
      };
    }
  }

  for (const entry of entries) {
    if (!entry.choice) continue;
    const collection = entry.choice.collection;
    entry.boundCollectionId = collection.id;
    const collectionFields = fieldsByCollection.get(collection.id) || [];
    entry.item.variables = {
      ...(entry.item.variables || {}),
      collection: {
        id: collection.id,
        ...listCollectionSettings(entry, collectionFields),
      },
    } as Layer['variables'];
    warnings.push(
      `Collection list "${entry.wrapperClasses.join('.') || 'w-dyn-list'}" on page "${entry.pageName || 'index'}" bound to "${collection.name}" (${entry.choice.reason})`
    );
    bindSlots([entry.item], {
      source: 'collection',
      collection,
      fields: collectionFields,
      used: new Set<string>(),
      collectionLayerId: entry.item.id,
      detailPageId: detailPageIdByCollectionId.get(collection.id) || null,
      cmsBackgroundGroups,
      index: entry.index,
      label: `list on ${entry.pageName}`,
      warnings,
    });
  }

  for (const entry of pages) {
    hideEmptyStates((entry.pageLayers.layers as Layer[]) || []);
  }

  return pages;
}

function rewriteCssUrls(
  cssContent: string,
  cssFilePath: string,
  assetPublicUrlBySource: Map<string, string>
): string {
  return cssContent.replace(/url\(([^)]+)\)/g, (fullMatch, rawValue) => {
    const original = String(rawValue).trim().replace(/^["']|["']$/g, '');
    if (!original || original.startsWith('data:') || original.startsWith('#') || /^https?:\/\//.test(original)) {
      return fullMatch;
    }

    const cssDir = path.posix.dirname(normalizeSlashes(cssFilePath));
    const joined = path.posix.normalize(path.posix.join(cssDir, normalizeSlashes(original)));
    const normalizedCandidates = [
      normalizeSlashes(original).replace(/^\.\//, '').replace(/^\//, ''),
      joined.replace(/^\//, ''),
      stripTopLevelFolder(joined).replace(/^\//, ''),
      path.posix.basename(original),
    ];

    for (const candidate of normalizedCandidates) {
      const mapped = assetPublicUrlBySource.get(candidate);
      if (mapped) {
        return `url("${mapped}")`;
      }
    }

    return fullMatch;
  });
}

/**
 * The `<style>` blocks a Webflow page carries in its body.
 *
 * These are PAGE-scoped: this export puts the client-first global styles —
 * including a fluid `html { font-size: calc(… + 0.86vw) }` — in an embed on the
 * homepage only, and `.pageLayout { width: 19cm }` on the catalog page only.
 * Concatenating them into the site-wide stylesheet applied them everywhere: the
 * root font size dropped from 16px to 11.86px on the five pages that never had
 * the embed, shrinking every `rem` padding on them. They are therefore stored
 * on the page (`settings.custom_code.head`), not in the global CSS.
 */
function extractEmbeddedCssFromHtml(htmlContent: string): string {
  const root = parse(htmlContent);
  const body = root.querySelector('body');
  if (!body) return '';

  const styleTags = body.querySelectorAll('style');
  const blocks: string[] = [];
  for (const tag of styleTags) {
    const css = tag.textContent.trim();
    if (css) blocks.push(`/* embedded */\n${css}`);
  }
  return blocks.join('\n\n');
}

/**
 * The stylesheet hrefs of one page, in cascade order.
 *
 * `rel` and `href` appear in either order in real markup — a Webflow export
 * writes `<link href="css/normalize.css" rel="stylesheet">`, href first. A
 * regex that demanded `rel` before `href` matched nothing, so the importer fell
 * back to sorting the CSS files alphabetically: `components.css` then
 * `normalize.css`, which put normalize's `h1 { font-size: 2em }` AFTER
 * components' `h1 { font-size: 38px }` and shrank every heading on the site.
 */
function extractStylesheetHrefsFromHtml(htmlContent: string): string[] {
  const hrefs: string[] = [];

  for (const match of htmlContent.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\brel\s*=\s*["']?stylesheet\b/i.test(tag)) continue;
    const href = (/\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || '').trim();
    if (!href || /^https?:\/\//i.test(href)) {
      continue;
    }
    hrefs.push(normalizeSlashes(href).replace(/^\.\//, '').replace(/^\//, ''));
  }

  return hrefs;
}

function orderCssFiles(
  cssFiles: Array<{ filePath: string; content: string }>,
  preferredOrder: string[]
): Array<{ filePath: string; content: string }> {
  if (preferredOrder.length === 0) {
    return [...cssFiles].sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  const byPath = new Map<string, { filePath: string; content: string }>();
  for (const file of cssFiles) {
    byPath.set(normalizeSlashes(file.filePath), file);
  }

  const ordered: Array<{ filePath: string; content: string }> = [];
  const seen = new Set<string>();

  for (const cssPath of preferredOrder) {
    const normalized = normalizeSlashes(cssPath);
    const file = byPath.get(normalized);
    if (file && !seen.has(normalized)) {
      ordered.push(file);
      seen.add(normalized);
    }
  }

  const remaining = cssFiles
    .filter(file => !seen.has(normalizeSlashes(file.filePath)))
    .sort((a, b) => a.filePath.localeCompare(b.filePath));

  return [...ordered, ...remaining];
}

/* ------------------------------------------------------------------ *
 * Webflow IX2 hover interactions -> CSS
 *
 * Webflow ships its interactions as data inside the exported site bundle
 * (`Webflow.require("ix2").init({ events, actionLists, site })`), replayed at
 * runtime by webflow.js. The export's JS is not carried over by the importer,
 * so every hover animation the designer built would be lost.
 *
 * The hover subset maps cleanly onto plain CSS: a MOUSE_OVER event whose
 * target is a class selector plus its paired MOUSE_OUT event is exactly a
 * `:hover` rule with a transition. Emitting CSS (instead of ycode
 * interactions) keeps the effect working for collection items injected at
 * runtime and for every element carrying the class, and it survives ycode's
 * Tailwind-aware class stack, which evicts unknown `w-`/framework tokens.
 * ------------------------------------------------------------------ */

/** A `{...}` literal as minifiers emit it: bare keys, `!0`/`!1`, hex numbers. */
interface JsLiteralCursor {
  index: number;
}

const JS_LITERAL_MAX_DEPTH = 64;

/**
 * Parse the JavaScript object literal starting at `start`.
 *
 * Deliberately a parser and not `eval`/`new Function`: the source is an
 * uploaded ZIP, so it must never be executed on the server. Returns null when
 * the text is not a literal this parser understands.
 */
function parseJsObjectLiteral(source: string, start: number): unknown | null {
  const cursor: JsLiteralCursor = { index: start };

  const skipWhitespace = () => {
    while (cursor.index < source.length && /\s/.test(source[cursor.index])) cursor.index += 1;
  };

  const readString = (): string => {
    const quote = source[cursor.index];
    cursor.index += 1;
    let out = '';
    while (cursor.index < source.length) {
      const char = source[cursor.index];
      cursor.index += 1;
      if (char === '\\') {
        const escaped = source[cursor.index];
        cursor.index += 1;
        if (escaped === 'u') {
          out += String.fromCharCode(Number.parseInt(source.substr(cursor.index, 4), 16));
          cursor.index += 4;
        } else if (escaped === 'n') out += '\n';
        else if (escaped === 't') out += '\t';
        else if (escaped === 'r') out += '\r';
        else out += escaped;
        continue;
      }
      if (char === quote) return out;
      out += char;
    }
    throw new Error('unterminated string');
  };

  const readKey = (): string => {
    skipWhitespace();
    const char = source[cursor.index];
    if (char === '"' || char === "'") return readString();
    const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(cursor.index, cursor.index + 64));
    if (!match) throw new Error('bad key');
    cursor.index += match[0].length;
    return match[0];
  };

  const readValue = (depth: number): unknown => {
    if (depth > JS_LITERAL_MAX_DEPTH) throw new Error('too deep');
    skipWhitespace();
    const char = source[cursor.index];
    if (char === '{') {
      cursor.index += 1;
      const out: Record<string, unknown> = {};
      skipWhitespace();
      if (source[cursor.index] === '}') { cursor.index += 1; return out; }
      for (;;) {
        const key = readKey();
        skipWhitespace();
        if (source[cursor.index] !== ':') throw new Error('expected :');
        cursor.index += 1;
        out[key] = readValue(depth + 1);
        skipWhitespace();
        const next = source[cursor.index];
        cursor.index += 1;
        if (next === '}') return out;
        if (next !== ',') throw new Error('expected , or }');
        skipWhitespace();
        if (source[cursor.index] === '}') { cursor.index += 1; return out; }
      }
    }
    if (char === '[') {
      cursor.index += 1;
      const out: unknown[] = [];
      skipWhitespace();
      if (source[cursor.index] === ']') { cursor.index += 1; return out; }
      for (;;) {
        out.push(readValue(depth + 1));
        skipWhitespace();
        const next = source[cursor.index];
        cursor.index += 1;
        if (next === ']') return out;
        if (next !== ',') throw new Error('expected , or ]');
        skipWhitespace();
        if (source[cursor.index] === ']') { cursor.index += 1; return out; }
      }
    }
    if (char === '"' || char === "'") return readString();
    // Minified booleans: `!0` === true, `!1` === false.
    if (char === '!') {
      cursor.index += 1;
      const digit = source[cursor.index];
      cursor.index += 1;
      return digit === '0';
    }
    if (source.startsWith('null', cursor.index)) { cursor.index += 4; return null; }
    if (source.startsWith('true', cursor.index)) { cursor.index += 4; return true; }
    if (source.startsWith('false', cursor.index)) { cursor.index += 5; return false; }
    if (source.startsWith('void 0', cursor.index)) { cursor.index += 6; return undefined; }
    const numberMatch = /^-?(0[xX][0-9a-fA-F]+|\d*\.?\d+(?:[eE][-+]?\d+)?)/.exec(
      source.slice(cursor.index, cursor.index + 40)
    );
    if (!numberMatch) throw new Error('bad value');
    cursor.index += numberMatch[0].length;
    return Number(numberMatch[0]);
  };

  try {
    return readValue(0);
  } catch {
    return null;
  }
}

interface Ix2Target {
  selector?: string;
  appliesTo?: string;
  useEventTarget?: string | boolean;
  id?: string;
}

interface Ix2ActionItem {
  actionTypeId?: string;
  config?: Record<string, unknown> & { target?: Ix2Target };
}

interface Ix2ActionList {
  title?: string;
  actionItemGroups?: Array<{ actionItems?: Ix2ActionItem[] }>;
}

interface Ix2Event {
  eventTypeId?: string;
  mediaQueries?: string[];
  target?: Ix2Target;
  action?: { config?: { actionListId?: string } };
}

interface Ix2Payload {
  events?: Record<string, Ix2Event>;
  actionLists?: Record<string, Ix2ActionList>;
}

/** Pull every `Webflow.require("ix2").init({...})` payload out of the export's JS. */
function extractIx2Payloads(jsFiles: Array<{ filePath: string; content: string }>): Ix2Payload[] {
  const payloads: Ix2Payload[] = [];
  for (const file of jsFiles) {
    const initRegex = /ix2["']?\)?\s*\.init\s*\(\s*\{/g;
    for (const match of file.content.matchAll(initRegex)) {
      const braceIndex = file.content.indexOf('{', match.index ?? 0);
      if (braceIndex < 0) continue;
      const parsed = parseJsObjectLiteral(file.content, braceIndex) as Ix2Payload | null;
      if (parsed && (parsed.events || parsed.actionLists)) payloads.push(parsed);
    }
  }
  return payloads;
}

/** Webflow easing name -> CSS timing function. */
const IX2_EASINGS: Record<string, string> = {
  ease: 'ease',
  easeIn: 'ease-in',
  easeOut: 'ease-out',
  easeInOut: 'ease-in-out',
  linear: 'linear',
  inQuad: 'cubic-bezier(0.55, 0.085, 0.68, 0.53)',
  outQuad: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
  inOutQuad: 'cubic-bezier(0.455, 0.03, 0.515, 0.955)',
  inCubic: 'cubic-bezier(0.55, 0.055, 0.675, 0.19)',
  outCubic: 'cubic-bezier(0.215, 0.61, 0.355, 1)',
  inOutCubic: 'cubic-bezier(0.645, 0.045, 0.355, 1)',
  inQuart: 'cubic-bezier(0.895, 0.03, 0.685, 0.22)',
  outQuart: 'cubic-bezier(0.165, 0.84, 0.44, 1)',
  inOutQuart: 'cubic-bezier(0.77, 0, 0.175, 1)',
  inQuint: 'cubic-bezier(0.755, 0.05, 0.855, 0.06)',
  outQuint: 'cubic-bezier(0.23, 1, 0.32, 1)',
  inOutQuint: 'cubic-bezier(0.86, 0, 0.07, 1)',
  inSine: 'cubic-bezier(0.47, 0, 0.745, 0.715)',
  outSine: 'cubic-bezier(0.39, 0.575, 0.565, 1)',
  inOutSine: 'cubic-bezier(0.445, 0.05, 0.55, 0.95)',
  inExpo: 'cubic-bezier(0.95, 0.05, 0.795, 0.035)',
  outExpo: 'cubic-bezier(0.19, 1, 0.22, 1)',
  inOutExpo: 'cubic-bezier(1, 0, 0, 1)',
  inCirc: 'cubic-bezier(0.6, 0.04, 0.98, 0.335)',
  outCirc: 'cubic-bezier(0.075, 0.82, 0.165, 1)',
  inOutCirc: 'cubic-bezier(0.785, 0.135, 0.15, 0.86)',
  inBack: 'cubic-bezier(0.6, -0.28, 0.735, 0.045)',
  outBack: 'cubic-bezier(0.175, 0.885, 0.32, 1.275)',
  inOutBack: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
};

/** Webflow breakpoint key -> the media query it stands for. */
const IX2_MEDIA_QUERIES: Record<string, string> = {
  main: '(min-width: 992px)',
  medium: '(min-width: 768px) and (max-width: 991px)',
  small: '(min-width: 480px) and (max-width: 767px)',
  tiny: '(max-width: 479px)',
};
const IX2_ALL_MEDIA = ['main', 'medium', 'small', 'tiny'];

/** Only class chains (`.a.b`) are turned into CSS; anything else is skipped. */
function isClassChainSelector(selector: string | undefined): selector is string {
  return !!selector && /^(\.[A-Za-z_][\w-]*)+$/.test(selector);
}

function cssUnit(raw: unknown, fallback: string): string {
  const unit = String(raw ?? '').toLowerCase();
  if (unit === 'px' || unit === '%' || unit === 'rem' || unit === 'em' || unit === 'vw' || unit === 'vh') return unit;
  if (unit === 'deg') return 'deg';
  return fallback;
}

function numberOr(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** How long one CSS property takes to reach its hover value. */
interface Ix2Timing {
  durationMs: number;
  delayMs: number;
  easing: string;
}

/** Per-target CSS the hover state should settle on. */
interface Ix2TargetState {
  selector: string;
  /** Plain declarations, last write wins. */
  declarations: Map<string, string>;
  /** Transform pieces, merged into one `transform` declaration. */
  translate?: { x: string; y: string };
  scale?: { x: number; y: number };
  rotate?: number;
  /** Timing per CSS property, taken from the action item that last wrote it. */
  timings: Map<string, Ix2Timing>;
}

/**
 * Fold an action list into its end state per target.
 *
 * Webflow plays action item groups in sequence; the last write to a property
 * wins, so the final group is the resting state of the animation. A CSS
 * transition can only express that end state, so intermediate groups (e.g. the
 * brief green flash the fixed menu does on its way to white) are collapsed.
 */
function foldActionList(list: Ix2ActionList | undefined): Map<string, Ix2TargetState> {
  const states = new Map<string, Ix2TargetState>();
  if (!list?.actionItemGroups) return states;

  for (const group of list.actionItemGroups) {
    for (const item of group.actionItems || []) {
      const config = item.config || {};
      const target = config.target || {};
      const useEventTarget = target.useEventTarget;
      let selector: string;
      if (useEventTarget === 'CHILDREN' && isClassChainSelector(target.selector)) {
        selector = ` ${target.selector}`;
      } else if (useEventTarget === true || target.appliesTo === 'TRIGGER_ELEMENT') {
        selector = '';
      } else {
        // SIBLINGS / PARENT / element-id targets have no reliable CSS equivalent.
        continue;
      }

      let state = states.get(selector);
      if (!state) {
        state = { selector, declarations: new Map(), timings: new Map() };
        states.set(selector, state);
      }

      const timing: Ix2Timing = {
        durationMs: numberOr(config.duration, 0),
        delayMs: numberOr(config.delay, 0),
        easing: IX2_EASINGS[String(config.easing || '')] || 'ease',
      };
      /** Groups play in sequence, so the last group's timing is the one that shows. */
      const setDeclaration = (property: string, value: string) => {
        state!.declarations.set(property, value);
        state!.timings.set(property, timing);
      };

      switch (item.actionTypeId) {
        case 'STYLE_SIZE': {
          if (config.widthValue !== undefined && config.widthValue !== null) {
            setDeclaration('width', `${numberOr(config.widthValue, 0)}${cssUnit(config.widthUnit, 'px')}`);
          }
          if (config.heightValue !== undefined && config.heightValue !== null) {
            setDeclaration('height', `${numberOr(config.heightValue, 0)}${cssUnit(config.heightUnit, 'px')}`);
          }
          break;
        }
        case 'STYLE_TEXT_COLOR': {
          setDeclaration('color', ix2Color(config));
          break;
        }
        case 'STYLE_BACKGROUND_COLOR': {
          setDeclaration('background-color', ix2Color(config));
          break;
        }
        case 'STYLE_BORDER_COLOR': {
          setDeclaration('border-color', ix2Color(config));
          break;
        }
        case 'STYLE_OPACITY': {
          setDeclaration('opacity', String(numberOr(config.value, 1)));
          break;
        }
        case 'TRANSFORM_MOVE': {
          state.translate = {
            x: `${numberOr(config.xValue, 0)}${cssUnit(config.xUnit, 'px')}`,
            y: `${numberOr(config.yValue, 0)}${cssUnit(config.yUnit, 'px')}`,
          };
          state.timings.set('transform', timing);
          break;
        }
        case 'TRANSFORM_SCALE': {
          state.scale = { x: numberOr(config.xValue, 1), y: numberOr(config.yValue, 1) };
          state.timings.set('transform', timing);
          break;
        }
        case 'TRANSFORM_ROTATE': {
          state.rotate = numberOr(config.zValue, 0);
          state.timings.set('transform', timing);
          break;
        }
        default:
          break;
      }
    }
  }
  return states;
}

function ix2Color(config: Record<string, unknown>): string {
  const r = Math.round(numberOr(config.rValue, 0));
  const g = Math.round(numberOr(config.gValue, 0));
  const b = Math.round(numberOr(config.bValue, 0));
  const a = numberOr(config.aValue, 1);
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
}

function transformDeclaration(state: Ix2TargetState): string | null {
  const parts: string[] = [];
  if (state.translate) parts.push(`translate3d(${state.translate.x}, ${state.translate.y}, 0)`);
  if (state.scale) parts.push(`scale3d(${state.scale.x}, ${state.scale.y}, 1)`);
  if (state.rotate !== undefined) parts.push(`rotateZ(${state.rotate}deg)`);
  return parts.length ? parts.join(' ') : null;
}

function cssTransition(property: string, timing: Ix2Timing | undefined): string {
  if (!timing) return `${property} 200ms ease`;
  const delay = timing.delayMs > 0 ? ` ${timing.delayMs}ms` : '';
  return `${property} ${timing.durationMs}ms ${timing.easing}${delay}`;
}

function mediaQueryFor(keys: string[] | undefined): string | null {
  if (!keys || keys.length === 0) return null;
  const known = keys.filter(key => IX2_MEDIA_QUERIES[key]);
  if (known.length === 0 || known.length === IX2_ALL_MEDIA.length) return null;
  return known.map(key => IX2_MEDIA_QUERIES[key]).join(', ');
}

/**
 * Turn the export's hover interactions into CSS.
 *
 * Only the hover state is emitted; the resting values are deliberately left to
 * the site's own stylesheet, because Webflow does not apply the hover-out
 * action list until the element has actually been hovered — writing those
 * values into the base rule would change how the page looks on first paint.
 * The base rule therefore carries only the transition that animates back.
 */
function buildIx2HoverCss(
  jsFiles: Array<{ filePath: string; content: string }>,
  warnings: string[]
): string {
  const payloads = extractIx2Payloads(jsFiles);
  if (payloads.length === 0) return '';

  const blocks: string[] = [];
  let converted = 0;
  let skipped = 0;

  for (const payload of payloads) {
    const events = payload.events || {};
    const actionLists = payload.actionLists || {};

    const outBySelector = new Map<string, Ix2Event>();
    for (const event of Object.values(events)) {
      if (event.eventTypeId === 'MOUSE_OUT' && isClassChainSelector(event.target?.selector)) {
        outBySelector.set(event.target!.selector!, event);
      }
    }

    const seen = new Set<string>();
    for (const event of Object.values(events)) {
      if (event.eventTypeId !== 'MOUSE_OVER') continue;
      const trigger = event.target?.selector;
      if (event.target?.appliesTo !== 'CLASS' || !isClassChainSelector(trigger)) {
        if (event.eventTypeId === 'MOUSE_OVER') skipped += 1;
        continue;
      }
      if (seen.has(trigger)) continue;
      seen.add(trigger);

      const hoverIn = foldActionList(actionLists[String(event.action?.config?.actionListId ?? '')]);
      if (hoverIn.size === 0) { skipped += 1; continue; }
      const outEvent = outBySelector.get(trigger);
      const hoverOut = foldActionList(actionLists[String(outEvent?.action?.config?.actionListId ?? '')]);

      const rules: string[] = [];
      for (const [suffix, state] of hoverIn) {
        const declarations = [...state.declarations].map(([property, value]) => `  ${property}: ${value};`);
        const transform = transformDeclaration(state);
        if (transform) declarations.push(`  transform: ${transform};`);
        if (declarations.length === 0) continue;

        // The base rule only transitions back; hover-out timing comes from the
        // paired MOUSE_OUT action list when the export has one.
        const back = hoverOut.get(suffix);
        const properties = [...new Set([...state.timings.keys(), ...(back?.timings.keys() ?? [])])];
        const transitionOut = properties
          .map(property => cssTransition(property, back?.timings.get(property) ?? state.timings.get(property)))
          .join(', ');
        const transitionIn = properties
          .map(property => cssTransition(property, state.timings.get(property)))
          .join(', ');

        rules.push(`${trigger}${suffix} {\n  transition: ${transitionOut};\n}`);
        rules.push(`${trigger}:hover${suffix} {\n${declarations.join('\n')}\n  transition: ${transitionIn};\n}`);
      }
      if (rules.length === 0) { skipped += 1; continue; }

      const media = mediaQueryFor(event.mediaQueries);
      const title = actionLists[String(event.action?.config?.actionListId ?? '')]?.title;
      const body = media
        ? `@media ${media} {\n${rules.map(rule => rule.replace(/^/gm, '  ')).join('\n')}\n}`
        : rules.join('\n');
      blocks.push(`/* Webflow interaction${title ? `: ${title}` : ''} (${trigger}) */\n${body}`);
      converted += 1;
    }
  }

  if (converted > 0) {
    warnings.push(
      `${converted} Webflow hover interaction${converted === 1 ? '' : 's'} converted to CSS`
      + (skipped > 0
        ? `; ${skipped} interaction${skipped === 1 ? '' : 's'} skipped (scroll/click triggers and element-scoped targets have no CSS equivalent and need to be rebuilt in the builder).`
        : '.')
    );
  }

  return blocks.length ? `/* --- Webflow interactions (ix2) --- */\n${blocks.join('\n\n')}` : '';
}

function buildImportedCss(
  cssFiles: Array<{ filePath: string; content: string }>,
  assetPublicUrlBySource: Map<string, string>,
  preferredOrder: string[]
): string {
  const sorted = orderCssFiles(cssFiles, preferredOrder);
  return sorted
    .map(file => `/* ${file.filePath} */\n${rewriteCssUrls(file.content, file.filePath, assetPublicUrlBySource)}`)
    .join('\n\n');
}

function parseWebflowCsv(payload: WebflowImportPayload): ParsedWebflowCsv[] {
  return payload.csvFiles.map((csvFile) => {
    const parsed = parseCSVText(csvFile.content);
    const firstRow = parsed.rows[0] || {};
    const collectionId = firstRow['Collection ID'] || randomUUID();
    const rawName = csvFile.filename.split(' - ')[1]?.split(' - ')[0] || path.basename(csvFile.filename, '.csv');
    const name = sanitizeCollectionName(rawName);

    return {
      name,
      headers: parsed.headers,
      rows: parsed.rows,
      webflowCollectionId: collectionId,
    };
  });
}

function buildTextLayer(text: string, tag: string = 'span', classes: string = ''): Layer {
  return {
    id: randomUUID(),
    name: 'text',
    classes,
    settings: { tag },
    restrictions: { editText: true },
    variables: {
      text: {
        type: 'dynamic_rich_text',
        data: {
          content: stringToTiptapContent(text),
        },
      },
    },
  };
}

function getInlineStyle(
  element: HTMLElement,
  assetPublicUrlBySource: Map<string, string>
): string | undefined {
  const raw = element.getAttribute('style');
  if (!raw) return undefined;
  return raw.replace(/url\(([^)]+)\)/g, (fullMatch, rawValue) => {
    const original = String(rawValue).trim().replace(/^["']|["']$/g, '');
    if (!original || original.startsWith('data:') || original.startsWith('#') || /^https?:\/\//.test(original)) {
      return fullMatch;
    }
    const baseName = path.posix.basename(original);
    const mapped = assetPublicUrlBySource.get(normalizeSlashes(original).replace(/^\.\//, ''))
      || assetPublicUrlBySource.get(baseName);
    return mapped ? `url("${mapped}")` : fullMatch;
  });
}

/**
 * Webflow attributes that its own stylesheet (`components.css`) keys off. Without
 * them rules like `.w-nav[data-collapse="all"] .w-nav-menu { display: none }`
 * never match and the imported page renders with its navigation permanently
 * open. Kept to a whitelist so no arbitrary markup travels into layer settings.
 */
const PRESERVED_WEBFLOW_ATTRIBUTES = [
  'data-collapse',
  'data-animation',
  'data-duration',
  'data-easing',
  'data-easing2',
  'data-doc-height',
  'data-hover',
  'data-delay',
  'data-w-id',
  'role',
  // Webflow's grid/Quick-Stack placement lives in `#w-node-… { grid-template-columns: … }`
  // rules in the site stylesheet. Without the id those rules never match and every
  // Quick Stack collapses to a single column (the artist page's two-column bio).
  'id',
];

/** Inline style (with rewritten asset URLs) plus the preserved Webflow attributes. */
function getPreservedAttributes(
  element: HTMLElement,
  inlineStyle: string | undefined
): Record<string, string> | undefined {
  const attributes: Record<string, string> = {};
  if (inlineStyle) attributes.style = inlineStyle;
  for (const name of PRESERVED_WEBFLOW_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value !== null && value !== undefined && value !== '') attributes[name] = value;
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

/**
 * `node-html-parser` returns `undefined` (not `null`) for a missing attribute, so
 * the natural-looking `getAttribute(name) !== null` test is true for EVERY boolean
 * attribute. That made imported `<video>` elements come out with `controls`,
 * `autoplay`, `loop` and `muted` all set regardless of the source markup — which is
 * why background videos rendered as a 300x150 player with visible controls.
 */
function hasBooleanAttribute(element: HTMLElement, name: string): boolean {
  const value = element.getAttribute(name);
  return value !== null && value !== undefined;
}

/** Webflow's own `data-*` switches, which use the strings "true"/"false". */
function webflowFlag(element: HTMLElement, name: string, fallback: boolean): boolean {
  const raw = element.getAttribute(name);
  if (raw === null || raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() !== 'false';
}

/**
 * Framework classes ycode's Tailwind-aware class stack cannot carry.
 * `getAffectedProperties("w-background-video")` reads the `w-` prefix as a width
 * utility, so `mergeClassStack` evicts the class from the layer and the wrapper
 * loses `position: relative; overflow: hidden` — the reason the hero video used to
 * render as a small inline player in the top-left corner. We therefore emit the
 * geometry as explicit Tailwind utilities instead of trusting the class name.
 */
const BACKGROUND_VIDEO_WRAPPER_CLASSES = 'relative overflow-hidden';
const BACKGROUND_VIDEO_VIDEO_CLASSES = 'absolute inset-0 w-full h-full object-cover';
/** Webflow's own bg-video classes: the ones we replace with explicit utilities. */
const BACKGROUND_VIDEO_FRAMEWORK_CLASSES = new Set([
  'w-background-video',
  'w-background-video-atom',
]);

function isBackgroundVideoWrapper(element: HTMLElement, className: string): boolean {
  if (element.tagName?.toLowerCase() === 'video') return false;
  const classes = className.split(/\s+/);
  if (classes.includes('w-background-video') || classes.includes('w-background-video-atom')) return true;
  return !!element.getAttribute('data-video-urls') && !!element.querySelector('video');
}

/**
 * Webflow background video (`<div class="w-background-video">` wrapping an
 * autoplaying `<video>`): rebuilt as a positioned, overflow-hidden box whose video
 * child fills it. Webflow's play/pause control and the `<noscript>` fallback are
 * dropped — both need Webflow's runtime JS, which the static export does not ship.
 */
function buildBackgroundVideoLayer(
  element: HTMLElement,
  className: string,
  styleAttr: Record<string, string> | undefined,
  assetIdBySource: Map<string, string>,
  assetPublicUrlBySource: Map<string, string>,
  warnings: string[]
): Layer {
  const lookup = <T,>(map: Map<string, T>, raw: string): T | undefined => {
    const normalized = normalizeSlashes(raw.trim()).replace(/^\.\//, '');
    if (!normalized || /^https?:\/\//.test(normalized) || normalized.startsWith('data:')) return undefined;
    return map.get(normalized)
      || map.get(stripTopLevelFolder(normalized))
      || map.get(path.basename(normalized));
  };
  const lookupAsset = (raw: string): string | undefined => lookup(assetIdBySource, raw);
  const lookupUrl = (raw: string): string | undefined => lookup(assetPublicUrlBySource, raw);

  const videoElement = element.querySelector('video');

  // Candidate sources: <source src> children first, then `data-video-urls`.
  const candidates: string[] = [];
  for (const source of videoElement?.querySelectorAll('source') || []) {
    const src = source.getAttribute('src');
    if (src) candidates.push(src);
  }
  for (const url of (element.getAttribute('data-video-urls') || '').split(',')) {
    if (url.trim()) candidates.push(url.trim());
  }
  const videoSrcFromTag = videoElement?.getAttribute('src');
  if (videoSrcFromTag) candidates.push(videoSrcFromTag);

  // mp4 first: the only container every browser can decode.
  const ordered = [...new Set(candidates)].sort(
    (a, b) => Number(/\.mp4$/i.test(b)) - Number(/\.mp4$/i.test(a))
  );
  const resolved = ordered
    .map(candidate => ({ candidate, assetId: lookupAsset(candidate), url: lookupUrl(candidate) }))
    .filter((entry): entry is { candidate: string; assetId: string; url: string } => !!entry.assetId && !!entry.url);
  if (resolved.length === 0) {
    warnings.push(`Background video source not found in import payload (${ordered[0] || 'no source'})`);
  } else if (resolved.length > 1) {
    // Worth saying out loud: a browser without the chosen container's codec now
    // shows the poster frame instead of silently falling back to the second file.
    warnings.push(
      `Background video kept "${path.basename(resolved[0].candidate)}"; `
      + `alternate format(s) ${resolved.slice(1).map(r => path.basename(r.candidate)).join(', ')} dropped `
      + '(a video layer holds one source — the poster is shown where that format cannot be decoded)'
    );
  }

  const posterRaw = element.getAttribute('data-poster-url')
    || (videoElement?.getAttribute('style') || '').match(/url\((?:&quot;|["']?)([^)"'&]+)/)?.[1]
    || '';
  const posterAssetId = posterRaw ? lookupAsset(posterRaw) : undefined;
  const posterUrl = posterRaw ? lookupUrl(posterRaw) : undefined;
  if (posterRaw && !posterAssetId) {
    warnings.push(`Background video poster not found in import payload (${posterRaw})`);
  }

  const wrapperClasses = [
    ...className.split(/\s+/).filter(c => c && !BACKGROUND_VIDEO_FRAMEWORK_CLASSES.has(c)),
    ...BACKGROUND_VIDEO_WRAPPER_CLASSES.split(' '),
  ];

  // Webflow ships every background video twice (mp4 + webm) and lets the browser
  // pick the container it can decode. ycode's video layer models a single
  // `variables.video.src` and upstream's renderer rejects `<source>` children
  // (React: "source is a void element tag"), so we take the mp4 — the first
  // `<source>` in the export and the only container every shipping browser can
  // decode — and rely on `poster` for anything that cannot play it, which keeps
  // the hero showing the video's own first frame instead of a black box.
  const videoVariables: Record<string, unknown> = {
    src: resolved[0]
      ? { type: 'asset', data: { asset_id: resolved[0].assetId } }
      : { type: 'dynamic_text', data: { content: ordered[0] || '' } },
  };
  if (posterAssetId) {
    videoVariables.poster = { type: 'asset', data: { asset_id: posterAssetId } };
  }

  const videoLayer: Layer = {
    id: randomUUID(),
    name: 'video',
    classes: BACKGROUND_VIDEO_VIDEO_CLASSES,
    attributes: {
      // Webflow paints the poster as a CSS background on the <video> itself, not
      // just as its `poster` attribute — and that is what keeps the frame visible
      // when the browser cannot decode the container (the `poster` attribute is
      // dropped the moment the element errors). Without it those tiles render
      // blank instead of showing the still.
      ...(posterUrl
        ? { style: `background-image: url("${posterUrl}"); background-size: cover; background-position: 50% 50%;` }
        : {}),
      // A background video is decoration: never chrome, always silent, and
      // `playsinline` so mobile Safari does not hijack it into fullscreen.
      controls: false,
      autoplay: webflowFlag(element, 'data-autoplay', true),
      loop: webflowFlag(element, 'data-loop', true),
      muted: true,
      preload: 'auto',
      'aria-hidden': 'true',
    },
    variables: { video: videoVariables } as Layer['variables'],
  };

  return {
    id: randomUUID(),
    name: 'div',
    classes: [...new Set(wrapperClasses)].join(' '),
    attributes: styleAttr,
    children: [videoLayer],
  };
}

/**
 * Map an element's children, folding `<br>`-separated text into one layer.
 *
 * Webflow writes multi-line footer blocks as bare text nodes joined by `<br>`
 * (`Atelier Studio <br>von Brase <br>…`). Mapping each text node on its own
 * turned the four address lines into four sibling inline layers, which the
 * parent's flex row then laid out side by side. A run of text nodes and `<br>`s
 * becomes a single text layer whose content carries the newlines, plus
 * `whitespace-pre-line` so they render as the line breaks they were.
 */
function mapChildNodesToLayers(
  element: HTMLElement,
  assetIdBySource: Map<string, string>,
  warnings: string[],
  assetPublicUrlBySource?: Map<string, string>
): Layer[] {
  const nodes = element.childNodes;
  const layers: Layer[] = [];
  let index = 0;

  const isBreak = (node: HtmlNode) =>
    node.nodeType === NodeType.ELEMENT_NODE && (node as HTMLElement).tagName?.toLowerCase() === 'br';
  const isText = (node: HtmlNode) => node.nodeType === NodeType.TEXT_NODE;

  while (index < nodes.length) {
    const node = nodes[index];
    if (isBreak(node) || isText(node)) {
      let end = index;
      let hasBreak = false;
      while (end < nodes.length && (isBreak(nodes[end]) || isText(nodes[end]))) {
        if (isBreak(nodes[end])) hasBreak = true;
        end += 1;
      }
      if (hasBreak) {
        const lines: string[] = [];
        let current = '';
        for (let i = index; i < end; i += 1) {
          if (isBreak(nodes[i])) {
            lines.push(current.replace(/\s+/g, ' ').trim());
            current = '';
          } else {
            current += nodes[i].text;
          }
        }
        lines.push(current.replace(/\s+/g, ' ').trim());
        const text = lines.filter((line, i) => line || (i > 0 && i < lines.length - 1)).join('\n');
        if (text.trim()) {
          layers.push(buildTextLayer(text, 'span', 'whitespace-pre-line'));
        }
        index = end;
        continue;
      }
    }
    const layer = mapElementToLayer(node, assetIdBySource, warnings, assetPublicUrlBySource);
    if (layer) layers.push(layer);
    index += 1;
  }

  return layers;
}

function mapElementToLayer(
  node: HtmlNode,
  assetIdBySource: Map<string, string>,
  warnings: string[],
  assetPublicUrlBySource?: Map<string, string>
): Layer | null {
  if (node.nodeType === NodeType.TEXT_NODE) {
    const text = node.rawText.replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return buildTextLayer(text, 'span');
  }

  if (node.nodeType !== NodeType.ELEMENT_NODE) {
    return null;
  }

  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  const className = element.getAttribute('class') || '';

  if (tag === 'script' || tag === 'link' || tag === 'style' || tag === 'noscript') {
    return null;
  }

  const urlMap = assetPublicUrlBySource || new Map<string, string>();
  const inlineStyle = getInlineStyle(element, urlMap);
  const styleAttr = getPreservedAttributes(element, inlineStyle);

  if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'small', 'label', 'blockquote'].includes(tag)) {
    const text = element.text.trim();
    if (!text) {
      // An empty heading/paragraph is normally noise — except when Webflow marked it
      // as a CMS slot. Dropping those lost half the bindable slots on every list
      // (`<h1 class="… w-dyn-bind-empty">` is where the item's Name belongs).
      if (!className.split(/\s+/).includes('w-dyn-bind-empty')) return null;
      return {
        id: randomUUID(),
        name: 'text',
        classes: className,
        settings: { tag },
        attributes: styleAttr,
        restrictions: { editText: true },
        variables: { text: { type: 'dynamic_text', data: { content: '' } } },
      };
    }
    const html = element.innerHTML.trim();
    const hasInnerHtml = html.includes('<');
    const textLayer = buildTextLayer(hasInnerHtml ? html : text, tag, className);
    return styleAttr ? { ...textLayer, attributes: styleAttr } : textLayer;
  }

  if (isBackgroundVideoWrapper(element, className)) {
    return buildBackgroundVideoLayer(element, className, styleAttr, assetIdBySource, urlMap, warnings);
  }

  if (tag === 'img') {
    const src = element.getAttribute('src') || '';
    const normalizedSrc = normalizeSlashes(src).replace(/^\.\//, '');
    const assetId = assetIdBySource.get(normalizedSrc)
      || assetIdBySource.get(stripTopLevelFolder(normalizedSrc))
      || assetIdBySource.get(path.basename(src));
    if (!assetId) {
      warnings.push(`Asset for image "${src}" not found in import payload`);
    }

    return {
      id: randomUUID(),
      name: 'image',
      classes: className,
      settings: { tag: 'img' },
      attributes: styleAttr,
      variables: {
        image: {
          src: assetId
            ? { type: 'asset', data: { asset_id: assetId } }
            : { type: 'dynamic_text', data: { content: src } },
          alt: { type: 'dynamic_text', data: { content: element.getAttribute('alt') || '' } },
        },
      },
    };
  }

  if (tag === 'video') {
    const srcFromTag = element.getAttribute('src');
    const sourceNode = element.querySelector('source');
    const sourceSrc = sourceNode?.getAttribute('src');
    const src = srcFromTag || sourceSrc || '';
    const normalizedSrc = normalizeSlashes(src).replace(/^\.\//, '');
    const assetId = assetIdBySource.get(normalizedSrc)
      || assetIdBySource.get(stripTopLevelFolder(normalizedSrc))
      || assetIdBySource.get(path.basename(src));

    return {
      id: randomUUID(),
      name: 'video',
      classes: className,
      attributes: {
        ...styleAttr,
        controls: hasBooleanAttribute(element, 'controls'),
        autoplay: hasBooleanAttribute(element, 'autoplay'),
        loop: hasBooleanAttribute(element, 'loop'),
        muted: hasBooleanAttribute(element, 'muted') || hasBooleanAttribute(element, 'autoplay'),
      },
      variables: {
        video: {
          src: assetId
            ? { type: 'asset', data: { asset_id: assetId } }
            : { type: 'dynamic_text', data: { content: src } },
        },
      },
    };
  }

  if (tag === 'a') {
    const href = resolveHref(element.getAttribute('href') || '#');
    const children = mapChildNodesToLayers(element, assetIdBySource, warnings, assetPublicUrlBySource);

    return {
      id: randomUUID(),
      name: 'div',
      classes: className,
      settings: { tag: 'a' },
      attributes: styleAttr,
      variables: {
        link: {
          type: 'url',
          url: { type: 'dynamic_text', data: { content: href } },
        },
      },
      // An empty anchor stays empty. Webflow uses them as icon buttons whose
      // artwork is a CSS background (the back-to-top arrow); injecting a "Link"
      // placeholder printed that word on top of the icon on every page.
      children,
    };
  }

  const children = mapChildNodesToLayers(element, assetIdBySource, warnings, assetPublicUrlBySource);

  const layerName = SAFE_HTML_TAGS.has(tag) ? tag : 'div';

  if (children.length === 0 && className.includes('w-embed')) {
    return null;
  }

  if (children.length === 0) {
    const text = element.text.trim();
    if (text) {
      const textLayer = buildTextLayer(text, tag === 'div' ? 'div' : tag, className);
      return styleAttr ? { ...textLayer, attributes: styleAttr } : textLayer;
    }
  }

  return {
    id: randomUUID(),
    name: layerName,
    classes: className,
    settings: tag !== 'div' && tag !== layerName ? { tag } : undefined,
    attributes: styleAttr,
    children,
  };
}

/**
 * Webflow navbar (`.w-nav`) toggle.
 *
 * The static export ships no JavaScript for the hamburger: `components.css` only
 * hides `.w-nav-menu` (`.w-nav[data-collapse='all'] .w-nav-menu { display:none }`)
 * and shows `.w-nav-button`; the opening is done by Webflow's runtime, which the
 * export does not include. We replace it with a ycode `click` interaction on the
 * button layer that toggles the menu layer's display, mirroring
 * `lib/webwow/import/webflow-zip/widgets.ts`.
 *
 * The menu's visibility has to be owned by exactly one mechanism. ycode's runtime
 * shows a layer by REMOVING `data-gsap-hidden`, which cannot beat a CSS
 * `display: none` that still matches — so the `w-nav-menu` class is stripped from
 * the menu layer (its geometry comes from the site's own `.nav-menu` class) and
 * the on-load hidden state comes from the interaction instead.
 */
const NAV_COLLAPSE_BREAKPOINTS: Record<string, Breakpoint[]> = {
  all: ['desktop', 'tablet', 'mobile'],
  medium: ['tablet', 'mobile'],
  small: ['mobile'],
  tiny: ['mobile'],
};
const DEFAULT_NAV_DURATION_MS = 400;
/** Tailwind display shims that would survive a `data-gsap-hidden` removal. */
const DISPLAY_SHIM_CLASSES = new Set(['hidden', 'max-lg:hidden', 'max-md:hidden']);

function classTokens(layer: Layer): string[] {
  const raw = layer.classes;
  if (Array.isArray(raw)) return raw.flatMap(c => String(c).split(/\s+/)).filter(Boolean);
  return String(raw || '').split(/\s+/).filter(Boolean);
}

function layerHasClassToken(layer: Layer, token: string): boolean {
  return classTokens(layer).includes(token);
}

function findLayerWithClass(layer: Layer, token: string, stopAt: string): Layer | undefined {
  for (const child of layer.children || []) {
    if (layerHasClassToken(child, token)) return child;
    // A nested navbar owns its own parts — do not steal them.
    if (layerHasClassToken(child, stopAt)) continue;
    const found = findLayerWithClass(child, token, stopAt);
    if (found) return found;
  }
  return undefined;
}

function collectLayersWithClass(layers: Layer[], token: string, out: Layer[] = []): Layer[] {
  for (const layer of layers) {
    if (layerHasClassToken(layer, token)) out.push(layer);
    if (layer.children) collectLayersWithClass(layer.children, token, out);
  }
  return out;
}

/** Drop class tokens that would keep a toggled layer invisible after the runtime reveals it. */
function stripClassTokens(layer: Layer, drop: (token: string) => boolean): void {
  const kept = classTokens(layer).filter(token => !drop(token));
  layer.classes = Array.isArray(layer.classes) ? (kept as unknown as Layer['classes']) : kept.join(' ');
}

function buildNavToggleInteraction(
  menuLayerId: string,
  breakpoints: Breakpoint[],
  durationSeconds: number,
  animation: string
): LayerInteraction {
  // `data-animation="over-right" | "over-left"` slides the panel in from that edge.
  const slide = animation === 'over-right' ? '100%' : animation === 'over-left' ? '-100%' : null;
  const from: Record<string, string> = { display: 'hidden' };
  const to: Record<string, string> = { display: 'visible' };
  if (slide) {
    from.x = slide;
    to.x = '0%';
  } else {
    from.autoAlpha = '0';
    to.autoAlpha = '100';
  }

  return {
    id: randomUUID(),
    trigger: 'click',
    timeline: { breakpoints, repeat: 0, yoyo: true },
    tweens: [
      {
        id: randomUUID(),
        layer_id: menuLayerId,
        position: 0,
        duration: durationSeconds,
        ease: 'power2.out',
        from: from as LayerInteraction['tweens'][number]['from'],
        to: to as LayerInteraction['tweens'][number]['to'],
        // `on-load` = paint the hidden state server-side, so the menu is closed
        // before hydration instead of flashing open.
        apply_styles: { display: 'on-load' },
      },
    ],
  };
}

/**
 * Webflow dropdowns (`.w-dropdown`) are runtime widgets too: `components.css`
 * only hides `.w-dropdown-list`, and the opening lives in webflow.js. The
 * toggle gets a `click` interaction (or `hover` for `data-hover="true"`) that
 * reveals the list, exactly as `lib/webwow/import/webflow-zip/widgets.ts` does.
 *
 * Unlike the navbar the framework class is NOT stripped here: `.w-dropdown-list`
 * also carries the panel's `position`, `min-width` and background, and the site
 * stylesheet routinely overrides just one of them (this export sets
 * `position: relative` on its own `.dropdown-list`). Instead
 * `DROPDOWN_REVEAL_CSS` re-opens the panel once the runtime has removed
 * `data-gsap-hidden`, which outranks `.w-dropdown-list { display: none }` on
 * specificity and source order while leaving every other framework property in
 * place.
 */
const DROPDOWN_DURATION_S = 0.2;
const DROPDOWN_REVEAL_CSS = `/* --- Webflow dropdowns (revealed by the generated interaction) --- */
.w-dropdown-list:not([data-gsap-hidden]) {
  display: block;
}`;

function generateDropdownInteractions(layers: Layer[], warnings: string[]): number {
  let generated = 0;
  for (const dropdown of collectLayersWithClass(layers, 'w-dropdown')) {
    const toggle = findLayerWithClass(dropdown, 'w-dropdown-toggle', 'w-dropdown');
    const list = findLayerWithClass(dropdown, 'w-dropdown-list', 'w-dropdown');
    if (!toggle || !list) {
      warnings.push(`Dropdown without ${toggle ? 'list' : 'toggle'}: no interaction generated`);
      continue;
    }

    const attributes = (dropdown.attributes || {}) as Record<string, unknown>;
    const trigger = String(attributes['data-hover'] ?? '').toLowerCase() === 'true' ? 'hover' : 'click';
    toggle.interactions = [
      ...(toggle.interactions || []),
      {
        id: randomUUID(),
        trigger,
        timeline: { breakpoints: ['desktop', 'tablet', 'mobile'], repeat: 0, yoyo: true },
        tweens: [
          {
            id: randomUUID(),
            layer_id: list.id,
            position: 0,
            duration: DROPDOWN_DURATION_S,
            ease: 'none',
            from: { display: 'hidden' } as LayerInteraction['tweens'][number]['from'],
            to: { display: 'visible' } as LayerInteraction['tweens'][number]['to'],
            apply_styles: { display: 'on-load' },
          },
        ],
      },
    ];
    stripClassTokens(list, token => DISPLAY_SHIM_CLASSES.has(token));
    toggle.attributes = { ...(toggle.attributes || {}), role: 'button', tabindex: '0' };
    generated++;
  }
  return generated;
}

function generateNavigationInteractions(layers: Layer[], warnings: string[]): number {
  let generated = 0;
  for (const nav of collectLayersWithClass(layers, 'w-nav')) {
    const attributes = (nav.attributes || {}) as Record<string, unknown>;
    const collapse = String(attributes['data-collapse'] ?? 'medium').toLowerCase();
    if (collapse === 'none') continue;

    const button = findLayerWithClass(nav, 'w-nav-button', 'w-nav');
    const menu = findLayerWithClass(nav, 'w-nav-menu', 'w-nav');
    if (!button || !menu) {
      warnings.push(`Navbar without ${button ? 'menu' : 'hamburger button'}: no toggle interaction generated`);
      continue;
    }

    const ms = Number.parseInt(String(attributes['data-duration'] ?? ''), 10);
    const duration = (Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_NAV_DURATION_MS) / 1000;
    const breakpoints = NAV_COLLAPSE_BREAKPOINTS[collapse] || NAV_COLLAPSE_BREAKPOINTS.medium;
    const animation = String(attributes['data-animation'] ?? '').toLowerCase();

    button.interactions = [
      ...(button.interactions || []),
      buildNavToggleInteraction(menu.id, breakpoints, duration, animation),
    ];
    // The interaction is now the single owner of the menu's visibility.
    stripClassTokens(menu, token => token === 'w-nav-menu' || DISPLAY_SHIM_CLASSES.has(token));
    // Webflow renders the hamburger as a plain <div>; make it behave like a control.
    button.attributes = { ...(button.attributes || {}), role: 'button', tabindex: '0' };
    generated++;
  }
  return generated;
}

function buildPagesFromHtml(
  htmlFiles: Array<{ filePath: string; content: string }>,
  assetIdBySource: Map<string, string>,
  assetPublicUrlBySource: Map<string, string>,
  warnings: string[],
  /** Set to the number of dropdown interactions generated, so the caller can emit their CSS. */
  counters?: { dropdowns: number }
): Array<{ page: Record<string, unknown>; pageLayers: Record<string, unknown> }> {
  let dropdowns = 0;
  const pages = htmlFiles.map(({ filePath, content }, index) => {
    const slug = slugFromFilename(filePath);
    const fileBaseName = path.basename(filePath, '.html');
    const pageName = fileBaseName === 'index' ? 'Homepage' : fileBaseName.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const pageId = randomUUID();

    const root = parse(content);
    const body = root.querySelector('body');
    const bodyChildren = body?.childNodes || [];
    const children = bodyChildren
      .map(child => mapElementToLayer(child, assetIdBySource, warnings, assetPublicUrlBySource))
      .filter((layer): layer is Layer => !!layer);

    const layers: Layer[] = [{
      id: randomUUID(),
      name: 'body',
      classes: body?.getAttribute('class') || '',
      children,
    }];

    const embeddedCss = rewriteCssUrls(
      extractEmbeddedCssFromHtml(content),
      filePath,
      assetPublicUrlBySource
    );

    generateNavigationInteractions(layers, warnings);
    dropdowns += generateDropdownInteractions(layers, warnings);

    return {
      page: {
        id: pageId,
        name: pageName,
        slug,
        page_folder_id: null,
        order: index,
        depth: 0,
        is_index: slug === '',
        is_dynamic: false,
        error_page: null,
        settings: embeddedCss
          ? { custom_code: { head: `<style id="webwow-webflow-page">\n${embeddedCss}\n</style>` } }
          : {},
        is_published: false,
        is_publishable: true,
      },
      pageLayers: {
        id: randomUUID(),
        page_id: pageId,
        layers,
        is_published: false,
      },
    };
  });
  if (counters) counters.dropdowns = dropdowns;
  return pages;
}

function buildProjectManifest(projectName: string, stats: WebflowImportResult): ProjectManifest {
  return {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    source: 'opensource',
    projectName,
    tables: [
      'settings',
      'assets',
      'pages',
      'page_layers',
      'layer_styles',
      'collections',
      'collection_fields',
      'collection_items',
      'collection_item_values',
    ],
    stats: {
      pages: stats.pages,
      components: 0,
      collections: stats.collections,
      assets: stats.assets,
    },
  };
}

async function processWebflowImportInternal(
  payload: WebflowImportPayload,
  shouldImport: boolean
): Promise<ConvertWebflowToProjectExportResponse> {
  const warnings: string[] = [];
  const errors: string[] = [];

  const result: WebflowImportResult = {
    pages: 0,
    collections: 0,
    items: 0,
    assets: 0,
  };

  try {
    const zipBuffer = Buffer.from(payload.zipBase64, 'base64');
    const zip = await JSZip.loadAsync(zipBuffer);

    const topLevelFolder = detectTopLevelFolder(zip);
    const normZipPath = (p: string) =>
      topLevelFolder ? stripTopLevelFolder(p) : normalizeSlashes(p);

    const htmlFiles: Array<{ filePath: string; content: string }> = [];
    const cssFiles: Array<{ filePath: string; content: string }> = [];
    /** Kept only to mine Webflow's IX2 interaction data; the JS itself is never shipped. */
    const jsFiles: Array<{ filePath: string; content: string }> = [];
    const assets: AssetCollector = { files: [], rows: [] };
    const assetIdBySource = new Map<string, string>();
    // ZIP path / remote URL -> upstream asset proxy URL (for CSS url() rewriting)
    const assetPublicUrlBySource = new Map<string, string>();
    const remoteAssetCache = new Map<string, string>();
    /** CMS asset URLs this server could not fetch — reported once, not per row. */
    const undownloadedAssetUrls = new Set<string>();

    const rememberAsset = (source: string, asset: ImportedAsset, includeBaseName: boolean) => {
      const normalizedSource = normalizeSlashes(source);
      assetIdBySource.set(normalizedSource, asset.id);
      if (asset.proxyUrl) {
        assetPublicUrlBySource.set(normalizedSource, asset.proxyUrl);
      }
      if (!includeBaseName) return;
      const baseName = path.basename(normalizedSource);
      if (!assetIdBySource.has(baseName)) {
        assetIdBySource.set(baseName, asset.id);
      }
      if (asset.proxyUrl && !assetPublicUrlBySource.has(baseName)) {
        assetPublicUrlBySource.set(baseName, asset.proxyUrl);
      }
    };

    for (const [filePath, zipObject] of Object.entries(zip.files)) {
      if (zipObject.dir) continue;
      const normalizedPath = normZipPath(filePath);
      const lowerPath = normalizedPath.toLowerCase();

      if (lowerPath.endsWith('.html')) {
        htmlFiles.push({
          filePath: normalizedPath,
          content: await zipObject.async('text'),
        });
        continue;
      }

      if (lowerPath.endsWith('.css')) {
        cssFiles.push({
          filePath: normalizedPath,
          content: await zipObject.async('text'),
        });
        continue;
      }

      if (lowerPath.endsWith('.js')) {
        jsFiles.push({
          filePath: normalizedPath,
          content: await zipObject.async('text'),
        });
        continue;
      }

      try {
        const buffer = await zipObject.async('nodebuffer');
        const registered = registerAsset(assets, path.basename(normalizedPath), buffer, inferMimeType(normalizedPath));
        rememberAsset(normalizedPath, registered, true);
      } catch (error) {
        warnings.push(`Asset "${normalizedPath}" could not be imported: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }

    htmlFiles.sort((a, b) => a.filePath.localeCompare(b.filePath));

    const assetRows = assets.rows;

    // Import asset URLs referenced in CSS (remote and local)
    for (const cssFile of cssFiles) {
      for (const cssUrl of extractCssUrls(cssFile.content)) {
        const normalized = normalizeSlashes(cssUrl).replace(/^\.\//, '');
        if (assetIdBySource.has(normalized) || assetIdBySource.has(stripTopLevelFolder(normalized))) {
          continue;
        }

        if (/^https?:\/\//.test(normalized)) {
          if (remoteAssetCache.has(normalized)) {
            continue;
          }
          const downloaded = await downloadRemoteAsset(normalized);
          if (!downloaded) {
            warnings.push(`Remote CSS asset "${normalized}" could not be downloaded`);
            continue;
          }
          const uploaded = registerAsset(assets, downloaded.filename, downloaded.buffer, downloaded.mimeType);
          remoteAssetCache.set(normalized, uploaded.id);
          rememberAsset(normalized, uploaded, false);
        }
      }
    }

    const parsedCsvCollections = parseWebflowCsv(payload);
    const normalizedCollections: NormalizedCollection[] = parsedCsvCollections.map((collection) => ({
      id: randomUUID(),
      webflowCollectionId: collection.webflowCollectionId,
      name: collection.name,
      headers: collection.headers.filter(header => !CSV_META_COLUMNS.has(header)),
      rows: collection.rows,
    }));

    const itemIdMap = new Map<string, string>(); // key: `${collectionId}:${oldItemId}` => newItemId
    const webflowItemIdsByCollection = new Map<string, Set<string>>();
    for (const collection of normalizedCollections) {
      const set = new Set<string>();
      for (const row of collection.rows) {
        const oldItemId = row['Item ID'];
        if (oldItemId) {
          set.add(oldItemId);
        }
      }
      webflowItemIdsByCollection.set(collection.id, set);
    }

    const fields: NormalizedField[] = [];
    for (const collection of normalizedCollections) {
      collection.headers.forEach((header, index) => {
        const values = collection.rows
          .map(row => (row[header] || '').trim())
          .filter(Boolean);

        const primitiveType = classifyPrimitiveType(values);
        const relation = inferRelationType(values, webflowItemIdsByCollection);

        const fieldType = relation.type || primitiveType || 'text';
        const referenceCollectionId = relation.targetCollectionId;

        fields.push({
          id: randomUUID(),
          collectionId: collection.id,
          csvHeader: header,
          name: header,
          key: mapFieldKeyFromHeader(header),
          type: fieldType,
          order: index,
          referenceCollectionId,
          isMultiAsset: isAssetFieldType(fieldType) && values.some(value => splitAssetUrls(value).length > 1),
        });
      });
    }

    const fieldByCollectionAndHeader = new Map<string, NormalizedField>();
    for (const field of fields) {
      fieldByCollectionAndHeader.set(`${field.collectionId}:${field.csvHeader}`, field);
    }

    const collectionRows: Record<string, unknown>[] = normalizedCollections.map((collection, index) => ({
      id: collection.id,
      name: collection.name,
      uuid: randomUUID(),
      sorting: null,
      order: index,
      is_published: false,
    }));

    const fieldRows: Record<string, unknown>[] = fields.map((field) => ({
      id: field.id,
      collection_id: field.collectionId,
      reference_collection_id: field.referenceCollectionId,
      name: field.name,
      key: field.key,
      type: field.type,
      default: null,
      fillable: true,
      order: field.order,
      hidden: false,
      is_computed: false,
      data: {},
      is_published: false,
    }));

    const itemRows: Record<string, unknown>[] = [];
    const valueRows: Record<string, unknown>[] = [];

    for (const collection of normalizedCollections) {
      for (let rowIndex = 0; rowIndex < collection.rows.length; rowIndex++) {
        const row = collection.rows[rowIndex];
        const oldItemId = row['Item ID'] || `${collection.id}:${rowIndex}`;
        const newItemId = randomUUID();
        itemIdMap.set(`${collection.id}:${oldItemId}`, newItemId);

        itemRows.push({
          id: newItemId,
          collection_id: collection.id,
          manual_order: rowIndex,
          is_publishable: true,
          is_published: false,
        });
      }
    }

    for (const collection of normalizedCollections) {
      for (let rowIndex = 0; rowIndex < collection.rows.length; rowIndex++) {
        const row = collection.rows[rowIndex];
        const oldItemId = row['Item ID'] || `${collection.id}:${rowIndex}`;
        const newItemId = itemIdMap.get(`${collection.id}:${oldItemId}`);
        if (!newItemId) continue;

        for (const header of collection.headers) {
          const rawValue = (row[header] || '').trim();
          if (!rawValue) continue;

          const field = fieldByCollectionAndHeader.get(`${collection.id}:${header}`);
          if (!field) continue;

          let finalValue: string | null = rawValue;

          if (field.type === 'reference') {
            const oldRefId = splitReferenceCandidates(rawValue)[0];
            const targetCollectionId = field.referenceCollectionId;
            if (targetCollectionId) {
              const translatedId = itemIdMap.get(`${targetCollectionId}:${oldRefId}`);
              if (translatedId) {
                finalValue = translatedId;
              } else {
                warnings.push(`Relation value "${rawValue}" in ${collection.name}.${header} could not be translated`);
                finalValue = null;
              }
            }
          } else if (field.type === 'multi_reference') {
            const targetCollectionId = field.referenceCollectionId;
            if (targetCollectionId) {
              const translated = splitReferenceCandidates(rawValue)
                .map(oldRefId => itemIdMap.get(`${targetCollectionId}:${oldRefId}`))
                .filter((value): value is string => !!value);
              finalValue = JSON.stringify(translated);
              if (translated.length === 0) {
                warnings.push(`Multi relation "${rawValue}" in ${collection.name}.${header} produced no mapped IDs`);
              }
            }
          } else if (isAssetFieldType(field.type)) {
            // A multi-image column holds several URLs in one cell; ycode's asset
            // fields hold one asset, so the first one wins.
            const first = splitAssetUrls(rawValue)[0] || rawValue;
            const normalized = normalizeSlashes(first).replace(/^\.\//, '');
            let assetId = assetIdBySource.get(normalized) || assetIdBySource.get(stripTopLevelFolder(normalized));

            if (!assetId && /^https?:\/\//.test(normalized)) {
              if (remoteAssetCache.has(normalized)) {
                assetId = remoteAssetCache.get(normalized);
              } else {
                const downloaded = await downloadRemoteAsset(normalized);
                if (downloaded) {
                  const uploaded = registerAsset(assets, downloaded.filename, downloaded.buffer, downloaded.mimeType);
                  remoteAssetCache.set(normalized, uploaded.id);
                  rememberAsset(normalized, uploaded, false);
                  assetId = uploaded.id;
                } else {
                  // The CDN was unreachable from this server. Dropping the value
                  // leaves a hole in the layout forever; instead record an asset
                  // that points straight at the original URL, so the image still
                  // appears wherever the CDN *is* reachable. The importer counts
                  // these and reports them once instead of once per row.
                  const remote = registerRemoteAsset(assets, normalized);
                  remoteAssetCache.set(normalized, remote.id);
                  rememberAsset(normalized, remote, false);
                  assetId = remote.id;
                  undownloadedAssetUrls.add(normalized);
                }
              }
            }

            if (assetId) {
              finalValue = assetId;
            } else {
              warnings.push(`Asset reference "${rawValue}" in ${collection.name}.${header} could not be resolved`);
              finalValue = null;
            }
          } else if (field.type === 'text' && looksLikeHtml(rawValue)) {
            finalValue = htmlToPlainText(rawValue);
          } else if (field.type === 'boolean') {
            const lower = rawValue.toLowerCase();
            finalValue = (lower === 'true' || lower === 'yes' || lower === '1') ? 'true' : 'false';
          } else if (field.type === 'rich_text') {
            finalValue = JSON.stringify(stringToTiptapContent(rawValue));
          }

          if (finalValue !== null) {
            valueRows.push({
              id: randomUUID(),
              item_id: newItemId,
              field_id: field.id,
              value: finalValue,
              is_published: false,
            });
          }
        }
      }
    }

    if (undownloadedAssetUrls.size > 0) {
      warnings.push(
        `${undownloadedAssetUrls.size} CMS asset${undownloadedAssetUrls.size === 1 ? '' : 's'} could not be downloaded from their CDN. `
        + 'The original URLs were kept as the field value, so the images appear on any server that can reach the CDN.'
      );
    }

    const cssOrderFromHtml = Array.from(new Set(
      htmlFiles.flatMap(file => extractStylesheetHrefsFromHtml(file.content))
    ));

    const widgetCounters = { dropdowns: 0 };
    const builtPages = buildPagesFromHtml(
      htmlFiles,
      assetIdBySource,
      assetPublicUrlBySource,
      warnings,
      widgetCounters
    );
    if (widgetCounters.dropdowns > 0) {
      warnings.push(
        `${widgetCounters.dropdowns} Webflow dropdown${widgetCounters.dropdowns === 1 ? '' : 's'} `
        + 'got a generated open/close interaction (the export ships no script for them).'
      );
    }
    const enhancedPages = enhancePagesWithCmsBindings(
      builtPages,
      normalizedCollections,
      fields,
      extractCmsBackgroundClassGroups(cssFiles),
      warnings
    );
    const pageRows = enhancedPages.map(entry => entry.page);
    const pageLayerRows = enhancedPages.map(entry => entry.pageLayers);
    const baseCss = buildImportedCss(cssFiles, assetPublicUrlBySource, cssOrderFromHtml);
    // Interaction CSS goes last so its `:hover` rules outrank the site stylesheet.
    const ix2Css = buildIx2HoverCss(jsFiles, warnings);
    const dropdownCss = widgetCounters.dropdowns > 0 ? DROPDOWN_REVEAL_CSS : '';
    const importedCss = [baseCss, ix2Css, dropdownCss].filter(Boolean).join('\n\n');
    const { layerStyleRows, styleIdByClassSignature } = buildLayerStyles(
      cssFiles,
      pageLayerRows as Array<{ layers: Layer[] }>
    );
    const lossySignatures = new Set<string>();
    const styledPageLayerRows = pageLayerRows.map((pageLayerRow) => ({
      ...pageLayerRow,
      layers: applyLayerStylesToTree(
        (pageLayerRow.layers as Layer[]) || [],
        styleIdByClassSignature,
        lossySignatures
      ),
    }));
    if (lossySignatures.size > 0) {
      warnings.push(
        `${lossySignatures.size} class combination${lossySignatures.size === 1 ? '' : 's'} `
        + `(${[...lossySignatures].slice(0, 3).map(sig => `"${sig}"`).join(', ')}`
        + `${lossySignatures.size > 3 ? ', …' : ''}) were kept as plain layer classes instead of a shared style, `
        + 'because those Webflow class names read as conflicting Tailwind utilities and one of them would be dropped.'
      );
    }
    const dedupedLayerStyleRows = dedupeLayerStyles(layerStyleRows);

    result.pages = pageRows.length;
    result.collections = collectionRows.length;
    result.items = itemRows.length;
    result.assets = assetRows.length;

    const manifest = buildProjectManifest(
      sanitizeCollectionName(path.basename(payload.zipFilename, path.extname(payload.zipFilename))),
      result
    );
    manifest.lastMigration = await resolveLatestMigrationName();

    const data: Record<string, Record<string, unknown>[]> = {
      settings: [
        { key: 'site_name', value: 'Imported from Webflow' },
        { key: 'site_description', value: 'Imported from Webflow export' },
        { key: 'ycode_version', value: '0.1.0' },
        { key: 'sitemap', value: getDefaultSitemapSettings() },
        { key: 'ycode_badge', value: false },
        { key: 'timezone', value: 'UTC' },
        // draft_css/published_css are the OUTPUT slots of the Tailwind CSS generator and get
        // overwritten on the first autosave. They only give the canvas its initial look; the
        // imported Webflow CSS is kept permanently in the global custom head code (rendered
        // in the canvas and on published pages, untouched by the generator).
        { key: 'draft_css', value: importedCss },
        { key: 'published_css', value: importedCss },
        {
          key: 'custom_code_head',
          value: importedCss ? `<style id="webwow-webflow-import">\n${importedCss}\n</style>` : '',
        },
      ],
      assets: assetRows,
      pages: pageRows,
      page_layers: styledPageLayerRows,
      layer_styles: dedupedLayerStyleRows,
      collections: collectionRows,
      collection_fields: fieldRows,
      collection_items: itemRows,
      collection_item_values: valueRows,
    };

    if (shouldImport) {
      const importResult = await importProject(manifest, data, assets.files);
      if (!importResult.success) {
        errors.push(importResult.error || 'Import in projectService failed');
      }
    }

    const exportData: ProjectExportData = {
      manifest,
      data,
      files: assets.files,
    };

    return {
      success: errors.length === 0,
      result,
      warnings,
      errors,
      exportData,
    };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Unknown Webflow import error');
  }

  return {
    success: errors.length === 0,
    result,
    warnings,
    errors,
  };
}

export async function processWebflowImport(
  payload: WebflowImportPayload
): Promise<ProcessWebflowImportResponse> {
  const response = await processWebflowImportInternal(payload, true);
  return {
    success: response.success,
    result: response.result,
    warnings: response.warnings,
    errors: response.errors,
  };
}

export async function convertWebflowToProjectExport(
  payload: WebflowImportPayload
): Promise<ConvertWebflowToProjectExportResponse> {
  return processWebflowImportInternal(payload, false);
}

export function badRequest(message: string) {
  return noCache({ error: message }, 400);
}

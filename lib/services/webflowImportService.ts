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
import { getDefaultSitemapSettings } from '@/lib/sitemap-utils';
import { stringToTiptapContent } from '@/lib/text-format-utils';
import {
  getLatestMigrationName,
  importProject,
  type ExportFile,
  type ProjectExportData,
  type ProjectManifest,
} from '@/lib/services/projectService';
import type { CollectionFieldType, Layer } from '@/types';
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

function applyLayerStylesToTree(
  layers: Layer[],
  styleIdByClassSignature: Map<string, string>
): Layer[] {
  const visit = (layer: Layer): Layer => {
    const classSignature = normalizeClassSignature(getLayerClasses(layer));
    const matchedStyleId = classSignature ? styleIdByClassSignature.get(classSignature) : undefined;

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
  collectionLayerId?: string
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

function getCollectionFields(
  collectionId: string,
  fields: NormalizedField[]
): NormalizedField[] {
  return fields
    .filter(field => field.collectionId === collectionId)
    .sort((a, b) => a.order - b.order);
}

function getPreferredTextFields(fields: NormalizedField[]): NormalizedField[] {
  const allowed = new Set<CollectionFieldType>(['text', 'number', 'date', 'rich_text']);
  const nameField = fields.find(field => field.key === 'name');
  const rest = fields.filter(
    field =>
      field !== nameField
      && allowed.has(field.type)
      && field.key !== 'slug'
  );

  return nameField ? [nameField, ...rest] : rest;
}

function bindDynamicItemTemplate(
  layer: Layer,
  textFields: NormalizedField[],
  imageField: NormalizedField | null,
  detailPageId: string | null,
  collectionLayerId: string,
  textFieldIndexRef: { index: number }
): Layer {
  let updated: Layer = { ...layer };

  if (detailPageId && updated.settings?.tag === 'a') {
    updated = {
      ...updated,
      variables: {
        ...updated.variables,
        link: {
          type: 'page',
          page: {
            id: detailPageId,
            collection_item_id: 'current-collection',
          },
        },
      },
    };
  }

  const isImageCandidate = imageField && (
    (updated.name === 'image' && layerHasClass(updated, 'w-dyn-bind-empty'))
    || (updated.name === 'image')
    || (updated.name === 'div' && !updated.children?.length && !layerHasClass(updated, 'w-dyn-bind-empty')
        && !layerHasClass(updated, 'w-dyn-empty') && !layerHasClass(updated, 'w-dyn-items')
        && !layerHasClass(updated, 'w-dyn-list'))
  );

  if (isImageCandidate && imageField) {
    const existingImage = updated.variables?.image;
    const fieldBinding = {
      type: 'field' as const,
      data: {
        field_id: imageField.id,
        field_type: imageField.type,
        relationships: [] as string[],
        source: 'collection' as const,
        collection_layer_id: collectionLayerId,
      },
    };

    if (updated.name === 'image') {
      updated = {
        ...updated,
        variables: {
          ...updated.variables,
          image: {
            ...(existingImage || {}),
            src: fieldBinding,
            alt: existingImage?.alt || {
              type: 'dynamic_text',
              data: { content: '' },
            },
          },
        },
      };
    } else {
      updated = {
        ...updated,
        name: 'image',
        settings: { ...(updated.settings || {}), tag: 'img' },
        variables: {
          ...updated.variables,
          image: {
            src: fieldBinding,
            alt: { type: 'dynamic_text', data: { content: '' } },
          },
        },
      };
    }
  } else if (updated.name === 'div' && layerHasClass(updated, 'w-dyn-bind-empty')) {
    const nextTextField = textFields[textFieldIndexRef.index];
    if (nextTextField) {
      textFieldIndexRef.index += 1;
      updated = {
        ...updated,
        name: 'text',
        restrictions: {
          ...updated.restrictions,
          editText: true,
        },
        settings: {
          ...(updated.settings || {}),
          tag: 'div',
        },
        variables: {
          ...updated.variables,
          text: {
            type: 'dynamic_text',
            data: {
              content: createFieldInlineVariableTag(
                nextTextField.id,
                nextTextField.type,
                'collection',
                collectionLayerId
              ),
            },
          },
        },
        children: undefined,
      };
    }
  }

  if (updated.children?.length) {
    updated = {
      ...updated,
      children: updated.children.map(child =>
        bindDynamicItemTemplate(
          child,
          textFields,
          imageField,
          detailPageId,
          collectionLayerId,
          textFieldIndexRef
        )
      ),
    };
  }

  return updated;
}

function bindCollectionLayersForPage(
  layers: Layer[],
  collectionId: string,
  fields: NormalizedField[],
  detailPageId: string | null,
  limit?: number
): Layer[] {
  const collectionFields = getCollectionFields(collectionId, fields);
  const textFields = getPreferredTextFields(collectionFields);
  const imageField = collectionFields.find(field => field.type === 'image') || null;

  const processLayer = (layer: Layer): Layer => {
    let updated: Layer = { ...layer };

    // Webflow toggles empty states via runtime JS.
    // We do not execute Webflow JS, so hide this block by default.
    if (layerHasClass(updated, 'w-dyn-empty')) {
      const currentClasses = getLayerClasses(updated);
      const hasHidden = currentClasses.split(/\s+/).includes('hidden');
      updated = {
        ...updated,
        classes: hasHidden ? currentClasses : `${currentClasses} hidden`.trim(),
      };
    }

    if (layerHasClass(updated, 'w-dyn-item')) {
      const collectionLayerId = updated.id;
      const textFieldIndexRef = { index: 0 };

      updated = {
        ...updated,
        variables: {
          ...updated.variables,
          collection: {
            id: collectionId,
            sort_by: 'manual',
            sort_order: 'asc',
            ...(typeof limit === 'number' ? { limit } : {}),
          },
        },
        children: (updated.children || []).map(child =>
          bindDynamicItemTemplate(
            child,
            textFields,
            imageField,
            detailPageId,
            collectionLayerId,
            textFieldIndexRef
          )
        ),
      };

      return updated;
    }

    if (updated.children?.length) {
      updated = {
        ...updated,
        children: updated.children.map(processLayer),
      };
    }

    return updated;
  };

  return layers.map(processLayer);
}

function enhancePagesWithCmsBindings(
  builtPages: BuiltPageEntry[],
  collections: NormalizedCollection[],
  fields: NormalizedField[]
): BuiltPageEntry[] {
  const pages = builtPages.map(entry => ({
    page: { ...entry.page },
    pageLayers: { ...entry.pageLayers },
  }));

  const detailPageIdByCollectionId = new Map<string, string>();
  const dynamicPageCollectionBySlug = new Map<string, string>();

  // Pass 1: Mark dynamic detail pages and assign CMS settings
  for (const entry of pages) {
    const pageSlug = String(entry.page.slug || '');
    const collection = inferCollectionForPageSlug(pageSlug, collections);
    if (!collection || !isLikelyDetailPageSlug(pageSlug)) {
      continue;
    }

    const collectionFields = getCollectionFields(collection.id, fields);
    const slugField = collectionFields.find(field => field.key === 'slug')
      || collectionFields.find(field => field.name.trim().toLowerCase() === 'slug');

    if (!slugField) {
      continue;
    }

    entry.page.is_dynamic = true;
    entry.page.settings = {
      ...(entry.page.settings as Record<string, unknown> || {}),
      cms: {
        collection_id: collection.id,
        slug_field_id: slugField.id,
      },
    };

    detailPageIdByCollectionId.set(collection.id, String(entry.page.id));
    dynamicPageCollectionBySlug.set(pageSlug, collection.id);
  }

  // Pass 2: Bind Webflow dynamic item placeholders to real collection bindings
  const sortedCollections = [...collections].sort((a, b) => b.rows.length - a.rows.length);

  for (const entry of pages) {
    const pageSlug = String(entry.page.slug || '');
    const explicitCollection = inferCollectionForPageSlug(pageSlug, collections);
    const isDetailPage = dynamicPageCollectionBySlug.has(pageSlug);
    const pageLayers = (entry.pageLayers.layers as Layer[]) || [];

    if (explicitCollection) {
      const detailPageId = detailPageIdByCollectionId.get(explicitCollection.id) || null;
      entry.pageLayers.layers = bindCollectionLayersForPage(
        pageLayers,
        explicitCollection.id,
        fields,
        detailPageId,
        isDetailPage ? 3 : undefined
      );
      continue;
    }

    if (!layerTreeHasDynItems(pageLayers) || collections.length === 0) {
      continue;
    }

    let collectionIndex = 0;
    const bindDynListSubtrees = (layers: Layer[]): Layer[] => {
      return layers.map(layer => {
        if (layerHasClass(layer, 'w-dyn-list') || layerHasClass(layer, 'w-dyn-items')) {
          const coll = sortedCollections[collectionIndex % sortedCollections.length];
          collectionIndex++;
          const detailPageId = detailPageIdByCollectionId.get(coll.id) || null;
          return bindCollectionLayersForPage([layer], coll.id, fields, detailPageId)[0] || layer;
        }
        if (layer.children?.length) {
          return { ...layer, children: bindDynListSubtrees(layer.children) };
        }
        return layer;
      });
    };

    entry.pageLayers.layers = bindDynListSubtrees(pageLayers);
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

function extractStylesheetHrefsFromHtml(htmlContent: string): string[] {
  const hrefs: string[] = [];
  const stylesheetRegex = /<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi;

  for (const match of htmlContent.matchAll(stylesheetRegex)) {
    const href = (match[1] || '').trim();
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

  if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'small', 'label', 'blockquote'].includes(tag)) {
    const text = element.text.trim();
    if (!text) return null;
    const html = element.innerHTML.trim();
    const hasInnerHtml = html.includes('<');
    return buildTextLayer(hasInnerHtml ? html : text, tag, className);
  }

  const urlMap = assetPublicUrlBySource || new Map<string, string>();
  const inlineStyle = getInlineStyle(element, urlMap);
  const styleAttr = inlineStyle ? { style: inlineStyle } : undefined;

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
        controls: element.getAttribute('controls') !== null,
        autoplay: element.getAttribute('autoplay') !== null,
        loop: element.getAttribute('loop') !== null,
        muted: element.getAttribute('muted') !== null,
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
    const children = element.childNodes
      .map(child => mapElementToLayer(child, assetIdBySource, warnings, assetPublicUrlBySource))
      .filter((layer): layer is Layer => !!layer);

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
      children: children.length > 0 ? children : [buildTextLayer(element.text.trim() || 'Link', 'span')],
    };
  }

  const children = element.childNodes
    .map(child => mapElementToLayer(child, assetIdBySource, warnings, assetPublicUrlBySource))
    .filter((layer): layer is Layer => !!layer);

  const layerName = SAFE_HTML_TAGS.has(tag) ? tag : 'div';

  if (children.length === 0 && className.includes('w-embed')) {
    return null;
  }

  if (children.length === 0) {
    const text = element.text.trim();
    if (text) {
      return buildTextLayer(text, tag === 'div' ? 'div' : tag, className);
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

function buildPagesFromHtml(
  htmlFiles: Array<{ filePath: string; content: string }>,
  assetIdBySource: Map<string, string>,
  assetPublicUrlBySource: Map<string, string>,
  warnings: string[]
): Array<{ page: Record<string, unknown>; pageLayers: Record<string, unknown> }> {
  return htmlFiles.map(({ filePath, content }, index) => {
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
        settings: {},
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
    const assets: AssetCollector = { files: [], rows: [] };
    const assetIdBySource = new Map<string, string>();
    // ZIP path / remote URL -> upstream asset proxy URL (for CSS url() rewriting)
    const assetPublicUrlBySource = new Map<string, string>();
    const remoteAssetCache = new Map<string, string>();

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
          } else if (field.type === 'image' || field.type === 'video' || field.type === 'audio' || field.type === 'document') {
            const normalized = normalizeSlashes(rawValue).replace(/^\.\//, '');
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
                }
              }
            }

            if (assetId) {
              finalValue = assetId;
            } else {
              warnings.push(`Asset reference "${rawValue}" in ${collection.name}.${header} could not be downloaded/resolved`);
              finalValue = null;
            }
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

    const cssOrderFromHtml = Array.from(new Set(
      htmlFiles.flatMap(file => extractStylesheetHrefsFromHtml(file.content))
    ));

    const builtPages = buildPagesFromHtml(htmlFiles, assetIdBySource, assetPublicUrlBySource, warnings);
    const enhancedPages = enhancePagesWithCmsBindings(
      builtPages,
      normalizedCollections,
      fields
    );
    const pageRows = enhancedPages.map(entry => entry.page);
    const pageLayerRows = enhancedPages.map(entry => entry.pageLayers);
    const embeddedCssBlocks = htmlFiles
      .map(file => extractEmbeddedCssFromHtml(file.content))
      .filter(Boolean);
    const baseCss = buildImportedCss(cssFiles, assetPublicUrlBySource, cssOrderFromHtml);
    const importedCss = embeddedCssBlocks.length > 0
      ? baseCss + '\n\n' + embeddedCssBlocks.join('\n\n')
      : baseCss;
    const { layerStyleRows, styleIdByClassSignature } = buildLayerStyles(
      cssFiles,
      pageLayerRows as Array<{ layers: Layer[] }>
    );
    const styledPageLayerRows = pageLayerRows.map((pageLayerRow) => ({
      ...pageLayerRow,
      layers: applyLayerStylesToTree(
        (pageLayerRow.layers as Layer[]) || [],
        styleIdByClassSignature
      ),
    }));
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

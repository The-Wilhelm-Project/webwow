/**
 * Webflow CMS CSV exports -> ycode collections, fields, items and values.
 *
 * Schema: the CSV headers are typed by inspecting every value (boolean,
 * number, date, URL/asset, HTML, colour/e-mail/phone, reference tokens) and,
 * for empty columns, by name heuristics (SPEC §4.8). Built-in fields follow
 * `lib/services/sampleCollectionService.ts` (ID / Status / Name / Slug first,
 * Created Date / Updated Date last, keyed) so the runtime finds `key === 'slug'`
 * / `'name'`; custom fields keep `key: null` so they stay editable.
 *
 * Persistence uses the repositories directly (draft rows only). Item ids are
 * pre-generated, so reference tokens (`;`-separated slugs / Webflow item ids /
 * names) resolve before anything is inserted and every item gets a complete
 * `content_hash`. CMS assets are downloaded through the materializer
 * (`uploadAsset` -> safeFetch -> uploadFile), de-duplicated by URL and by
 * `findAssetsByFilenames`, bounded by `remoteAssets` (D4).
 */

import { randomUUID } from 'crypto';
import { createCollection, getAllCollections } from '@/lib/repositories/collectionRepository';
import { createField } from '@/lib/repositories/collectionFieldRepository';
import { createItemsBulk } from '@/lib/repositories/collectionItemRepository';
import { insertValuesBulk } from '@/lib/repositories/collectionItemValueRepository';
import { findAssetsByFilenames } from '@/lib/repositories/assetRepository';
import { convertValueForFieldType, extractRichTextImageUrls, parseCSVText, replaceRichTextImageUrls } from '@/lib/csv-utils';
import { generateUniqueSlug } from '@/lib/collection-utils';
import { generateCollectionItemContentHash } from '@/lib/hash-utils';
import type { CollectionFieldType } from '@/types';
import { BOUND_IMG_PLACEHOLDER } from './css';
import { filenameFromUrl } from './safe-fetch';
import type { WfMaterializerLike, WfRemoteAssets } from './types';
import type { Warnings } from './warnings';

// ─── Types ────────────────────────────────────────────────────────────────────

export const CSV_META_COLUMNS = ['Collection ID', 'Locale ID', 'Item ID', 'Archived', 'Draft', 'Created On', 'Updated On', 'Published On'];

export interface WfCsvCollection {
  name: string;
  webflowId: string | null;
  filename: string;
  headers: string[];
  rows: Record<string, string>[];
  order: number;
}

export interface WfFieldPlan {
  header: string;
  name: string;
  /** `name` / `slug` for the two built-ins fed from the CSV, null for custom fields. */
  key: string | null;
  type: CollectionFieldType;
  multiple?: boolean;
  referenceTargetWebflowId?: string | null;
  /** Target collection by CSV name (used when the target CSV has no Webflow id). */
  referenceTargetName?: string;
  /** Built-in (Name / Slug). */
  system: boolean;
  /** Type decided by the header name alone (empty column). */
  guessed: boolean;
  reason: string;
}

export interface WfCollectionPlan {
  csv: WfCsvCollection;
  fields: WfFieldPlan[];
}

export interface WfCollectionInfoField {
  id: string;
  key: string | null;
  name: string;
  header: string | null;
  type: CollectionFieldType;
  multiple: boolean;
  referenceCollectionId: string | null;
}

export interface WfCollectionInfo {
  id: string;
  name: string;
  webflowId: string | null;
  fields: WfCollectionInfoField[];
  slugFieldId: string;
  nameFieldId: string;
  itemIdBySlug: Map<string, string>;
  itemIdByWebflowId: Map<string, string>;
  itemIdByName: Map<string, string>;
  rowCount: number;
  publishableCount: number;
  /** Date preset id per date field (`part-year` when the column holds year-only dates, else `date-eu-dot`). */
  dateFormatByField: Record<string, string>;
  /** Non-empty cells per field id (binding prefers filled columns). */
  fillCountByField: Record<string, number>;
}

export interface WfCmsResult {
  collections: WfCollectionInfo[];
  counts: { collections: number; fields: number; items: number; itemsPublishable: number; cmsImages: number; failed: number; skipped: number };
}

export interface ImportCmsDeps {
  mat: WfMaterializerLike;
  remoteAssets: WfRemoteAssets;
  warn: Warnings;
  onProgress?: (done: number, total: number) => void;
  /** Parallel asset uploads (default 4). */
  concurrency?: number;
}

// ─── CSV parsing ──────────────────────────────────────────────────────────────

const HEX24_RE = /[0-9a-f]{24}/i;

/** `"<site> - <Collection> - <24-hex id>[ (n)].csv"` -> name + Webflow collection id. */
export function parseCollectionFilename(filename: string): { name: string; webflowId: string | null } {
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.csv$/i, '');
  const parts = base.split(' - ');
  const name = parts.length >= 2 ? (parts[1]?.trim() || base) : base.trim();
  const tail = parts.slice(2).join(' - ');
  const webflowId = tail.match(HEX24_RE)?.[0]?.toLowerCase() ?? (parts.length >= 2 ? null : base.match(HEX24_RE)?.[0]?.toLowerCase() ?? null);
  return { name, webflowId };
}

export function parseCsvFiles(files: { filename: string; content: string }[]): WfCsvCollection[] {
  const out: WfCsvCollection[] = [];
  files.forEach((file, index) => {
    const parsed = parseCSVText(file.content.replace(/^\uFEFF/, ''));
    if (parsed.headers.length === 0) return;
    const { name, webflowId } = parseCollectionFilename(file.filename);
    out.push({ name, webflowId, filename: file.filename, headers: parsed.headers, rows: parsed.rows, order: index });
  });
  return out;
}

// ─── Schema inference ─────────────────────────────────────────────────────────

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?)(\?.*)?$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv|mpe?g)(\?.*)?$/i;
const DOCUMENT_EXT_RE = /\.(mp3|wav|ogg|m4a|aac|flac|pdf|docx?|xlsx?|pptx?|zip|txt|csv|json)(\?.*)?$/i;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const COLOR_RE = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s()./-]{6,}$/;
/** Webflow's export date format (`Thu Jan 22 2026 19:21:05 GMT+0000 (…)`) or ISO. */
const DATE_RE = /^(?:[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{4}|\d{4}-\d{2}-\d{2})/;

const NAME_IMAGE_RE = /bild|image|foto|photo|cover|werk|thumbnail/i;
const NAME_VIDEO_RE = /video/i;
const NAME_RICH_RE = /beschreibung|description|article|text|inhalt|body|content/i;
const NAME_DATE_RE = /datum|date/i;

export function splitTokens(value: string): string[] {
  return value.split(';').map((t) => t.trim()).filter(Boolean);
}

function normaliseName(s: string): string {
  return s.trim().toLowerCase();
}

function sameCollectionName(header: string, name: string): boolean {
  const a = normaliseName(header);
  const b = normaliseName(name);
  if (!a || !b) return false;
  const strip = (s: string) => s.replace(/s$/, '');
  return a === b || strip(a) === b || a === strip(b) || strip(a) === strip(b);
}

function isPlural(header: string): boolean {
  return /s$/i.test(header.trim()) || /images|bilder|fotos|photos/i.test(header);
}

interface Inferred {
  type: CollectionFieldType;
  multiple?: boolean;
  referenceTarget?: WfCsvCollection;
  guessed: boolean;
  reason: string;
}

function referenceKeys(collection: WfCsvCollection): Set<string> {
  const keys = new Set<string>();
  for (const row of collection.rows) {
    for (const col of ['Slug', 'Item ID', 'Name']) {
      const v = (row[col] ?? '').trim();
      if (v) {
        keys.add(v);
        keys.add(v.toLowerCase());
      }
    }
  }
  return keys;
}

function inferColumn(header: string, values: string[], self: WfCsvCollection, others: WfCsvCollection[]): Inferred {
  if (values.length === 0) {
    const byName = others.find((o) => sameCollectionName(header, o.name));
    if (byName) return { type: 'multi_reference', referenceTarget: byName, guessed: true, reason: `empty column named like collection ${byName.name}` };
    if (NAME_IMAGE_RE.test(header)) return { type: 'image', multiple: isPlural(header), guessed: true, reason: 'empty column, image-like name' };
    if (NAME_VIDEO_RE.test(header)) return { type: 'text', guessed: true, reason: 'empty column, video-like name (URL text)' };
    if (NAME_RICH_RE.test(header)) return { type: 'rich_text', guessed: true, reason: 'empty column, rich-text-like name' };
    if (NAME_DATE_RE.test(header)) return { type: 'date', guessed: true, reason: 'empty column, date-like name' };
    return { type: 'text', guessed: true, reason: 'empty column' };
  }
  if (values.every((v) => v === 'true' || v === 'false')) return { type: 'boolean', guessed: false, reason: 'all values true/false' };
  if (values.every((v) => NUMBER_RE.test(v))) return { type: 'number', guessed: false, reason: 'all values numeric' };
  if (values.every((v) => DATE_RE.test(v) && !Number.isNaN(Date.parse(v)))) return { type: 'date', guessed: false, reason: 'all values parse as dates' };
  const tokens = values.flatMap(splitTokens);
  const anyMulti = values.some((v) => v.includes(';'));
  if (tokens.length > 0 && tokens.every((t) => /^https?:\/\//i.test(t))) {
    if (tokens.every((t) => IMAGE_EXT_RE.test(t.split(/[?#]/)[0]))) return { type: 'image', multiple: anyMulti, guessed: false, reason: 'image URLs' };
    if (tokens.every((t) => VIDEO_EXT_RE.test(t.split(/[?#]/)[0]))) return { type: 'text', guessed: false, reason: 'video URLs (kept as text)' };
    if (tokens.every((t) => DOCUMENT_EXT_RE.test(t.split(/[?#]/)[0]))) return { type: 'document', guessed: false, reason: 'document URLs' };
    return { type: 'link', guessed: false, reason: 'URLs' };
  }
  if (values.every((v) => v.startsWith('<'))) return { type: 'rich_text', guessed: false, reason: 'HTML values' };
  if (values.every((v) => COLOR_RE.test(v))) return { type: 'color', guessed: false, reason: 'hex colours' };
  if (values.every((v) => EMAIL_RE.test(v))) return { type: 'email', guessed: false, reason: 'e-mail addresses' };
  if (values.every((v) => PHONE_RE.test(v) && (v.match(/\d/g) ?? []).length >= 6)) return { type: 'phone', guessed: false, reason: 'phone numbers' };
  if (tokens.length > 0) {
    let best: { target: WfCsvCollection; ratio: number } | null = null;
    for (const other of others) {
      const keys = referenceKeys(other);
      const matched = tokens.filter((t) => keys.has(t) || keys.has(t.toLowerCase())).length;
      const ratio = matched / tokens.length;
      if (ratio >= 0.7 && (!best || ratio > best.ratio)) best = { target: other, ratio };
    }
    if (best) {
      return anyMulti
        ? { type: 'multi_reference', referenceTarget: best.target, guessed: false, reason: `tokens match ${best.target.name} items (${Math.round(best.ratio * 100)}%)` }
        : { type: 'reference', referenceTarget: best.target, guessed: false, reason: `values match ${best.target.name} items (${Math.round(best.ratio * 100)}%)` };
    }
  }
  return { type: 'text', guessed: false, reason: 'text' };
}

export function inferSchema(collections: WfCsvCollection[], warn?: Warnings): WfCollectionPlan[] {
  return collections.map((csv) => {
    const others = collections.filter((c) => c !== csv);
    const fields: WfFieldPlan[] = [];
    for (const header of csv.headers) {
      const trimmed = header.trim();
      if (!trimmed || CSV_META_COLUMNS.includes(trimmed)) continue;
      if (trimmed === 'Name') {
        fields.push({ header, name: 'Name', key: 'name', type: 'text', system: true, guessed: false, reason: 'built-in name' });
        continue;
      }
      if (trimmed === 'Slug') {
        fields.push({ header, name: 'Slug', key: 'slug', type: 'text', system: true, guessed: false, reason: 'built-in slug' });
        continue;
      }
      const values = csv.rows.map((r) => (r[header] ?? '').trim()).filter(Boolean);
      const inferred = inferColumn(trimmed, values, csv, others);
      const plan: WfFieldPlan = { header, name: trimmed, key: null, type: inferred.type, system: false, guessed: inferred.guessed, reason: inferred.reason };
      if (inferred.multiple) plan.multiple = true;
      if (inferred.referenceTarget) {
        plan.referenceTargetWebflowId = inferred.referenceTarget.webflowId;
        plan.referenceTargetName = inferred.referenceTarget.name;
      }
      if (inferred.guessed) warn?.add('csv_type_guess', `${csv.name}.${trimmed}: type ${inferred.type} guessed (${inferred.reason})`);
      fields.push(plan);
    }
    return { csv, fields };
  });
}

// ─── Value helpers ────────────────────────────────────────────────────────────

export function isPublishableRow(row: Record<string, string>): boolean {
  const flag = (k: string) => (row[k] ?? '').trim().toLowerCase() === 'true';
  return !(flag('Draft') || flag('Archived') || !(row['Published On'] ?? '').trim());
}

/** ISO string for a CSV date cell, or the fallback when it does not parse. */
export function isoDate(value: string | undefined, fallback: string): string {
  const v = (value ?? '').trim();
  if (!v) return fallback;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? fallback : new Date(ms).toISOString();
}

/** True when a date is a Webflow "year only" entry (`Dec 31 23:00` or `Jan 1 00:00` UTC). */
export function isYearOnlyDate(value: string): boolean {
  const ms = Date.parse(value.trim());
  if (Number.isNaN(ms)) return false;
  const d = new Date(ms);
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const h = d.getUTCHours();
  const min = d.getUTCMinutes();
  return (m === 11 && day === 31 && (h === 23 || h === 22) && min === 0) || (m === 0 && day === 1 && h === 0 && min === 0);
}

/** Date preset id for a column: `part-year` when >= 80 % of the values are year-only, else `date-eu-dot` (26.03.2026). */
export function dateFormatFor(values: string[]): 'part-year' | 'date-eu-dot' {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (filled.length === 0) return 'date-eu-dot';
  const yearOnly = filled.filter(isYearOnlyDate).length;
  return yearOnly / filled.length >= 0.8 ? 'part-year' : 'date-eu-dot';
}

/** Scalar conversion for non-asset, non-reference fields (null = no value row). */
export function convertScalar(value: string, type: CollectionFieldType): string | null {
  const v = value.trim();
  if (!v) return null;
  switch (type) {
    case 'date':
    case 'date_only':
    case 'number':
      return convertValueForFieldType(v, type);
    case 'boolean':
      return convertValueForFieldType(v, 'boolean') ?? (/^(true|1|yes|y|on)$/i.test(v) ? 'true' : 'false');
    case 'rich_text':
      return v.startsWith('<') ? convertValueForFieldType(v, 'rich_text') : convertValueForFieldType(`<p>${escapeHtml(v)}</p>`, 'rich_text');
    default:
      return v;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Slug -> Webflow item id -> name (exact, then case-insensitive). */
export function resolveReferenceToken(token: string, target: WfCollectionInfo): string | null {
  const t = token.trim();
  if (!t) return null;
  return target.itemIdBySlug.get(t) ?? target.itemIdByWebflowId.get(t) ?? target.itemIdByName.get(t) ?? target.itemIdByName.get(t.toLowerCase()) ?? null;
}

function displayNameOf(url: string): string {
  return filenameFromUrl(url).replace(/\.[^/.]+$/, '');
}

function isPlaceholder(url: string): boolean {
  return url.includes(BOUND_IMG_PLACEHOLDER);
}

async function mapConcurrent<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// ─── Import ───────────────────────────────────────────────────────────────────

interface Scaffold {
  plan: WfCollectionPlan;
  info: WfCollectionInfo;
  fieldIdByHeader: Map<string, string>;
  itemIds: string[];
  slugs: string[];
  richTextCache: Map<string, string>;
}

/**
 * Six built-in definitions copied from `lib/services/sampleCollectionService.ts`
 * (ycode 1.30.15, BUILT_IN_FIELDS_START / BUILT_IN_FIELDS_END): keyed so the
 * runtime can find slug / name, non-fillable where the CMS computes the value.
 */
const BUILT_IN_START = [
  { name: 'ID', key: 'id', type: 'number' as CollectionFieldType, fillable: false, is_computed: false },
  { name: 'Status', key: 'status', type: 'status' as CollectionFieldType, fillable: false, is_computed: true },
  { name: 'Name', key: 'name', type: 'text' as CollectionFieldType, fillable: true, is_computed: false },
  { name: 'Slug', key: 'slug', type: 'text' as CollectionFieldType, fillable: true, is_computed: false },
];
const BUILT_IN_END = [
  { name: 'Created Date', key: 'created_at', type: 'date' as CollectionFieldType, fillable: false, is_computed: false },
  { name: 'Updated Date', key: 'updated_at', type: 'date' as CollectionFieldType, fillable: false, is_computed: false },
];

export async function importCms(plans: WfCollectionPlan[], deps: ImportCmsDeps): Promise<WfCmsResult> {
  const { mat, remoteAssets, warn } = deps;
  const concurrency = deps.concurrency ?? 4;
  const counts: WfCmsResult['counts'] = { collections: 0, fields: 0, items: 0, itemsPublishable: 0, cmsImages: 0, failed: 0, skipped: 0 };
  const totalRows = plans.reduce((n, p) => n + p.csv.rows.length, 0);
  let doneRows = 0;
  const progress = () => deps.onProgress?.(doneRows, totalRows);
  if (plans.length === 0) return { collections: [], counts };

  // 1. Collections (names de-duplicated against the existing drafts).
  const existing = await getAllCollections({ is_published: false, deleted: false });
  const usedNames = new Set(existing.map((c) => c.name.trim().toLowerCase()));
  let order = existing.reduce((max, c) => Math.max(max, c.order ?? 0), -1) + 1;
  const scaffolds: Scaffold[] = [];
  for (const plan of plans) {
    let name = plan.csv.name.trim() || 'Collection';
    let n = 2;
    while (usedNames.has(name.toLowerCase())) name = `${plan.csv.name.trim() || 'Collection'} ${n++}`;
    usedNames.add(name.toLowerCase());
    const collection = await createCollection({ name, order: order++, is_published: false });
    counts.collections++;
    scaffolds.push({
      plan,
      info: {
        id: collection.id,
        name,
        webflowId: plan.csv.webflowId,
        fields: [],
        slugFieldId: '',
        nameFieldId: '',
        itemIdBySlug: new Map(),
        itemIdByWebflowId: new Map(),
        itemIdByName: new Map(),
        rowCount: plan.csv.rows.length,
        publishableCount: 0,
        dateFormatByField: {},
        fillCountByField: {},
      },
      fieldIdByHeader: new Map(),
      itemIds: [],
      slugs: [],
      richTextCache: new Map(),
    });
  }
  const byWebflowId = new Map<string, Scaffold>();
  const byName = new Map<string, Scaffold>();
  for (const s of scaffolds) {
    if (s.info.webflowId) byWebflowId.set(s.info.webflowId, s);
    byName.set(s.plan.csv.name.trim().toLowerCase(), s);
  }
  const targetOf = (plan: WfFieldPlan): Scaffold | undefined =>
    (plan.referenceTargetWebflowId ? byWebflowId.get(plan.referenceTargetWebflowId) : undefined) ?? (plan.referenceTargetName ? byName.get(plan.referenceTargetName.toLowerCase()) : undefined);

  // 2. Fields.
  for (const s of scaffolds) {
    let fieldOrder = 0;
    const add = async (data: { name: string; key: string | null; type: CollectionFieldType; fillable: boolean; is_computed: boolean; header: string | null; multiple?: boolean; referenceCollectionId?: string | null }) => {
      const field = await createField({
        name: data.name,
        key: data.key,
        type: data.type,
        fillable: data.fillable,
        hidden: false,
        is_computed: data.is_computed,
        order: fieldOrder++,
        collection_id: s.info.id,
        reference_collection_id: data.referenceCollectionId ?? null,
        data: data.multiple ? { multiple: true } : {},
        is_published: false,
      });
      counts.fields++;
      s.info.fields.push({ id: field.id, key: data.key, name: data.name, header: data.header, type: data.type, multiple: !!data.multiple, referenceCollectionId: data.referenceCollectionId ?? null });
      if (data.header !== null) s.fieldIdByHeader.set(data.header, field.id);
      if (data.key === 'slug') s.info.slugFieldId = field.id;
      if (data.key === 'name') s.info.nameFieldId = field.id;
      return field.id;
    };
    const nameHeader = s.plan.fields.find((f) => f.key === 'name')?.header ?? null;
    const slugHeader = s.plan.fields.find((f) => f.key === 'slug')?.header ?? null;
    for (const b of BUILT_IN_START) await add({ ...b, header: b.key === 'name' ? nameHeader : b.key === 'slug' ? slugHeader : null });
    for (const plan of s.plan.fields) {
      if (plan.system) continue;
      const target = plan.type === 'reference' || plan.type === 'multi_reference' ? targetOf(plan) : undefined;
      if ((plan.type === 'reference' || plan.type === 'multi_reference') && !target) {
        warn.add('reference_unresolved', `${s.info.name}.${plan.name}: reference target collection not found; field created as text`);
      }
      const type: CollectionFieldType = target ? plan.type : plan.type === 'reference' || plan.type === 'multi_reference' ? 'text' : plan.type;
      const fieldId = await add({ name: plan.name, key: null, type, fillable: true, is_computed: false, header: plan.header, multiple: plan.multiple, referenceCollectionId: target?.info.id ?? null });
      const raw = s.plan.csv.rows.map((r) => r[plan.header] ?? '');
      s.info.fillCountByField[fieldId] = raw.filter((v) => v.trim()).length;
      if (type === 'date' || type === 'date_only') s.info.dateFormatByField[fieldId] = dateFormatFor(raw);
    }
    for (const b of BUILT_IN_END) await add({ ...b, header: null });
  }

  // 3. Item ids + lookup maps (before any insert, so references resolve up front).
  for (const s of scaffolds) {
    const used = new Set<string>();
    s.plan.csv.rows.forEach((row, i) => {
      const id = randomUUID();
      s.itemIds.push(id);
      const name = (row['Name'] ?? '').trim();
      let slug = (row['Slug'] ?? '').trim();
      if (!slug || used.has(slug)) {
        const fallback = generateUniqueSlug(name || `item-${i + 1}`, used);
        warn.add('slug_suffixed', `${s.info.name}: ${slug ? `duplicate slug ${slug}` : `row ${i + 1} has no slug`}; using ${fallback}`);
        slug = fallback;
      } else {
        used.add(slug);
      }
      s.slugs.push(slug);
      s.info.itemIdBySlug.set(slug, id);
      const webflowId = (row['Item ID'] ?? '').trim();
      if (webflowId) s.info.itemIdByWebflowId.set(webflowId, id);
      if (name) {
        if (!s.info.itemIdByName.has(name)) s.info.itemIdByName.set(name, id);
        if (!s.info.itemIdByName.has(name.toLowerCase())) s.info.itemIdByName.set(name.toLowerCase(), id);
      }
    });
  }

  // 4. Assets: every image / document URL (single or `;`-separated) plus rich-text images.
  const urls = new Set<string>();
  for (const s of scaffolds) {
    for (const plan of s.plan.fields) {
      if (plan.system) continue;
      for (const row of s.plan.csv.rows) {
        const cell = row[plan.header] ?? '';
        if (!cell.trim()) continue;
        if (plan.type === 'image' || plan.type === 'document') {
          for (const t of splitTokens(cell)) if (/^https?:\/\//i.test(t) && !isPlaceholder(t)) urls.add(t);
        } else if (plan.type === 'rich_text') {
          const json = convertScalar(cell, 'rich_text');
          if (!json) continue;
          s.richTextCache.set(`${plan.header}\u0000${row['Item ID'] ?? ''}\u0000${s.plan.csv.rows.indexOf(row)}`, json);
          for (const ref of extractRichTextImageUrls(json)) if (/^https?:\/\//i.test(ref.src) && !isPlaceholder(ref.src)) urls.add(ref.src);
        }
      }
    }
  }
  const assetByUrl = new Map<string, { assetId: string; publicUrl: string }>();
  if (urls.size > 0) {
    const names = new Map<string, string>();
    for (const url of urls) names.set(url, displayNameOf(url));
    let reused: Record<string, { id: string; public_url?: string | null }> = {};
    try {
      reused = await findAssetsByFilenames([...new Set(names.values())]);
    } catch (error) {
      warn.add('asset_missing', `asset lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const pending: string[] = [];
    for (const url of urls) {
      const hit = reused[names.get(url) ?? ''];
      if (hit) assetByUrl.set(url, { assetId: hit.id, publicUrl: hit.public_url ?? '' });
      else pending.push(url);
    }
    if (remoteAssets === 'skip') {
      counts.skipped += pending.length;
      if (pending.length > 0) warn.add('asset_skipped', 'CMS asset downloads skipped (remoteAssets = skip)', { count: pending.length });
    } else {
      let verbatim = 0;
      await mapConcurrent(pending, concurrency, async (url) => {
        let assetId: string | null = null;
        try {
          assetId = await mat.uploadAsset(url);
        } catch (error) {
          assetId = null;
          warn.add('asset_download_failed', `download failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (assetId) {
          assetByUrl.set(url, { assetId, publicUrl: mat.assetUrl(url) ?? '' });
          counts.cmsImages++;
          return;
        }
        counts.failed++;
        let host = 'unknown host';
        try {
          host = new URL(url).host;
        } catch {
          // keep 'unknown host'
        }
        if (verbatim < 5) {
          verbatim++;
          warn.add('asset_download_failed', `download failed: ${url}`);
        } else {
          warn.add('asset_download_failed', `download failed from ${host}`);
        }
      });
    }
  }

  // 5. Items + values (references resolved from the pre-generated ids).
  for (const s of scaffolds) {
    const { rows } = s.plan.csv;
    const items: { id: string; collection_id: string; manual_order: number; is_published: boolean; is_publishable: boolean; content_hash: string }[] = [];
    const values: { item_id: string; field_id: string; value: string | null }[] = [];
    const idField = s.info.fields.find((f) => f.key === 'id')!.id;
    const createdField = s.info.fields.find((f) => f.key === 'created_at')!.id;
    const updatedField = s.info.fields.find((f) => f.key === 'updated_at')!.id;
    rows.forEach((row, i) => {
      const now = new Date().toISOString();
      const itemValues: { field_id: string; value: string | null }[] = [
        { field_id: idField, value: String(i + 1) },
        { field_id: s.info.nameFieldId, value: (row['Name'] ?? '').trim() },
        { field_id: s.info.slugFieldId, value: s.slugs[i] },
        { field_id: createdField, value: isoDate(row['Created On'], now) },
        { field_id: updatedField, value: isoDate(row['Updated On'], now) },
      ];
      for (const plan of s.plan.fields) {
        if (plan.system) continue;
        const fieldId = s.fieldIdByHeader.get(plan.header);
        if (!fieldId) continue;
        const cell = row[plan.header] ?? '';
        if (!cell.trim()) continue;
        const fieldType = s.info.fields.find((f) => f.id === fieldId)!.type;
        let value: string | null = null;
        switch (fieldType) {
          case 'image':
          case 'document': {
            const ids = splitTokens(cell).map((t) => assetByUrl.get(t)?.assetId).filter((x): x is string => !!x);
            value = plan.multiple ? (ids.length > 0 ? JSON.stringify(ids) : null) : (ids[0] ?? null);
            break;
          }
          case 'rich_text': {
            const json = s.richTextCache.get(`${plan.header}\u0000${row['Item ID'] ?? ''}\u0000${i}`) ?? convertScalar(cell, 'rich_text');
            value = json ? replaceRichTextImageUrls(json, assetByUrl) : null;
            break;
          }
          case 'reference':
          case 'multi_reference': {
            const target = targetOf(plan);
            if (!target) break;
            const resolved: string[] = [];
            for (const token of splitTokens(cell)) {
              const id = resolveReferenceToken(token, target.info);
              if (id) resolved.push(id);
              else warn.add('reference_unresolved', `${s.info.name}.${plan.name}: no ${target.info.name} item matches "${token}"`);
            }
            value = fieldType === 'reference' ? (resolved[0] ?? null) : resolved.length > 0 ? JSON.stringify(resolved) : null;
            break;
          }
          case 'option':
            value = cell.trim();
            break;
          default:
            value = convertScalar(cell, fieldType);
        }
        if (value !== null) itemValues.push({ field_id: fieldId, value });
      }
      const publishable = isPublishableRow(row);
      if (publishable) s.info.publishableCount++;
      items.push({ id: s.itemIds[i], collection_id: s.info.id, manual_order: i, is_published: false, is_publishable: publishable, content_hash: generateCollectionItemContentHash(itemValues) });
      for (const v of itemValues) if (v.value !== null) values.push({ item_id: s.itemIds[i], field_id: v.field_id, value: v.value });
    });
    if (items.length > 0) {
      await createItemsBulk(items);
      for (let i = 0; i < values.length; i += 500) await insertValuesBulk(values.slice(i, i + 500));
    }
    counts.items += items.length;
    counts.itemsPublishable += s.info.publishableCount;
    doneRows += rows.length;
    progress();
  }

  return { collections: scaffolds.map((s) => s.info), counts };
}

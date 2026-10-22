import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

import { getAllCollections, createCollection } from '@/lib/repositories/collectionRepository';
import { createField, getFieldsByCollectionId } from '@/lib/repositories/collectionFieldRepository';
import { createItemsBulk } from '@/lib/repositories/collectionItemRepository';
import { insertValuesBulk } from '@/lib/repositories/collectionItemValueRepository';
import { getAllPages, getPagesByFolder, createPage } from '@/lib/repositories/pageRepository';
import { getAllPageFolders, createPageFolder } from '@/lib/repositories/pageFolderRepository';
import { upsertDraftLayers, getDraftLayers } from '@/lib/repositories/pageLayersRepository';
import { createAsset } from '@/lib/repositories/assetRepository';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import { STORAGE_BUCKET, STORAGE_FOLDERS } from '@/lib/asset-constants';
import { generateId } from '@/lib/utils';
import {
  UNIVERSAL_ONTOLOGY,
  type OntologyCollection,
  type OntologyField,
  type OntologySampleValue,
  type OntologyStaticPage,
  type OntologyStaticSection,
} from '@/lib/webwow/templates/universal-ontology';
import type {
  Asset,
  Collection,
  CollectionField,
  CollectionFieldType,
  ConditionalVisibility,
  FieldVariable,
  VisibilityCondition,
  Layer,
  Page,
  PageFolder,
} from '@/types';

/**
 * Universal Template Service
 *
 * Applies the universal website ontology to the current site:
 * 1. Creates all collections with built-in + custom fields (references resolved by key)
 * 2. Inserts a coherent set of sample items (optional)
 * 3. Creates a folder with a list page and a dynamic detail page per collection,
 *    plus a handful of static wireframe pages (Home, About, Contact, FAQ, Legal)
 *
 * The service is additive: collections, folders and pages that already exist
 * (matched by name / slug) are reused and never overwritten. Everything is
 * created as a draft, so the result can be reviewed before publishing.
 *
 * Runs against the current site (multi-site: request header, MCP token or
 * `runInSite`). Callers: app/(builder)/ycode/api/webwow/templates/universal,
 * lib/webwow/mcp/universal-template.ts, scripts/webwow-universal-template.ts.
 */

const ASSET_SOURCE = 'universal-template';

/** Sample images shipped with upstream's sample collections */
const SAMPLES_DIR = path.join(process.cwd(), 'storage', 'collections');

export interface UniversalTemplateOptions {
  /** Insert sample items into newly created collections (default: true) */
  withSamples?: boolean;
  /** Create folders, list/detail pages and static pages (default: true) */
  withPages?: boolean;
}

export interface UniversalTemplateResult {
  version: string;
  collections: Array<{ key: string; id: string; name: string; created: boolean; fields: number; items: number }>;
  folders: Array<{ id: string; slug: string; created: boolean }>;
  pages: Array<{ id: string; name: string; path: string; created: boolean }>;
}

/* -------------------------------------------------------------------------- */
/*                               Internal types                               */
/* -------------------------------------------------------------------------- */

interface ResolvedCollection {
  def: OntologyCollection;
  collection: Collection;
  created: boolean;
  /** Fields keyed by ontology field key (built-ins included) */
  fields: Record<string, CollectionField>;
  /** Item IDs keyed by sample slug (only for collections created by this run) */
  itemIdsBySlug: Record<string, string>;
}

type ResolvedMap = Record<string, ResolvedCollection>;

/** Built-in fields created before the custom fields */
const BUILT_IN_FIELDS_START: Array<Omit<OntologyField, 'role'> & { fillable: boolean; is_computed?: boolean }> = [
  { key: 'id', name: 'ID', type: 'number', fillable: false },
  { key: 'status', name: 'Status', type: 'status', fillable: false, is_computed: true },
  { key: 'name', name: 'Name', type: 'text', fillable: true },
  { key: 'slug', name: 'Slug', type: 'text', fillable: true },
];

/** Built-in fields created after the custom fields */
const BUILT_IN_FIELDS_END: Array<Omit<OntologyField, 'role'> & { fillable: boolean }> = [
  { key: 'created_at', name: 'Created Date', type: 'date', fillable: false },
  { key: 'updated_at', name: 'Updated Date', type: 'date', fillable: false },
];

/* -------------------------------------------------------------------------- */
/*                                 Public API                                 */
/* -------------------------------------------------------------------------- */

/**
 * Apply the universal ontology to the current site.
 */
export async function applyUniversalTemplate(
  options: UniversalTemplateOptions = {}
): Promise<UniversalTemplateResult> {
  const withSamples = options.withSamples ?? true;
  const withPages = options.withPages ?? true;

  const resolved = await ensureCollections();
  await ensureFields(resolved);

  if (withSamples) {
    await insertSamples(resolved);
  }

  const result: UniversalTemplateResult = {
    version: UNIVERSAL_ONTOLOGY.version,
    collections: UNIVERSAL_ONTOLOGY.collections.map((def) => {
      const entry = resolved[def.key];
      return {
        key: def.key,
        id: entry.collection.id,
        name: entry.collection.name,
        created: entry.created,
        fields: Object.keys(entry.fields).length,
        items: Object.keys(entry.itemIdsBySlug).length,
      };
    }),
    folders: [],
    pages: [],
  };

  if (withPages) {
    const pagesResult = await ensurePages(resolved);
    result.folders = pagesResult.folders;
    result.pages = pagesResult.pages;
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/*                                Collections                                 */
/* -------------------------------------------------------------------------- */

async function ensureCollections(): Promise<ResolvedMap> {
  const existing = await getAllCollections({ is_published: false, deleted: false });
  const byName = new Map(existing.map((c) => [c.name.trim().toLowerCase(), c]));
  let nextOrder = existing.reduce((max, c) => Math.max(max, c.order ?? 0), -1) + 1;

  const resolved: ResolvedMap = {};

  for (const def of UNIVERSAL_ONTOLOGY.collections) {
    const found = byName.get(def.name.toLowerCase());
    if (found) {
      resolved[def.key] = { def, collection: found, created: false, fields: {}, itemIdsBySlug: {} };
      continue;
    }

    const collection = await createCollection({
      name: def.name,
      order: nextOrder++,
      is_published: false,
    });
    resolved[def.key] = { def, collection, created: true, fields: {}, itemIdsBySlug: {} };
  }

  return resolved;
}

async function ensureFields(resolved: ResolvedMap): Promise<void> {
  for (const entry of Object.values(resolved)) {
    const { def, collection } = entry;

    if (!entry.created) {
      // Reuse existing schema: match by key first, then by lower-cased name
      const fields = await getFieldsByCollectionId(collection.id, false);
      const byKey = new Map(fields.filter((f) => f.key).map((f) => [f.key as string, f]));
      const byName = new Map(fields.map((f) => [f.name.trim().toLowerCase(), f]));
      const wanted = [...BUILT_IN_FIELDS_START, ...def.fields, ...BUILT_IN_FIELDS_END];
      for (const fieldDef of wanted) {
        const match = byKey.get(fieldDef.key) || byName.get(fieldDef.name.toLowerCase());
        if (match) entry.fields[fieldDef.key] = match;
      }
      continue;
    }

    const customFields = def.fields.map((f, i) => ({ ...f, fillable: true, order: BUILT_IN_FIELDS_START.length + i }));
    const startFields = BUILT_IN_FIELDS_START.map((f, i) => ({ ...f, order: i }));
    const endFields = BUILT_IN_FIELDS_END.map((f, i) => ({
      ...f,
      order: BUILT_IN_FIELDS_START.length + def.fields.length + i,
    }));

    for (const fieldDef of [...startFields, ...customFields, ...endFields]) {
      const refCollectionId = 'ref' in fieldDef && fieldDef.ref ? resolved[fieldDef.ref]?.collection.id ?? null : null;
      const isReference = fieldDef.type === 'reference' || fieldDef.type === 'multi_reference';
      if (isReference && !refCollectionId) {
        throw new Error(`Unknown reference target "${(fieldDef as OntologyField).ref}" on ${def.key}.${fieldDef.key}`);
      }

      const field = await createField({
        name: fieldDef.name,
        key: fieldDef.key,
        type: fieldDef.type,
        default: 'default' in fieldDef ? fieldDef.default ?? null : null,
        fillable: fieldDef.fillable,
        hidden: false,
        order: fieldDef.order,
        is_computed: 'is_computed' in fieldDef ? Boolean(fieldDef.is_computed) : false,
        collection_id: collection.id,
        reference_collection_id: refCollectionId,
        data: 'multiple' in fieldDef && fieldDef.multiple ? { multiple: true } : {},
        is_published: false,
      });
      entry.fields[fieldDef.key] = field;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Samples                                   */
/* -------------------------------------------------------------------------- */

async function insertSamples(resolved: ResolvedMap): Promise<void> {
  const now = new Date().toISOString();
  const entries = Object.values(resolved).filter((e) => e.created && e.def.samples.length > 0);

  // Pass 1: create all items so references can be resolved across collections
  for (const entry of entries) {
    const items = await createItemsBulk(
      entry.def.samples.map((_, index) => ({
        collection_id: entry.collection.id,
        manual_order: index + 1,
        is_published: false,
      }))
    );
    items.forEach((item, index) => {
      const slug = String(entry.def.samples[index].values.slug);
      entry.itemIdsBySlug[slug] = item.id;
    });
  }

  // Pass 2: upload images and insert values
  for (const entry of entries) {
    const values: Array<{ item_id: string; field_id: string; value: string | null; is_published: boolean }> = [];

    for (const [index, sample] of entry.def.samples.entries()) {
      const itemId = entry.itemIdsBySlug[String(sample.values.slug)];
      const raw: Record<string, OntologySampleValue> = {
        id: index + 1,
        created_at: now,
        updated_at: now,
        ...sample.values,
      };

      for (const [key, value] of Object.entries(raw)) {
        const field = entry.fields[key];
        if (!field) continue;
        const fieldDef = entry.def.fields.find((f) => f.key === key);
        const serialized = serializeValue(value, field.type, fieldDef, resolved);
        if (serialized !== null) {
          values.push({ item_id: itemId, field_id: field.id, value: serialized, is_published: false });
        }
      }

      for (const [key, filename] of Object.entries(sample.images || {})) {
        const field = entry.fields[key];
        if (!field) continue;
        const asset = await getOrUploadTemplateImage(filename);
        values.push({ item_id: itemId, field_id: field.id, value: asset.id, is_published: false });
      }
    }

    await insertValuesBulk(values);
  }
}

/**
 * Find an existing draft asset of this template by filename, or upload the sample
 * image and create one. Same routine as upstream's sampleCollectionService (which
 * keeps it private and hard-codes its own asset source), so re-runs reuse the files.
 */
async function getOrUploadTemplateImage(filename: string): Promise<Asset> {
  const supabase = await getSupabaseAdmin();
  if (!supabase) {
    throw new Error('Database not configured');
  }

  const { data: existing } = await supabase
    .from('assets')
    .select('*')
    .eq('filename', filename)
    .eq('source', ASSET_SOURCE)
    .eq('is_published', false)
    .is('deleted_at', null)
    .limit(1)
    .single();

  if (existing) return existing as Asset;

  const buffer = await fs.readFile(path.join(SAMPLES_DIR, filename));
  const metadata = await sharp(buffer).metadata();
  const ext = path.extname(filename).slice(1) || 'jpg';
  const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  const random = Math.random().toString(36).substring(2, 15);
  const storagePath = `${STORAGE_FOLDERS.WEBSITE}/${Date.now()}-${random}.${ext}`;

  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, { cacheControl: '3600', upsert: false, contentType: mimeType });

  if (error) {
    throw new Error(`Failed to upload sample image "${filename}": ${error.message}`);
  }

  const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(data.path);

  return createAsset({
    filename,
    source: ASSET_SOURCE,
    storage_path: data.path,
    public_url: urlData.publicUrl,
    file_size: buffer.length,
    mime_type: mimeType,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    is_published: false,
  });
}

/** Convert a sample value into the string representation stored in collection_item_values */
function serializeValue(
  value: OntologySampleValue,
  type: CollectionFieldType,
  fieldDef: OntologyField | undefined,
  resolved: ResolvedMap
): string | null {
  switch (type) {
    case 'rich_text':
      return JSON.stringify(paragraphsToTiptap(String(value)));
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return String(value);
    case 'date':
      return new Date(String(value)).toISOString();
    case 'link':
      return JSON.stringify({ type: 'url', url: String(value) });
    case 'reference': {
      const target = fieldDef?.ref ? resolved[fieldDef.ref] : undefined;
      return target?.itemIdsBySlug[String(value)] ?? null;
    }
    case 'multi_reference': {
      const target = fieldDef?.ref ? resolved[fieldDef.ref] : undefined;
      const slugs = Array.isArray(value) ? value : [String(value)];
      const ids = slugs.map((s) => target?.itemIdsBySlug[s]).filter((id): id is string => !!id);
      return JSON.stringify(ids);
    }
    default:
      return Array.isArray(value) ? value.join(', ') : String(value);
  }
}

/** Turn "para\n\npara" into a Tiptap document */
function paragraphsToTiptap(text: string): object {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return {
    type: 'doc',
    content: paragraphs.map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })),
  };
}

/* -------------------------------------------------------------------------- */
/*                                   Pages                                    */
/* -------------------------------------------------------------------------- */

interface PagesResult {
  folders: UniversalTemplateResult['folders'];
  pages: UniversalTemplateResult['pages'];
}

interface CollectionPages {
  folder: PageFolder;
  listPage: Page | null;
  detailPage: Page | null;
}

async function ensurePages(resolved: ResolvedMap): Promise<PagesResult> {
  const result: PagesResult = { folders: [], pages: [] };
  const allFolders = await getAllPageFolders({ is_published: false });
  const allPages = await getAllPages({ is_published: false });

  const folderBySlug = new Map(allFolders.filter((f) => !f.page_folder_id).map((f) => [f.slug, f]));
  let nextFolderOrder = allFolders.filter((f) => !f.page_folder_id).reduce((m, f) => Math.max(m, f.order ?? 0), -1) + 1;

  // 1. Folder + list + detail page per collection
  const collectionPages: Record<string, CollectionPages> = {};
  const createdDetailPages: Array<{ key: string; page: Page }> = [];
  const createdListPages: Array<{ key: string; page: Page }> = [];

  for (const entry of Object.values(resolved)) {
    const { def, collection } = entry;
    if (!def.folderSlug) continue;

    let folder = folderBySlug.get(def.folderSlug) ?? null;
    let folderCreated = false;
    if (!folder) {
      folder = await createPageFolder({
        name: def.name,
        slug: def.folderSlug,
        depth: 0,
        order: nextFolderOrder++,
        settings: {},
        is_published: false,
        page_folder_id: null,
      });
      folderBySlug.set(def.folderSlug, folder);
      folderCreated = true;
    }
    result.folders.push({ id: folder.id, slug: folder.slug, created: folderCreated });

    const siblings = folderCreated ? [] : await getPagesByFolder(folder.id);
    let listPage = siblings.find((p) => p.is_index) ?? null;
    let detailPage = siblings.find((p) => p.is_dynamic && p.settings?.cms?.collection_id === collection.id) ?? null;
    let order = siblings.reduce((m, p) => Math.max(m, p.order ?? 0), -1) + 1;

    if (!listPage) {
      listPage = await createPage({
        name: def.name,
        slug: '',
        is_published: false,
        page_folder_id: folder.id,
        order: order++,
        depth: 1,
        is_index: true,
        is_dynamic: false,
        error_page: null,
        settings: { seo: { title: def.name, description: def.description, noindex: false, image: null } },
      });
      createdListPages.push({ key: def.key, page: listPage });
      result.pages.push({ id: listPage.id, name: listPage.name, path: `/${folder.slug}`, created: true });
    } else {
      result.pages.push({ id: listPage.id, name: listPage.name, path: `/${folder.slug}`, created: false });
    }

    if (!detailPage) {
      detailPage = await createPage({
        name: `${singular(def.name)} detail`,
        slug: '',
        is_published: false,
        page_folder_id: folder.id,
        order: order++,
        depth: 1,
        is_index: false,
        is_dynamic: true,
        error_page: null,
        settings: {
          cms: { collection_id: collection.id, slug_field_id: entry.fields.slug.id },
          seo: buildDynamicSeo(entry),
        },
      });
      createdDetailPages.push({ key: def.key, page: detailPage });
      result.pages.push({ id: detailPage.id, name: detailPage.name, path: `/${folder.slug}/{slug}`, created: true });
    } else {
      result.pages.push({ id: detailPage.id, name: detailPage.name, path: `/${folder.slug}/{slug}`, created: false });
    }

    collectionPages[def.key] = { folder, listPage, detailPage };
  }

  const detailPageIdByKey: Record<string, string | null> = {};
  for (const [key, pages] of Object.entries(collectionPages)) {
    detailPageIdByKey[key] = pages.detailPage?.id ?? null;
  }

  const builder = new WireframeBuilder(resolved, detailPageIdByKey);

  // 2. Layers for newly created list / detail pages
  for (const { key, page } of createdListPages) {
    await upsertDraftLayers(page.id, builder.listPage(resolved[key]));
  }
  for (const { key, page } of createdDetailPages) {
    await upsertDraftLayers(page.id, builder.detailPage(resolved[key]));
  }

  // 3. Static pages at root level
  const rootPages = allPages.filter((p) => !p.page_folder_id);
  const hasRootIndex = rootPages.some((p) => p.is_index);
  const rootSlugs = new Set(rootPages.map((p) => p.slug));
  let rootOrder = rootPages.reduce((m, p) => Math.max(m, p.order ?? 0), -1) + 1;

  for (const pageDef of UNIVERSAL_ONTOLOGY.pages) {
    if (pageDef.isIndex && hasRootIndex) {
      // Reuse the existing homepage; fill it with the wireframe only when it is still empty
      const index = rootPages.find((p) => p.is_index) as Page;
      const existingLayers = await getDraftLayers(index.id);
      const isEmpty = !existingLayers?.layers?.some((l: Layer) => (l.children?.length ?? 0) > 0);
      if (isEmpty) {
        await upsertDraftLayers(index.id, builder.staticPage(pageDef));
      }
      result.pages.push({ id: index.id, name: index.name, path: '/', created: isEmpty });
      continue;
    }
    if (!pageDef.isIndex && rootSlugs.has(pageDef.slug)) {
      const existing = rootPages.find((p) => p.slug === pageDef.slug) as Page;
      result.pages.push({ id: existing.id, name: existing.name, path: `/${pageDef.slug}`, created: false });
      continue;
    }

    const page = await createPage({
      name: pageDef.name,
      slug: pageDef.isIndex ? '' : pageDef.slug,
      is_published: false,
      page_folder_id: null,
      order: rootOrder++,
      depth: 0,
      is_index: !!pageDef.isIndex,
      is_dynamic: false,
      error_page: null,
      settings: { seo: { title: pageDef.name, description: '', noindex: false, image: null } },
    });
    await upsertDraftLayers(page.id, builder.staticPage(pageDef));
    result.pages.push({ id: page.id, name: page.name, path: pageDef.isIndex ? '/' : `/${pageDef.slug}`, created: true });
  }

  return result;
}

/**
 * SEO settings for a dynamic page: title = item name, description = summary,
 * OG image = cover field. Inline variables are resolved per item at render time.
 */
function buildDynamicSeo(entry: ResolvedCollection): NonNullable<Page['settings']['seo']> {
  const { def, fields } = entry;
  const summaryField = def.fields.find((f) => f.role === 'summary' && fields[f.key]);
  const coverField = def.fields.find((f) => f.role === 'cover' && fields[f.key]);

  return {
    title: inlineVariableTag(fieldVariable(fields.name, 'page')),
    description: summaryField ? inlineVariableTag(fieldVariable(fields[summaryField.key], 'page')) : '',
    noindex: false,
    image: coverField ? fieldVariable(fields[coverField.key], 'page') : null,
  };
}

/** Serialize a field variable as an inline variable tag (used in SEO strings) */
function inlineVariableTag(variable: FieldVariable): string {
  return `<ycode-inline-variable>${JSON.stringify(variable)}</ycode-inline-variable>`;
}

/** Very small singularizer for page names ("Articles" -> "Article", "People" -> "Person") */
function singular(name: string): string {
  const irregular: Record<string, string> = { People: 'Person', Categories: 'Category' };
  if (irregular[name]) return irregular[name];
  return name.endsWith('s') ? name.slice(0, -1) : name;
}

/* -------------------------------------------------------------------------- */
/*                              Wireframe builder                             */
/* -------------------------------------------------------------------------- */

/**
 * Builds plain, neutral wireframe layers. Everything uses Tailwind utility
 * classes plus the matching `design` properties so the layers are editable in
 * the builder like any hand-made layer.
 */
class WireframeBuilder {
  constructor(
    private readonly resolved: ResolvedMap,
    private readonly detailPageIdByKey: Record<string, string | null>
  ) {}

  /* ------------------------------- Pages -------------------------------- */

  listPage(entry: ResolvedCollection): Layer[] {
    const { def } = entry;
    return [
      body([
        this.navigation(),
        section(`${def.name} header`, [
          heading(def.name, 1),
          paragraph(def.description, 'muted'),
        ]),
        section(`${def.name} list`, [this.cardGrid(def.key, {})]),
        this.footer(),
      ]),
    ];
  }

  detailPage(entry: ResolvedCollection): Layer[] {
    const { def, fields } = entry;
    const pageField = (key: string): FieldVariable => fieldVariable(fields[key], 'page');

    const subtitleFields = def.fields.filter((f) => f.role === 'subtitle' && fields[f.key]);
    const summaryFields = def.fields.filter((f) => f.role === 'summary' && fields[f.key]);
    const bodyFields = def.fields.filter((f) => f.role === 'body' && fields[f.key]);
    const coverField = def.fields.find((f) => f.role === 'cover' && fields[f.key]);
    const galleryFields = def.fields.filter((f) => f.role === 'gallery' && f.type === 'image' && !f.multiple && fields[f.key]);
    const metaFields = def.fields.filter((f) => f.role === 'meta' && fields[f.key]);
    const relationFields = def.fields.filter((f) => f.role === 'relation' && fields[f.key] && f.ref);

    const typeField = def.fields.find((f) => (f.key === 'type' || f.key === 'kind' || f.key === 'platform') && fields[f.key]);
    const headerChildren: Layer[] = [
      ...(typeField ? [textLayer([inlineVariable(pageField(typeField.key), typeField.name)], 'span', 'eyebrow')] : []),
      textLayer([inlineVariable(pageField('name'), 'Name')], 'h1', 'h1'),
      ...subtitleFields.map((f) => textLayer([inlineVariable(pageField(f.key), f.name)], 'p', 'lead')),
      ...summaryFields.map((f) => textLayer([inlineVariable(pageField(f.key), f.name)], 'p', 'muted')),
    ];

    const sections: Layer[] = [
      this.navigation(),
      section(`${def.name} header`, headerChildren, 'narrow'),
    ];

    if (coverField) {
      sections.push(section('Cover', [imageLayer(pageField(coverField.key), coverField.name, 'hero')], 'narrow'));
    }

    for (const f of bodyFields) {
      sections.push(
        section(f.name, [
          heading(f.name, 2),
          richTextLayer(pageField(f.key), f.name),
        ], 'narrow')
      );
    }

    if (galleryFields.length > 0) {
      sections.push(
        section('Images', [
          heading('Images', 2),
          grid(galleryFields.map((f) => imageLayer(pageField(f.key), f.name, 'card')), 3),
        ], 'narrow')
      );
    }

    if (metaFields.length > 0) {
      sections.push(
        section('Details', [
          heading('Details', 2),
          div('Details list', ['flex', 'flex-col', 'gap-[8px]'], { layout: { isActive: true, display: 'Flex', flexDirection: 'column', gap: '8px' } },
            metaFields.map((f) => this.metaRow(f, pageField(f.key)))
          ),
        ], 'narrow')
      );
    }

    for (const f of relationFields) {
      const targetKey = f.ref as string;
      const relationSection = section(f.name, [
        heading(f.name, 2),
        this.cardGrid(targetKey, {
          source_field_id: fields[f.key].id,
          source_field_type: f.type === 'reference' ? 'reference' : 'multi_reference',
          source_field_source: 'page',
        }),
      ]);
      // Hide the whole section when the reference is empty
      relationSection.variables = {
        conditionalVisibility: visibility({
          source: 'collection_field',
          fieldId: fields[f.key].id,
          fieldType: fields[f.key].type,
          operator: f.type === 'reference' ? 'exists' : 'has_items',
        }),
      };
      sections.push(relationSection);
    }

    for (const inverse of def.inverse || []) {
      const child = this.resolved[inverse.collection];
      const childField = child?.fields[inverse.field];
      if (!child || !childField) continue;
      const list = this.cardGrid(inverse.collection, {
        source_field_id: childField.id,
        source_field_type: 'inverse_reference',
        source_field_source: 'page',
      });
      const inverseSection = section(inverse.label, [heading(inverse.label, 2), list]);
      // Hide the section when no item points back to this one
      inverseSection.variables = {
        conditionalVisibility: visibility({
          source: 'page_collection',
          collectionLayerId: list.children?.[0]?.id,
          collectionLayerName: `${child.def.name} item`,
          operator: 'has_items',
        }),
      };
      sections.push(inverseSection);
    }

    sections.push(this.footer());
    return [body(sections)];
  }

  staticPage(pageDef: OntologyStaticPage): Layer[] {
    const sections: Layer[] = [this.navigation()];

    pageDef.sections.forEach((s, index) => {
      sections.push(this.staticSection(s, index === 0 && !!pageDef.isIndex));
    });

    sections.push(this.footer());
    return [body(sections)];
  }

  /* ----------------------------- Sections ------------------------------- */

  private staticSection(s: OntologyStaticSection, isHero: boolean): Layer {
    const children: Layer[] = [heading(s.title, isHero ? 1 : 2)];
    if (s.text) children.push(paragraph(s.text, isHero ? 'lead' : 'muted'));

    if (s.collection) {
      const entry = this.resolved[s.collection];
      const options: CollectionListOptions = {};
      if (s.limit) options.limit = s.limit;
      if (s.sortBy && entry.fields[s.sortBy]) {
        options.sort_by = entry.fields[s.sortBy].id;
        options.sort_order = s.sortOrder ?? 'asc';
      }
      if (s.filter && entry.fields[s.filter.field]) {
        options.filters = textFilter(entry.fields[s.filter.field], s.filter.value);
      }
      if (s.fields?.length) {
        options.fields = s.fields;
      }
      children.push(this.cardGrid(s.collection, options));
    }

    if (s.form) children.push(contactForm());

    return section(s.title, children);
  }

  private navigation(): Layer {
    const links = UNIVERSAL_ONTOLOGY.pages.map((p) => linkText(p.name, p.isIndex ? '/' : `/${p.slug}`));
    const collectionLinks = UNIVERSAL_ONTOLOGY.collections
      .filter((c) => c.folderSlug)
      .slice(0, 6)
      .map((c) => linkText(c.name, `/${c.folderSlug}`));

    return {
      id: generateId('lyr'),
      name: 'section',
      customName: 'Navigation',
      classes: ['flex', 'flex-col', 'w-[100%]', 'items-center', 'border-b-[1px]', 'border-[#e5e5e5]'],
      design: {
        layout: { isActive: true, display: 'Flex', flexDirection: 'column', alignItems: 'center' },
        sizing: { isActive: true, width: '100%' },
      },
      children: [
        div('Container', ['flex', 'flex-row', 'items-center', 'justify-between', 'flex-wrap', 'gap-[24px]', 'max-w-[1200px]', 'w-[100%]', 'pl-[24px]', 'pr-[24px]', 'pt-[16px]', 'pb-[16px]'], {
          layout: { isActive: true, display: 'Flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '24px' },
          sizing: { isActive: true, width: '100%', maxWidth: '1200px' },
          spacing: { isActive: true, paddingLeft: '24px', paddingRight: '24px', paddingTop: '16px', paddingBottom: '16px' },
        }, [
          linkText('Logo', '/', 'font-[700]'),
          div('Menu', ['flex', 'flex-row', 'flex-wrap', 'gap-[16px]'], { layout: { isActive: true, display: 'Flex', flexDirection: 'row', flexWrap: 'wrap', gap: '16px' } }, [...links, ...collectionLinks]),
        ]),
      ],
    };
  }

  private footer(): Layer {
    const collectionLinks = UNIVERSAL_ONTOLOGY.collections
      .filter((c) => c.folderSlug)
      .map((c) => linkText(c.name, `/${c.folderSlug}`));

    return section('Footer', [
      div('Footer columns', ['flex', 'flex-row', 'flex-wrap', 'gap-[16px]'], { layout: { isActive: true, display: 'Flex', flexDirection: 'row', flexWrap: 'wrap', gap: '16px' } }, collectionLinks),
      paragraph('© Your organization. Replace with your footer.', 'muted'),
    ], 'wide', ['border-t-[1px]', 'border-[#e5e5e5]']);
  }

  /* ------------------------------ Cards --------------------------------- */

  /**
   * Grid of linked cards for a collection (repeated collection layer inside a grid container).
   * With `options.fields` the items are rendered as full-width blocks showing those fields
   * (used for legal texts) instead of linked cards.
   */
  private cardGrid(collectionKey: string, options: CollectionListOptions): Layer {
    const entry = this.resolved[collectionKey];
    const { def, fields } = entry;
    const detailPageId = options.fields ? null : this.detailPageIdByKey[collectionKey] ?? null;

    const collectionLayerId = generateId('lyr');
    const itemField = (key: string): FieldVariable => fieldVariable(fields[key], 'collection', collectionLayerId);

    if (options.fields) {
      const blockChildren: Layer[] = [];
      for (const key of options.fields) {
        const fieldDef = def.fields.find((f) => f.key === key);
        if (!fieldDef || !fields[key]) continue;
        if (fieldDef.type === 'rich_text') {
          blockChildren.push(richTextLayer(itemField(key), fieldDef.name));
        } else if (fieldDef.type === 'image') {
          blockChildren.push(imageLayer(itemField(key), fieldDef.name, 'card'));
        } else if (fieldDef.type === 'reference' || fieldDef.type === 'multi_reference') {
          continue; // references need their own list; not rendered in field blocks
        } else {
          blockChildren.push(this.metaRow(fieldDef, itemField(key)));
        }
      }
      const block = div(`${singular(def.name)} block`, ['flex', 'flex-col', 'gap-[8px]'], { layout: { isActive: true, display: 'Flex', flexDirection: 'column', gap: '8px' } }, blockChildren);
      return this.collectionLayer(entry, collectionLayerId, options, [block], ['flex', 'flex-col', 'gap-[16px]']);
    }

    const coverField = def.fields.find((f) => f.role === 'cover' && fields[f.key]);
    const subtitleField = def.fields.find((f) => f.role === 'subtitle' && fields[f.key]);
    const summaryField = def.fields.find((f) => f.role === 'summary' && fields[f.key]);

    const cardChildren: Layer[] = [];
    if (coverField) cardChildren.push(imageLayer(itemField(coverField.key), coverField.name, 'card'));
    cardChildren.push(textLayer([inlineVariable(itemField('name'), 'Name')], 'h3', 'h3'));
    if (subtitleField) cardChildren.push(textLayer([inlineVariable(itemField(subtitleField.key), subtitleField.name)], 'p', 'small'));
    if (summaryField) cardChildren.push(textLayer([inlineVariable(itemField(summaryField.key), summaryField.name)], 'p', 'muted'));

    const card: Layer = {
      id: generateId('lyr'),
      name: 'div',
      customName: `${singular(def.name)} card`,
      classes: ['flex', 'flex-col', 'gap-[8px]', 'p-[16px]', 'rounded-[12px]', 'border-[1px]', 'border-[#e5e5e5]', 'bg-[#ffffff]', 'no-underline', 'text-[#171717]'],
      settings: { tag: detailPageId ? 'a' : 'div' },
      design: {
        layout: { isActive: true, display: 'Flex', flexDirection: 'column', gap: '8px' },
        spacing: { isActive: true, paddingTop: '16px', paddingBottom: '16px', paddingLeft: '16px', paddingRight: '16px' },
        borders: { isActive: true, borderWidth: '1px', borderColor: '#e5e5e5', borderRadius: '12px' },
        backgrounds: { isActive: true, backgroundColor: '#ffffff' },
      },
      children: cardChildren,
      ...(detailPageId
        ? { variables: { link: { type: 'page', page: { id: detailPageId, collection_item_id: 'current-collection' } } } }
        : {}),
    };

    const collectionLayer = this.collectionLayer(entry, collectionLayerId, options, [card]);
    return grid([collectionLayer], 3, `${def.name} grid`);
  }

  /** The repeated collection layer (one instance per item) */
  private collectionLayer(
    entry: ResolvedCollection,
    collectionLayerId: string,
    options: CollectionListOptions,
    children: Layer[],
    classes: string[] = ['flex', 'flex-col']
  ): Layer {
    return {
      id: collectionLayerId,
      name: 'div',
      customName: `${entry.def.name} item`,
      classes,
      design: { layout: { isActive: true, display: 'Flex', flexDirection: 'column' } },
      variables: {
        collection: {
          id: entry.collection.id,
          sort_by: options.sort_by ?? 'manual',
          ...(options.sort_order ? { sort_order: options.sort_order } : {}),
          ...(options.limit ? { limit: options.limit } : {}),
          ...(options.source_field_id ? { source_field_id: options.source_field_id } : {}),
          ...(options.source_field_type ? { source_field_type: options.source_field_type } : {}),
          ...(options.source_field_source ? { source_field_source: options.source_field_source } : {}),
          ...(options.filters ? { filters: options.filters } : {}),
        },
      },
      children,
    };
  }

  private metaRow(f: OntologyField, variable: FieldVariable): Layer {
    const value: Layer =
      f.type === 'link'
        ? linkField(variable, f.name)
        : textLayer([inlineVariable(variable, f.name)], 'span', 'body');

    const row = div(`${f.name} row`, ['flex', 'flex-row', 'gap-[16px]', 'pb-[8px]', 'border-b-[1px]', 'border-[#e5e5e5]'], {
      layout: { isActive: true, display: 'Flex', flexDirection: 'row', gap: '16px' },
      spacing: { isActive: true, paddingBottom: '8px' },
    }, [
      textLayer([textNode(f.name)], 'span', 'label'),
      value,
    ]);
    // Hide the row when the field is empty
    row.variables = {
      conditionalVisibility: visibility({
        source: 'collection_field',
        fieldId: variable.data.field_id as string,
        fieldType: f.type,
        operator: 'is_present',
      }),
    };
    return row;
  }
}

interface CollectionListOptions {
  limit?: number;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  source_field_id?: string;
  source_field_type?: 'reference' | 'multi_reference' | 'inverse_reference';
  source_field_source?: 'page' | 'collection';
  filters?: ConditionalVisibility;
  /** Render these field keys as blocks instead of linked cards */
  fields?: string[];
}

/* -------------------------------------------------------------------------- */
/*                               Layer helpers                                */
/* -------------------------------------------------------------------------- */

type TextStyleKey = 'h1' | 'h2' | 'h3' | 'lead' | 'body' | 'muted' | 'small' | 'label' | 'eyebrow';

const TEXT_STYLES: Record<TextStyleKey, { classes: string[]; typography: Record<string, string> }> = {
  h1: { classes: ['text-[48px]', 'font-[700]', 'leading-[1.1]', 'tracking-[-0.01em]'], typography: { fontSize: '48px', fontWeight: '700', lineHeight: '1.1', letterSpacing: '-0.01em' } },
  h2: { classes: ['text-[32px]', 'font-[700]', 'leading-[1.2]'], typography: { fontSize: '32px', fontWeight: '700', lineHeight: '1.2' } },
  h3: { classes: ['text-[20px]', 'font-[600]', 'leading-[1.3]'], typography: { fontSize: '20px', fontWeight: '600', lineHeight: '1.3' } },
  lead: { classes: ['text-[20px]', 'leading-[1.5]'], typography: { fontSize: '20px', lineHeight: '1.5' } },
  body: { classes: ['text-[16px]', 'leading-[1.6]'], typography: { fontSize: '16px', lineHeight: '1.6' } },
  muted: { classes: ['text-[16px]', 'leading-[1.6]', 'text-[#737373]'], typography: { fontSize: '16px', lineHeight: '1.6', color: '#737373' } },
  small: { classes: ['text-[14px]', 'text-[#737373]'], typography: { fontSize: '14px', color: '#737373' } },
  label: { classes: ['text-[14px]', 'font-[600]', 'min-w-[160px]', 'text-[#737373]'], typography: { fontSize: '14px', fontWeight: '600', color: '#737373' } },
  eyebrow: { classes: ['text-[12px]', 'font-[600]', 'uppercase', 'tracking-[0.08em]', 'text-[#737373]'], typography: { fontSize: '12px', fontWeight: '600', letterSpacing: '0.08em', color: '#737373' } },
};

type InlineNode = { type: 'text'; text: string } | { type: 'dynamicVariable'; attrs: { variable: FieldVariable; label: string } };

function textNode(text: string): InlineNode {
  return { type: 'text', text };
}

function inlineVariable(variable: FieldVariable, label: string): InlineNode {
  return { type: 'dynamicVariable', attrs: { variable, label } };
}

function fieldVariable(field: CollectionField, source: 'page' | 'collection', collectionLayerId?: string): FieldVariable {
  return {
    type: 'field',
    data: {
      field_id: field.id,
      field_type: field.type,
      relationships: [],
      source,
      ...(collectionLayerId ? { collection_layer_id: collectionLayerId } : {}),
    },
  };
}

function textLayer(content: InlineNode[], tag: string, style: TextStyleKey, customName?: string): Layer {
  const preset = TEXT_STYLES[style];
  return {
    id: generateId('lyr'),
    name: 'text',
    ...(customName ? { customName } : {}),
    settings: { tag },
    classes: preset.classes,
    restrictions: { editText: true },
    design: { typography: { isActive: true, ...preset.typography } },
    variables: {
      text: {
        type: 'dynamic_rich_text',
        data: { content: { type: 'doc', content: [{ type: 'paragraph', content }] } },
      },
    },
  };
}

function heading(text: string, level: 1 | 2 | 3): Layer {
  return textLayer([textNode(text)], `h${level}`, `h${level}`);
}

function paragraph(text: string, style: TextStyleKey = 'body'): Layer {
  return textLayer([textNode(text)], 'p', style);
}

/** Rich text field rendered as block content (the variable expands to the stored Tiptap blocks) */
function richTextLayer(variable: FieldVariable, label: string): Layer {
  const layer = textLayer([inlineVariable(variable, label)], 'div', 'body', label);
  layer.name = 'richText';
  return layer;
}

function imageLayer(variable: FieldVariable, alt: string, variant: 'hero' | 'card'): Layer {
  const isHero = variant === 'hero';
  return {
    id: generateId('lyr'),
    name: 'image',
    customName: alt,
    settings: { tag: 'img' },
    classes: isHero
      ? ['w-[100%]', 'object-cover', 'rounded-[16px]', 'aspect-[16/9]']
      : ['w-[100%]', 'object-cover', 'rounded-[8px]', 'aspect-[4/3]'],
    attributes: { loading: 'lazy' },
    design: { sizing: { isActive: true, width: '100%', objectFit: 'cover' } },
    variables: {
      image: {
        src: variable,
        alt: { type: 'dynamic_text', data: { content: alt } },
      },
    },
  };
}

function linkField(variable: FieldVariable, label: string): Layer {
  return {
    id: generateId('lyr'),
    name: 'div',
    customName: label,
    settings: { tag: 'a' },
    classes: ['text-[16px]', 'underline'],
    design: { typography: { isActive: true, fontSize: '16px' } },
    variables: { link: { type: 'field', field: variable } },
    children: [textLayer([textNode(label)], 'span', 'body')],
  };
}

function linkText(label: string, url: string, extraClass?: string): Layer {
  return {
    id: generateId('lyr'),
    name: 'div',
    customName: label,
    settings: { tag: 'a' },
    classes: ['text-[14px]', 'no-underline', 'text-[#171717]', ...(extraClass ? [extraClass] : [])],
    design: { typography: { isActive: true, fontSize: '14px' } },
    variables: { link: { type: 'url', url: { type: 'dynamic_text', data: { content: url } } } },
    children: [textLayer([textNode(label)], 'span', 'small')],
  };
}

function div(customName: string, classes: string[], design: Layer['design'], children: Layer[]): Layer {
  return { id: generateId('lyr'), name: 'div', customName, classes, design, children };
}

function grid(children: Layer[], columns: number, customName = 'Grid'): Layer {
  return {
    id: generateId('lyr'),
    name: 'div',
    customName,
    classes: ['grid', `grid-cols-[repeat(${columns},minmax(0,1fr))]`, 'gap-[24px]', 'w-[100%]'],
    design: {
      layout: { isActive: true, display: 'Grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: '24px' },
      sizing: { isActive: true, width: '100%' },
    },
    children,
  };
}

function section(customName: string, children: Layer[], width: 'narrow' | 'wide' = 'wide', extraClasses: string[] = []): Layer {
  const maxWidth = width === 'narrow' ? '800px' : '1200px';
  return {
    id: generateId('lyr'),
    name: 'section',
    customName,
    classes: ['flex', 'flex-col', 'w-[100%]', 'items-center', 'pt-[48px]', 'pb-[48px]', ...extraClasses],
    design: {
      layout: { isActive: true, display: 'Flex', flexDirection: 'column', alignItems: 'center' },
      sizing: { isActive: true, width: '100%' },
      spacing: { isActive: true, paddingTop: '48px', paddingBottom: '48px' },
    },
    children: [
      {
        id: generateId('lyr'),
        name: 'div',
        customName: 'Container',
        classes: ['flex', 'flex-col', 'gap-[16px]', `max-w-[${maxWidth}]`, 'w-[100%]', 'pl-[24px]', 'pr-[24px]'],
        design: {
          layout: { isActive: true, display: 'Flex', flexDirection: 'column', gap: '16px' },
          sizing: { isActive: true, width: '100%', maxWidth },
          spacing: { isActive: true, paddingLeft: '24px', paddingRight: '24px' },
        },
        children,
      },
    ],
  };
}

function body(children: Layer[]): Layer {
  return { id: 'body', name: 'body', classes: '', children };
}

function textFilter(field: CollectionField, value: string): ConditionalVisibility {
  return visibility({
    source: 'collection_field',
    fieldId: field.id,
    fieldType: field.type,
    operator: 'is',
    value,
  });
}

/** Wrap a single condition into a ConditionalVisibility structure */
function visibility(condition: Omit<VisibilityCondition, 'id'>): ConditionalVisibility {
  return {
    groups: [{ id: generateId('grp'), conditions: [{ id: generateId('cnd'), ...condition }] }],
  };
}

/** Minimal contact form: name, email, message, submit */
function contactForm(): Layer {
  const input = (name: string, placeholder: string, type = 'text'): Layer => ({
    id: generateId('lyr'),
    name: 'input',
    customName: placeholder,
    classes: ['w-[100%]', 'p-[12px]', 'rounded-[8px]', 'border-[1px]', 'border-[#e5e5e5]'],
    attributes: { name, placeholder, type, required: true },
    design: {
      sizing: { isActive: true, width: '100%' },
      spacing: { isActive: true, paddingTop: '12px', paddingBottom: '12px', paddingLeft: '12px', paddingRight: '12px' },
      borders: { isActive: true, borderWidth: '1px', borderColor: '#e5e5e5', borderRadius: '8px' },
    },
  });

  return {
    id: generateId('lyr'),
    name: 'form',
    customName: 'Contact form',
    classes: ['flex', 'flex-col', 'gap-[12px]', 'max-w-[560px]', 'w-[100%]'],
    attributes: { method: 'POST' },
    design: {
      layout: { isActive: true, display: 'Flex', flexDirection: 'column', gap: '12px' },
      sizing: { isActive: true, width: '100%', maxWidth: '560px' },
    },
    children: [
      input('name', 'Your name'),
      input('email', 'Your email', 'email'),
      {
        id: generateId('lyr'),
        name: 'textarea',
        customName: 'Message',
        classes: ['w-[100%]', 'p-[12px]', 'rounded-[8px]', 'border-[1px]', 'border-[#e5e5e5]', 'min-h-[140px]'],
        attributes: { name: 'message', placeholder: 'Your message', required: true },
        design: {
          sizing: { isActive: true, width: '100%', minHeight: '140px' },
          borders: { isActive: true, borderWidth: '1px', borderColor: '#e5e5e5', borderRadius: '8px' },
        },
      },
      {
        id: generateId('lyr'),
        name: 'button',
        customName: 'Submit',
        classes: ['flex', 'items-center', 'justify-center', 'text-[#ffffff]', 'bg-[#171717]', 'rounded-[8px]', 'pt-[12px]', 'pb-[12px]', 'pl-[20px]', 'pr-[20px]'],
        attributes: { type: 'submit' },
        design: {
          typography: { isActive: true, color: '#ffffff', fontSize: '16px' },
          backgrounds: { isActive: true, backgroundColor: '#171717' },
          spacing: { isActive: true, paddingTop: '12px', paddingBottom: '12px', paddingLeft: '20px', paddingRight: '20px' },
        },
        children: [textLayer([textNode('Send')], 'span', 'body')],
      },
    ],
  };
}

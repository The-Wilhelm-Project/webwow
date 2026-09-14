/**
 * Page / folder / settings persistence (SPEC §4.16).
 *
 * `planPages` is pure: it decides what rows the export needs (index page,
 * folders, dynamic collection pages, folder-index pages, error pages) and their
 * slugs, so `assertNoSlugConflicts` can fail the whole import *before* anything
 * is written (D7). `createPageRows` then writes them in the order the index
 * constraints require, and mirrors what the builder's own POST /ycode/api/pages
 * does: `incrementSiblingOrders` + `createPage` + an initial `body` draft.
 *
 * v2 is additive: a fresh database already ships a default "Homepage" and the
 * default error pages, so those rows are reused rather than duplicated (a second
 * root index page would demote the first one to a slug-less orphan).
 */

import { neutraliseCss } from './css-sanitize';
import { WfImportError } from './types';

import { buildDesign } from '@/lib/import/design';
import { getAllPages, createPage, updatePage } from '@/lib/repositories/pageRepository';
import { getAllPageFolders, createPageFolder } from '@/lib/repositories/pageFolderRepository';
import { upsertDraftLayers } from '@/lib/repositories/pageLayersRepository';
import { getSettingsByKeys, setSettings } from '@/lib/repositories/settingsRepository';
import { incrementSiblingOrders } from '@/lib/services/pageService';

import type { WfCollectionInfo } from './cms';
import type { WfPage } from './types';
import type { Warnings } from './warnings';
import type { Layer, PageSettings } from '@/types';

/** Marker around the residual Webflow CSS inside `settings.custom_code_head`. */
export const RESIDUAL_STYLE_ID = 'webwow-webflow-import';

/**
 * Slugs the app's own routing owns at root level (mirrors `RESERVED_ROOT_SLUGS`
 * in lib/page-utils.ts, which cannot be imported here: it pulls in React).
 */
const RESERVED_ROOT_SLUGS = ['ycode'];

/** Site names we are allowed to overwrite with the export's title. */
const PLACEHOLDER_SITE_NAMES = new Set(['my site', 'ycode site', '']);

export type PageKind = 'index' | 'static' | 'dynamic' | 'error' | 'folder-index';

export interface PagePlan {
  page: WfPage;
  kind: PageKind;
  name: string;
  slug: string;
  folder?: { name: string; slug: string };
  errorPage?: 401 | 404;
  cms?: { collectionId: string; slugFieldId: string };
  seo: { title: string; description: string; image: string | null; noindex: boolean };
  customHead: string;
  customBody: string;
}

export interface AssetIdLookup {
  idOf(key: string): string | null;
}

// ─── Planning ─────────────────────────────────────────────────────────────────

function titleCase(basename: string): string {
  return basename
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || basename;
}

function detailSuffix(name: string): string | null {
  const m = name.match(/^detail[_-](.+)$/i);
  return m ? m[1] : null;
}

/** Page-scoped residual CSS + head scripts, neutralised before they are stored (D5). */
function buildCustomHead(page: WfPage, warn: Warnings): string {
  const parts: string[] = [];
  const css = page.headStyles.join('\n').trim();
  if (css) {
    const { css: safe, changes } = neutraliseCss(css);
    if (changes > 0) {
      warn.add('css_neutralised', `page ${page.name}: ${changes} unsafe construct(s) removed from an embedded stylesheet`, { page: page.name });
    }
    if (safe.trim()) parts.push(`<style data-webwow-import="page">\n${safe.trim()}\n</style>`);
  }
  for (const script of page.headScripts ?? []) parts.push(script);
  return parts.join('\n');
}

/**
 * Decide the row shape for every page of the export. Pure — no database access,
 * so a slug conflict can abort the run before the first write.
 */
export function planPages(
  pages: WfPage[],
  detailCollections: Map<string, WfCollectionInfo>,
  warn: Warnings,
  assets?: AssetIdLookup,
): PagePlan[] {
  // Folders come from `detail_<x>` pages; a static page whose basename equals a
  // folder slug becomes that folder's index so `/exhibitions` keeps working.
  const folderSlugs = new Map<string, { name: string; slug: string }>();
  for (const page of pages) {
    const suffix = detailSuffix(page.name);
    if (suffix === null) continue;
    const collection = detailCollections.get(page.name);
    if (!collection) continue;
    const slug = suffix.toLowerCase();
    if (!folderSlugs.has(slug)) folderSlugs.set(slug, { name: collection.name, slug });
  }

  const plans: PagePlan[] = [];
  for (const page of pages) {
    const seoImage = page.ogImage && assets ? assets.idOf(page.ogImage) : null;
    const base: Omit<PagePlan, 'kind' | 'name' | 'slug'> = {
      page,
      seo: { title: page.title, description: page.description, image: seoImage, noindex: false },
      customHead: buildCustomHead(page, warn),
      customBody: (page.bodyScripts ?? []).join('\n'),
    };

    if (page.name === '401' || page.name === '404') {
      plans.push({ ...base, kind: 'error', name: page.name === '401' ? '401 - Unauthorized' : '404 - Not found', slug: '', errorPage: page.name === '401' ? 401 : 404, seo: { ...base.seo, noindex: true } });
      continue;
    }

    if (page.name === 'index') {
      plans.push({ ...base, kind: 'index', name: 'Home', slug: '' });
      continue;
    }

    const suffix = detailSuffix(page.name);
    if (suffix !== null) {
      const collection = detailCollections.get(page.name);
      if (!collection) {
        warn.add('collection_guess', `page ${page.name} looks like a collection page but no collection matched; imported as a static page`, { page: page.name });
      } else {
        const folder = folderSlugs.get(suffix.toLowerCase())!;
        plans.push({ ...base, kind: 'dynamic', name: collection.name, slug: '*', folder, cms: { collectionId: collection.id, slugFieldId: collection.slugFieldId } });
        continue;
      }
    }

    const folder = folderSlugs.get(page.name.toLowerCase());
    if (folder) {
      plans.push({ ...base, kind: 'folder-index', name: titleCase(page.name), slug: '', folder });
      continue;
    }

    let slug = page.name.toLowerCase();
    if (RESERVED_ROOT_SLUGS.includes(slug)) {
      const replacement = `${slug}-1`;
      warn.add('slug_suffixed', `"${slug}" is a reserved root slug; using "${replacement}"`, { page: page.name });
      slug = replacement;
    }
    plans.push({ ...base, kind: 'static', name: titleCase(page.name), slug });
  }

  return plans;
}

// ─── Slug conflicts ───────────────────────────────────────────────────────────

/**
 * Fail (or suffix) when a planned root slug or folder slug already exists.
 * Runs before any write, so a re-run of the same import leaves the database
 * exactly as it was.
 */
export async function assertNoSlugConflicts(plans: PagePlan[], mode: 'fail' | 'suffix', warn: Warnings): Promise<void> {
  const [existingPages, existingFolders] = await Promise.all([
    getAllPages({ is_published: false }),
    getAllPageFolders({ is_published: false }),
  ]);

  const taken = new Set<string>();
  for (const page of existingPages) {
    if (page.page_folder_id) continue;
    if (page.is_index || page.error_page !== null || page.is_dynamic) continue;
    if (page.slug) taken.add(page.slug.toLowerCase());
  }
  for (const folder of existingFolders) {
    if (folder.page_folder_id) continue;
    if (folder.slug) taken.add(folder.slug.toLowerCase());
  }

  const claim = (slug: string, label: string, page?: string): string => {
    const lower = slug.toLowerCase();
    if (!taken.has(lower)) {
      taken.add(lower);
      return slug;
    }
    if (mode === 'fail') {
      throw new WfImportError('slug_conflict', `${label} "${slug}" already exists. Re-run with pageSlugConflict=suffix, or remove the existing page/folder first.`);
    }
    let i = 2;
    while (taken.has(`${lower}-${i}`)) i += 1;
    const next = `${slug}-${i}`;
    taken.add(next.toLowerCase());
    warn.add('slug_suffixed', `${label} "${slug}" already exists; using "${next}"`, page ? { page } : undefined);
    return next;
  };

  // Folders first: a folder-index page and its dynamic page share the folder slug.
  const folderRename = new Map<string, string>();
  for (const plan of plans) {
    if (!plan.folder) continue;
    if (folderRename.has(plan.folder.slug)) continue;
    folderRename.set(plan.folder.slug, claim(plan.folder.slug, 'Page folder', plan.page.name));
  }
  for (const plan of plans) {
    if (plan.folder) plan.folder = { ...plan.folder, slug: folderRename.get(plan.folder.slug) ?? plan.folder.slug };
  }

  for (const plan of plans) {
    if (plan.kind !== 'static') continue;
    plan.slug = claim(plan.slug, 'Page slug', plan.page.name);
  }
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function toPageSettings(plan: PagePlan): PageSettings {
  const settings: PageSettings = {
    seo: { title: plan.seo.title, description: plan.seo.description, image: plan.seo.image, noindex: plan.seo.noindex },
  };
  if (plan.customHead || plan.customBody) settings.custom_code = { head: plan.customHead, body: plan.customBody };
  if (plan.cms) {
    settings.cms = {
      collection_id: plan.cms.collectionId,
      slug_field_id: plan.cms.slugFieldId,
      next_previous: { sort_by: 'manual', sort_order: 'asc' },
    };
  }
  return settings;
}

const EMPTY_BODY: Layer[] = [{ id: 'body', name: 'body', classes: '', children: [] }];

export interface CreatePageRowsResult {
  /** page basename -> page id */
  pageIds: Map<string, string>;
  /** folder slug -> folder id */
  folderIds: Map<string, string>;
}

/**
 * Create every planned row. Order matters: the index page first (the root folder
 * must always keep exactly one), then folders, then the pages inside them.
 */
export async function createPageRows(plans: PagePlan[]): Promise<CreatePageRowsResult> {
  const pageIds = new Map<string, string>();
  const folderIds = new Map<string, string>();

  const existingPages = await getAllPages({ is_published: false });
  const existingFolders = await getAllPageFolders({ is_published: false });

  const orderByFolder = new Map<string, number>();
  for (const page of existingPages) {
    const key = page.page_folder_id ?? '';
    orderByFolder.set(key, Math.max(orderByFolder.get(key) ?? -1, page.order ?? 0));
  }
  let folderOrder = existingFolders.reduce((max, f) => Math.max(max, f.order ?? 0), -1);

  const nextOrder = (folderId: string | null): number => {
    const key = folderId ?? '';
    const next = (orderByFolder.get(key) ?? -1) + 1;
    orderByFolder.set(key, next);
    return next;
  };

  const persist = async (plan: PagePlan, folderId: string | null, depth: number, extra: { isIndex?: boolean; isDynamic?: boolean } = {}) => {
    const order = nextOrder(folderId);
    await incrementSiblingOrders(order, depth, folderId);
    const page = await createPage({
      name: plan.name,
      slug: plan.kind === 'index' || plan.kind === 'folder-index' || plan.kind === 'error' ? '' : plan.slug,
      page_folder_id: folderId,
      order,
      depth,
      is_index: extra.isIndex ?? false,
      is_dynamic: extra.isDynamic ?? false,
      error_page: plan.errorPage ?? null,
      settings: toPageSettings(plan),
    });
    await upsertDraftLayers(page.id, EMPTY_BODY.map((l) => ({ ...l })));
    pageIds.set(plan.page.name, page.id);
  };

  // 1. Index page — reuse the default "Homepage" instead of demoting it.
  const indexPlan = plans.find((p) => p.kind === 'index');
  if (indexPlan) {
    const existingIndex = existingPages.find((p) => p.is_index && !p.page_folder_id && p.error_page === null);
    if (existingIndex) {
      await updatePage(existingIndex.id, { name: indexPlan.name, settings: toPageSettings(indexPlan) });
      pageIds.set(indexPlan.page.name, existingIndex.id);
    } else {
      await persist(indexPlan, null, 0, { isIndex: true });
    }
  }

  // 2. Folders.
  for (const plan of plans) {
    if (!plan.folder) continue;
    if (folderIds.has(plan.folder.slug)) continue;
    const existing = existingFolders.find((f) => !f.page_folder_id && f.slug.toLowerCase() === plan.folder!.slug.toLowerCase());
    if (existing) {
      folderIds.set(plan.folder.slug, existing.id);
      continue;
    }
    const folder = await createPageFolder({ name: plan.folder.name, slug: plan.folder.slug, depth: 0, order: ++folderOrder });
    folderIds.set(plan.folder.slug, folder.id);
  }

  // 3. Folder-index pages (must exist before any other page of that folder).
  for (const plan of plans) {
    if (plan.kind !== 'folder-index' || !plan.folder) continue;
    await persist(plan, folderIds.get(plan.folder.slug) ?? null, 1, { isIndex: true });
  }

  // 4. Dynamic collection pages.
  for (const plan of plans) {
    if (plan.kind !== 'dynamic') continue;
    await persist(plan, plan.folder ? folderIds.get(plan.folder.slug) ?? null : null, plan.folder ? 1 : 0, { isDynamic: true });
  }

  // 5. Static pages.
  for (const plan of plans) {
    if (plan.kind !== 'static') continue;
    await persist(plan, null, 0);
  }

  // 6. Error pages — the defaults already exist, so update them in place.
  for (const plan of plans) {
    if (plan.kind !== 'error' || !plan.errorPage) continue;
    const existing = existingPages.find((p) => p.error_page === plan.errorPage);
    if (existing) {
      await updatePage(existing.id, { name: plan.name, settings: toPageSettings(plan) });
      pageIds.set(plan.page.name, existing.id);
    } else {
      await persist(plan, null, 0);
    }
  }

  return { pageIds, folderIds };
}

/** Persist a page's converted layer tree under the mandatory `body` root (G5). */
export async function savePageLayers(pageId: string, bodyClasses: string, roots: Layer[]): Promise<void> {
  // `body` is the layer the builder selects when a page is opened, so it needs
  // its `design` as much as any other layer — without it the very first design
  // panel the user sees is empty even though the page carries site typography.
  const body: Layer = { id: 'body', name: 'body', classes: bodyClasses, children: roots };
  const design = buildDesign(bodyClasses);
  if (design) body.design = design;
  await upsertDraftLayers(pageId, [body]);
}

export interface SiteSettingsInput {
  siteName?: string;
  faviconAssetId?: string;
  webClipAssetId?: string;
  /** Residual CSS + residual `@font-face` rules (already namespaced + neutralised). */
  residualCss: string;
}

/** Merge the import's residual CSS into `custom_code_head` and set the site basics. */
export async function saveSiteSettings(input: SiteSettingsInput): Promise<void> {
  const current = await getSettingsByKeys(['custom_code_head', 'site_name']);
  const previous = typeof current.custom_code_head === 'string' ? current.custom_code_head : '';
  const stripped = previous.replace(new RegExp(`<style id="${RESIDUAL_STYLE_ID}"[\\s\\S]*?</style>`, 'gi'), '').trim();

  const block = input.residualCss.trim()
    ? `<style id="${RESIDUAL_STYLE_ID}">\n${input.residualCss.trim()}\n</style>`
    : '';

  const updates: Record<string, unknown> = {
    custom_code_head: [stripped, block].filter(Boolean).join('\n'),
  };
  if (input.faviconAssetId) updates.favicon_asset_id = input.faviconAssetId;
  if (input.webClipAssetId) updates.web_clip_asset_id = input.webClipAssetId;

  const siteName = typeof current.site_name === 'string' ? current.site_name.trim() : '';
  if (input.siteName && PLACEHOLDER_SITE_NAMES.has(siteName.toLowerCase())) updates.site_name = input.siteName;

  await setSettings(updates);
}

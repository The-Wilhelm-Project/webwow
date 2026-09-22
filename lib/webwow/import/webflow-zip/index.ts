/**
 * Webflow ZIP importer v2 — orchestrator (SPEC §4.17).
 *
 * Runs the whole import inside one request: ZIP -> style model -> pages -> CMS
 * -> layers -> components -> CSS. The order matters and is load-bearing:
 * everything that can fail without touching the database (ZIP limits, CSV
 * schema, slug conflicts) happens in steps 1-6, so a rejected import leaves the
 * project exactly as it was.
 *
 * The design goal that separates v2 from v1: the Webflow stylesheet is
 * *translated* into ycode layer styles with real `design` data, not shipped
 * alongside the site. Only what ycode's model genuinely cannot express (the
 * `tiny` breakpoint, pseudo-elements, complex selectors) survives as namespaced
 * residual CSS.
 */

import { ImportConverter } from '@/lib/import/convert';
import { createAssetFolder, getAllAssetFolders } from '@/lib/repositories/assetFolderRepository';
import { generateAndSaveDraftCSS, generateCSSForPages } from '@/lib/server/cssGenerator';
import { clearAllCache } from '@/lib/services/cacheService';
import { guessMimeType } from '@/lib/webwow/storage';

import { bindPages, chooseCollection } from './binding';
import { importCms, inferSchema, inferTimeZoneFromDates, parseCsvFiles, reportGuessedFields } from './cms';
import { componentizeKeepingMedia, extractCrossPageComponents } from './components';
import { fetchCmsFromApi, mergeCmsPlans } from './data-api';
import { applyNodeLayerPostProcessing, convertPage, liftSelfBoundBackgrounds, pinBackgroundBindingClasses, resolveShadowedChipClasses, walkLayers } from './convert-bridge';
import { bodyClassesFor, buildStyleModel } from './css';
import { installFonts } from './fonts';
import { loadSvgIcons, parsePage } from './html';
import { mapInteractions } from './ix2';
import { collectRichTextClasses } from './richtext-styles';
import { collectClassLists } from './states';
import { parseIx2FromJs } from './ix2-parse';
import { assertNoSlugConflicts, createPageRows, planPages, savePageLayers, saveSiteSettings } from './pages';
import { ByteBudget } from './safe-fetch';
import { ServerMaterializer } from './server-materializer';
import { applySiteSeo, createSiteOracle, mergeSitePlans } from './site-cms';
import { crawlSite, pagePathOf } from './site-crawl';
import { DEFAULT_IMPORT_OPTIONS } from './types';
import { Warnings } from './warnings';
import { generateWidgetInteractions } from './widgets';
import { siteClassIndex } from './widgets-extra';
import { parseLightboxPayload } from './widgets-native';
import { openWebflowZip } from './zip';

import type { WfCmsResult, WfCollectionInfo, WfCollectionPlan } from './cms';
import type { WfCmsSource } from './data-api';
import type { PageLayers, RegionHint } from './components';
import type { PagePlan } from './pages';
import type { SiteCmsMerge } from './site-cms';
import type { SiteCollectionHint } from './site-crawl';
import type { WfImportCounts, WfImportOptions, WfImportResult, WfNode, WfPage, WfSiteContribution } from './types';
import type { WfZipBundle } from './zip';

import type { ImportMaterializer } from '@/lib/import/materializer';
import type { Ix2Data } from './ix2-parse';
import type { Layer } from '@/types';

export { WfImportError } from './types';
export type { WfImportCounts, WfImportOptions, WfImportResult, WfWarning, WfWarningCode } from './types';

/** Total bytes the whole import may download from remote hosts. */
const REMOTE_BUDGET_BYTES = 500 * 2 ** 20;

export interface WfImportInput {
  zip: Buffer;
  csvFiles: { filename: string; content: string }[];
  options?: Partial<WfImportOptions>;
}

export interface WfImportHooks {
  onProgress?: (step: string, done: number, total: number) => void;
}

// ─── Asset key collection ─────────────────────────────────────────────────────

const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gi;
const HTML_REF_RE = /(?:src|href|content|srcset|data-poster-url|data-video-urls|data-src)\s*=\s*"([^"]*)"/gi;
const DERIVATIVE_RE = /-p-\d+(\.[a-z0-9]+)$/i;

/** `'../images/x-p-500.jpg?v=1'` -> `'images/x.jpg'` (the base file actually in the ZIP). */
function toZipKey(raw: string): string | null {
  const value = raw.trim();
  if (!value || /^(https?:|data:|mailto:|tel:|javascript:|#)/i.test(value)) return null;
  const clean = value.split('?')[0].split('#')[0].replace(/^\.?\//, '').replace(/^(\.\.\/)+/, '');
  if (!clean || clean.includes('..')) return null;
  return clean.replace(DERIVATIVE_RE, '$1');
}

function collectCssAssetKeys(css: string, zip: WfZipBundle, out: Set<string>): void {
  for (const match of css.matchAll(CSS_URL_RE)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    const key = toZipKey(raw);
    if (key && zip.files.has(key)) out.add(key);
  }
}

/**
 * Lightbox galleries reference their full-size images only from the JSON payload
 * Webflow writes inside `<script class="w-json">` — never from an `src`/`href`,
 * so `collectHtmlAssetKeys` cannot see them. Their urls point at Webflow's CDN;
 * `ServerMaterializer.uploadAsset` re-hosts an https key like any other, so
 * adding them here is what turns `settings.lightbox.files` into real asset ids
 * instead of links to someone else's CDN.
 */
const W_JSON_RE = /<script[^>]*class="[^"]*\bw-json\b[^"]*"[^>]*>([\s\S]*?)<\/script>/gi;

function collectLightboxAssetKeys(html: string, zip: WfZipBundle, out: Set<string>): void {
  for (const match of html.matchAll(W_JSON_RE)) {
    for (const url of parseLightboxPayload(match[1]).urls) {
      if (/^https?:\/\//i.test(url)) {
        out.add(url);
        continue;
      }
      const key = toZipKey(url);
      if (key && zip.files.has(key)) out.add(key);
    }
  }
}

function collectHtmlAssetKeys(html: string, zip: WfZipBundle, out: Set<string>): void {
  for (const match of html.matchAll(HTML_REF_RE)) {
    for (const part of match[1].split(',')) {
      const key = toZipKey(part.trim().split(/\s+/)[0] ?? '');
      if (key && zip.files.has(key)) out.add(key);
    }
  }
}

/** A `slides` layer whose children were lifted out before componentization. */
interface DetachedSlides {
  parent: Layer;
  slides: Layer[];
}

function detachSlides(layers: Layer[]): DetachedSlides[] {
  const out: DetachedSlides[] = [];
  walkLayers(layers, (layer) => {
    if (layer.name !== 'slides' || !layer.children || layer.children.length === 0) return;
    out.push({ parent: layer, slides: layer.children });
    layer.children = [];
  });
  return out;
}

// ─── CMS plan helpers ─────────────────────────────────────────────────────────

/**
 * A `WfCollectionInfo` shaped from the CSV alone (no ids yet). `chooseCollection`
 * only reads `name`, `webflowId` and `rowCount`, so page planning — and the slug
 * conflict check — can run before the first database write.
 */
function provisionalCms(plans: WfCollectionPlan[]): WfCmsResult {
  const collections: WfCollectionInfo[] = plans.map((plan) => ({
    id: '',
    name: plan.csv.name.trim() || 'Collection',
    webflowId: plan.csv.webflowId,
    fields: [],
    slugFieldId: '',
    nameFieldId: '',
    itemIdBySlug: new Map<string, string>(),
    itemIdByWebflowId: new Map<string, string>(),
    itemIdByName: new Map<string, string>(),
    rowCount: plan.csv.rows.length,
    publishableCount: 0,
    dateFormatByField: {},
    fillCountByField: {},
  }));
  return { collections, counts: { collections: 0, fields: 0, items: 0, itemsPublishable: 0, cmsImages: 0, failed: 0, skipped: 0 } };
}

/** `detail_werke` -> `werke` (the folder slug of the collection pages). */
function detailFolderOf(pageName: string): string | null {
  const m = pageName.match(/^detail[_-](.+)$/i);
  return m ? m[1].toLowerCase() : null;
}

/** page basename -> the collection its `detail_*` page belongs to. */
function detailCollectionsOf(pages: WfPage[], cms: WfCmsResult): Map<string, WfCollectionInfo> {
  const out = new Map<string, WfCollectionInfo>();
  for (const page of pages) {
    if (!/^detail[_-]/i.test(page.name)) continue;
    const choice = chooseCollection('page', { page }, cms);
    if (choice) out.set(page.name, choice.collection);
  }
  return out;
}

/** Swap the provisional collections in the page plans for the persisted ones. */
function resolvePlanCollections(plans: PagePlan[], provisional: WfCmsResult, real: WfCmsResult): void {
  const realByWebflowId = new Map(real.collections.filter((c) => c.webflowId).map((c) => [c.webflowId!, c]));
  const realByIndex = new Map(provisional.collections.map((c, i) => [c, real.collections[i]]));
  const realByName = new Map(real.collections.map((c) => [c.name.trim().toLowerCase(), c]));

  for (const plan of plans) {
    if (plan.kind !== 'dynamic' || !plan.cms) continue;
    const provisionalMatch = provisional.collections.find((c) => c.name === plan.name);
    const resolved =
      (provisionalMatch?.webflowId ? realByWebflowId.get(provisionalMatch.webflowId) : undefined)
      ?? (provisionalMatch ? realByIndex.get(provisionalMatch) : undefined)
      ?? realByName.get(plan.name.trim().toLowerCase());
    if (!resolved) continue;
    plan.cms = { collectionId: resolved.id, slugFieldId: resolved.slugFieldId };
    plan.name = resolved.name;
    if (plan.folder) plan.folder = { ...plan.folder, name: resolved.name };
  }
}

// ─── Counting helpers ─────────────────────────────────────────────────────────

function countComponentInstances(layers: Layer[]): number {
  let n = 0;
  const walk = (list: Layer[]) => {
    for (const layer of list) {
      if (layer.componentId) n += 1;
      if (layer.children) walk(layer.children);
    }
  };
  walk(layers);
  return n;
}

/**
 * Webflow's own region markers. The navbar widget is recognised by its role
 * (`<div class="navbar w-nav">` — no `<nav>` tag anywhere), the footer and the
 * top header only by their class names: this export nests `.section-footer` at
 * four different depths and calls the header `.topheader`.
 */
const FOOTER_CLASS_RE = /(^|[-_])footer([-_]|$)/i;
const HEADER_CLASS_RE = /(^|[-_])(header|topheader|topbar)([-_]|$)/i;

function regionHintsOf(pages: WfPage[], layerByNode: Map<string, Layer>): Map<string, RegionHint> {
  const hints = new Map<string, RegionHint>();
  for (const page of pages) {
    for (const node of page.nodeIndex.values()) {
      const layer = layerByNode.get(node.wf.id);
      if (!layer) continue;
      let hint: RegionHint | undefined;
      // Only the Webflow navbar widget — a bare `<nav>` is how Webflow renders a
      // collection list, which must never become a component.
      if (node.wf.role === 'nav') hint = 'nav';
      else if (node.wf.tag === 'footer' || node.wf.siteClasses.some((c) => FOOTER_CLASS_RE.test(c))) hint = 'footer';
      else if (node.wf.tag === 'header' || node.wf.siteClasses.some((c) => HEADER_CLASS_RE.test(c))) hint = 'header';
      if (hint) hints.set(layer.id, hint);
    }
  }
  return hints;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export async function importWebflowZip(input: WfImportInput, hooks?: WfImportHooks): Promise<WfImportResult> {
  const started = Date.now();
  const options: WfImportOptions = { ...DEFAULT_IMPORT_OPTIONS, ...input.options };
  const warn = new Warnings();
  const errors: string[] = [];
  const progress = (step: string, done: number, total: number) => hooks?.onProgress?.(step, done, total);

  // 1. ZIP.
  progress('zip', 0, 1);
  const zip = await openWebflowZip(input.zip, { warn });

  // 2. CSV schema (no database yet).
  progress('csv', 0, 1);
  const csvCollections = parseCsvFiles(input.csvFiles);
  // The `csv_type_guess` warnings are held back when the Data API may replace a
  // CSV collection outright — they are re-reported below for the plans that
  // actually survive the merge.
  const usingApi = Boolean(options.webflowApi?.token?.trim());
  const csvPlans = inferSchema(csvCollections, usingApi ? undefined : warn);

  // 2b. Optional: the Webflow Data API as the CMS source (SPEC §4.8a). Runs
  // before anything is written, so a rejected token, a missing scope or a rate
  // limit aborts the import with the project untouched. Without credentials
  // nothing here executes and `cmsPlans` stays the CSV plan list.
  let cmsPlans = csvPlans;
  let cmsSource: WfCmsSource = 'csv';
  let webflowSiteId: string | undefined;
  if (usingApi && options.webflowApi) {
    progress('webflow-api', 0, 1);
    const pageHtml: string[] = [];
    for (const file of zip.pages.values()) pageHtml.push(await file.text());
    const api = await fetchCmsFromApi({ credentials: options.webflowApi, pageHtml, warn });
    const merged = mergeCmsPlans({ csvPlans, apiPlans: api.plans, pageNames: zip.pages.keys(), warn });
    cmsPlans = merged.plans;
    cmsSource = merged.source;
    webflowSiteId = api.siteId;
    reportGuessedFields(cmsPlans, warn);
    progress('webflow-api', 1, 1);
  }

  // 3. Assets referenced by the export's own CSS and HTML.
  progress('assets', 0, 1);
  const siteCss: string[] = [];
  const assetKeys = new Set<string>();
  for (const file of zip.css.site) {
    const css = await file.text();
    siteCss.push(css);
    collectCssAssetKeys(css, zip, assetKeys);
  }
  // Webflow's own sheets: only their tag defaults are translated (SPEC §4.5).
  const frameworkCss: string[] = [];
  for (const file of [zip.css.normalize, zip.css.components]) {
    if (file) frameworkCss.push(await file.text());
  }
  // Classes of the rich-text elements, so the style model reads `.rich-text-block p`
  // as a rich-text rule (textStyles) instead of residual CSS.
  const richTextClasses = new Set<string>();
  // Every element's class list, so a state rule inside a complex selector
  // (`.dropdown-list.w--open .link`) knows which elements it targets (states.ts).
  const classLists = new Set<string>();
  for (const file of zip.pages.values()) {
    const html = await file.text();
    collectHtmlAssetKeys(html, zip, assetKeys);
    collectLightboxAssetKeys(html, zip, assetKeys);
    collectRichTextClasses(html, richTextClasses);
    collectClassLists(html, classLists);
  }
  for (const file of zip.errorPages.values()) collectHtmlAssetKeys(await file.text(), zip, assetKeys);

  const folders = await getAllAssetFolders(false);
  const existingFolder = folders.find((f) => f.name === options.assetFolderName);
  const assetFolder = existingFolder ?? (await createAssetFolder({ name: options.assetFolderName }));

  const mat = await ServerMaterializer.create({
    group: 'Webflow',
    files: async (key: string) => {
      const file = zip.files.get(key);
      if (!file) return null;
      const buffer = await file.data();
      const filename = key.split('/').pop() || key;
      return { buffer, filename, mime: guessMimeType(filename) };
    },
    remote: { enabled: options.remoteAssets === 'download', budget: new ByteBudget(REMOTE_BUDGET_BYTES) },
    assetFolderId: assetFolder?.id ?? null,
    source: options.source,
    warn,
  });

  const keys = [...assetKeys];
  let uploaded = 0;
  await mat.prepareAssets(keys, () => progress('assets', ++uploaded, keys.length));
  const assets = { idOf: (key: string) => mat.assetId(key), urlOf: (key: string) => mat.assetUrl(key) };

  // 4. Style model.
  progress('css', 0, 1);
  const model = buildStyleModel({
    siteCss,
    frameworkCss,
    richTextClasses,
    classLists,
    assetUrl: (relativeUrl: string) => {
      const key = toZipKey(relativeUrl);
      return key ? mat.assetUrl(key) : null;
    },
    warn,
  });

  // 5. Pages + IX2.
  progress('html', 0, zip.pages.size);
  const svgFiles = await loadSvgIcons(zip);
  const pageNames = new Set([...zip.pages.keys()]);
  const pages: WfPage[] = [];
  let parsed = 0;
  for (const [name, file] of zip.pages) {
    pages.push(parsePage(await file.text(), {
      page: name,
      styles: model,
      zip,
      pageNames,
      assetKey: (relPath: string) => (zip.files.has(relPath) ? relPath : null),
      warn,
      svgFiles,
      widgets: options.widgets,
    }));
    progress('html', ++parsed, zip.pages.size);
  }

  let ix2: Ix2Data | null = null;
  for (const file of zip.js) {
    if (ix2) break;
    try {
      ix2 = parseIx2FromJs(await file.text());
    } catch {
      // not an IX2 bundle
    }
  }

  // 5b. Optional: the published site as a source (SPEC B). Runs after the
  // pages are parsed because the crawl needs the export's page list and the
  // detail folders, and before the plan because it may add rows, fill cells
  // and build whole collections. Never fatal: every problem is a `site_*`
  // warning and the import continues with what the export has.
  let siteMerge: SiteCmsMerge | null = null;
  let siteCounts: WfSiteContribution | undefined;
  if (options.websiteUrl?.trim()) {
    progress('site', 0, 1);
    const before = provisionalCms(cmsPlans);
    const detailOwners = detailCollectionsOf(pages, before);
    const detailPages = new Map<string, { folder: string; planIndex: number }>();
    for (const page of pages) {
      const folder = detailFolderOf(page.name);
      if (!folder) continue;
      const owner = detailOwners.get(page.name);
      detailPages.set(page.name, { folder, planIndex: owner ? before.collections.indexOf(owner) : -1 });
    }
    const hints: SiteCollectionHint[] = cmsPlans.map((plan, i) => ({
      name: plan.csv.name,
      folder: [...detailPages.values()].find((d) => d.planIndex === i)?.folder ?? null,
      slugs: plan.csv.rows.map((r) => (r['Slug'] ?? '').trim()).filter(Boolean),
    }));
    for (const { folder } of detailPages.values()) {
      if (!hints.some((h) => h.folder === folder)) hints.push({ name: folder, folder, slugs: [] });
    }
    // Safety net for the never-fatal rule: the crawler and the merge guard
    // themselves, but whatever still escapes (a parser or merge defect on an
    // unforeseen page) must not turn into an HTTP 500 for the whole import.
    try {
      const site = await crawlSite({
        baseUrl: options.websiteUrl,
        pagePaths: [...zip.pages.keys()].filter((name) => !detailFolderOf(name)).map(pagePathOf),
        collections: hints,
        warn,
      });
      const merged = mergeSitePlans({ plans: cmsPlans, site, pages, detailPages, warn });
      siteMerge = merged;
      cmsPlans = merged.plans;
      if (merged.siteOnly && cmsPlans.length > 0) cmsSource = 'site';
      siteCounts = {
        pages: site.stats.fetched,
        failed: site.stats.failed + site.stats.skipped,
        valuesFilled: merged.stats.valuesFilled,
        itemsAdded: merged.stats.itemsAdded,
        collectionsBuilt: merged.stats.collectionsBuilt,
        slotsBound: 0,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warn.add('site_unreachable', `website ${options.websiteUrl.trim()} could not be used (${reason}); the import continues with the export alone`);
      siteMerge = null;
      siteCounts = undefined;
    }
    progress('site', 1, 1);
  }

  // 6. Page plan + slug conflicts — the last step that can fail cleanly.
  progress('plan', 0, 1);
  const provisional = provisionalCms(cmsPlans);
  const plans = planPages(pages, detailCollectionsOf(pages, provisional), warn, assets);
  await assertNoSlugConflicts(plans, options.pageSlugConflict, warn);

  // 7. CMS. (First database writes.)
  progress('cms', 0, 1);
  const cms = await importCms(cmsPlans, {
    mat,
    remoteAssets: options.remoteAssets,
    warn,
    onProgress: (done, total) => progress('cms', done, total),
    ...(siteMerge && siteMerge.alternateUrls.size > 0 ? { alternateUrls: siteMerge.alternateUrls } : {}),
  });
  resolvePlanCollections(plans, provisional, cms);
  // The live collection pages' <title> / description per item, now that the field ids exist.
  if (siteMerge && siteMerge.seo.size > 0) applySiteSeo(plans, cms, siteMerge, warn);

  // 8. Page rows.
  progress('pages', 0, plans.length);
  const { pageIds, folderIds } = await createPageRows(plans);
  const dynamicPageByCollection = new Map<string, { pageId: string; folderId: string; slug: string }>();
  for (const plan of plans) {
    if (plan.kind !== 'dynamic' || !plan.cms || !plan.folder) continue;
    const pageId = pageIds.get(plan.page.name);
    const folderId = folderIds.get(plan.folder.slug);
    if (pageId && folderId) dynamicPageByCollection.set(plan.cms.collectionId, { pageId, folderId, slug: plan.folder.slug });
  }

  // 9. CMS binding: live-site evidence first (deterministic), structure for the rest.
  progress('binding', 0, 1);
  const oracle = siteMerge ? createSiteOracle(siteMerge, cms, pages) : undefined;
  bindPages({ cms, pages, dynamicPageByCollection, warn, oracle });
  if (siteCounts && oracle) siteCounts.slotsBound = oracle.hits;

  // 10. Layers.
  progress('layers', 0, pages.length);
  const converter = new ImportConverter(mat as unknown as ImportMaterializer);
  const allRoots: WfNode[] = pages.flatMap((p) => p.roots);
  await mat.prepareStyles(converter.collectStyleRefs(allRoots));

  const styleClasses = mat.styleClassesById();
  const layerByNode = new Map<string, Layer>();
  const rootsByPage = new Map<string, Layer[]>();
  let converted = 0;
  for (const page of pages) {
    const result = await convertPage(page, converter);
    for (const [nodeId, layer] of result.layerByNode) layerByNode.set(nodeId, layer);
    applyNodeLayerPostProcessing(page, result.layerByNode, assets, warn, options.widgets);
    resolveShadowedChipClasses(result.roots, (id) => styleClasses.get(id));
    pinBackgroundBindingClasses(result.roots, (id) => styleClasses.get(id));
    // Re-points the item's node at its new child layer (interactions, regions).
    if (liftSelfBoundBackgrounds(result.roots, result.layerByNode) > 0) {
      for (const [nodeId, layer] of result.layerByNode) layerByNode.set(nodeId, layer);
    }
    rootsByPage.set(page.name, result.roots);
    progress('layers', ++converted, pages.length);
  }

  // 11. Interactions.
  progress('interactions', 0, 1);
  const mapped = ix2 ? mapInteractions({ data: ix2, pages, layerByNode, warn }) : { items: [], definitions: 0, instances: 0 };
  let generated = 0;
  for (const page of pages) generated += generateWidgetInteractions(page, layerByNode, warn).generated;

  // 12. Components: cross-page regions first, then repeated siblings per page.
  progress('components', 0, 1);
  const pageLayers: PageLayers[] = pages.map((page) => ({
    page: page.name,
    body: { id: 'body', name: 'body', classes: bodyClassesFor(page.bodyClassNames, model), children: rootsByPage.get(page.name) ?? [] },
  }));
  const regionHints = regionHintsOf(pages, layerByNode);
  // Slider slides are structurally identical BY DESIGN, so both component passes
  // would fold them into one master with per-slide text overrides — which takes
  // the slide's own classes, its `restrictions.ancestor` and the ability to lay
  // out slide 2 differently from slide 1. They are detached for the duration and
  // componentized on their own afterwards, so a repeated card INSIDE one slide
  // still becomes a component while two slides never merge.
  const detachedSlides = pageLayers.flatMap((entry) => detachSlides(entry.body.children ?? []));
  const siteClasses = siteClassIndex(pages, layerByNode);
  await extractCrossPageComponents(pageLayers, mat, warn, { hintOf: (id) => regionHints.get(id), classesOf: (id) => siteClasses.get(id), variants: options.widgets?.navbarVariants !== false });
  for (const entry of pageLayers) {
    entry.body.children = await componentizeKeepingMedia(entry.body.children ?? [], mat);
  }
  for (const slot of detachedSlides) {
    for (const slide of slot.slides) {
      slide.children = await componentizeKeepingMedia(slide.children ?? [], mat);
    }
    slot.parent.children = slot.slides;
  }

  // 13. Persist layers, fonts and site settings.
  progress('save', 0, pageLayers.length);
  let saved = 0;
  for (const entry of pageLayers) {
    const pageId = pageIds.get(entry.page);
    if (!pageId) continue;
    await savePageLayers(pageId, typeof entry.body.classes === 'string' ? entry.body.classes : (entry.body.classes ?? []).join(' '), entry.body.children ?? []);
    progress('save', ++saved, pageLayers.length);
  }

  const fonts = await installFonts(model, pages, zip, mat, warn);

  const indexPage = pages.find((p) => p.name === 'index');
  const favicon = indexPage?.favicon ? assets.idOf(indexPage.favicon) : null;
  const webclip = indexPage?.webclip ? assets.idOf(indexPage.webclip) : null;
  const residualCss = [model.residualCss, fonts.residualFaces].filter((s) => s && s.trim()).join('\n');
  // Dates render in `settings.timezone`: the zone the live site renders in
  // when the crawl saw one, else the zone Webflow's year-only dates imply.
  const timeZone = siteMerge?.timeZone ? { zone: siteMerge.timeZone, reason: siteMerge.timeZoneReason ?? 'live site' } : inferTimeZoneFromDates(cmsPlans);
  const settingsSaved = await saveSiteSettings({
    siteName: indexPage?.title ? indexPage.title.split(/\s+[–|]\s+/)[0].trim() : undefined,
    faviconAssetId: favicon ?? undefined,
    webClipAssetId: webclip ?? undefined,
    residualCss,
    timezone: timeZone?.zone,
  });
  if (timeZone) {
    warn.add('timezone_set', settingsSaved.timezoneSet ? `site time zone set to ${timeZone.zone}: ${timeZone.reason}; CMS dates render as on the Webflow site` : `site time zone kept as configured; the CMS dates suggest ${timeZone.zone} (${timeZone.reason})`);
  }

  // 14. CSS generation (publish throws on an empty `draft_css` — G4).
  progress('css-generate', 0, 1);
  try {
    await generateCSSForPages([...pageIds.values()]);
    await generateAndSaveDraftCSS();
  } catch (error) {
    errors.push(`CSS generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await clearAllCache();
  } catch {
    // cache purge is best-effort
  }

  // 15. Counts.
  const comboKeys = new Set([...model.combos.values()].map((ref) => ref.key));
  let comboStyles = 0;
  for (const key of mat.createdStyleKeys) {
    const base = key.includes('|') ? key.slice(key.indexOf('|') + 1) : key;
    if (comboKeys.has(base)) comboStyles += 1;
  }

  const counts: WfImportCounts = {
    pages: plans.length,
    folders: folderIds.size,
    dynamicPages: plans.filter((p) => p.kind === 'dynamic').length,
    collections: cms.counts.collections,
    fields: cms.counts.fields,
    items: cms.counts.items,
    itemsPublishable: cms.counts.itemsPublishable,
    assets: {
      images: mat.assetCounts.images,
      videos: mat.assetCounts.videos,
      documents: mat.assetCounts.documents,
      fontFiles: mat.assetCounts.fontFiles,
      cmsImages: cms.counts.cmsImages,
      failed: mat.assetCounts.failed,
      skipped: mat.assetCounts.skipped + cms.counts.skipped,
    },
    styles: mat.counts.styles,
    comboStyles,
    components: mat.counts.components,
    componentInstances: pageLayers.reduce((n, e) => n + countComponentInstances(e.body.children ?? []), 0),
    interactions: { mappedDefinitions: mapped.definitions, mappedInstances: mapped.instances, generated },
    fonts: fonts.fonts,
    residualCss: { rules: model.residual.rules.length, bytes: Buffer.byteLength(residualCss, 'utf8') },
    warnings: warn.list.reduce((n, w) => n + (w.count ?? 1), 0),
  };

  return {
    ok: errors.length === 0,
    counts,
    warnings: warn.list,
    warningSummary: warn.summary(),
    errors,
    pageIds: Object.fromEntries(pageIds),
    collectionIds: Object.fromEntries(cms.collections.map((c) => [c.name, c.id])),
    cmsSource,
    ...(webflowSiteId ? { webflowSiteId } : {}),
    ...(siteCounts ? { site: siteCounts } : {}),
    durationMs: Date.now() - started,
  };
}

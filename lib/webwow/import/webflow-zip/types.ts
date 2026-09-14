/**
 * Webflow ZIP importer v2 — shared data shapes.
 *
 * Every module of `lib/webwow/import/webflow-zip/**` imports its types from
 * here. The IR extension (`WfNode` / `WfNodeMeta`) rides on upstream's neutral
 * import IR (`ImportNode`) so the upstream `ImportConverter` can turn the tree
 * into layers unchanged; the `wf` side-car carries everything the Webflow
 * specific passes (binding, IX2, widgets, convert-bridge) need.
 *
 * Only type imports from upstream: nothing here loads Zustand or React.
 */

import type { CollectionFieldType, Font, SliderSettings } from '@/types';
import type { ImportNode } from '@/lib/import/types';
import type { WfCmsSource, WfDataApiCredentials } from './data-api';
import type { FormControlPlan, WfWidgetFlags } from './widgets-native';

// ─── Options / result ─────────────────────────────────────────────────────────

export type WfRemoteAssets = 'download' | 'skip';

export interface WfImportOptions {
  /** Download CMS assets from Webflow's CDN (`download`, default) or leave the values empty (`skip`). */
  remoteAssets: WfRemoteAssets;
  /** What to do when a page slug already exists: fail fast (default) or append `-2`, `-3`, … */
  pageSlugConflict: 'fail' | 'suffix';
  /** Asset folder that receives every uploaded file. Default `Webflow import`. */
  assetFolderName: string;
  /** `assets.source` for uploaded files. Default `webflow-import`. */
  source: string;
  /**
   * Per-widget kill switches for the native widget builders
   * (`widgets-native.ts`). Unset flags default to on; a widget turned off here
   * takes the generic-box path and reports `html_unmapped` as before.
   */
  widgets?: Partial<WfWidgetFlags>;
  /**
   * Optional Webflow Data API credentials. When set, collection items come from
   * the REST v2 API as typed JSON instead of the CSV export (`data-api.ts`);
   * the site id is discovered from the export's `data-wf-site` when omitted.
   * The token is request-scoped — it is never persisted, logged or returned.
   * Unset (the default) means the CSV path runs exactly as before.
   */
  webflowApi?: WfDataApiCredentials;
}

export const DEFAULT_IMPORT_OPTIONS: WfImportOptions = {
  remoteAssets: 'download',
  pageSlugConflict: 'fail',
  assetFolderName: 'Webflow import',
  source: 'webflow-import',
};

export type WfWarningCode =
  | 'zip_entry_skipped' | 'asset_download_failed' | 'asset_skipped' | 'asset_missing'
  | 'css_residual' | 'css_dropped' | 'css_neutralised'
  | 'html_unmapped' | 'embed_script' | 'embed_dropped' | 'video_missing_file' | 'link_broken' | 'page_empty'
  | 'collection_guess' | 'field_guess' | 'binding_guess' | 'binding_unbound' | 'reference_unresolved' | 'csv_type_guess'
  | 'ix2_unsupported_event' | 'ix2_unsupported_action' | 'ix2_no_targets' | 'ix2_ease_approximated'
  | 'component_skipped' | 'font_extra_weight' | 'slug_suffixed'
  | 'widget_partial' | 'widget_skipped'
  | 'cms_api_extra' | 'cms_api_partial';

export interface WfWarning {
  code: WfWarningCode;
  message: string;
  page?: string;
  node?: string;
  /** Number of identical occurrences (identical code + message + page merge into one entry). */
  count?: number;
}

export interface WfImportCounts {
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

export interface WfImportResult {
  ok: boolean;
  counts: WfImportCounts;
  warnings: WfWarning[];
  warningSummary: Partial<Record<WfWarningCode, number>>;
  errors: string[];
  /** page basename -> page id */
  pageIds: Record<string, string>;
  /** CSV collection name -> collection id */
  collectionIds: Record<string, string>;
  /** Where collection items came from: the CSV export, the Data API, or both. */
  cmsSource: WfCmsSource;
  /** Webflow site id the Data API was read from (absent when no token was supplied). */
  webflowSiteId?: string;
  durationMs: number;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * A fatal, user-facing import error. `code` is a stable machine-readable key
 * (`zip_too_large`, `zip_entry_too_large`, `zip_ratio`, `zip_entries`,
 * `slug_conflict`, …); the route maps it to a 400 response.
 *
 * Defined here (not in index.ts) so the leaf modules (zip.ts, pages.ts) can throw
 * it without a circular import; index.ts re-exports it.
 */
export class WfImportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WfImportError';
  }
}

// ─── IR extension ─────────────────────────────────────────────────────────────

export type WfNodeRole =
  | 'dyn-list' | 'dyn-items' | 'dyn-item' | 'dyn-empty' | 'rich-text'
  | 'nav' | 'nav-menu' | 'nav-button' | 'nav-brand'
  | 'dropdown' | 'dropdown-toggle' | 'dropdown-list' | 'dropdown-icon'
  | 'grid' | 'cell' | 'bg-video' | 'embed-script' | 'iframe' | 'hr' | 'button'
  | 'slider' | 'slides' | 'slide'
  | 'lightbox'
  | 'form-wrapper' | 'form' | 'form-control' | 'form-alert'
  | 'tabs' | 'tab-menu' | 'tab-link' | 'tab-content' | 'tab-pane'
  | 'row' | 'col';

export type WfNavCollapse = 'all' | 'medium' | 'small' | 'tiny' | 'none';

export interface WfNodeMeta {
  /** `${page}#${n}` — unique per import run. */
  id: string;
  /** Page basename (`index`, `work`, …). */
  page: string;
  /** Lower-case html tag. */
  tag: string;
  /** ALL original classes incl. `w-*` and `w-dyn-bind-empty`, document order. */
  classNames: string[];
  /** `classNames` minus framework/state classes (`w-*`, `w--current`, `wf-layout-layout`) -> styling input. */
  siteClasses: string[];
  /** `id` attribute (`w-node-*` ids included). */
  htmlId?: string;
  /** The residual stylesheet still selects this id, so the layer must keep it. */
  keepHtmlId?: boolean;
  /** `data-w-id`. */
  wId?: string;
  /** Remaining attributes (`data-*`, `role`, `aria-*`), diagnostics only. */
  attrs: Record<string, string>;
  /** Had `w-dyn-bind-empty`. */
  bindEmpty: boolean;
  role?: WfNodeRole;
  /** Base class carries Webflow's bound-background placeholder (binding slot for a bg image). */
  boundBackground?: boolean;
  /** Inner HTML for rich-text / embed-script nodes. */
  html?: string;
  /** Background video wrapper data. */
  video?: { sources: string[]; poster?: string; autoplay: boolean; loop: boolean };
  /** On role `nav`. */
  navCollapse?: WfNavCollapse;
  /** On role `dropdown` (`data-hover="true"`). */
  dropdownHover?: boolean;
  /** Set by binding.ts. */
  binding?: WfBinding;
  /** Set by binding.ts on role `dyn-item`. */
  collection?: WfCollectionBinding;
  /** Native widget data (widgets-native.ts); set on role `slider`. */
  slider?: SliderSettings;
  /** Set on role `lightbox`: asset keys (ZIP path or https URL) + Webflow's gallery key. */
  lightbox?: { files: string[]; group: string };
  /** Set on role `form-control`: the ycode layer name plus the attributes the control needs to submit. */
  formControl?: FormControlPlan;
  /** Set on role `form-alert`. */
  formAlert?: 'success' | 'error';
  /** Set on role `form`: `settings.id`, which is what `form_id` is reported as on submission. */
  formId?: string;
  /** `data-w-tab` on roles `tab-link` / `tab-pane`; `active` mirrors `w--tab-active` / `w--current`. */
  tab?: { id: string; active: boolean };
  /** Post-conversion replacement (convert-bridge). */
  layerKind?:
    | 'htmlEmbed' | 'richText' | 'video' | 'iframe' | 'hr'
    | 'slider' | 'slides' | 'slide' | 'lightbox'
    | 'form' | 'formControl' | 'formAlert';
}

export interface WfNode extends ImportNode {
  wf: WfNodeMeta;
  children?: WfNode[];
}

export interface WfBinding {
  kind: 'text' | 'image' | 'background' | 'richText' | 'link' | 'multiAsset' | 'video';
  fieldId: string;
  fieldType: CollectionFieldType;
  fieldName: string;
  source: 'collection' | 'page';
  /** `wf.id` of the enclosing dyn-item node (source `collection`). */
  collectionNodeId?: string;
  /** e.g. `YYYY` for dates. */
  format?: string;
  /** `collectionItemId` is a keyword (`current-collection`, `current-page`) or a specific item UUID (href safety net). */
  link?: { pageId: string; collectionItemId: 'current-collection' | 'current-page' | string };
  confidence: number;
  reason: string;
}

export interface WfCollectionBinding {
  collectionId: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  filters?: { fieldId: string; fieldType: 'boolean'; value: 'true' }[];
  /** Nested image list. */
  multiAsset?: { fieldId: string; source: 'collection' | 'page'; parentCollectionNodeId?: string };
  confidence: number;
  reason: string;
}

export interface WfPage {
  /** Basename without `.html`. */
  name: string;
  /** `<html data-wf-page>`. */
  wfPageId?: string;
  title: string;
  description: string;
  ogImage?: string;
  canonical?: string;
  lang: string;
  bodyClassNames: string[];
  roots: WfNode[];
  nodeIndex: Map<string, WfNode>;
  /** `<style>` blocks from `.w-embed` and `<head>` (page-scoped residual). */
  headStyles: string[];
  /** Non-Webflow inline `<script>` / external script tags found in `<body>` (raw HTML). */
  bodyScripts: string[];
  /** Non-Webflow script tags found in `<head>` (raw HTML) — pages.ts appends them to `custom_code.head`. */
  headScripts?: string[];
  /** Google Fonts families requested by the page (`fonts.googleapis.com` links / `WebFont.load`). */
  googleFontFamilies?: string[];
  /** Relative paths inside the ZIP. */
  favicon?: string;
  webclip?: string;
  /** Body has no element children (detail_exhibitions). */
  isEmpty: boolean;
}

// ─── Materializer contract used by the leaf modules ───────────────────────────

/**
 * The subset of `ServerMaterializer` (SPEC §4.14) that `cms.ts` and `fonts.ts`
 * call. `ServerMaterializer` satisfies this structurally; the leaf modules code
 * against the interface so they can be unit-tested with a stub.
 */
export interface WfMaterializerLike {
  /** Upload an asset by key (ZIP path `images/x.jpg` or https URL). Promise-cached; null on failure / when remote downloads are disabled. */
  uploadAsset(key: string): Promise<string | null>;
  /** Public URL of an asset uploaded through `uploadAsset` / `prepareAssets` (null when unknown). */
  assetUrl(key: string): string | null;
  /** Store a raw file (extra font weights, CSS-referenced SVGs) as an asset with a public URL. */
  uploadRaw(zipPath: string, buffer: Buffer, mime: string): Promise<{ id: string; publicUrl: string } | null>;
  /** Install a Google font family (existing row reused). */
  installFont(family: string): Promise<Font | null>;
}

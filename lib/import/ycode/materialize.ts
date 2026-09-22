'use client';

/**
 * Cross-project paste materializer for the internal Ycode clipboard bundle.
 *
 * When a bundle is pasted into a DIFFERENT project than it was copied from, all
 * of its project-scoped references (layer styles, components, assets, fonts) are
 * foreign ids that don't exist in the target. This module recreates those
 * entities in the target project and rewrites every reference on the pasted
 * layers to the new ids — reusing the same `ImportMaterializer` primitives the
 * Webflow/Figma importer uses, so styles dedupe by content, images re-host, and
 * fonts install exactly as they do for a design-tool import.
 *
 * CMS bindings (collections, field-bound values) cannot travel — the data lives
 * in the source project's database — so they are stripped and the caller warns.
 */

import { cloneDeep } from 'lodash';
import type { Asset, Component, Layer } from '@/types';
import { ImportMaterializer } from '@/lib/import/materializer';
import { useFontsStore } from '@/stores/useFontsStore';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { useLayerStylesStore } from '@/stores/useLayerStylesStore';
import { useAssetsStore } from '@/stores/useAssetsStore';
import { useColorVariablesStore } from '@/stores/useColorVariablesStore';
import { usePagesStore } from '@/stores/usePagesStore';
import { useCollectionsStore } from '@/stores/useCollectionsStore';
import type {
  YcodeClipboardAsset,
  YcodeClipboardBundle,
  YcodeClipboardColorVariable,
} from '@/lib/import/ycode/bundle';
import { componentVariantLayers } from '@/lib/import/ycode/bundle';

/** Old id -> new id maps built while recreating entities in the target. */
interface RemapContext {
  styleIds: Map<string, string>;
  assetIds: Map<string, string>;
  componentIds: Map<string, string>;
  /** Old color-variable id -> new id (or a reused existing token's id). */
  colorVarIds: Map<string, string>;
  /** Incremented whenever a CMS binding is stripped, for the user-facing warning. */
  cmsStripped: number;
  /** Incremented whenever a page link is neutralized (target page doesn't exist). */
  pageLinksStripped: number;
}

export interface YcodeMaterializeResult {
  layers: Layer[];
  summary: {
    styles: number;
    assets: number;
    components: number;
    fonts: number;
    colorVariables: number;
  };
  cmsStripped: number;
  pageLinksStripped: number;
  /** Referenced font families that aren't on Google Fonts (text uses default). */
  unavailableFonts: string[];
}

/**
 * Same-project paste hydration.
 *
 * Two tabs of the same project share an origin, so a paste between them takes
 * the no-remap fast path — but an entity created in the OTHER tab (a component,
 * style, or asset) exists server-side yet isn't in THIS tab's in-memory store
 * until a refresh, so the pasted layer would reference an id this tab doesn't
 * know about. The bundle already carries those full definitions with the same
 * ids, so we inject any that are missing into the local stores (no DB writes —
 * a later refresh simply reloads the identical records).
 */
export function hydrateLocalDependencies(bundle: YcodeClipboardBundle): void {
  const componentsStore = useComponentsStore.getState();
  const missingComponents = bundle.components.filter((c) => !componentsStore.getComponentById(c.id));
  if (missingComponents.length > 0) {
    componentsStore.setComponents([...missingComponents, ...componentsStore.components]);
  }

  const stylesStore = useLayerStylesStore.getState();
  const missingStyles = bundle.styles.filter((s) => !stylesStore.getStyleById(s.id));
  if (missingStyles.length > 0) {
    useLayerStylesStore.setState((state) => ({ styles: [...missingStyles, ...state.styles] }));
  }

  const assetsStore = useAssetsStore.getState();
  for (const asset of bundle.assets) {
    if (!assetsStore.getAsset(asset.id)) assetsStore.addAsset(reconstructAsset(asset));
  }
}

/**
 * Reload the shared, project-scoped reference stores from the server: fonts and
 * color-variable tokens, plus collections (with fields/items) and the page list
 * that collection bindings and page links resolve against.
 *
 * Called on a same-project paste that originated in a DIFFERENT tab, where an
 * entity created there isn't loaded here yet. None of these stores hold unsaved
 * draft state — in particular `loadPages` replaces only the page metadata list
 * and leaves per-page layer drafts (`draftsByPageId`) untouched — so a reload is
 * safe and simply brings in anything new.
 */
export async function refreshSharedReferenceStores(): Promise<void> {
  // Best-effort: a failure to refresh one store must not abort the paste.
  await Promise.allSettled([
    useFontsStore.getState().loadFonts(),
    useColorVariablesStore.getState().loadColorVariables(),
    useCollectionsStore.getState().loadCollections(),
    usePagesStore.getState().loadPages(),
  ]);
}

/** Build a renderable `Asset` from the minimal clipboard payload. */
function reconstructAsset(asset: YcodeClipboardAsset): Asset {
  const now = new Date().toISOString();
  return {
    id: asset.id,
    filename: asset.filename,
    storage_path: null,
    public_url: asset.public_url,
    file_size: 0,
    mime_type: asset.mime_type,
    width: asset.width ?? null,
    height: asset.height ?? null,
    source: 'clipboard',
    asset_folder_id: null,
    content: asset.content ?? null,
    content_hash: null,
    is_published: true,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
}

/**
 * Recreate the bundle's dependencies in the current project and return the root
 * layers with every reference remapped (ids still need a final regeneration by
 * the caller before insertion).
 */
export async function materializeYcodeBundle(
  bundle: YcodeClipboardBundle,
): Promise<YcodeMaterializeResult> {
  const mat = new ImportMaterializer('Clipboard');
  const ctx: RemapContext = {
    styleIds: new Map(),
    assetIds: new Map(),
    componentIds: new Map(),
    colorVarIds: new Map(),
    cmsStripped: 0,
    pageLinksStripped: 0,
  };

  // 0. Color variables — create/reuse first so their new ids are known before
  //    styles and layers (which reference them as `var(--id)` in class strings)
  //    are rewritten.
  const colorVariablesCreated = await materializeColorVariables(bundle.colorVariables, ctx);

  // 1. Styles — rewrite color-var ids in the class string, then create or reuse
  //    (dedupe by name + content) and map old -> new.
  for (const style of bundle.styles) {
    const classes = rewriteColorVars(style.classes, ctx.colorVarIds).split(/\s+/).filter(Boolean);
    if (classes.length === 0) continue;
    const created = await mat.getOrCreateStyle({ key: style.id, name: style.name, classes });
    if (created) ctx.styleIds.set(style.id, created.id);
  }

  // 2. Assets — re-host remote images / recreate inline SVG icons, map old -> new.
  await Promise.all(
    bundle.assets.map(async (asset) => {
      let newId: string | null = null;
      if (asset.public_url) {
        newId = await mat.uploadAsset(asset.public_url);
      } else if (asset.content) {
        newId = await uploadInlineAsset(asset.content, asset.filename, asset.mime_type);
      }
      if (newId) ctx.assetIds.set(asset.id, newId);
    }),
  );

  // 3. Fonts — install referenced families so font-[...] classes resolve. Only
  //    Google fonts can be re-installed; custom uploads don't travel, so collect
  //    any family we couldn't resolve to warn the user (text falls back to the
  //    default font, matching the Figma/Webflow import behavior).
  let fontsInstalled = 0;
  const unavailableFonts: string[] = [];
  if (bundle.fonts.length > 0) {
    await useFontsStore.getState().loadGoogleFontsCatalog();
    const before = useFontsStore.getState().fonts?.length ?? 0;
    const results = await Promise.all(
      bundle.fonts.map(async (family) => ({ family, font: await mat.installFont(family) })),
    );
    fontsInstalled = Math.max(0, (useFontsStore.getState().fonts?.length ?? 0) - before);
    for (const { family, font } of results) {
      if (!font) unavailableFonts.push(family);
    }
  }

  // 4. Components — recreate in dependency order (a component referencing another
  //    bundled component is created only once that dependency is mapped). Variable
  //    ids are kept (they're component-scoped, so instance overrides stay valid).
  await materializeComponents(bundle.components, ctx, mat);

  // 5. Rewrite the root layers' references and strip CMS bindings.
  const layers = bundle.layers.map((layer) => transformLayer(cloneDeep(layer), ctx, true));

  return {
    layers,
    summary: {
      styles: ctx.styleIds.size,
      assets: ctx.assetIds.size,
      components: ctx.componentIds.size,
      fonts: fontsInstalled,
      colorVariables: colorVariablesCreated,
    },
    cmsStripped: ctx.cmsStripped,
    pageLinksStripped: ctx.pageLinksStripped,
    unavailableFonts,
  };
}

/**
 * Create (or reuse) the bundle's color-variable tokens in the target project,
 * mapping each source id to a target id. Reuse is by name + value so an
 * identical token already in the target isn't duplicated; a same-name token with
 * a different value is treated as distinct and created fresh. Returns the number
 * of tokens newly created (for the summary).
 */
async function materializeColorVariables(
  colorVariables: YcodeClipboardColorVariable[],
  ctx: RemapContext,
): Promise<number> {
  if (colorVariables.length === 0) return 0;

  const store = useColorVariablesStore.getState();
  const byContent = new Map<string, string>();
  for (const existing of store.colorVariables ?? []) {
    byContent.set(`${existing.name}\u0000${existing.value}`, existing.id);
  }

  let created = 0;
  for (const token of colorVariables) {
    const key = `${token.name}\u0000${token.value}`;
    const reuseId = byContent.get(key);
    if (reuseId) {
      ctx.colorVarIds.set(token.id, reuseId);
      continue;
    }
    const newVar = await useColorVariablesStore
      .getState()
      .createColorVariable(token.name, token.value);
    if (newVar) {
      ctx.colorVarIds.set(token.id, newVar.id);
      byContent.set(key, newVar.id);
      created += 1;
    }
  }
  return created;
}

/**
 * Rewrite `var(--<oldId>)` references (covers `color:var(--id)` too) in a class
 * string to the remapped target ids. No-op when nothing was remapped.
 */
function rewriteColorVars<T extends string | string[] | undefined>(
  classes: T,
  map: Map<string, string>,
): T {
  if (!classes || map.size === 0) return classes;
  const apply = (str: string): string => {
    let result = str;
    for (const [oldId, newId] of map) {
      if (oldId === newId) continue;
      result = result.split(`var(--${oldId})`).join(`var(--${newId})`);
    }
    return result;
  };
  return (Array.isArray(classes) ? classes.map(apply) : apply(classes)) as T;
}

/**
 * Create the bundle's components in dependency order. Components whose trees
 * reference other bundled components wait until those have been mapped, so the
 * nested `componentId` can be rewritten before creation. Cycles are impossible
 * (a component can't contain itself), so the queue always drains.
 */
async function materializeComponents(
  components: Component[],
  ctx: RemapContext,
  mat: ImportMaterializer,
): Promise<void> {
  const bundledIds = new Set(components.map((c) => c.id));
  const pending = [...components];
  let guard = pending.length * pending.length + 1;

  while (pending.length > 0 && guard-- > 0) {
    const index = pending.findIndex((component) =>
      referencedBundledComponentIds(component, bundledIds).every(
        (id) => id === component.id || ctx.componentIds.has(id),
      ),
    );
    // No fully-resolvable component left (shouldn't happen) — process the next
    // one anyway so we don't loop forever; any unmapped nested ref is cleared.
    const component = index >= 0 ? pending.splice(index, 1)[0] : pending.shift()!;
    await createRemappedComponent(component, ctx, mat);
  }
}

/** Bundled component ids referenced anywhere in a component's variant trees. */
function referencedBundledComponentIds(component: Component, bundledIds: Set<string>): string[] {
  const ids = new Set<string>();
  for (const tree of componentVariantLayers(component)) {
    walk(tree, (layer) => {
      if (layer.componentId && bundledIds.has(layer.componentId)) ids.add(layer.componentId);
    });
  }
  return [...ids];
}

async function createRemappedComponent(
  source: Component,
  ctx: RemapContext,
  mat: ImportMaterializer,
): Promise<void> {
  const name = uniqueComponentName(source.name);

  const variants = (source.variants && source.variants.length > 0
    ? source.variants
    : [{ id: source.variants?.[0]?.id ?? `cmpvar_${source.id}`, name: 'Default', layers: source.layers ?? [] }]
  ).map((variant) => ({
    ...variant,
    layers: (variant.layers ?? []).map((layer) => transformLayer(cloneDeep(layer), ctx, true)),
  }));

  const primaryLayers = variants[0]?.layers ?? [];

  // Remap asset references inside component variable default values too, and
  // neutralize any default page link (the target page is project-scoped).
  let variables = source.variables;
  if (variables && variables.length > 0) {
    variables = cloneDeep(variables);
    remapAssets(variables, ctx.assetIds);
    for (const variable of variables) {
      const dv = variable.default_value as { type?: string } | undefined;
      if (variable.type === 'link' && dv?.type === 'page') {
        variable.default_value = { type: 'url' };
        ctx.pageLinksStripped += 1;
      }
    }
  }

  const created = await createComponentViaApi(name, primaryLayers, variables, variants);
  if (created) ctx.componentIds.set(source.id, created.id);
}

/** Names already taken in the target plus those created during this paste. */
const claimedComponentNames = new Set<string>();

function uniqueComponentName(base: string): string {
  const existing = new Set(
    (useComponentsStore.getState().components ?? []).map((c) => c.name),
  );
  const wanted = base?.trim() || 'Component';
  let name = wanted;
  let i = 2;
  while (existing.has(name) || claimedComponentNames.has(name)) {
    name = `${wanted} ${i}`;
    i += 1;
  }
  claimedComponentNames.add(name);
  return name;
}

/** Create a component (with variants) and register it in the components store. */
async function createComponentViaApi(
  name: string,
  layers: Layer[],
  variables: Component['variables'],
  variants: Component['variants'],
): Promise<Component | null> {
  try {
    const response = await fetch('/ycode/api/components', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, layers, variables, variants }),
    });
    const result = await response.json();
    if (result.error || !result.data) return null;
    const component: Component = result.data;
    useComponentsStore.setState((state) => ({ components: [component, ...state.components] }));
    return component;
  } catch {
    return null;
  }
}

/** Upload an inline SVG (icon asset) as a file and return its new asset id. */
async function uploadInlineAsset(
  content: string,
  filename: string,
  mimeType: string,
): Promise<string | null> {
  try {
    const type = mimeType || 'image/svg+xml';
    const file = new File([content], filename || 'icon.svg', { type });
    const formData = new FormData();
    formData.append('file', file);
    formData.append('source', 'clipboard-import');
    const response = await fetch('/ycode/api/files/upload', { method: 'POST', body: formData });
    if (!response.ok) return null;
    const data = await response.json();
    const asset = data?.data;
    if (!asset?.id) return null;
    useAssetsStore.getState().addAsset(asset);
    return asset.id;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reference rewriting
// ---------------------------------------------------------------------------

function walk(layers: Layer[], visit: (layer: Layer) => void): void {
  for (const layer of layers) {
    visit(layer);
    if (layer.children && layer.children.length > 0) walk(layer.children, visit);
  }
}

/**
 * Rewrite a single layer's (and its descendants') foreign references to the
 * newly-created target ids, and optionally strip CMS bindings. Mutates and
 * returns the given (already-cloned) layer.
 */
function transformLayer(layer: Layer, ctx: RemapContext, stripCms: boolean): Layer {
  // Color-variable tokens are referenced by id inside class strings.
  if (ctx.colorVarIds.size > 0) {
    if (layer.classes) layer.classes = rewriteColorVars(layer.classes, ctx.colorVarIds);
    if (layer.styleOverrides?.classes) {
      layer.styleOverrides.classes = rewriteColorVars(layer.styleOverrides.classes, ctx.colorVarIds);
    }
    if (layer.styleOverridesByStyle) {
      for (const override of Object.values(layer.styleOverridesByStyle)) {
        if (override.classes) override.classes = rewriteColorVars(override.classes, ctx.colorVarIds);
      }
    }
    if (layer.textStyles) {
      for (const textStyle of Object.values(layer.textStyles)) {
        if (textStyle.classes) textStyle.classes = rewriteColorVars(textStyle.classes, ctx.colorVarIds);
        if (textStyle.styleOverrides?.classes) {
          textStyle.styleOverrides.classes = rewriteColorVars(textStyle.styleOverrides.classes, ctx.colorVarIds);
        }
      }
    }
  }

  // Style stack
  if (layer.styleIds && layer.styleIds.length > 0) {
    layer.styleIds = layer.styleIds.map((id) => ctx.styleIds.get(id)).filter(Boolean) as string[];
    if (layer.styleIds.length === 0) delete layer.styleIds;
  }
  if (layer.styleId) {
    const mapped = ctx.styleIds.get(layer.styleId);
    if (mapped) layer.styleId = mapped;
    else delete layer.styleId;
  }
  if (layer.styleOverridesByStyle) {
    const remapped: NonNullable<Layer['styleOverridesByStyle']> = {};
    for (const [oldId, value] of Object.entries(layer.styleOverridesByStyle)) {
      const mapped = ctx.styleIds.get(oldId);
      if (mapped) remapped[mapped] = value;
    }
    layer.styleOverridesByStyle = Object.keys(remapped).length > 0 ? remapped : undefined;
  }
  // Rich-text styles each carry their own LayerStyle reference.
  if (layer.textStyles) {
    for (const textStyle of Object.values(layer.textStyles)) {
      if (textStyle.styleId) {
        const mapped = ctx.styleIds.get(textStyle.styleId);
        if (mapped) textStyle.styleId = mapped;
        else delete textStyle.styleId;
      }
    }
  }

  // Component instance
  if (layer.componentId) {
    const mapped = ctx.componentIds.get(layer.componentId);
    if (mapped) layer.componentId = mapped;
    // If a referenced component couldn't be recreated, drop the instance link so
    // the layer renders as a plain container rather than a dangling reference.
    else delete layer.componentId;
  }

  // Asset references (deep, across variables / overrides / settings)
  if (layer.variables) remapAssets(layer.variables, ctx.assetIds);
  if (layer.componentOverrides) remapAssets(layer.componentOverrides, ctx.assetIds);
  if (layer.settings) remapAssets(layer.settings, ctx.assetIds);

  // CMS bindings and page links can't move between projects.
  if (stripCms && layer.variables) {
    ctx.cmsStripped += stripCmsBindings(layer);
    if (neutralizePageLink(layer.variables)) ctx.pageLinksStripped += 1;
  }

  if (layer.children && layer.children.length > 0) {
    layer.children = layer.children.map((child) => transformLayer(child, ctx, stripCms));
  }
  return layer;
}

/** Deep-replace asset ids in place across the two shapes assets appear in. */
function remapAssets(value: unknown, map: Map<string, string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) remapAssets(item, map);
    return;
  }
  const obj = value as Record<string, unknown>;

  if (obj.type === 'asset' && obj.data && typeof obj.data === 'object') {
    const data = obj.data as Record<string, unknown>;
    if (typeof data.asset_id === 'string') {
      const mapped = map.get(data.asset_id);
      data.asset_id = mapped ?? null;
    }
  }

  const asset = obj.asset as Record<string, unknown> | undefined;
  if (asset && typeof asset === 'object' && typeof asset.id === 'string') {
    const mapped = map.get(asset.id);
    asset.id = mapped ?? null;
  }

  for (const key of Object.keys(obj)) {
    if (key.startsWith('_')) continue;
    remapAssets(obj[key], map);
  }
}

/**
 * Remove CMS-bound data from a layer's variables (collections, conditional
 * visibility, field-bound media/text, CMS color bindings, field links). Returns
 * the number of bindings removed so the caller can surface a single warning.
 */
function stripCmsBindings(layer: Layer): number {
  const vars = layer.variables;
  if (!vars) return 0;
  let removed = 0;

  if (vars.collection) { delete vars.collection; removed += 1; }
  if (vars.conditionalVisibility) { delete vars.conditionalVisibility; removed += 1; }
  if (vars.design) { delete vars.design; removed += 1; }

  // Field-bound media/text srcs (type: 'field') can't resolve without the CMS.
  for (const key of ['text', 'icon', 'image', 'audio', 'video', 'backgroundImage'] as const) {
    const entry = vars[key] as unknown;
    if (isFieldBound(entry)) {
      delete (vars as Record<string, unknown>)[key];
      removed += 1;
    }
  }

  // Field-href links fall back to a no-op url link.
  if (vars.link && vars.link.type === 'field') {
    vars.link = { type: 'url' };
    removed += 1;
  }

  if (Object.keys(vars).length === 0) delete layer.variables;
  return removed;
}

/**
 * Neutralize a page link whose target page lives in the source project. Returns
 * true when a link was changed. Used for both layer variables and component
 * variable defaults. Asset links are left to {@link remapAssets}; field links to
 * {@link stripCmsBindings}.
 */
function neutralizePageLink(holder: { link?: { type?: string } } | undefined): boolean {
  if (holder?.link && holder.link.type === 'page') {
    holder.link = { type: 'url' };
    return true;
  }
  return false;
}

/** True when a variable entry (or one of its src fields) is a CMS field binding. */
function isFieldBound(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const obj = entry as Record<string, unknown>;
  if (obj.type === 'field') return true;
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && (value as Record<string, unknown>).type === 'field') {
      return true;
    }
  }
  return false;
}

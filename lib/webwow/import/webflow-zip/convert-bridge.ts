/**
 * Bridge between the Webflow IR (`WfNode`) and upstream's `ImportConverter`
 * (SPEC §4.15).
 *
 * `convertPage` runs the unmodified upstream converter over the page's nodes and
 * then recovers the node -> layer mapping: `html.ts` writes `"<friendly> <nodeId>"`
 * into `ImportNode.displayName`, every `convert*` method copies `displayName`
 * into `Layer.customName` (D12), so one walk of the produced layers rebuilds the
 * mapping and restores the friendly name — no second, drift-prone tree walk.
 *
 * `applyNodeLayerPostProcessing` then does everything the neutral converter
 * cannot express: the layer kinds Webflow has and the IR does not (html embeds,
 * rich text, background video, iframes, `<hr>`), anchor ids, and the CMS binding
 * shapes (findings-cms §4.1/§4.2/§5).
 */

import { convertValueForFieldType } from '@/lib/csv-utils';
import { buildDesign } from '@/lib/import/design';
import { mergeClassStack, splitVariant } from '@/lib/layer-style-resolve';
import { getAffectedProperties } from '@/lib/tailwind-class-mapper';
import { MULTI_ASSET_COLLECTION_ID } from '@/lib/collection-field-utils';
import { generateId } from '@/lib/utils';

import type { WfBinding, WfCollectionBinding, WfNode, WfPage } from './types';
import type { Warnings } from './warnings';

import type { ImportConverter } from '@/lib/import/convert';
import type { CollectionVariable, ConditionalVisibility, FieldVariable, Layer, LinkSettings } from '@/types';

/** Virtual image field of a multi-asset (`__multi_asset__`) collection layer. */
const ASSET_URL_FIELD = '__asset_url';

/** Classes a CMS-bound background box needs for `--bg-img` to render. */
const BACKGROUND_CLASSES = ['bg-cover', 'bg-center', 'bg-no-repeat', 'bg-[image:var(--bg-img)]'];

/** Background video element classes (the wrapper already carries `relative overflow-hidden`). */
const BG_VIDEO_CLASSES = 'absolute -inset-[100%] m-auto w-full h-full object-cover -z-[100]';

/** Resolves an asset key (ZIP path or URL) that `prepareAssets` already uploaded. */
export interface AssetIdResolver {
  idOf(key: string): string | null;
}

export interface ConvertPageResult {
  roots: Layer[];
  /** `wf.id` -> the layer the converter produced for that node. */
  layerByNode: Map<string, Layer>;
}

/** Depth-first walk over a layer tree (parents before children). */
export function walkLayers(layers: Layer[], visit: (layer: Layer, parent: Layer | null) => void, parent: Layer | null = null): void {
  for (const layer of layers) {
    visit(layer, parent);
    if (layer.children && layer.children.length > 0) walkLayers(layer.children, visit, layer);
  }
}

/**
 * Split the `customName` carrier back into the friendly name and the node id.
 * Returns null when the tail is not a node id of this page.
 */
export function splitCarrier(customName: string | undefined, has: (id: string) => boolean): { friendly: string; nodeId: string } | null {
  if (!customName) return null;
  const cut = customName.lastIndexOf(' ');
  if (cut <= 0) return null;
  const nodeId = customName.slice(cut + 1);
  if (!has(nodeId)) return null;
  return { friendly: customName.slice(0, cut), nodeId };
}

/** Run the upstream converter over one page and recover the node -> layer map. */
export async function convertPage(page: WfPage, converter: ImportConverter): Promise<ConvertPageResult> {
  const roots = await converter.convertNodes(page.roots);
  const layerByNode = new Map<string, Layer>();

  walkLayers(roots, (layer) => {
    const parsed = splitCarrier(layer.customName, (id) => page.nodeIndex.has(id));
    if (!parsed) return;
    layerByNode.set(parsed.nodeId, layer);
    if (parsed.friendly && parsed.friendly !== layer.name) layer.customName = parsed.friendly;
    else delete layer.customName;
  });

  return { roots, layerByNode };
}

// ─── Post-processing ──────────────────────────────────────────────────────────

/**
 * Apply every Webflow-specific fix-up the neutral converter cannot express.
 * Mutates the layers in `layerByNode` in place.
 */
/**
 * Second, narrower conflict pass over a layer's merged class list.
 *
 * Upstream's `mergeClassStack` asks `removeConflictingClasses` whether an
 * earlier class conflicts with a later one's property. For the shape Webflow
 * emits on every page header — a combined
 * `background-image: linear-gradient(…), url(…)` — that oracle disagrees with
 * `getAffectedProperties`: the latter reports `backgroundColor`, the former
 * treats the class as `backgroundImage`/`color`. So a combo class's background
 * never evicts its base class's background, both survive into `layer.classes`,
 * and the base wins by stylesheet order — `.topheader.artist` rendered the
 * `.topheader` photo.
 *
 * This pass drops an earlier class only when a later class with the SAME
 * variant prefix affects EXACTLY the same property set, i.e. the one case where
 * the later declaration must win and nothing else can be meant. `text-[24px]`
 * (fontSize) and `text-[#fff]` (color) have different sets and both survive.
 */
export function dropShadowedClasses(classes: string): string {
  const tokens = classes.split(/\s+/).filter(Boolean);
  const keyOf = (cls: string): string | null => {
    // `getAffectedProperties` only understands bare utilities, so ask it about
    // the base and keep the variant prefix as part of the key: a `max-lg:` value
    // must never evict the desktop one.
    const { prefix, base } = splitVariant(cls);
    // `[background-position:0_0,0%]` — an arbitrary *property* class. ycode's
    // mapper reports no property for these, so nothing ever evicts them and two
    // of them (a Webflow base class and its combo) both reach the stylesheet,
    // where alphabetical rule order decides the winner. The property name in the
    // class is the key.
    const arbitrary = /^\[([a-zA-Z-]+):/.exec(base);
    if (arbitrary) return `${prefix}|@${arbitrary[1].toLowerCase()}`;
    const props = getAffectedProperties(base);
    if (props.length === 0) return null;
    return `${prefix}|${[...props].sort().join(',')}`;
  };
  const lastIndexByKey = new Map<string, number>();
  tokens.forEach((cls, i) => {
    const key = keyOf(cls);
    if (key) lastIndexByKey.set(key, i);
  });
  return tokens
    .filter((cls, i) => {
      const key = keyOf(cls);
      return key === null || lastIndexByKey.get(key) === i;
    })
    .join(' ');
}

/**
 * Repair a layer whose style stack upstream's merge cannot flatten.
 *
 * Fixing `layer.classes` alone is not enough: publishing re-flattens every
 * layer from its style stack through `resolveLayerClasses` (see
 * `syncLayerStyleChangesToDrafts`), so the shadowed class comes straight back.
 * The only place that survives the round trip is a per-chip override —
 * `chipClasses` lets a layer replace what one style contributes to *its* stack.
 * So the shadowed class is removed from the chip that holds it, for this layer
 * only; the shared style row is untouched and every other layer keeps it.
 *
 * Only classes upstream's own merge would have kept are touched, so this never
 * second-guesses a conflict ycode already resolves.
 */
export function resolveShadowedChipClasses(roots: Layer[], classesOfStyle: (id: string) => string | undefined): number {
  const split = (value: string | string[] | undefined): string[] =>
    (typeof value === 'string' ? value : (value ?? []).join(' ')).split(/\s+/).filter(Boolean);
  let changed = 0;

  walkLayers(roots, (layer) => {
    const ids = layer.styleIds && layer.styleIds.length > 0 ? layer.styleIds : layer.styleId ? [layer.styleId] : [];
    if (ids.length < 2) return;

    const chips = ids.map((id) => ({ id, tokens: split(layer.styleOverridesByStyle?.[id]?.classes ?? classesOfStyle(id)) }));
    const trailing = split(layer.styleOverrides?.classes);
    const stack = [...chips.flatMap((c) => c.tokens), ...trailing];
    if (stack.length === 0) return;

    const survivors = new Set(split(dropShadowedClasses(stack.join(' '))));
    const dead = new Set(mergeClassStack(stack).filter((cls) => !survivors.has(cls)));
    if (dead.size === 0) return;

    let touched = false;
    for (const chip of chips) {
      if (!chip.tokens.some((t) => dead.has(t))) continue;
      chip.tokens = chip.tokens.filter((t) => !dead.has(t));
      const classes = chip.tokens.join(' ');
      layer.styleOverridesByStyle = {
        ...(layer.styleOverridesByStyle ?? {}),
        [chip.id]: { ...(layer.styleOverridesByStyle?.[chip.id] ?? {}), classes, design: buildDesign(classes) },
      };
      touched = true;
    }
    if (!touched) return;

    const resolved = mergeClassStack([...chips.flatMap((c) => c.tokens), ...trailing.filter((t) => !dead.has(t))]).join(' ').trim();
    layer.classes = resolved;
    const design = buildDesign(resolved);
    if (design) layer.design = design;
    else delete layer.design;
    changed += 1;
  });

  return changed;
}

/**
 * Pin the classes a CMS-bound background needs into the layer's TOP style chip.
 *
 * `applyBinding` merges `BACKGROUND_CLASSES` into `layer.classes`, but
 * `layer.classes` is a derived value: `resolveShadowedChipClasses` recomputes it
 * from the chip stack, and so does ycode itself on every re-flatten
 * (`syncLayerStyleChangesToDrafts` -> `resolveLayerClasses`). Anything written
 * only into `layer.classes` is therefore gone by the time the page is saved —
 * the renderer sets `--bg-img` from the binding but nothing consumes it, and the
 * card stays blank.
 *
 * A per-chip override is the one place that survives a re-flatten, so the four
 * classes go there, on this layer only; the shared style row is untouched.
 * Layers without a style chip keep them inline, where nothing recomputes them.
 *
 * Must run AFTER `resolveShadowedChipClasses`.
 */
export function pinBackgroundBindingClasses(roots: Layer[], classesOfStyle: (id: string) => string | undefined): number {
  const split = (value: string | string[] | undefined): string[] =>
    (typeof value === 'string' ? value : (value ?? []).join(' ')).split(/\s+/).filter(Boolean);
  let changed = 0;

  walkLayers(roots, (layer) => {
    if (!layer.variables?.backgroundImage) return;
    const ids = layer.styleIds && layer.styleIds.length > 0 ? layer.styleIds : layer.styleId ? [layer.styleId] : [];
    const top = ids[ids.length - 1];

    if (top) {
      const chipOf = (id: string) => split(layer.styleOverridesByStyle?.[id]?.classes ?? classesOfStyle(id));
      const pinned = mergeClassStack([...chipOf(top), ...BACKGROUND_CLASSES]).join(' ');
      layer.styleOverridesByStyle = {
        ...(layer.styleOverridesByStyle ?? {}),
        [top]: { ...(layer.styleOverridesByStyle?.[top] ?? {}), classes: pinned, design: buildDesign(pinned) },
      };
      const stack = ids.flatMap((id) => chipOf(id));
      layer.classes = mergeClassStack([...stack, ...split(layer.styleOverrides?.classes)]).join(' ').trim();
    } else {
      layer.classes = mergeClassStack([...split(layer.classes), ...BACKGROUND_CLASSES]).join(' ');
    }

    layer.design = {
      ...(buildDesign(layer.classes) ?? {}),
      backgrounds: { isActive: true, backgroundImage: '--bg-img', backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' },
    } as Layer['design'];
    changed += 1;
  });

  return changed;
}

export function applyNodeLayerPostProcessing(
  page: WfPage,
  layerByNode: Map<string, Layer>,
  assets: AssetIdResolver,
  warn?: Warnings,
): void {
  for (const node of page.nodeIndex.values()) {
    const layer = layerByNode.get(node.wf.id);
    if (!layer) continue;

    applyLayerKind(node, layer, assets, warn);
    applyAnchorId(node, layer);
    applyCollection(node, layer);
    applyBinding(node, layer, layerByNode);
  }
}

function applyLayerKind(node: WfNode, layer: Layer, assets: AssetIdResolver, warn?: Warnings): void {
  const wf = node.wf;
  switch (wf.layerKind) {
    case 'htmlEmbed':
      layer.name = 'htmlEmbed';
      layer.settings = { ...layer.settings, htmlEmbed: { code: wf.html ?? '' } };
      delete layer.children;
      break;

    case 'richText': {
      layer.name = 'richText';
      layer.restrictions = { ...layer.restrictions, editText: true };
      layer.variables = { ...layer.variables, text: { type: 'dynamic_rich_text', data: { content: richTextDoc(wf.bindEmpty ? '' : wf.html ?? '') } } };
      layer.children = [];
      break;
    }

    case 'video': {
      const video = wf.video;
      layer.children = layer.children ?? [];
      if (!video || video.sources.length === 0) break;
      const kept = video.sources.find((key) => assets.idOf(key));
      const assetId = kept ? assets.idOf(kept) : null;
      if (!kept || !assetId) break;
      // ycode's video layer stores exactly one file. Webflow ships an mp4 plus a
      // webm fallback, so every source after the first one is lost — say so
      // instead of dropping it silently.
      const dropped = video.sources.filter((key) => key !== kept && assets.idOf(key));
      if (dropped.length > 0) {
        warn?.add(
          'embed_dropped',
          `background video: only ${kept} is kept (ycode stores one file per video); alternative source(s) dropped: ${dropped.join(', ')}`,
          { page: wf.page, node: wf.id },
        );
      }
      const posterId = video.poster ? assets.idOf(video.poster) : null;
      const child: Layer = {
        id: generateId('lyr'),
        name: 'video',
        classes: BG_VIDEO_CLASSES,
        design: buildDesign(BG_VIDEO_CLASSES),
        attributes: { autoplay: video.autoplay, muted: true, loop: video.loop, controls: false, preload: 'metadata' },
        variables: {
          video: {
            src: { type: 'asset', data: { asset_id: assetId } },
            ...(posterId ? { poster: { type: 'asset' as const, data: { asset_id: posterId } } } : {}),
          },
        },
      };
      layer.children = [child];
      break;
    }

    case 'iframe': {
      layer.name = 'iframe';
      layer.variables = { ...layer.variables, iframe: { src: { type: 'dynamic_text', data: { content: wf.attrs.src ?? '' } } } };
      delete layer.children;
      break;
    }

    case 'hr':
      layer.name = 'hr';
      delete layer.children;
      break;

    default:
      break;
  }
}

/**
 * Webflow grid ids (`w-node-…`) are styling handles, not anchors — they are
 * dropped unless the residual stylesheet still selects them (`keepHtmlId`),
 * which is the only way a `tiny`-breakpoint Quick Stack rule can reach the
 * element at all.
 */
function applyAnchorId(node: WfNode, layer: Layer): void {
  const id = node.wf.htmlId;
  if (!id) return;
  if (id.startsWith('w-node-') && !node.wf.keepHtmlId) return;
  layer.settings = { ...layer.settings, id };
}

/** Minimal TipTap doc from a rich-text HTML fragment (empty doc for a blank slot). */
function richTextDoc(html: string): object {
  if (!html.trim()) return { type: 'doc', content: [{ type: 'paragraph' }] };
  try {
    const json = convertValueForFieldType(html, 'rich_text');
    if (json) {
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === 'object') return parsed as object;
    }
  } catch {
    // fall through to a plain-text doc
  }
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() }] }] };
}

// ─── CMS shapes ───────────────────────────────────────────────────────────────

function fieldVariable(binding: WfBinding, layerByNode: Map<string, Layer>, overrides?: { fieldId?: string; fieldType?: FieldVariable['data']['field_type']; collectionLayerId?: string }): FieldVariable {
  const data: FieldVariable['data'] = {
    field_id: overrides?.fieldId ?? binding.fieldId,
    field_type: overrides?.fieldType ?? binding.fieldType,
    relationships: [],
    source: binding.source,
  };
  const collectionLayerId = overrides?.collectionLayerId
    ?? (binding.source === 'collection' && binding.collectionNodeId ? layerByNode.get(binding.collectionNodeId)?.id : undefined);
  if (collectionLayerId) data.collection_layer_id = collectionLayerId;
  if (binding.format) data.format = binding.format;
  return { type: 'field', data };
}

function dynamicVariableDoc(variable: FieldVariable, label: string): object {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'dynamicVariable', attrs: { variable, label } }] }],
  };
}

/** `variables.collection` for a `.w-dyn-item` node (the collection list layer). */
function applyCollection(node: WfNode, layer: Layer): void {
  const binding = node.wf.collection;
  if (!binding) return;

  // A nested image list is a multi-asset pseudo-collection fed by a field of the
  // enclosing item (or of the dynamic page), not a real collection.
  if (binding.multiAsset) {
    const collection: CollectionVariable = {
      id: MULTI_ASSET_COLLECTION_ID,
      source_field_id: binding.multiAsset.fieldId,
      source_field_type: 'multi_asset',
      source_field_source: binding.multiAsset.source,
    };
    layer.variables = { ...layer.variables, collection };
    return;
  }

  const collection: CollectionVariable = { id: binding.collectionId, sort_by: binding.sortBy ?? 'manual' };
  if (binding.sortOrder) collection.sort_order = binding.sortOrder;
  if (binding.limit !== undefined) collection.limit = binding.limit;
  if (binding.filters && binding.filters.length > 0) collection.filters = filtersOf(binding);

  layer.variables = { ...layer.variables, collection };
}

function filtersOf(binding: WfCollectionBinding): ConditionalVisibility {
  return {
    groups: [
      {
        id: 'vc-g-1',
        conditions: (binding.filters ?? []).map((f, i) => ({
          id: `vc-${i + 1}`,
          source: 'collection_field' as const,
          fieldId: f.fieldId,
          fieldType: f.fieldType,
          operator: 'is' as const,
          value: f.value,
        })),
      },
    ],
  };
}

/** Field-level bindings (text, image, background, rich text, link, video). */
function applyBinding(node: WfNode, layer: Layer, layerByNode: Map<string, Layer>): void {
  const binding = node.wf.binding;
  if (!binding) return;

  switch (binding.kind) {
    case 'text':
    case 'richText': {
      const variable = fieldVariable(binding, layerByNode);
      if (layer.name !== 'heading' && layer.name !== 'text' && layer.name !== 'richText') {
        layer.name = binding.kind === 'richText' ? 'richText' : 'text';
      }
      layer.restrictions = { ...layer.restrictions, editText: true };
      layer.variables = { ...layer.variables, text: { type: 'dynamic_rich_text', data: { content: dynamicVariableDoc(variable, binding.fieldName) } } };
      layer.children = [];
      break;
    }

    case 'image': {
      const variable = fieldVariable(binding, layerByNode);
      layer.name = 'image';
      layer.variables = {
        ...layer.variables,
        image: { src: variable, alt: { type: 'dynamic_text', data: { content: '' } } },
      };
      delete layer.children;
      break;
    }

    case 'background': {
      const variable = fieldVariable(binding, layerByNode);
      const existing = typeof layer.classes === 'string' ? layer.classes.split(/\s+/).filter(Boolean) : (layer.classes ?? []);
      const merged = mergeClassStack([...existing, ...BACKGROUND_CLASSES]).join(' ');
      layer.classes = merged;
      layer.design = {
        ...(buildDesign(merged) ?? {}),
        backgrounds: { isActive: true, backgroundImage: '--bg-img', backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' },
      } as Layer['design'];
      layer.variables = { ...layer.variables, backgroundImage: { src: variable } };
      break;
    }

    case 'multiAsset': {
      // The nested list layer itself is the multi-asset collection; its image
      // child binds the virtual `__asset_url` field against this layer.
      const collection: CollectionVariable = {
        id: MULTI_ASSET_COLLECTION_ID,
        source_field_id: binding.fieldId,
        source_field_type: 'multi_asset',
        source_field_source: binding.source,
      };
      layer.variables = { ...layer.variables, collection };
      const image = firstImageDescendant(layer);
      if (image) {
        image.variables = {
          ...image.variables,
          image: {
            src: { type: 'field', data: { field_id: ASSET_URL_FIELD, field_type: 'image', relationships: [], source: 'collection', collection_layer_id: layer.id } },
            alt: { type: 'dynamic_text', data: { content: '' } },
          },
        };
      }
      break;
    }

    case 'video': {
      const variable = fieldVariable(binding, layerByNode);
      layer.name = 'video';
      layer.variables = { ...layer.variables, video: { src: variable } };
      break;
    }

    case 'link': {
      if (!binding.link) break;
      const link: LinkSettings = {
        type: 'page',
        page: { id: binding.link.pageId, collection_item_id: binding.link.collectionItemId },
      };
      layer.variables = { ...layer.variables, link };
      break;
    }

    default:
      break;
  }
}

function firstImageDescendant(layer: Layer): Layer | null {
  for (const child of layer.children ?? []) {
    if (child.name === 'image') return child;
    const found = firstImageDescendant(child);
    if (found) return found;
  }
  return null;
}

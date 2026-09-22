/**
 * Cross-page components (SPEC §4.12, D13).
 *
 * Upstream's `componentizeLayers` only recovers repeated *sibling* subtrees
 * inside one page and explicitly refuses page regions (`section`/`nav`/`footer`
 * /`header`/`main`/`aside`) and anything holding a collection
 * (lib/import/componentize.ts:44-79). A Webflow export's navbar and footer are
 * exactly those regions, repeated across pages rather than across siblings, so
 * they need their own pass — which runs BEFORE `componentizeLayers` so the page
 * bodies it sees already contain thin instances.
 *
 * Matching is structural: a signature that captures shape, styling and content
 * but ignores ids, custom names, interactions, attributes and Webflow's
 * `w--current` state class. Regions that differ only by an href or an extra
 * combo class stay inline and raise `component_skipped` — ycode has no
 * per-instance class overrides, so folding them in would silently restyle a page.
 */

import { cloneDeep } from 'lodash';

import { componentizeLayers } from '@/lib/import/componentize';
import type { ImportMaterializer } from '@/lib/import/materializer';
import { cleanLayersForComponentCreation } from '@/lib/layer-utils';
import { generateId } from '@/lib/utils';

import type { ServerMaterializer } from './server-materializer';
import type { Warnings } from './warnings';
import { variantNameFromClasses } from './widgets-extra';

import type { Component, ComponentVariable, ComponentVariableValue, ComponentVariant, Layer } from '@/types';

/** One page's root layer (`body.id === 'body'`; its children are the page). */
export interface PageLayers {
  page: string;
  body: Layer;
}

/**
 * What a layer *is* in Webflow terms. Webflow ships its navbar as
 * `<div class="navbar w-nav">` and its footer as `<div class="section-footer">`,
 * so neither carries an HTML tag we could key off; the caller derives the hint
 * from the Webflow node role and its site classes instead (SPEC §4.12).
 */
export type RegionHint = 'nav' | 'footer' | 'header';

export interface ExtractOptions {
  /** `layer.id` -> region hint. Hinted layers are candidates at ANY depth. */
  hintOf?: (layerId: string) => RegionHint | undefined;
  /** `layer.id` -> the Webflow site classes of its node (`['navbar', 'black']`); names the variants. */
  classesOf?: (layerId: string) => string[] | undefined;
  /** Same region with different classes on another page -> a variant of one component (default on). */
  variants?: boolean;
}

export interface CrossPageComponentResult {
  components: number;
  instances: number;
}

/** Smallest subtree worth a component (a lone box is noise). */
const MIN_NODES = 3;

/** Webflow's "current page" state class, namespaced by css.ts — never part of the shape. */
const STATE_CLASS = 'wf-w--current';

function classList(classes: Layer['classes']): string[] {
  const list = Array.isArray(classes) ? classes : (classes ?? '').split(/\s+/);
  return list.filter((c) => c && c !== STATE_CLASS).sort();
}

function tagOf(layer: Layer): string {
  return layer.settings?.tag ?? layer.name;
}

function textOf(layer: Layer): string {
  const variable = layer.variables?.text;
  if (!variable) return '';
  const data = (variable as { data?: { content?: unknown } }).data;
  const content = data?.content;
  if (typeof content === 'string') return content.trim();
  if (!content || typeof content !== 'object') return '';
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { text?: string; content?: unknown[] };
    if (typeof n.text === 'string') parts.push(n.text);
    if (Array.isArray(n.content)) for (const child of n.content) walk(child);
  };
  walk(content);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function mediaOf(layer: Layer): string {
  const src = layer.variables?.image?.src ?? layer.variables?.icon?.src ?? layer.variables?.video?.src ?? layer.variables?.audio?.src;
  if (!src) return '';
  const v = src as { type?: string; data?: Record<string, unknown> };
  // A background video's poster is part of what the region shows.
  const poster = layer.variables?.video?.poster as { data?: Record<string, unknown> } | undefined;
  return `${v.type ?? ''}:${JSON.stringify(v.data ?? {})}${poster ? `:${JSON.stringify(poster.data ?? {})}` : ''}`;
}

function linkOf(layer: Layer): string {
  const link = layer.variables?.link;
  return link ? JSON.stringify(link) : '';
}

function countNodes(layer: Layer): number {
  return 1 + (layer.children ?? []).reduce((sum, child) => sum + countNodes(child), 0);
}

function hasCollection(layer: Layer): boolean {
  if (layer.variables?.collection) return true;
  return (layer.children ?? []).some(hasCollection);
}

/**
 * Deterministic structural signature of a page region. Two regions with the same
 * signature render identically, so one can replace the other.
 */
export function regionSignature(layer: Layer): string {
  return JSON.stringify(signatureNode(layer, true));
}

/** Signature that ignores hrefs and classes — used to spot near-misses worth reporting. */
function looseSignature(layer: Layer): string {
  return JSON.stringify(signatureNode(layer, false));
}

function signatureNode(layer: Layer, strict: boolean): unknown[] {
  return [
    layer.name,
    layer.settings?.tag ?? '',
    strict ? (layer.styleIds && layer.styleIds.length > 0 ? layer.styleIds : classList(layer.classes)) : '',
    textOf(layer),
    mediaOf(layer),
    strict ? linkOf(layer) : '',
    (layer.children ?? []).map((child) => signatureNode(child, strict)),
  ];
}

interface Candidate {
  page: string;
  layer: Layer;
  hint?: RegionHint;
}

const TAG_HINTS: Record<string, RegionHint> = { nav: 'nav', footer: 'footer', header: 'header' };

/**
 * Specificity: a navbar sitting inside a `.topheader` wrapper must still be
 * found, because the wrapper carries a page-specific background while the
 * navbar inside it is identical everywhere. Ranks say which hint may still be
 * looked for below an enclosing one — a navbar is atomic, everything else is
 * descended into for a navbar.
 */
const HINT_RANK: Record<RegionHint, number> = { nav: 0, footer: 1, header: 2 };
const NO_HINT_RANK = 9;

/**
 * Candidate regions of one page:
 *  - every hinted region (navbar / footer / header) at any depth, outermost wins;
 *  - every body-level child, so repeated page bands are still found.
 *
 * Webflow nests the same footer at four different depths across this export
 * (body > div.section-footer on three pages, body > section > div.section-footer
 * on another, body > div.page-wrapper > … on the home page), which is why the
 * hinted walk is depth-independent.
 */
function candidatesOf(entry: PageLayers, hintOf: ExtractOptions['hintOf']): Candidate[] {
  const out: Candidate[] = [];
  const push = (layer: Layer, hint?: RegionHint) => {
    if (countNodes(layer) < MIN_NODES) return false;
    if (hasCollection(layer)) return false;
    out.push({ page: entry.page, layer, hint });
    return true;
  };
  const walk = (layer: Layer, depth: number, enclosing: number): void => {
    // A real `<nav>` / `<footer>` / `<header>` tag is its own hint; the caller's
    // map covers Webflow's tagless widgets.
    const hint = hintOf?.(layer.id) ?? TAG_HINTS[tagOf(layer)];
    let inner = enclosing;
    if (hint !== undefined && HINT_RANK[hint] < enclosing) {
      if (push(layer, hint)) inner = HINT_RANK[hint];
    } else if (depth === 1 && enclosing === NO_HINT_RANK) {
      push(layer);
    }
    if (inner === HINT_RANK.nav) return;
    for (const child of layer.children ?? []) walk(child, depth + 1, inner);
  };
  for (const child of entry.body.children ?? []) walk(child, 1, NO_HINT_RANK);
  return out;
}

/** Does the subtree already hold an instance of a component extracted earlier? */
function containsInstance(layer: Layer): boolean {
  return (layer.children ?? []).some((child) => child.componentId !== undefined || containsInstance(child));
}

/** Replace the layer with `id` anywhere under `body` with `replacement`. */
function replaceById(body: Layer, id: string, replacement: Layer): boolean {
  const children = body.children;
  if (!children) return false;
  for (let i = 0; i < children.length; i++) {
    if (children[i].id === id) {
      children[i] = replacement;
      return true;
    }
    if (replaceById(children[i], id, replacement)) return true;
  }
  return false;
}

function componentNameFor(candidate: Candidate, used: Set<string>, fallbackIndex: number): string {
  const role = candidate.hint ?? tagOf(candidate.layer);
  const base = role === 'nav' ? 'Navbar' : role === 'footer' ? 'Footer' : role === 'header' ? 'Header' : `Region ${fallbackIndex}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base} ${i}`)) i += 1;
  const name = `${base} ${i}`;
  used.add(name);
  return name;
}

/**
 * True when two regions with the same loose signature differ in nothing but
 * classes / style chips (anywhere in the tree): the case a component variant
 * exists for. Links, text, media and structure must match exactly.
 */
export function classesOnlyDiff(a: Layer, b: Layer): boolean {
  if (a.name !== b.name || tagOf(a) !== tagOf(b)) return false;
  if (textOf(a) !== textOf(b) || mediaOf(a) !== mediaOf(b) || linkOf(a) !== linkOf(b)) return false;
  const ca = a.children ?? [];
  const cb = b.children ?? [];
  if (ca.length !== cb.length) return false;
  return ca.every((child, i) => classesOnlyDiff(child, cb[i]));
}

/** Name of a variant from the first layer pair whose Webflow classes differ (`navbar black` -> `Black`). */
function variantName(primary: Layer, variant: Layer, classesOf: ExtractOptions['classesOf'], fallbackIndex: number): string {
  const fallback = `Variant ${fallbackIndex}`;
  if (!classesOf) return fallback;
  const pairs: [Layer, Layer][] = [];
  const collect = (a: Layer, b: Layer) => {
    pairs.push([a, b]);
    const ca = a.children ?? [];
    const cb = b.children ?? [];
    for (let i = 0; i < Math.min(ca.length, cb.length); i++) collect(ca[i], cb[i]);
  };
  collect(primary, variant);
  for (const [a, b] of pairs) {
    const name = variantNameFromClasses(classesOf(a.id), classesOf(b.id), fallbackIndex);
    if (name !== fallback) return name;
  }
  return fallback;
}

/** Human-readable summary of why two near-identical regions could not be merged. */
function diffSummary(a: Layer, b: Layer): string {
  const reasons: string[] = [];
  const linksA: string[] = [];
  const linksB: string[] = [];
  const classesA: string[] = [];
  const classesB: string[] = [];
  const collect = (layer: Layer, links: string[], classes: string[]) => {
    links.push(linkOf(layer));
    classes.push(classList(layer.classes).join(' '));
    for (const child of layer.children ?? []) collect(child, links, classes);
  };
  collect(a, linksA, classesA);
  collect(b, linksB, classesB);
  const linkDiffs = linksA.filter((l, i) => l !== linksB[i]).length;
  const classDiffs = classesA.filter((c, i) => c !== classesB[i]).length;
  if (linkDiffs > 0) reasons.push(`${linkDiffs} link target(s) differ`);
  if (classDiffs > 0) reasons.push(`${classDiffs} element(s) carry different classes`);
  if (reasons.length === 0) reasons.push('structures differ');
  return reasons.join(', ');
}

/**
 * Extract navbar / footer / repeated body regions that appear on two or more
 * pages into real components, replacing every occurrence with an instance layer.
 */
export async function extractCrossPageComponents(
  pages: PageLayers[],
  mat: ServerMaterializer,
  warn: Warnings,
  opts: ExtractOptions = {},
): Promise<CrossPageComponentResult> {
  const all: Candidate[] = [];
  for (const entry of pages) all.push(...candidatesOf(entry, opts.hintOf));
  if (all.length === 0) return { components: 0, instances: 0 };

  const looseGroups = new Map<string, Candidate[]>();
  const push = (groups: Map<string, Candidate[]>, key: string, candidate: Candidate) => {
    const list = groups.get(key);
    if (list) list.push(candidate);
    else groups.set(key, [candidate]);
  };
  for (const candidate of all) push(looseGroups, looseSignature(candidate.layer), candidate);

  const bodyByPage = new Map(pages.map((p) => [p.page, p.body]));
  const usedNames = new Set<string>();
  const merged = new Set<Layer>();
  let components = 0;
  let instances = 0;
  let regionIndex = 1;

  const variantsEnabled = opts.variants !== false;

  /** Replace every occurrence of a strict group with an instance of `componentId` (+ variant). */
  const instantiate = (group: Candidate[], componentId: string, componentVariantId?: string): void => {
    for (const occurrence of group) {
      const body = bodyByPage.get(occurrence.page);
      if (!body) continue;
      const instance: Layer = { id: occurrence.layer.id, name: 'div', classes: '', componentId, children: [] };
      if (componentVariantId) instance.componentVariantId = componentVariantId;
      if (replaceById(body, occurrence.layer.id, instance)) {
        instances += 1;
        merged.add(occurrence.layer);
      }
    }
  };

  const mergeGroups = async (candidates: Candidate[]): Promise<void> => {
    const groups = new Map<string, Candidate[]>();
    for (const candidate of candidates) push(groups, regionSignature(candidate.layer), candidate);
    const keys = [...groups.keys()].sort();
    const consumed = new Set<string>();

    // Variant families: strict groups that share a loose signature and differ
    // ONLY in classes (`navbar` vs `navbar black`) become one component with one
    // variant per look — the model ycode has for exactly this. Different links or
    // structure still keep a group apart (reported below as near-misses).
    if (variantsEnabled) {
      const families = new Map<string, string[]>();
      for (const key of keys) {
        const loose = looseSignature(groups.get(key)![0].layer);
        families.set(loose, [...(families.get(loose) ?? []), key]);
      }
      for (const familyKeys of families.values()) {
        if (familyKeys.length < 2) continue;
        const members = familyKeys.map((k) => groups.get(k)!).sort((a, b) => b.length - a.length);
        if (new Set(members.flat().map((c) => c.page)).size < 2) continue;
        const primary = members[0];
        if (!members.slice(1).every((m) => classesOnlyDiff(primary[0].layer, m[0].layer))) continue;

        const name = componentNameFor(primary[0], usedNames, regionIndex++);
        const variants: ComponentVariant[] = members.map((m, i) => ({
          id: generateId('cmpvar'),
          name: i === 0 ? 'Default' : variantName(primary[0].layer, m[0].layer, opts.classesOf, i + 1),
          layers: cleanLayersForComponentCreation([cloneDeep(m[0].layer)]),
        }));
        const component = await mat.createComponent(name, variants[0].layers, undefined, variants);
        for (const k of familyKeys) consumed.add(k);
        if (!component) {
          warn.add('component_skipped', `could not create the component for ${name}`);
          continue;
        }
        components += 1;
        members.forEach((m, i) => instantiate(m, component.id, variants[i].id));
      }
    }

    // Deterministic order: by signature.
    for (const key of keys) {
      if (consumed.has(key)) continue;
      const group = groups.get(key)!;
      if (new Set(group.map((c) => c.page)).size < 2) continue;

      const template = cleanLayersForComponentCreation([cloneDeep(group[0].layer)]);
      const name = componentNameFor(group[0], usedNames, regionIndex++);
      const component = await mat.createComponent(name, template);
      if (!component) {
        warn.add('component_skipped', `could not create the component for ${name}`);
        continue;
      }
      components += 1;
      instantiate(group, component.id);
    }
  };

  if (process.env.WF_DEBUG_COMPONENTS) {
    for (const c of all) {
      const sig = regionSignature(c.layer);
      let h = 0;
      for (let i = 0; i < sig.length; i++) h = (Math.imul(h, 31) + sig.charCodeAt(i)) | 0;
      console.log('[wfcand]', c.page, c.hint ?? '-', countNodes(c.layer), (h >>> 0).toString(16), String(c.layer.classes).slice(0, 50));
    }
  }
  // Pass 1 — Webflow's own regions at any depth, most specific first, so neither
  // a repeated page wrapper nor a page-specific `.topheader` can swallow the
  // navbar sitting inside it.
  await mergeGroups(all.filter((c) => c.hint === 'nav'));
  await mergeGroups(all.filter((c) => c.hint === 'footer' || c.hint === 'header'));

  // Pass 2 — everything else, re-collected from the now-rewritten bodies so the
  // signatures see the instances pass 1 left behind instead of stale subtrees.
  // A band that now holds an instance is page chrome around an already-extracted
  // region — componentising it as well would lock the whole page body away.
  const rest: Candidate[] = [];
  for (const entry of pages) {
    for (const c of candidatesOf(entry, opts.hintOf)) if (!c.hint && !containsInstance(c.layer)) rest.push(c);
  }
  await mergeGroups(rest);

  // Near-misses: same shape, different hrefs or combo classes. ycode has no
  // per-instance class overrides, so these stay inline — but say so.
  for (const group of looseGroups.values()) {
    if (group.length < 2) continue;
    const mergedMember = group.find((c) => merged.has(c.layer));
    if (!mergedMember) continue;
    for (const candidate of group) {
      if (merged.has(candidate.layer)) continue;
      warn.add(
        'component_skipped',
        `${candidate.hint ?? tagOf(candidate.layer)} on ${candidate.page} looks like the shared ${mergedMember.hint ?? 'region'} but ${diffSummary(mergedMember.layer, candidate.layer)}; kept inline`,
        { page: candidate.page },
      );
    }
  }

  return { components, instances };
}

// ─── Repeated siblings with media upstream does not compare ──────────────────

/** Media kinds upstream's `componentizeLayers` neither fingerprints nor turns into variables. */
type MediaKind = 'video' | 'audio' | 'icon';
const MEDIA_KINDS: MediaKind[] = ['video', 'audio', 'icon'];
/** Prefix of the stand-in asset id a media layer carries while upstream's pass runs. */
const MEDIA_TOKEN = 'wfmedia:';

interface StashedMedia {
  kind: MediaKind;
  /** The layer's own `variables[kind]` (the template keeps it, plus the variable id). */
  variable: NonNullable<Layer['variables']>[MediaKind];
  /** The component-variable value of this media (`VideoSettingsValue` & co.). */
  value: ComponentVariableValue;
}

type MarkerImage = { src?: { type?: string; id?: string; data?: { asset_id?: unknown } } };

function tokenOf(image: unknown): string | null {
  const id = (image as MarkerImage | undefined)?.src?.data?.asset_id;
  return typeof id === 'string' && id.startsWith(MEDIA_TOKEN) ? id : null;
}

/**
 * Upstream's `componentizeLayers` groups repeated siblings by shape and turns
 * the text, image and link leaves that differ into component variables, but it
 * never looks at a video, audio or icon source: two tiles of `/artist` with
 * different background videos became one component that plays the first video
 * in both. This runs upstream's pass with every such media layer standing in as
 * an image layer (an image upstream *does* compare, with a stand-in asset id
 * derived from the media and the video's poster, autoplay and loop), then turns
 * the stand-ins back: the component template's layer gets its media with the
 * variable id, the variable becomes a `video` / `audio` / `icon` variable whose
 * value ycode's `applyComponentOverrides` applies, and each instance's image
 * override becomes the matching media override. Identical media stays plain
 * template content, exactly as upstream treats identical images.
 */
export async function componentizeKeepingMedia(
  layers: Layer[],
  mat: Pick<ImportMaterializer, 'createComponent'>,
): Promise<Layer[]> {
  const stash = new Map<string, StashedMedia>();
  const tokenByKey = new Map<string, string>();

  const standIn = (layer: Layer): void => {
    const vars = layer.variables;
    if (vars && !vars.image) {
      const kind = MEDIA_KINDS.find((k) => vars[k]?.src);
      if (kind) {
        const variable = cloneDeep(vars[kind])!;
        const value = mediaValueOf(kind, layer);
        const key = JSON.stringify([kind, value]);
        let token = tokenByKey.get(key);
        if (!token) {
          token = `${MEDIA_TOKEN}${tokenByKey.size}`;
          tokenByKey.set(key, token);
          stash.set(token, { kind, variable, value });
        }
        const rest = { ...vars };
        delete rest[kind];
        layer.variables = {
          ...rest,
          image: { src: { type: 'asset', data: { asset_id: token } }, alt: { type: 'dynamic_text', data: { content: '' } } },
        };
      }
    }
    for (const child of layer.children ?? []) standIn(child);
  };

  const restore = (layer: Layer): void => {
    const token = tokenOf(layer.variables?.image);
    const entry = token ? stash.get(token) : undefined;
    if (entry && layer.variables) {
      const variableId = (layer.variables.image as MarkerImage).src?.id;
      const media = cloneDeep(entry.variable) as { src?: Record<string, unknown> };
      if (variableId && media.src) media.src = { ...media.src, id: variableId };
      const rest = { ...layer.variables };
      delete rest.image;
      layer.variables = { ...rest, [entry.kind]: media };
    }
    const overrides = layer.componentOverrides;
    if (overrides?.image) {
      for (const [variableId, value] of Object.entries(overrides.image)) {
        const t = tokenOf(value);
        const e = t ? stash.get(t) : undefined;
        if (!e) continue;
        overrides[e.kind] = { ...(overrides[e.kind] ?? {}), [variableId]: cloneDeep(e.value) };
        delete overrides.image[variableId];
      }
      if (Object.keys(overrides.image).length === 0) delete overrides.image;
    }
    for (const child of layer.children ?? []) restore(child);
  };

  const restoreVariables = (variables: ComponentVariable[] | undefined): ComponentVariable[] | undefined =>
    variables?.map((variable) => {
      const t = variable.type === 'image' ? tokenOf(variable.default_value) : null;
      const e = t ? stash.get(t) : undefined;
      if (!e) return variable;
      const name = variable.name.replace(/^Image\b/, e.kind.charAt(0).toUpperCase() + e.kind.slice(1));
      return { ...variable, name, type: e.kind, default_value: cloneDeep(e.value) };
    });

  for (const layer of layers) standIn(layer);
  if (stash.size === 0) return componentizeLayers(layers, mat as unknown as ImportMaterializer);

  // Upstream's pass only ever calls `createComponent`; the template is restored before it is stored.
  const wrapped: Pick<ImportMaterializer, 'createComponent'> = {
    createComponent: (name: string, componentLayers: Layer[], variables?: ComponentVariable[]): Promise<Component | null> => {
      for (const layer of componentLayers) restore(layer);
      return mat.createComponent(name, componentLayers, restoreVariables(variables));
    },
  };
  const out = await componentizeLayers(layers, wrapped as unknown as ImportMaterializer);
  for (const layer of out) restore(layer);
  return out;
}

/** What an instance override of the layer's media carries (`src` / `poster` / playback flags for a video). */
function mediaValueOf(kind: MediaKind, layer: Layer): ComponentVariableValue {
  const vars = layer.variables!;
  if (kind === 'video') {
    const attrs = (layer.attributes ?? {}) as Record<string, unknown>;
    const flags: Record<string, boolean> = {};
    for (const flag of ['autoplay', 'loop', 'muted', 'controls']) {
      if (typeof attrs[flag] === 'boolean') flags[flag] = attrs[flag] as boolean;
    }
    return cloneDeep({ src: vars.video!.src, ...(vars.video!.poster ? { poster: vars.video!.poster } : {}), ...flags }) as ComponentVariableValue;
  }
  return cloneDeep({ src: vars[kind]!.src }) as ComponentVariableValue;
}

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

import { cleanLayersForComponentCreation } from '@/lib/layer-utils';

import type { ServerMaterializer } from './server-materializer';
import type { Warnings } from './warnings';

import type { Layer } from '@/types';

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
  const src = layer.variables?.image?.src ?? layer.variables?.icon?.src ?? layer.variables?.video?.src;
  if (!src) return '';
  const v = src as { type?: string; data?: Record<string, unknown> };
  return `${v.type ?? ''}:${JSON.stringify(v.data ?? {})}`;
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

  const mergeGroups = async (candidates: Candidate[]): Promise<void> => {
    const groups = new Map<string, Candidate[]>();
    for (const candidate of candidates) push(groups, regionSignature(candidate.layer), candidate);
    // Deterministic order: by signature.
    for (const key of [...groups.keys()].sort()) {
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

      for (const occurrence of group) {
        const body = bodyByPage.get(occurrence.page);
        if (!body) continue;
        const instance: Layer = { id: occurrence.layer.id, name: 'div', classes: '', componentId: component.id, children: [] };
        if (replaceById(body, occurrence.layer.id, instance)) {
          instances += 1;
          merged.add(occurrence.layer);
        }
      }
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

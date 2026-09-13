/**
 * Structural CMS binding (DESIGN2 Addendum A, SPEC §4.9).
 *
 * The static export carries no CMS values: every bound leaf is an empty
 * `w-dyn-bind-empty` slot and every list holds one template item. Binding is
 * therefore decided from structure and names:
 *
 * 1. Collection per list / detail page — ObjectId timestamp proximity between
 *    the CSV collection id and the page's `data-wf-page` (detail pages), then
 *    template shape (rich-text slot, nested image list), name similarity with
 *    synonyms (`work` ~ `Werke`), and finally the largest collection.
 * 2. Field per slot — images to the main image field, headings / the first
 *    text inside a link to Name, rich text to the rich-text field, nested
 *    lists to the multi-image field (`__asset_url`), remaining text slots to
 *    the collection's text-like fields (class-name similarity first, then the
 *    best-filled columns in CSV order), `<a href="#">` to the item's page.
 *
 * Every decision is a `collection_guess` / `binding_guess` warning with its
 * confidence so the user can rebind in the builder; leftovers are
 * `binding_unbound`. The module only mutates `wf.binding` / `wf.collection`;
 * convert-bridge turns them into layer variables.
 */

import { MULTI_ASSET_COLLECTION_ID } from '@/lib/collection-field-utils';
import type { CollectionFieldType } from '@/types';
import type { WfCmsResult, WfCollectionInfo, WfCollectionInfoField } from './cms';
import type { WfBinding, WfNode, WfPage } from './types';
import type { Warnings } from './warnings';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface BindingDeps {
  cms: WfCmsResult;
  pages: WfPage[];
  /** collection id -> its dynamic page (links to items need it). */
  dynamicPageByCollection: Map<string, { pageId: string; folderId: string; slug: string }>;
  warn: Warnings;
}

export interface CollectionChoice {
  collection: WfCollectionInfo;
  confidence: number;
  reason: string;
}

export interface ListContext {
  page: WfPage;
  list?: WfNode;
  heading?: string;
  wrapperClasses?: string[];
}

export const NAME_SYNONYMS: Record<string, string[]> = {
  work: ['werke', 'works', 'arbeiten'],
  exhibitions: ['ausstellungen'],
  artist: ['kuenstler', 'artists'],
};

// ─── String similarity ────────────────────────────────────────────────────────

function normalise(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** `1 - levenshtein / max(len)` on normalised strings (lower-case, ascii-folded, non-alphanumerics removed). */
export function similarity(a: string, b: string): number {
  const x = normalise(a);
  const y = normalise(b);
  if (!x || !y) return 0;
  const max = Math.max(x.length, y.length);
  return 1 - levenshtein(x, y) / max;
}

function synonymsOf(s: string): string[] {
  const n = normalise(s);
  const out = new Set<string>([n]);
  for (const [key, list] of Object.entries(NAME_SYNONYMS)) {
    const group = [key, ...list].map(normalise);
    if (group.includes(n)) for (const g of group) out.add(g);
  }
  return [...out];
}

/** `similarity` with synonym expansion on both sides (`work` ~ `Werke` = 1). */
export function nameSimilarity(a: string, b: string): number {
  let best = 0;
  for (const x of synonymsOf(a)) for (const y of synonymsOf(b)) best = Math.max(best, similarity(x, y));
  return best;
}

/** Best similarity of a phrase (and each of its words) against a name. */
function phraseSimilarity(phrase: string, name: string): number {
  const words = phrase.split(/[\s_-]+/).filter((w) => w.length >= 3);
  return Math.max(nameSimilarity(phrase, name), ...words.map((w) => nameSimilarity(w, name)));
}

/** Unix seconds encoded in the first 8 hex chars of a Webflow ObjectId. */
export function objectIdSeconds(id: string | null | undefined): number | null {
  if (!id || !/^[0-9a-f]{24}$/i.test(id)) return null;
  return Number.parseInt(id.slice(0, 8), 16);
}

// ─── Tree helpers ─────────────────────────────────────────────────────────────

interface PageIndex {
  page: WfPage;
  nodes: WfNode[];
  parent: Map<string, WfNode>;
}

function indexPage(page: WfPage): PageIndex {
  const nodes: WfNode[] = [];
  const parent = new Map<string, WfNode>();
  const walk = (list: WfNode[], p?: WfNode) => {
    for (const n of list) {
      nodes.push(n);
      if (p) parent.set(n.wf.id, p);
      if (n.children) walk(n.children, n);
    }
  };
  walk(page.roots);
  return { page, nodes, parent };
}

function ancestors(node: WfNode, index: PageIndex): WfNode[] {
  const out: WfNode[] = [];
  let cur = index.parent.get(node.wf.id);
  while (cur) {
    out.push(cur);
    cur = index.parent.get(cur.wf.id);
  }
  return out;
}

/** Pre-order descendants; `stopAt` subtrees are skipped (their root is still visited when `includeStop`). */
function descendants(node: WfNode, stopAt?: (n: WfNode) => boolean, includeStop = false): WfNode[] {
  const out: WfNode[] = [];
  const walk = (list: WfNode[]) => {
    for (const n of list) {
      if (stopAt?.(n)) {
        if (includeStop) out.push(n);
        continue;
      }
      out.push(n);
      if (n.children) walk(n.children);
    }
  };
  walk(node.children ?? []);
  return out;
}

function firstDescendant(node: WfNode, pred: (n: WfNode) => boolean): WfNode | undefined {
  for (const child of node.children ?? []) {
    if (pred(child)) return child;
    const found = firstDescendant(child, pred);
    if (found) return found;
  }
  return undefined;
}

function describe(node: WfNode): string {
  return `${node.wf.tag}${node.wf.siteClasses.length ? `.${node.wf.siteClasses.join('.')}` : ''}`;
}

/** Site classes of the item and its first two descendants (template identity across pages). */
export function templateSignature(item: WfNode): string {
  const parts = [item, ...descendants(item).slice(0, 2)].map((n) => `${n.wf.tag}:${n.wf.siteClasses.join('.')}`);
  return parts.join('|');
}

function stripDigits(cls: string): string {
  return cls.replace(/[-_]?\d+$/g, '').replace(/[-_]+/g, ' ').trim();
}

// ─── Collection choice ────────────────────────────────────────────────────────

const TEXT_TYPES = new Set<CollectionFieldType>(['text', 'date', 'date_only', 'number', 'option', 'email', 'phone', 'link']);
const IMAGE_NAME_RE = /werk|bild|image|cover|foto|main/i;
const ORDER_NAME_RE = /order|reihenfolge|sort/i;
const CURRENT_RE = /current|upcoming|aktuell|archive/i;
const FEATURE_RE = /feature|highlight/i;

function customFields(c: WfCollectionInfo): WfCollectionInfoField[] {
  return c.fields.filter((f) => f.key === null);
}

function singleImageField(c: WfCollectionInfo): WfCollectionInfoField | undefined {
  const images = customFields(c).filter((f) => f.type === 'image' && !f.multiple);
  return images.find((f) => IMAGE_NAME_RE.test(f.name)) ?? images[0];
}

function multiImageField(c: WfCollectionInfo): WfCollectionInfoField | undefined {
  return customFields(c).find((f) => f.type === 'image' && f.multiple);
}

function detailSuffix(page: WfPage): string | null {
  const m = page.name.match(/^detail[_-](.+)$/i);
  return m ? m[1] : null;
}

/**
 * Pick the collection for a detail page or a list (first rule with confidence
 * >= 0.6 wins; the largest collection is the 0.5 fallback). Template matching
 * against already-bound lists (0.9) lives in `bindPages`, which knows them.
 */
export function chooseCollection(kind: 'list' | 'page', ctx: ListContext, cms: WfCmsResult): CollectionChoice | null {
  const collections = cms.collections;
  if (collections.length === 0) return null;

  if (kind === 'page') {
    const suffix = detailSuffix(ctx.page);
    if (suffix === null) return null;
    const pageTs = objectIdSeconds(ctx.page.wfPageId);
    if (pageTs !== null) {
      let best: { c: WfCollectionInfo; delta: number } | null = null;
      for (const c of collections) {
        const ts = objectIdSeconds(c.webflowId);
        if (ts === null) continue;
        const delta = Math.abs(ts - pageTs);
        if (delta <= 10 && (!best || delta < best.delta)) best = { c, delta };
      }
      if (best) return { collection: best.c, confidence: 0.95, reason: `collection id and page id created ${best.delta}s apart` };
    }
    let byName: { c: WfCollectionInfo; score: number } | null = null;
    for (const c of collections) {
      const score = nameSimilarity(suffix, c.name);
      if (score >= 0.6 && (!byName || score > byName.score)) byName = { c, score };
    }
    if (byName) return { collection: byName.c, confidence: 0.7, reason: `page name "${suffix}" ~ collection "${byName.c.name}" (${byName.score.toFixed(2)})` };
    return null;
  }

  const list = ctx.list;
  const item = list ? firstDescendant(list, (n) => n.wf.role === 'dyn-item') : undefined;
  const inner = item ? descendants(item) : [];
  if (inner.some((n) => n.wf.role === 'rich-text')) {
    const withRich = collections.filter((c) => customFields(c).some((f) => f.type === 'rich_text'));
    if (withRich.length === 1) return { collection: withRich[0], confidence: 0.8, reason: 'template has a rich-text slot and only this collection has a rich-text field' };
  }
  if (inner.some((n) => n.wf.role === 'dyn-list')) {
    const withMulti = collections.filter((c) => multiImageField(c));
    if (withMulti.length === 1) return { collection: withMulti[0], confidence: 0.8, reason: 'template has a nested list and only this collection has a multi-image field' };
  }

  const candidates: string[] = [ctx.page.name];
  for (const cls of ctx.wrapperClasses ?? []) candidates.push(stripDigits(cls));
  if (ctx.heading) candidates.push(ctx.heading);
  let best: { c: WfCollectionInfo; score: number; via: string } | null = null;
  for (const c of collections) {
    for (const candidate of candidates) {
      if (!candidate) continue;
      const score = phraseSimilarity(candidate, c.name);
      if (score >= 0.6 && (!best || score > best.score)) best = { c, score, via: candidate };
    }
  }
  if (best) return { collection: best.c, confidence: 0.7, reason: `"${best.via}" ~ collection "${best.c.name}" (${best.score.toFixed(2)})` };

  if (ctx.heading) {
    const matches = collections.filter((c) => customFields(c).some((f) => phraseSimilarity(ctx.heading!, f.name) >= 0.7));
    if (matches.length === 1) return { collection: matches[0], confidence: 0.7, reason: `heading "${ctx.heading}" ~ a field of "${matches[0].name}"` };
  }

  const largest = [...collections].sort((a, b) => b.rowCount - a.rowCount)[0];
  return { collection: largest, confidence: 0.5, reason: `fallback: largest collection (${largest.rowCount} items)` };
}

// ─── Slot binding ─────────────────────────────────────────────────────────────

interface SlotScope {
  source: 'collection' | 'page';
  collection: WfCollectionInfo;
  /** `wf.id` of the item node (source `collection`). */
  collectionNodeId?: string;
  /** Fields already taken (sort field etc.). */
  used: Set<string>;
  dynamicPage?: { pageId: string };
  page: WfPage;
  index: PageIndex;
  warn: Warnings;
  label: string;
}

function makeBinding(scope: SlotScope, field: WfCollectionInfoField, kind: WfBinding['kind'], confidence: number, reason: string): WfBinding {
  const b: WfBinding = { kind, fieldId: field.id, fieldType: field.type, fieldName: field.name, source: scope.source, confidence, reason };
  if (scope.source === 'collection' && scope.collectionNodeId) b.collectionNodeId = scope.collectionNodeId;
  if (field.type === 'date' || field.type === 'date_only') b.format = scope.collection.dateFormatByField?.[field.id] ?? 'date-eu-dot';
  return b;
}

function bind(scope: SlotScope, node: WfNode, field: WfCollectionInfoField, kind: WfBinding['kind'], confidence: number, reason: string): void {
  node.wf.binding = makeBinding(scope, field, kind, confidence, reason);
  scope.used.add(field.id);
  scope.warn.add('binding_guess', `${scope.label}: ${describe(node)} -> ${scope.collection.name}.${field.name} (${confidence.toFixed(2)}, ${reason})`, { page: scope.page.name, node: node.wf.id });
}

function unbound(scope: SlotScope, node: WfNode, why: string): void {
  scope.warn.add('binding_unbound', `${scope.label}: ${describe(node)} left unbound (${why})`, { page: scope.page.name, node: node.wf.id });
}

function fillRatio(c: WfCollectionInfo, field: WfCollectionInfoField): number {
  const filled = c.fillCountByField?.[field.id];
  if (filled === undefined || c.rowCount === 0) return 1;
  return filled / c.rowCount;
}

/** Text-like candidates: Name first, then custom fields by fill ratio (desc) in CSV order. */
function textCandidates(scope: SlotScope): WfCollectionInfoField[] {
  const c = scope.collection;
  const out: WfCollectionInfoField[] = [];
  const name = c.fields.find((f) => f.key === 'name');
  if (name && !scope.used.has(name.id)) out.push(name);
  const custom = customFields(c)
    .filter((f) => TEXT_TYPES.has(f.type) && !scope.used.has(f.id))
    .map((f, i) => ({ f, i, ratio: fillRatio(c, f) }))
    .sort((a, b) => b.ratio - a.ratio || a.i - b.i)
    .map((x) => x.f);
  return [...out, ...custom];
}

function isSlotText(node: WfNode): boolean {
  return node.wf.bindEmpty && node.kind === 'text';
}

/** Bind every slot below `root` (the item template or the page body). Nested lists are handled as multi-asset lists. */
function bindSlots(root: WfNode | WfNode[], scope: SlotScope): void {
  const roots = Array.isArray(root) ? root : [root];
  const isNestedList = (n: WfNode) => n.wf.role === 'dyn-list';
  // The root itself is a candidate too: an item template like `.section.feature`
  // carries the bound background of the item it represents.
  const nodes: WfNode[] = [];
  for (const r of roots) {
    if (isNestedList(r)) nodes.push(r);
    else nodes.push(r, ...descendants(r, isNestedList, true));
  }
  const c = scope.collection;

  // 1. Images and bound backgrounds -> main image field.
  const image = singleImageField(c);
  for (const n of nodes) {
    if (n.kind === 'image' && n.wf.bindEmpty) {
      if (image) bind(scope, n, image, 'image', 0.8, 'first single image field');
      else unbound(scope, n, 'collection has no image field');
    } else if (n.wf.boundBackground && n.kind !== 'image') {
      if (image) bind(scope, n, image, 'background', 0.75, 'bound background -> image field');
      else unbound(scope, n, 'collection has no image field');
    }
  }

  // 2. Headings -> Name (first only).
  const name = c.fields.find((f) => f.key === 'name');
  let nameBound = false;
  for (const n of nodes) {
    if (n.kind !== 'heading' || !n.wf.bindEmpty) continue;
    if (name && !nameBound) {
      bind(scope, n, name, 'text', 0.85, 'heading -> Name');
      nameBound = true;
    } else {
      unbound(scope, n, 'second heading; probably the previous/next item name — bind it in the builder');
    }
  }

  // 3. Rich text -> first rich_text field.
  const rich = customFields(c).find((f) => f.type === 'rich_text');
  for (const n of nodes) {
    if (n.wf.role !== 'rich-text' || !n.wf.bindEmpty) continue;
    if (rich && !scope.used.has(rich.id)) bind(scope, n, rich, 'richText', 0.8, 'rich text slot -> rich-text field');
    else if (rich) bind(scope, n, rich, 'richText', 0.6, 'rich text slot -> rich-text field (already used)');
    else unbound(scope, n, 'collection has no rich-text field');
  }

  // 4. Nested lists -> multi-image field (`__asset_url` on the inner image). Inside an
  //    item template every nested list is one; on a detail page only an image-only
  //    list qualifies (other lists are regular collection lists bound by `bindPages`).
  const multi = multiImageField(c);
  for (const n of nodes) {
    if (n.wf.role !== 'dyn-list') continue;
    const nestedItem = firstDescendant(n, (x) => x.wf.role === 'dyn-item');
    if (!nestedItem) continue;
    const slots = descendants(nestedItem);
    const imageOnly = slots.length > 0 && slots.every((x) => x.kind === 'image' || (x.kind === 'box' && !x.wf.bindEmpty && !x.wf.role));
    if (scope.source === 'page' && !(multi && imageOnly)) continue;
    if (!multi) {
      unbound(scope, nestedItem, 'nested list but the collection has no multi-image field');
      continue;
    }
    nestedItem.wf.collection = {
      collectionId: MULTI_ASSET_COLLECTION_ID,
      multiAsset: { fieldId: multi.id, source: scope.source, ...(scope.collectionNodeId ? { parentCollectionNodeId: scope.collectionNodeId } : {}) },
      confidence: 0.8,
      reason: `nested list -> multi-image field ${multi.name}`,
    };
    scope.used.add(multi.id);
    scope.warn.add('binding_guess', `${scope.label}: nested ${describe(n)} -> ${c.name}.${multi.name} (0.80, multi-image list)`, { page: scope.page.name, node: nestedItem.wf.id });
    for (const inner of descendants(nestedItem)) {
      if (inner.kind === 'image' && inner.wf.bindEmpty) {
        inner.wf.binding = { kind: 'image', fieldId: '__asset_url', fieldType: 'image', fieldName: multi.name, source: 'collection', collectionNodeId: nestedItem.wf.id, confidence: 0.8, reason: 'image inside a multi-image list' };
      }
    }
  }

  // 5. Remaining text slots.
  const linkAncestor = (n: WfNode) => ancestors(n, scope.index).some((a) => a.kind === 'link');
  for (const n of nodes) {
    if (!isSlotText(n) || n.wf.binding) continue;
    if (name && !nameBound && linkAncestor(n)) {
      bind(scope, n, name, 'text', 0.8, 'first text inside a link -> Name');
      nameBound = true;
      continue;
    }
    const candidates = textCandidates(scope);
    if (name && nameBound) {
      const idx = candidates.indexOf(name);
      if (idx !== -1) candidates.splice(idx, 1);
    }
    let chosen: { field: WfCollectionInfoField; confidence: number; reason: string } | null = null;
    for (const cls of n.wf.siteClasses) {
      for (const f of customFields(c)) {
        if (scope.used.has(f.id) || !TEXT_TYPES.has(f.type)) continue;
        const score = similarity(stripDigits(cls), f.name);
        if (score >= 0.7 && (!chosen || score > chosen.confidence)) chosen = { field: f, confidence: score, reason: `class "${cls}" ~ field "${f.name}"` };
      }
    }
    if (!chosen && candidates.length > 0) {
      const f = candidates[0];
      chosen = { field: f, confidence: f.key === 'name' ? 0.7 : 0.55, reason: f.key === 'name' ? 'first text slot -> Name' : 'next text-like field in CSV order' };
    }
    if (!chosen) {
      unbound(scope, n, 'no text-like field left');
      continue;
    }
    bind(scope, n, chosen.field, 'text', chosen.confidence, chosen.reason);
    if (chosen.field.key === 'name') nameBound = true;
  }

  // 6. Links to the item's page.
  if (scope.source === 'collection' && scope.dynamicPage) {
    for (const n of nodes) {
      if (n.kind !== 'link' || n.wf.binding) continue;
      const href = (n.link?.href ?? '').trim();
      if (href !== '' && href !== '#') continue;
      const slug = c.fields.find((f) => f.key === 'slug');
      n.wf.binding = { kind: 'link', fieldId: slug?.id ?? c.slugFieldId, fieldType: 'text', fieldName: slug?.name ?? 'Slug', source: 'collection', collectionNodeId: scope.collectionNodeId, link: { pageId: scope.dynamicPage.pageId, collectionItemId: 'current-collection' }, confidence: 0.8, reason: 'item link -> current item page' };
      scope.warn.add('binding_guess', `${scope.label}: ${describe(n)} -> link to the current ${c.name} item`, { page: scope.page.name, node: n.wf.id });
    }
  }
}

// ─── Lists ────────────────────────────────────────────────────────────────────

interface ListEntry {
  index: PageIndex;
  list: WfNode;
  item: WfNode;
  heading?: string;
  wrapperClasses: string[];
  signature: string;
  choice: CollectionChoice | null;
}

function precedingHeading(index: PageIndex, list: WfNode): string | undefined {
  const at = index.nodes.indexOf(list);
  const inside = new Set(descendants(list).map((n) => n.wf.id));
  for (let i = at - 1; i >= 0; i--) {
    const n = index.nodes[i];
    if (inside.has(n.wf.id)) continue;
    if ((n.kind === 'heading' || /^h[1-6]$/.test(n.wf.tag)) && n.text?.trim()) return n.text.trim();
  }
  return undefined;
}

function listSettings(entry: ListEntry, c: WfCollectionInfo, used: Set<string>): { sortBy?: string; sortOrder?: 'asc' | 'desc'; limit?: number; filters?: { fieldId: string; fieldType: 'boolean'; value: 'true' }[] } {
  const custom = customFields(c);
  const context = [...entry.wrapperClasses, entry.heading ?? ''].join(' ');
  const out: ReturnType<typeof listSettings> = {};
  const order = custom.find((f) => f.type === 'number' && ORDER_NAME_RE.test(f.name));
  const date = custom.find((f) => f.type === 'date' || f.type === 'date_only');
  if (order) {
    out.sortBy = order.id;
    out.sortOrder = 'asc';
    used.add(order.id);
  } else if (date && CURRENT_RE.test(context)) {
    out.sortBy = date.id;
    out.sortOrder = 'desc';
  } else {
    out.sortBy = 'manual';
  }
  if (/feature/i.test(context)) {
    const flag = custom.find((f) => f.type === 'boolean' && FEATURE_RE.test(f.name));
    if (flag) {
      out.filters = [{ fieldId: flag.id, fieldType: 'boolean', value: 'true' }];
      if (entry.wrapperClasses.includes('feature')) out.limit = 1;
    }
  }
  return out;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function bindPages(deps: BindingDeps): void {
  const { cms, pages, dynamicPageByCollection, warn } = deps;
  if (cms.collections.length === 0) return;
  const indexes = pages.map(indexPage);
  const detailCollectionBySuffix = new Map<string, WfCollectionInfo>();

  // Detail pages.
  for (const index of indexes) {
    const page = index.page;
    const suffix = detailSuffix(page);
    if (suffix === null) continue;
    const choice = chooseCollection('page', { page }, cms);
    if (!choice) {
      warn.add('collection_guess', `page ${page.name} looks like a collection page but no collection matches`, { page: page.name });
      continue;
    }
    detailCollectionBySuffix.set(suffix.toLowerCase(), choice.collection);
    warn.add('collection_guess', `bound page ${page.name} to collection ${choice.collection.name} (confidence ${choice.confidence.toFixed(2)}: ${choice.reason})`, { page: page.name });
    const scope: SlotScope = { source: 'page', collection: choice.collection, used: new Set(), page, index, warn, label: `page ${page.name}` };
    bindSlots(page.roots, scope);
  }

  // Lists (top level: not inside another item).
  const entries: ListEntry[] = [];
  for (const index of indexes) {
    for (const list of index.nodes) {
      if (list.wf.role !== 'dyn-list') continue;
      if (ancestors(list, index).some((a) => a.wf.role === 'dyn-item')) continue;
      const item = firstDescendant(list, (n) => n.wf.role === 'dyn-item');
      if (!item || item.wf.collection) continue; // already bound as a page-level multi-asset list
      const parent = index.parent.get(list.wf.id);
      const wrapperClasses = [...list.wf.siteClasses, ...(parent?.wf.siteClasses ?? [])];
      const heading = precedingHeading(index, list);
      const entry: ListEntry = { index, list, item, heading, wrapperClasses, signature: templateSignature(item), choice: null };
      entry.choice = chooseCollection('list', { page: index.page, list, heading, wrapperClasses }, cms);
      entries.push(entry);
    }
  }
  // Template match: a list whose item template equals a confidently bound one takes that collection.
  const confident = entries.filter((e) => e.choice && e.choice.confidence >= 0.6);
  for (const e of entries) {
    if (e.choice && e.choice.confidence >= 0.6) continue;
    const twin = confident.find((c) => c.signature === e.signature && c !== e);
    if (twin && twin.choice) e.choice = { collection: twin.choice.collection, confidence: 0.9, reason: `same item template as the ${twin.index.page.name} list bound to ${twin.choice.collection.name}` };
  }
  for (const e of entries) {
    const page = e.index.page;
    if (!e.choice) continue;
    const c = e.choice.collection;
    const label = `list ${describe(e.list)} on ${page.name}`;
    warn.add('collection_guess', `bound ${label} to collection ${c.name} (confidence ${e.choice.confidence.toFixed(2)}: ${e.choice.reason})`, { page: page.name, node: e.list.wf.id });
    const used = new Set<string>();
    const settings = listSettings(e, c, used);
    e.item.wf.collection = { collectionId: c.id, ...settings, confidence: e.choice.confidence, reason: e.choice.reason };
    const dynamicPage = dynamicPageByCollection.get(c.id);
    const scope: SlotScope = { source: 'collection', collection: c, collectionNodeId: e.item.wf.id, used, dynamicPage: dynamicPage ? { pageId: dynamicPage.pageId } : undefined, page, index: e.index, warn, label };
    bindSlots(e.item, scope);
  }

  // Safety net: exported `/detail_<x>/<slug>` hrefs.
  for (const index of indexes) {
    for (const n of index.nodes) {
      if (n.kind !== 'link' || n.wf.binding) continue;
      const m = (n.link?.href ?? '').match(/^\/?detail[_-](\w+)\/([^/?#]+)$/);
      if (!m) continue;
      const c = detailCollectionBySuffix.get(m[1].toLowerCase());
      const dyn = c ? dynamicPageByCollection.get(c.id) : undefined;
      if (!c || !dyn) {
        warn.add('link_broken', `link to ${n.link?.href} has no collection page`, { page: index.page.name, node: n.wf.id });
        continue;
      }
      const itemNode = ancestors(n, index).find((a) => a.wf.role === 'dyn-item');
      const inList = !!itemNode && itemNode.wf.collection?.collectionId === c.id;
      const itemId = c.itemIdBySlug.get(m[2]);
      const slug = c.fields.find((f) => f.key === 'slug');
      n.wf.binding = {
        kind: 'link',
        fieldId: slug?.id ?? c.slugFieldId,
        fieldType: 'text',
        fieldName: slug?.name ?? 'Slug',
        source: inList ? 'collection' : 'page',
        ...(inList ? { collectionNodeId: itemNode.wf.id } : {}),
        link: { pageId: dyn.pageId, collectionItemId: inList ? 'current-collection' : itemId ?? 'current-collection' },
        confidence: itemId || inList ? 0.9 : 0.5,
        reason: `href ${n.link?.href}`,
      };
      if (!inList && !itemId) warn.add('link_broken', `link to ${n.link?.href}: no ${c.name} item with slug ${m[2]}`, { page: index.page.name, node: n.wf.id });
    }
  }
}

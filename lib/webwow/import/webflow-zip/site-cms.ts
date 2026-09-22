/**
 * Live-site source, part 2: merge what `site-crawl.ts` read into the CMS plans
 * and answer the binding oracle (SPEC B.3 / B.4).
 *
 * Precedence is Data API > CSV > live site. The site only ever *adds*:
 *
 *   - an empty CSV / API cell whose slot shows a value on the live page is
 *     filled (`cms_site_value_filled`); an image the CSV names by CDN URL gets
 *     the live URL as a download fallback (`alternateUrls`, used by `cms.ts`
 *     only when the primary download fails);
 *   - an item that is on the live site but in no CSV / API collection becomes a
 *     row (`cms_site_item_added`), its cells taken from the slots whose field
 *     is known;
 *   - with neither CSV nor API, whole collections are built from the site
 *     (`cms_site_only`): one per `detail_<folder>` page — items from the
 *     collection pages, from lists linking to them and from lists whose items
 *     show a known name, the lists on the collection pages included (pooled
 *     over every crawled page, as in the CSV path) — plus one per list that
 *     belongs to no folder, keyed by the item names; fields named after the
 *     slot classes, typed by `inferSchema` from the harvested values.
 *
 * The slot -> field mapping is decided per list (and per collection page) by
 * comparing every live value of a slot with the item's cells: a field that
 * matches on at least one item and contradicts none is a candidate, and a slot
 * with exactly one candidate is decided. Everything else stays with the
 * structural heuristics of `binding.ts`. Slot identity is the key scheme of
 * `site-crawl.ts`, computed here over the export's `WfNode` template with the
 * same walk.
 *
 * Two more things the live site settles, both decided once the rows are final
 * (`finaliseMerge`):
 *
 *   - the **list settings**: a list that shows the same n items on every crawled
 *     page while the collection has more is limited to n; when every live item
 *     was identified and the shown rows are exactly the ones with a boolean
 *     field set, or exactly the ones dated after / before today, the list gets
 *     that filter instead (`SiteListMapping.limit` / `.filter`);
 *   - the **site time zone**: a date slot whose live rendering matches the cell
 *     only in some zones (Webflow's year-only `Dec 31 23:00 UTC` shows `2025`
 *     in Europe, `2024` in UTC) names the zones that reproduce the page; the
 *     zone every such slot agrees on becomes `settings.timezone`.
 */

import { inferSchema, inferTimeZoneFromDates, isPublishableRow, splitTokens } from './cms';
import { filenameFromUrl } from './safe-fetch';
import { SlotKeyCounter, pagePathOf, type SiteItem, type SiteList, type SitePage, type SiteSlotValue, type WfSiteCrawl } from './site-crawl';
import type { BindingOracle, BindingOracleListHit, CollectionChoice } from './binding';
import type { WfCmsResult, WfCollectionInfo, WfCollectionInfoField, WfCollectionPlan, WfCsvCollection, WfFieldPlan } from './cms';
import type { PagePlan } from './pages';
import type { WfNode, WfPage } from './types';
import type { Warnings } from './warnings';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SiteSlotKind = 'text' | 'image' | 'background' | 'richText';

export interface SiteSlotMapping {
  /** CSV header (= `WfCollectionInfoField.header`) of the field the slot shows. */
  header: string;
  kind: SiteSlotKind;
  /** Date preset the live site renders (`part-year` for `2024`, `date-eu-dot` for `24.03.2026`). */
  format?: 'part-year' | 'date-eu-dot';
  /**
   * Date slots only: the candidate zones (`SITE_TIME_ZONES`) in which every
   * matched cell renders as the live text — absent when UTC does too (no
   * evidence) or when the samples disagree.
   */
  timeZones?: string[];
  reason: string;
}

/** A list filter the live items prove: the shown rows are exactly the ones the condition selects. */
export interface SiteListFilter {
  header: string;
  operator: 'is' | 'is_after' | 'is_before';
  /** `true` for a boolean field, the `$today` preset for a date field. */
  value: 'true' | '$today';
}

export interface SiteListMapping {
  /** Index into the returned `plans`. */
  planIndex: number;
  /** Slot key -> field. */
  slots: Map<string, SiteSlotMapping>;
  /** Live items that were matched to a row. */
  identified: number;
  /** Export slot keys of the template (site-only builds: lists with the same template share slot decisions). */
  template?: string;
  /** Items the live list shows, one entry per crawled page that renders it (a list on a collection page: every page). */
  liveCounts?: number[];
  /** Slugs of the rows the live list shows, when every live item was identified (filters need the exact set). */
  shownSlugs?: string[];
  /** The live list is paginated: its count is a page size, not a limit. */
  paginated?: boolean;
  /** `finaliseMerge`: the live site shows this many items on every page while the collection has more. */
  limit?: number;
  /** `finaliseMerge`: the live items are exactly the rows this condition selects. */
  filter?: SiteListFilter;
  /**
   * `finaliseMerge`: this list shows exactly the rows an earlier list of the page
   * leaves out, in one sort (`Upcoming` shows the newest exhibition, `Archive`
   * all the others): skip that many leading rows instead of a limit.
   */
  offset?: number;
  /** `finaliseMerge`: the sort both lists of such a pair share (a CSV header). */
  sort?: { header: string; order: 'asc' | 'desc' };
  /** A list on a collection page: whether the live pages leave their own item out. */
  currentItem?: SiteCurrentItem;
}

/**
 * What the `<title>` / meta description of every crawled collection page is
 * made of: a constant around one field's value (`Affinität | Valeska von
 * Brase` = Name + ` | Valeska von Brase`), or the same text on every page.
 */
export type SiteSeoText = { header: string; prefix: string; suffix: string } | { text: string };

export interface SiteSeoTemplates {
  title?: SiteSeoText;
  description?: SiteSeoText;
  /** Crawled collection pages with a known row the templates were read from. */
  pages: number;
}

export interface SiteCmsMerge {
  plans: WfCollectionPlan[];
  /** `<page>#list<n>` (top-level list n of a static page) or `<page>#page` (a `detail_*` page) -> mapping. */
  mappings: Map<string, SiteListMapping>;
  /** CSV / API asset URL -> the same file's URL on the live site. */
  alternateUrls: Map<string, string>;
  /** Every plan was built from the site (no CSV, no API). */
  siteOnly: boolean;
  /**
   * `<page>#list<n>` of a list the live site showed but whose items identify no
   * collection (today: rendered empty) -> why. The binding must not fall back
   * to the largest collection for such a list — the site proves that wrong.
   */
  unresolvedLists: Map<string, string>;
  /** IANA zone in which the live date renderings match the cells (absent when UTC does, or without date evidence). */
  timeZone?: string;
  /** Why `timeZone` was chosen (reporting). */
  timeZoneReason?: string;
  /** Detail folder (`werke`) -> what its live collection pages put in `<title>` and the meta description. */
  seo: Map<string, SiteSeoTemplates>;
  stats: { valuesFilled: number; itemsAdded: number; collectionsBuilt: number };
}

export interface MergeSitePlansInput {
  plans: WfCollectionPlan[];
  site: WfSiteCrawl;
  pages: WfPage[];
  /** `detail_<x>` page basename -> its folder slug and the plan it belongs to (-1: none, site-only). */
  detailPages: Map<string, { folder: string; planIndex: number }>;
  warn: Warnings;
  /** "Today" for the date filters (tests); default: now. */
  now?: Date;
}

// ─── Export-side keys ─────────────────────────────────────────────────────────

/**
 * Slot key per node id of a container (an item template with its root, or the
 * page roots), with the walk `site-crawl.ts` applies to the live DOM: nested
 * and top-level lists are skipped, leaves are not descended into.
 */
export function exportSlotKeys(container: WfNode | WfNode[], includeRoot: boolean): Map<string, string> {
  const counter = new SlotKeyCounter();
  const out = new Map<string, string>();
  const visit = (n: WfNode) => {
    if (n.wf.role === 'dyn-list') return;
    out.set(n.wf.id, counter.next(n.wf.tag, n.wf.siteClasses));
    for (const c of n.children ?? []) visit(c);
  };
  if (Array.isArray(container)) {
    for (const n of container) visit(n);
  } else if (includeRoot) {
    visit(container);
  } else {
    for (const c of container.children ?? []) visit(c);
  }
  return out;
}

export interface ExportList {
  list: WfNode;
  item: WfNode;
  ordinal: number;
}

/** Top-level collection lists of an export page in document order, each with its template item. */
export function exportLists(page: WfPage): ExportList[] {
  const out: ExportList[] = [];
  const firstItem = (n: WfNode): WfNode | undefined => {
    for (const c of n.children ?? []) {
      if (c.wf.role === 'dyn-item') return c;
      const found = firstItem(c);
      if (found) return found;
    }
    return undefined;
  };
  const walk = (list: WfNode[]) => {
    for (const n of list) {
      if (n.wf.role === 'dyn-list') {
        const item = firstItem(n);
        if (item) out.push({ list: n, item, ordinal: out.length });
        continue;
      }
      if (n.children) walk(n.children);
    }
  };
  walk(page.roots);
  return out;
}

function listKeyOf(list: WfNode): string {
  return `${list.wf.tag}.${list.wf.siteClasses.join('.')}`;
}

function slotKindOf(node: WfNode): SiteSlotKind | null {
  if (node.kind === 'image') return node.wf.bindEmpty ? 'image' : null;
  if (node.wf.boundBackground) return 'background';
  if (node.wf.role === 'rich-text') return node.wf.bindEmpty ? 'richText' : null;
  if (node.wf.bindEmpty && (node.kind === 'text' || node.kind === 'heading' || node.kind === 'link')) return 'text';
  return null;
}

interface ExportSlot {
  node: WfNode;
  key: string;
  kind: SiteSlotKind;
}

function exportSlots(container: WfNode | WfNode[], includeRoot: boolean): { keys: Map<string, string>; slots: ExportSlot[] } {
  const keys = exportSlotKeys(container, includeRoot);
  const slots: ExportSlot[] = [];
  const visit = (n: WfNode) => {
    if (n.wf.role === 'dyn-list') return;
    const kind = slotKindOf(n);
    const key = keys.get(n.wf.id);
    if (kind && key) slots.push({ node: n, key, kind });
    for (const c of n.children ?? []) visit(c);
  };
  if (Array.isArray(container)) for (const n of container) visit(n);
  else if (includeRoot) visit(container);
  else for (const c of container.children ?? []) visit(c);
  return { keys, slots };
}

// ─── Value comparison ─────────────────────────────────────────────────────────

function normText(s: string): string {
  return s
    .replace(/\u00a0/g, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/** File identity of an image URL: decoded basename without Webflow's id prefix and `-p-NNN` derivative suffix. */
export function imageIdentity(url: string): string {
  return filenameFromUrl(url).replace(/-p-\d+(\.[a-z0-9]+)$/i, '$1').toLowerCase();
}

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
/**
 * Time zones a published site may render in, one per offset family (UTC,
 * Western / Central / Eastern Europe, the four US zones), in preference order.
 * IANA names rather than offsets: a zone renders summer and winter dates with
 * their own offsets exactly as `settings.timezone` will, so a match here is a
 * match on the published page. Every entry is in `getTimezoneOptions()`.
 */
export const SITE_TIME_ZONES = ['UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Helsinki', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];

const calendarFormatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar day of an instant in a zone (month 1-based); UTC when the zone is unknown to the runtime. */
export function calendarDay(ms: number, zone: string): { y: number; m: number; d: number } {
  let f = calendarFormatters.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' });
    } catch {
      f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
    }
    calendarFormatters.set(zone, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

export interface DateRendering {
  /** ycode date preset that produces this text, when one exists. */
  format?: SiteSlotMapping['format'];
  /** Zones of `SITE_TIME_ZONES` in which the cell renders as this text. */
  zones: string[];
}

/** Every rendering of a date the live site may show, keyed by normalised text. */
export function dateRenderings(cell: string): Map<string, DateRendering> {
  const out = new Map<string, DateRendering>();
  const ms = Date.parse(cell.trim());
  if (Number.isNaN(ms)) return out;
  for (const zone of SITE_TIME_ZONES) {
    const { y, m: month, d: day } = calendarDay(ms, zone);
    const m = month - 1;
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    const put = (text: string, format: SiteSlotMapping['format']) => {
      const key = normText(text);
      const entry = out.get(key);
      if (!entry) out.set(key, { format, zones: [zone] });
      else if (!entry.zones.includes(zone)) entry.zones.push(zone);
    };
    put(String(y), 'part-year');
    put(`${dd}.${mm}.${y}`, 'date-eu-dot');
    put(`${day}.${month}.${y}`, 'date-eu-dot');
    put(`${y}-${mm}-${dd}`, undefined);
    put(`${MONTHS_EN[m]} ${day}, ${y}`, undefined);
    put(`${MONTHS_EN[m].slice(0, 3)} ${day}, ${y}`, undefined);
    put(`${day}. ${MONTHS_DE[m]} ${y}`, undefined);
    put(`${day} ${MONTHS_EN[m]} ${y}`, undefined);
    put(`${mm}/${dd}/${y}`, undefined);
    put(`${dd}/${mm}/${y}`, undefined);
  }
  return out;
}

function liveCell(value: SiteSlotValue | undefined, kind: SiteSlotKind): string {
  if (!value) return '';
  switch (kind) {
    case 'image':
      return value.src ?? '';
    case 'background':
      return value.bg ?? '';
    case 'richText':
      return value.html ?? '';
    default:
      return value.text ?? '';
  }
}

interface Comparison {
  match: boolean;
  /** The cell is empty: no evidence for or against this field (the gap the site may fill). */
  neutral?: boolean;
  format?: SiteSlotMapping['format'];
  /** Date match: the zones in which the cell renders as the live text. */
  zones?: string[];
}

/** Does the live value of a slot equal this cell of a field of the given type? */
export function compareValue(kind: SiteSlotKind, live: string, cell: string, type: WfFieldPlan['type']): Comparison {
  const c = cell.trim();
  if (!c) return { match: false, neutral: true };
  if (kind === 'image' || kind === 'background') {
    if (type !== 'image') return { match: false };
    const id = imageIdentity(live);
    return { match: !!id && splitTokens(c).some((t) => imageIdentity(t) === id) };
  }
  if (kind === 'richText') {
    if (type !== 'rich_text' && type !== 'text') return { match: false };
    const a = normText(stripTags(live));
    const b = normText(c.startsWith('<') ? stripTags(c) : c);
    return { match: !!a && a === b };
  }
  const text = normText(live);
  if (!text) return { match: false };
  switch (type) {
    case 'date':
    case 'date_only': {
      const rendering = dateRenderings(c).get(text);
      return rendering ? { match: true, format: rendering.format, zones: rendering.zones } : { match: false };
    }
    case 'number': {
      const a = Number(c.replace(',', '.'));
      const b = Number(live.trim().replace(/\s/g, '').replace(',', '.'));
      return { match: Number.isFinite(a) && Number.isFinite(b) && a === b };
    }
    case 'boolean':
    case 'image':
    case 'document':
    case 'reference':
    case 'multi_reference':
      return { match: false };
    case 'rich_text':
      return { match: normText(stripTags(c)) === text };
    default:
      return { match: normText(c) === text };
  }
}

interface Sample {
  value: SiteSlotValue | undefined;
  row: Record<string, string>;
}

/**
 * The one field a slot shows, or null. A field is a candidate when it matches
 * the live value on at least one item and contradicts none (a live value with
 * a different cell, or an empty live slot with a filled cell — an empty cell
 * under a live value is neutral: that is the gap the site fills); with several
 * candidates the slot kind breaks the tie, otherwise it is ambiguous.
 */
export function decideSlot(kind: SiteSlotKind, samples: Sample[], plan: WfCollectionPlan): SiteSlotMapping | null {
  const candidates = plan.fields.filter((f) => f.key === 'name' || !f.system);
  const tally = new Map<string, { matches: number; conflicts: number; formats: Map<string, number>; dated: number; zones: Map<string, number> }>();
  for (const f of candidates) tally.set(f.header, { matches: 0, conflicts: 0, formats: new Map(), dated: 0, zones: new Map() });
  let evidence = 0;
  for (const { value, row } of samples) {
    if (!value) continue;
    const live = liveCell(value, kind);
    if (!live) {
      if (!value.empty) continue;
      // Webflow leaves the slot marked empty when the field has no value.
      for (const f of candidates) {
        if ((row[f.header] ?? '').trim()) tally.get(f.header)!.conflicts++;
      }
      continue;
    }
    evidence++;
    for (const f of candidates) {
      const t = tally.get(f.header)!;
      const result = compareValue(kind, live, row[f.header] ?? '', f.type);
      if (result.match) {
        t.matches++;
        if (result.format) t.formats.set(result.format, (t.formats.get(result.format) ?? 0) + 1);
        if (result.zones) {
          t.dated++;
          for (const z of result.zones) t.zones.set(z, (t.zones.get(z) ?? 0) + 1);
        }
      } else if (!result.neutral) {
        t.conflicts++;
      }
    }
  }
  if (evidence === 0) return null;
  let consistent = candidates.filter((f) => {
    const t = tally.get(f.header)!;
    return t.matches >= 1 && t.conflicts === 0;
  });
  if (consistent.length > 1) {
    const fits = consistent.filter((f) => (kind === 'image' || kind === 'background' ? f.type === 'image' : kind === 'richText' ? f.type === 'rich_text' : f.type !== 'image' && f.type !== 'rich_text'));
    if (fits.length >= 1) consistent = fits;
  }
  if (consistent.length !== 1) return null;
  const field = consistent[0];
  const t = tally.get(field.header)!;
  let format: SiteSlotMapping['format'];
  let best = 0;
  for (const [f, n] of t.formats) {
    if (n > best) {
      best = n;
      format = f as SiteSlotMapping['format'];
    }
  }
  const mapping: SiteSlotMapping = { header: field.header, kind, reason: `live value matches ${plan.csv.name}.${field.name} on ${t.matches} item(s)` };
  if (format) mapping.format = format;
  if (t.dated > 0) {
    // Zones that reproduce every matched rendering; UTC among them means the
    // page could be rendered without a zone change, so there is no evidence.
    const agreed = SITE_TIME_ZONES.filter((z) => (t.zones.get(z) ?? 0) === t.dated);
    if (agreed.length > 0 && !agreed.includes('UTC')) mapping.timeZones = agreed;
  }
  return mapping;
}

// ─── Row identification ───────────────────────────────────────────────────────

type Row = Record<string, string>;

interface PlanView {
  plan: WfCollectionPlan;
  index: number;
  folder: string | null;
  rowBySlug: Map<string, Row>;
  /** Normalised Name -> every row with that name (Webflow allows duplicates: two editions of one exhibition). */
  rowsByName: Map<string, Row[]>;
  /** Image identity -> the one CSV / API token of the plan that carries it (identities two rows share are absent). */
  imageTokenByIdentity: Map<string, string>;
  /** Live-only items collected so far (slug -> row). */
  added: Map<string, Row>;
  /** Zone the plan's own year-only dates name (`inferTimeZoneFromDates`), null when they are UTC midnight: weights the date evidence. */
  zone: string | null;
}

function makeView(plan: WfCollectionPlan, index: number, folder: string | null): PlanView {
  const rowBySlug = new Map<string, Row>();
  const rowsByName = new Map<string, Row[]>();
  const imageTokenByIdentity = new Map<string, string>();
  const ambiguousImages = new Set<string>();
  for (const row of plan.csv.rows) {
    const slug = (row['Slug'] ?? '').trim();
    if (slug && !rowBySlug.has(slug)) rowBySlug.set(slug, row);
    const name = normText(row['Name'] ?? '');
    if (name) {
      const rows = rowsByName.get(name);
      if (rows) rows.push(row);
      else rowsByName.set(name, [row]);
    }
    for (const field of plan.fields) {
      if (field.type !== 'image' || field.system) continue;
      for (const token of splitTokens(row[field.header] ?? '')) {
        const id = imageIdentity(token);
        if (!id || ambiguousImages.has(id)) continue;
        const known = imageTokenByIdentity.get(id);
        if (known !== undefined && known !== token) {
          imageTokenByIdentity.delete(id);
          ambiguousImages.add(id);
        } else {
          imageTokenByIdentity.set(id, token);
        }
      }
    }
  }
  return { plan, index, folder, rowBySlug, rowsByName, imageTokenByIdentity, added: new Map(), zone: inferTimeZoneFromDates([plan])?.zone ?? null };
}

function slugFromLinks(links: string[], folder: string | null): string | null {
  if (!folder) return null;
  const re = new RegExp(`^/${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/?#]+)$`, 'i');
  for (const link of links) {
    const m = link.match(re);
    if (m) {
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return m[1];
      }
    }
  }
  return null;
}

/** The kind a live value renders as (what `liveCell` reads), or null for an empty-marked slot. */
function valueKind(value: SiteSlotValue): SiteSlotKind | null {
  if (value.src) return 'image';
  if (value.bg) return 'background';
  if (value.html) return 'richText';
  if (value.text) return 'text';
  return null;
}

/** Weight of a date match that only zones other than the site's reproduce: evidence, but less than a match in the site zone. */
export const OTHER_ZONE_MATCH = 0.5;

/**
 * How many of a live item's values (slots and nested-gallery images) equal a
 * cell of this row: the evidence that tells two rows with the same Name apart
 * (a different year, location or picture). A date renders differently per
 * zone, and Webflow's year-only `Dec 31 23:00 UTC` shows the next year in
 * Europe: a live `2016` fits both a `Dec 31 2015` and a `Dec 31 2016` cell.
 * With the site zone known (`zone`, from the CSV dates), the row whose cell
 * renders the live text in that zone counts a full match, the other only
 * `OTHER_ZONE_MATCH` — so the two rows are told apart instead of tied.
 */
export function rowEvidence(item: SiteItem, row: Row, fields: { header: string; type: WfFieldPlan['type'] }[], zone: string | null = null): number {
  let score = 0;
  for (const value of item.values.values()) {
    const kind = valueKind(value);
    if (!kind) continue;
    const live = liveCell(value, kind);
    let best = 0;
    for (const f of fields) {
      const result = compareValue(kind, live, row[f.header] ?? '', f.type);
      if (!result.match) continue;
      const weight = zone && result.zones && !result.zones.includes(zone) ? OTHER_ZONE_MATCH : 1;
      if (weight > best) best = weight;
      if (best === 1) break;
    }
    score += best;
  }
  for (const url of item.images) {
    const id = imageIdentity(url);
    if (id && fields.some((f) => f.type === 'image' && splitTokens(row[f.header] ?? '').some((t) => imageIdentity(t) === id))) score++;
  }
  return score;
}

/**
 * One row per live item out of its candidates. An item with one candidate
 * takes it. With several, the candidate with the most matching values wins
 * when it is alone at the top. On a single live page (`exclusive`: not the
 * pool of a collection page's lists) every row appears at most once, so the
 * rows other items took are out of the running: the items are settled one at
 * a time, the surest first (a unique best among the still free candidates,
 * highest score first, list order among equals). Two items that both fit one
 * row best therefore land on two rows — the first on that row, the other on
 * its best remaining one — and a row only exclusion tells apart still lands.
 * Rows nothing tells apart (the same fair twice, no value differs): the items
 * take them in list order rather than losing them — every cell the live item
 * shows is a cell both rows carry alike.
 */
export function assignRows<R>(items: SiteItem[], candidatesOf: (item: SiteItem, index: number) => R[], evidence: (item: SiteItem, row: R) => number, exclusive: boolean): (R | null)[] {
  const assigned: (R | null)[] = items.map(() => null);
  const open: { index: number; rows: R[]; score: Map<R, number> }[] = [];
  items.forEach((item, index) => {
    const rows = candidatesOf(item, index);
    if (rows.length === 0) return;
    if (rows.length === 1) {
      assigned[index] = rows[0];
      return;
    }
    open.push({ index, rows, score: new Map(rows.map((row) => [row, evidence(item, row)])) });
  });
  const bestOf = (rows: R[], score: Map<R, number>): { rows: R[]; score: number } => {
    let best: R[] = [];
    let bestScore = -Infinity;
    for (const row of rows) {
      const n = score.get(row) ?? 0;
      if (n > bestScore) {
        best = [row];
        bestScore = n;
      } else if (n === bestScore) {
        best.push(row);
      }
    }
    return { rows: best, score: bestScore };
  };
  if (!exclusive) {
    for (const o of open) {
      const best = bestOf(o.rows, o.score);
      if (best.rows.length === 1) assigned[o.index] = best.rows[0];
    }
    return assigned;
  }
  const taken = new Set<R>(assigned.filter((r): r is R => r !== null));
  while (open.length > 0) {
    let pick = -1;
    let pickRow: R | undefined;
    let pickScore = -Infinity;
    let tie = -1;
    let tieRow: R | undefined;
    open.forEach((o, i) => {
      const free = o.rows.filter((row) => !taken.has(row));
      if (free.length === 0) return;
      const best = bestOf(free, o.score);
      if (best.rows.length === 1) {
        if (best.score > pickScore) {
          pick = i;
          pickRow = best.rows[0];
          pickScore = best.score;
        }
      } else if (tie < 0) {
        tie = i;
        tieRow = best.rows[0];
      }
    });
    if (pick < 0) {
      pick = tie;
      pickRow = tieRow;
    }
    // Only items whose candidates are all taken are left: they stay unknown.
    if (pick < 0 || pickRow === undefined) break;
    assigned[open[pick].index] = pickRow;
    taken.add(pickRow);
    open.splice(pick, 1);
  }
  return assigned;
}

interface Candidates {
  /** Slug the item links to (a live-only item has one without a row). */
  slug: string | null;
  rows: Row[];
}

/**
 * The plan rows a live item may show: the row of the collection page it links
 * to, else every row whose Name equals one of its texts (publishable rows
 * first: a draft is not on the live site).
 */
function candidatesFor(item: SiteItem, view: PlanView): Candidates {
  const slug = slugFromLinks(item.links, view.folder);
  if (slug) {
    const row = view.rowBySlug.get(slug);
    return { slug, rows: row ? [row] : [] };
  }
  for (const value of item.values.values()) {
    if (!value.text) continue;
    const rows = view.rowsByName.get(normText(value.text));
    if (!rows || rows.length === 0) continue;
    const publishable = rows.filter(isPublishableRow);
    return { slug: null, rows: publishable.length > 0 ? publishable : rows };
  }
  return { slug: null, rows: [] };
}

/** Rows of a plan a live list's items show, one per item (null: unknown), with the linked slug of each item. */
function identifyItems(items: SiteItem[], view: PlanView, exclusive: boolean): { row: Row | null; slug: string | null }[] {
  const candidates = items.map((item) => candidatesFor(item, view));
  const fields = view.plan.fields.filter((f) => !f.system || f.key === 'name');
  const rows = assignRows(items, (_item, i) => candidates[i].rows, (item, row) => rowEvidence(item, row, fields, view.zone), exclusive);
  return rows.map((row, i) => ({ row, slug: candidates[i].slug ?? (row ? (row['Slug'] ?? '').trim() || null : null) }));
}

const FILLABLE_TYPES = new Set<WfFieldPlan['type']>(['text', 'image', 'rich_text', 'link', 'number', 'email', 'phone', 'color']);

function titleCase(s: string): string {
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** `Aufbruch - II | Valeska von Brase` -> `Aufbruch - II`: only the site suffix after the last separator goes. */
function nameFromTitle(title: string): string {
  const t = title.trim();
  const m = t.match(/^(.*\S)\s+[|–—-]\s+[^|–—-]*$/);
  return (m ? m[1] : t).trim();
}

// ─── Merge ────────────────────────────────────────────────────────────────────

function cloneRows(plans: WfCollectionPlan[]): WfCollectionPlan[] {
  return plans.map((p) => ({ ...p, csv: { ...p.csv, rows: p.csv.rows.map((r) => ({ ...r })) } }));
}

function newRow(headers: string[], slug: string): Record<string, string> {
  const now = new Date().toISOString();
  const row: Record<string, string> = {};
  for (const h of headers) row[h] = '';
  row['Name'] = '';
  row['Slug'] = slug;
  row['Archived'] = 'false';
  row['Draft'] = 'false';
  row['Created On'] = now;
  row['Updated On'] = now;
  row['Published On'] = now;
  return row;
}

/** Items a list shows on a collection page are pooled over every crawled page of the collection (bounded). */
const MAX_POOLED_ITEMS = 400;

interface LiveLists {
  lists: SiteList[];
  /** Per list ordinal: the item count on every crawled page that renders it (one entry for a static page). */
  counts: number[][];
  /** The lists were pooled over several pages (their item sets differ per page). */
  pooled: boolean;
  /** Per list ordinal of a collection page: how the list treats the page's own item ({@link currentItemEvidence}). */
  current?: (SiteCurrentItem | undefined)[];
}

/**
 * How a list on a collection page treats the page's own item, read from the
 * item links of every crawled page (`/werke/<slug>`):
 * - `excluded`: no crawled page lists its own item, although some item that
 *   has a crawled page of its own shows up in another page's list;
 * - `shown`: at least one page lists its own item.
 * `follows`: with `excluded`, every page shows the items that follow its own
 * one in a fixed order (page A lists B, C, D, E and page B lists C, D, E, …),
 * which no ycode list setting reproduces.
 */
export interface SiteCurrentItem {
  mode: 'excluded' | 'shown';
  follows?: boolean;
}

/** Slug of the `/<folder>/<slug>` link of a list item, or null (none, or several different ones). */
function itemSlugIn(item: SiteItem, folder: string): string | null {
  let slug: string | null = null;
  for (const link of item.links) {
    const m = link.match(/^\/([^/]+)\/([^/?#]+)$/);
    if (!m || m[1].toLowerCase() !== folder.toLowerCase()) continue;
    if (slug !== null && slug !== m[2]) return null;
    slug = m[2];
  }
  return slug;
}

/**
 * {@link SiteCurrentItem} of one list ordinal over the crawled pages of a
 * collection (`slug -> item slugs of that page's list`); undefined when an
 * item has no link into the folder or there is too little to tell.
 */
export function currentItemEvidence(byPage: Map<string, (string | null)[]>): SiteCurrentItem | undefined {
  if (byPage.size < 2) return undefined;
  for (const slugs of byPage.values()) if (slugs.some((s) => s === null)) return undefined;
  const lists = byPage as Map<string, string[]>;
  for (const [slug, slugs] of lists) if (slugs.includes(slug)) return { mode: 'shown' };
  // Leaving the own item out only shows when that item could appear at all.
  let witness = false;
  for (const [slug, slugs] of lists) {
    if (slugs.some((s) => s !== slug && lists.has(s))) {
      witness = true;
      break;
    }
  }
  if (!witness) return undefined;
  let checked = 0;
  let follows = true;
  for (const slugs of lists.values()) {
    if (slugs.length < 2) continue;
    const next = lists.get(slugs[0]);
    if (!next) continue;
    checked++;
    const expected = slugs.slice(1);
    if (next.length < expected.length || expected.some((s, i) => next[i] !== s)) {
      follows = false;
      break;
    }
  }
  return { mode: 'excluded', ...(follows && checked > 0 ? { follows: true } : {}) };
}

function liveListsFor(page: WfPage, site: WfSiteCrawl, folder: string | null): LiveLists | null {
  if (!folder) {
    const lists = site.pages.get(pagePathOf(page.name))?.lists;
    return lists ? { lists, counts: lists.map((l) => [l.items.length]), pooled: false } : null;
  }
  const livePages = site.detail.get(folder);
  if (!livePages || livePages.size === 0) return null;
  const pooled: SiteList[] = [];
  const counts: number[][] = [];
  const itemSlugs: Map<string, (string | null)[]>[] = [];
  for (const [pageSlug, livePage] of livePages) {
    livePage.lists.forEach((list, ordinal) => {
      const target = pooled[ordinal];
      if (!target) {
        pooled[ordinal] = { ordinal, key: list.key, items: [...list.items], ...(list.pagination ? { pagination: list.pagination } : {}) };
        counts[ordinal] = [list.items.length];
        itemSlugs[ordinal] = new Map([[pageSlug, list.items.map((item) => itemSlugIn(item, folder))]]);
        return;
      }
      if (target.key !== list.key) return;
      counts[ordinal].push(list.items.length);
      itemSlugs[ordinal].set(pageSlug, list.items.map((item) => itemSlugIn(item, folder)));
      if (list.pagination && !target.pagination) target.pagination = list.pagination;
      if (target.items.length >= MAX_POOLED_ITEMS) return;
      target.items.push(...list.items.slice(0, MAX_POOLED_ITEMS - target.items.length));
    });
  }
  return { lists: pooled, counts, pooled: true, current: itemSlugs.map((byPage) => (byPage ? currentItemEvidence(byPage) : undefined)) };
}

export function mergeSitePlans(input: MergeSitePlansInput): SiteCmsMerge {
  const { site, pages, detailPages, warn } = input;
  const plans = cloneRows(input.plans);
  const merge: SiteCmsMerge = { plans, mappings: new Map(), alternateUrls: new Map(), siteOnly: false, unresolvedLists: new Map(), seo: new Map(), stats: { valuesFilled: 0, itemsAdded: 0, collectionsBuilt: 0 } };
  if (!site.reachable) return merge;
  if (plans.length === 0) return finaliseMerge(buildSitePlans(input, merge), input.now ?? new Date());

  const folderByPlan = new Map<number, string>();
  for (const { folder, planIndex } of detailPages.values()) if (planIndex >= 0 && !folderByPlan.has(planIndex)) folderByPlan.set(planIndex, folder);
  const views = plans.map((plan, i) => makeView(plan, i, folderByPlan.get(i) ?? null));
  const filledByField = new Map<string, number>();

  /** Every image the CSV / API names for a row that the live item also shows becomes a download fallback. */
  const imageFallbacks = (view: PlanView, row: Record<string, string>, images: string[]) => {
    if (images.length === 0) return;
    const byIdentity = new Map<string, string>();
    for (const url of images) {
      const id = imageIdentity(url);
      if (id && !byIdentity.has(id)) byIdentity.set(id, url);
    }
    for (const field of view.plan.fields) {
      if (field.type !== 'image' || field.system) continue;
      for (const token of splitTokens(row[field.header] ?? '')) {
        const live = byIdentity.get(imageIdentity(token));
        if (live && live !== token && !merge.alternateUrls.has(token)) merge.alternateUrls.set(token, live);
      }
    }
  };

  /** Live images of an item without a row: fallbacks for the tokens whose file identity exactly one row of the plan carries. */
  const imageFallbacksByIdentity = (view: PlanView, images: string[]) => {
    for (const live of images) {
      const token = view.imageTokenByIdentity.get(imageIdentity(live));
      if (token && token !== live && !merge.alternateUrls.has(token)) merge.alternateUrls.set(token, live);
    }
  };

  const fill = (view: PlanView, row: Row, slots: Map<string, SiteSlotMapping>, values: Map<string, SiteSlotValue>, isNew: boolean) => {
    for (const [key, m] of slots) {
      const live = liveCell(values.get(key), m.kind);
      if (!live) continue;
      const field = view.plan.fields.find((f) => f.header === m.header);
      if (!field) continue;
      if (!isNew && !FILLABLE_TYPES.has(field.type) && field.key !== 'name') continue;
      const existing = (row[m.header] ?? '').trim();
      if (!existing) {
        row[m.header] = live;
        if (!isNew) {
          merge.stats.valuesFilled++;
          const k = `${view.plan.csv.name}.${field.name}`;
          filledByField.set(k, (filledByField.get(k) ?? 0) + 1);
        }
        continue;
      }
      if ((m.kind === 'image' || m.kind === 'background') && existing !== live) {
        const token = splitTokens(existing).find((t) => imageIdentity(t) === imageIdentity(live));
        if (token && token !== live && !merge.alternateUrls.has(token)) merge.alternateUrls.set(token, live);
      }
    }
  };

  /**
   * Live items of a list that no CSV row was settled for, with that list's slot
   * mapping. A live-only item shows up in several lists, and only some of them
   * link it to its page (`/catalog` lists every work with its Order but links
   * none), so once every live-only row is known these fill the rest of its cells.
   */
  const unmatched: { view: PlanView; slots: Map<string, SiteSlotMapping>; values: Map<string, SiteSlotValue>; slug: string | null }[] = [];

  const addItem = (view: PlanView, slug: string, slots: Map<string, SiteSlotMapping>, values: Map<string, SiteSlotValue>) => {
    let row = view.added.get(slug);
    if (!row) {
      row = newRow(view.plan.csv.headers, slug);
      view.added.set(slug, row);
    }
    fill(view, row, slots, values, true);
  };

  // Every top-level list of every page against its live counterpart (a list on a
  // collection page is pooled over every crawled page of that collection).
  for (const page of pages) {
    const live = liveListsFor(page, site, detailPages.get(page.name)?.folder ?? null);
    if (!live) continue;
    for (const entry of exportLists(page)) {
      const liveList = live.lists[entry.ordinal];
      if (!liveList || liveList.key !== listKeyOf(entry.list) || liveList.items.length === 0) continue;
      const { slots } = exportSlots(entry.item, true);
      let best: { view: PlanView; matched: { row: Row | null; slug: string | null }[]; count: number } | null = null;
      for (const view of views) {
        const matched = identifyItems(liveList.items, view, !live.pooled);
        const count = matched.filter((m) => m.row).length;
        if (count > 0 && (!best || count > best.count)) best = { view, matched, count };
      }
      if (!best) continue;
      const mapping: SiteListMapping = { planIndex: best.view.index, slots: new Map(), identified: best.count, liveCounts: live.counts[entry.ordinal] ?? [liveList.items.length] };
      if (liveList.pagination) mapping.paginated = true;
      if (live.current?.[entry.ordinal]) mapping.currentItem = live.current[entry.ordinal];
      const known: { item: SiteItem; row: Row }[] = [];
      liveList.items.forEach((item, i) => {
        const row = best!.matched[i].row;
        if (row) known.push({ item, row });
      });
      // A filter needs the exact set of shown rows: only when this is one page
      // and every live item is a known row (live-only items get a row below,
      // but a slug alone does not prove which cells they carry).
      if (!live.pooled && known.length === liveList.items.length) mapping.shownSlugs = known.map((k) => (k.row['Slug'] ?? '').trim());
      for (const slot of slots) {
        const decided = decideSlot(slot.kind, known.map((k) => ({ value: k.item.values.get(slot.key), row: k.row })), best.view.plan);
        if (decided) mapping.slots.set(slot.key, decided);
      }
      merge.mappings.set(`${page.name}#list${entry.ordinal}`, mapping);
      liveList.items.forEach((item, i) => {
        const m = best!.matched[i];
        if (m.row) {
          fill(best!.view, m.row, mapping.slots, item.values, false);
          imageFallbacks(best!.view, m.row, item.images);
        } else {
          // An item no row could be settled for still shows pictures the CSV
          // names: by their file identity they are fallbacks all the same.
          imageFallbacksByIdentity(best!.view, item.images);
          if (m.slug) addItem(best!.view, m.slug, mapping.slots, item.values);
          unmatched.push({ view: best!.view, slots: mapping.slots, values: item.values, slug: m.slug });
        }
      });
    }
  }

  // Collection pages: the export's `detail_<x>` against every live `/<x>/<slug>` page.
  for (const page of pages) {
    const detail = detailPages.get(page.name);
    if (!detail || detail.planIndex < 0) continue;
    const view = views[detail.planIndex];
    const livePages = site.detail.get(detail.folder);
    if (!view || !livePages || livePages.size === 0) continue;
    const { slots } = exportSlots(page.roots, false);
    const samples: { slug: string; values: Map<string, SiteSlotValue>; row: Record<string, string> | null }[] = [];
    for (const [slug, livePage] of livePages) samples.push({ slug, values: livePage.values, row: view.rowBySlug.get(slug) ?? null });
    const known = samples.filter((s) => s.row);
    const mapping: SiteListMapping = { planIndex: view.index, slots: new Map(), identified: known.length };
    if (known.length > 0) {
      for (const slot of slots) {
        const decided = decideSlot(slot.kind, known.map((s) => ({ value: s.values.get(slot.key), row: s.row! })), view.plan);
        if (decided) mapping.slots.set(slot.key, decided);
      }
    }
    merge.mappings.set(`${page.name}#page`, mapping);
    for (const s of samples) {
      if (s.row) {
        fill(view, s.row, mapping.slots, s.values, false);
        imageFallbacks(view, s.row, livePages.get(s.slug)?.images ?? []);
      } else if (view.folder) {
        addItem(view, s.slug, mapping.slots, s.values);
      }
    }
  }

  // Live-only items become rows; a name comes from the slot bound to Name, else the page title, else the slug.
  for (const view of views) {
    for (const [slug, row] of view.added) {
      if (!(row['Name'] ?? '').trim()) {
        const title = view.folder ? site.detail.get(view.folder)?.get(slug)?.title ?? '' : '';
        row['Name'] = nameFromTitle(title) || titleCase(slug);
      }
    }
  }
  // Every other list that shows a live-only item fills the cells still empty:
  // by its slug when the list links it, else by the name its Name slot shows.
  for (const entry of unmatched) {
    const row = liveOnlyRowFor(entry.view, entry.slots, entry.values, entry.slug);
    if (row) fill(entry.view, row, entry.slots, entry.values, true);
  }
  for (const view of views) {
    for (const [slug, row] of view.added) {
      view.plan.csv.rows.push(row);
      view.rowBySlug.set(slug, row);
      merge.stats.itemsAdded++;
      warn.add('cms_site_item_added', `${view.plan.csv.name}: "${row['Name']}" (/${view.folder}/${slug}) exists on the live site but not in the CSV / API export; added from the page`);
    }
  }
  for (const [key, n] of filledByField) {
    warn.add('cms_site_value_filled', `${key}: ${n} empty value(s) filled from the live site`, { count: n });
  }
  for (const view of views) {
    if (!view.folder || merge.seo.has(view.folder)) continue;
    const templates = seoTemplatesFor(view.rowBySlug, site.detail.get(view.folder), view.plan.fields);
    if (templates) merge.seo.set(view.folder, templates);
  }
  return finaliseMerge(merge, input.now ?? new Date());
}

/** The live-only row a list item stands for: by slug, else the one added row whose Name the item's Name slot shows. */
function liveOnlyRowFor(view: PlanView, slots: Map<string, SiteSlotMapping>, values: Map<string, SiteSlotValue>, slug: string | null): Row | null {
  if (slug) return view.added.get(slug) ?? null;
  for (const [key, m] of slots) {
    if (m.header !== 'Name') continue;
    const name = normText(liveCell(values.get(key), m.kind));
    if (!name) continue;
    // Never a name a CSV row carries: that item is not live-only.
    if (view.rowsByName.has(name)) return null;
    const rows = [...view.added.values()].filter((r) => normText(r['Name'] ?? '') === name);
    return rows.length === 1 ? rows[0] : null;
  }
  return null;
}

// ─── Collection page SEO ──────────────────────────────────────────────────────

function collapseSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * The one shape every sample text has: `prefix + <cell of header> + suffix`
 * with the same prefix and suffix on every page (Name first, then the text
 * fields), else the same text on every page. Null when the pages disagree.
 */
export function seoTextTemplate(samples: { text: string; row: Row }[], fields: { header: string; type: WfFieldPlan['type'] }[]): SiteSeoText | null {
  const texts = samples.map((s) => collapseSpace(s.text));
  if (texts.length === 0 || texts.some((t) => !t)) return null;
  const headers = ['Name', ...fields.filter((f) => (f.type === 'text' || f.type === 'rich_text') && f.header !== 'Name').map((f) => f.header)];
  for (const header of headers) {
    let prefix: string | null = null;
    let suffix: string | null = null;
    let ok = true;
    for (let i = 0; i < samples.length && ok; i++) {
      const raw = samples[i].row[header] ?? '';
      const cell = collapseSpace(raw.startsWith('<') ? stripTags(raw) : raw);
      if (cell.length < 2) {
        ok = false;
        break;
      }
      const at = texts[i].toLowerCase().indexOf(cell.toLowerCase());
      if (at < 0) {
        ok = false;
        break;
      }
      const p = texts[i].slice(0, at);
      const q = texts[i].slice(at + cell.length);
      if (prefix === null) {
        prefix = p;
        suffix = q;
      } else if (p !== prefix || q !== suffix) {
        ok = false;
      }
    }
    if (ok && prefix !== null && suffix !== null) return { header, prefix, suffix };
  }
  return texts.every((t) => t === texts[0]) ? { text: texts[0] } : null;
}

/** Title and description templates of a folder's live collection pages, from the pages whose row is known. */
function seoTemplatesFor(rowBySlug: Map<string, Row>, livePages: Map<string, SitePage> | undefined, fields: { header: string; type: WfFieldPlan['type'] }[]): SiteSeoTemplates | null {
  if (!livePages) return null;
  const titles: { text: string; row: Row }[] = [];
  const descriptions: { text: string; row: Row }[] = [];
  for (const [slug, livePage] of livePages) {
    const row = rowBySlug.get(slug);
    if (!row) continue;
    titles.push({ text: livePage.title, row });
    descriptions.push({ text: livePage.description ?? '', row });
  }
  if (titles.length === 0) return null;
  const out: SiteSeoTemplates = { pages: titles.length };
  const title = seoTextTemplate(titles, fields);
  if (title) out.title = title;
  const description = seoTextTemplate(descriptions, fields);
  if (description) out.description = description;
  return out.title || out.description ? out : null;
}

/** `<ycode-inline-variable>` for a page-collection field, the canonical tag the SEO title editor writes. */
function inlineFieldVariable(field: WfCollectionInfoField): string {
  return `<ycode-inline-variable>${JSON.stringify({ type: 'field', data: { field_id: field.id, field_type: field.type, relationships: [], source: 'page' } })}</ycode-inline-variable>`;
}

/** Human form of a template for the warning (`<Name> | Valeska von Brase`). */
function describeSeoText(t: SiteSeoText, field?: WfCollectionInfoField): string {
  return 'text' in t ? `"${t.text}"` : `"${t.prefix}<${field?.name ?? t.header}>${t.suffix}"`;
}

/**
 * Once the collections exist: the dynamic page of every folder the live site
 * settled gets the title / description its collection pages show, the field
 * as an inline variable that `generatePageMetadata` resolves per item. The
 * export's static `<title>` of the template page is the fallback the page
 * keeps otherwise.
 */
export function applySiteSeo(plans: PagePlan[], cms: WfCmsResult, merge: SiteCmsMerge, warn: Warnings): number {
  let applied = 0;
  for (const plan of plans) {
    if (plan.kind !== 'dynamic' || !plan.folder || !plan.cms) continue;
    const templates = merge.seo.get(plan.folder.slug);
    if (!templates) continue;
    const collection = cms.collections.find((c) => c.id === plan.cms!.collectionId);
    if (!collection) continue;
    const render = (t: SiteSeoText): { text: string; field?: WfCollectionInfoField } | null => {
      if ('text' in t) return { text: t.text };
      const field = collection.fields.find((f) => f.header === t.header) ?? (t.header === 'Name' ? collection.fields.find((f) => f.id === collection.nameFieldId) : undefined);
      if (!field) return null;
      return { text: `${t.prefix}${inlineFieldVariable(field)}${t.suffix}`, field };
    };
    const parts: string[] = [];
    if (templates.title) {
      const r = render(templates.title);
      if (r && r.text !== plan.seo.title) {
        plan.seo.title = r.text;
        parts.push(`title ${describeSeoText(templates.title, r.field)}`);
      }
    }
    if (templates.description) {
      const r = render(templates.description);
      if (r && r.text !== plan.seo.description) {
        plan.seo.description = r.text;
        parts.push(`description ${describeSeoText(templates.description, r.field)}`);
      }
    }
    if (parts.length === 0) continue;
    applied++;
    warn.add('seo_from_site', `page ${plan.page.name}: ${parts.join(', ')} as on the ${templates.pages} live /${plan.folder.slug}/ page(s)`, { page: plan.page.name });
  }
  return applied;
}

// ─── List settings and time zone ──────────────────────────────────────────────

/** `y*10000 + m*100 + d` of an instant in a zone: comparable calendar days, the way ycode's `$today` filters compare. */
function dayNumber(ms: number, zone: string): number {
  const { y, m, d } = calendarDay(ms, zone);
  return y * 10000 + m * 100 + d;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((s) => set.has(s));
}

/**
 * The condition that selects exactly the shown rows, if one field explains
 * them: a boolean set on exactly those rows, or a date after / before today
 * (calendar days in the site zone — `is_after $today` / `is_before $today`
 * in ycode) on exactly those rows.
 */
export function listFilterFor(plan: WfCollectionPlan, rows: Record<string, string>[], shownSlugs: string[], zone: string, now: Date): SiteListFilter | null {
  if (shownSlugs.length === 0 || shownSlugs.length >= rows.length) return null;
  const slugOf = (r: Record<string, string>) => (r['Slug'] ?? '').trim();
  const today = dayNumber(now.getTime(), zone);
  for (const field of plan.fields) {
    if (field.system) continue;
    if (field.type === 'boolean') {
      const set = rows.filter((r) => /^(true|1|yes|y|on)$/i.test((r[field.header] ?? '').trim())).map(slugOf);
      if (set.length > 0 && sameSet(set, shownSlugs)) return { header: field.header, operator: 'is', value: 'true' };
      continue;
    }
    if (field.type !== 'date' && field.type !== 'date_only') continue;
    const after: string[] = [];
    const before: string[] = [];
    for (const r of rows) {
      const ms = Date.parse((r[field.header] ?? '').trim());
      if (Number.isNaN(ms)) continue;
      const day = dayNumber(ms, zone);
      if (day > today) after.push(slugOf(r));
      else if (day < today) before.push(slugOf(r));
    }
    if (after.length > 0 && sameSet(after, shownSlugs)) return { header: field.header, operator: 'is_after', value: '$today' };
    if (before.length > 0 && sameSet(before, shownSlugs)) return { header: field.header, operator: 'is_before', value: '$today' };
  }
  return null;
}

/** The zone every date slot agrees on (preference order of `SITE_TIME_ZONES`), else the one most slots name. */
export function decideTimeZone(merge: SiteCmsMerge): { zone: string; reason: string } | null {
  const votes = new Map<string, number>();
  let slots = 0;
  for (const mapping of merge.mappings.values()) {
    for (const m of mapping.slots.values()) {
      if (!m.timeZones || m.timeZones.length === 0) continue;
      slots++;
      for (const z of m.timeZones) votes.set(z, (votes.get(z) ?? 0) + 1);
    }
  }
  if (slots === 0) return null;
  const agreed = SITE_TIME_ZONES.find((z) => votes.get(z) === slots);
  if (agreed) return { zone: agreed, reason: `${slots} date slot(s) of the live site render in this zone, not in UTC` };
  let best: string | null = null;
  let bestVotes = 0;
  for (const z of SITE_TIME_ZONES) {
    const n = votes.get(z) ?? 0;
    if (n > bestVotes) {
      best = z;
      bestVotes = n;
    }
  }
  return best ? { zone: best, reason: `${bestVotes} of ${slots} date slot(s) of the live site render in this zone, not in UTC` } : null;
}

/**
 * Once the rows are final: the site time zone from the date slots, then per
 * list what the live counts prove — a filter when the shown rows are exactly
 * one condition's rows, else a limit when every crawled page shows the same
 * n items and the collection has more. A paginated list shows a page size,
 * not a limit.
 */
export function finaliseMerge(merge: SiteCmsMerge, now: Date): SiteCmsMerge {
  const tz = decideTimeZone(merge);
  if (tz) {
    merge.timeZone = tz.zone;
    merge.timeZoneReason = tz.reason;
  }
  const zone = merge.timeZone ?? 'UTC';
  for (const [key, mapping] of merge.mappings) {
    if (!key.includes('#list') || !mapping.liveCounts || mapping.liveCounts.length === 0 || mapping.paginated) continue;
    const n = mapping.liveCounts[0];
    if (n < 1 || mapping.liveCounts.some((c) => c !== n)) continue;
    const plan = merge.plans[mapping.planIndex];
    if (!plan) continue;
    const rows = plan.csv.rows.filter(isPublishableRow);
    if (n >= rows.length) continue;
    const filter = mapping.shownSlugs && mapping.shownSlugs.length === n ? listFilterFor(plan, rows, mapping.shownSlugs, zone, now) : null;
    if (filter) mapping.filter = filter;
    else mapping.limit = n;
  }
  splitListPairs(merge);
  return merge;
}

/** A sortable cell: a date as its time, a number as itself; null when empty or neither. */
function sortKeyOf(value: string, type: WfFieldPlan['type']): number | null {
  const v = value.trim();
  if (!v) return null;
  if (type === 'number') {
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'date' || type === 'date_only') {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * The sort under which the rows of `first` all come before the rows of `second`
 * (strictly: no tie across the boundary), both lists in their live order: a
 * date or number field of the plan and a direction. Null when none fits.
 */
function sharedSortOf(plan: WfCollectionPlan, first: Row[], second: Row[]): { header: string; order: 'asc' | 'desc' } | null {
  for (const field of plan.fields) {
    if (field.system || (field.type !== 'date' && field.type !== 'date_only' && field.type !== 'number')) continue;
    const a = first.map((r) => sortKeyOf(r[field.header] ?? '', field.type));
    const b = second.map((r) => sortKeyOf(r[field.header] ?? '', field.type));
    if (a.some((k) => k === null) || b.some((k) => k === null)) continue;
    const keysA = a as number[];
    const keysB = b as number[];
    for (const order of ['desc', 'asc'] as const) {
      const before = (x: number, y: number) => (order === 'desc' ? x >= y : x <= y);
      const monotone = (keys: number[]) => keys.every((k, i) => i === 0 || before(keys[i - 1], k));
      const boundary = order === 'desc' ? Math.min(...keysA) > Math.max(...keysB) : Math.max(...keysA) < Math.min(...keysB);
      if (monotone(keysA) && monotone(keysB) && boundary) return { header: field.header, order };
    }
  }
  return null;
}

/**
 * Two lists of one page that show the same collection and split it between
 * them — disjoint, together every publishable row, every live item known, the
 * first list's rows all ahead of the second's in one date / number sort
 * (`Upcoming`: the newest exhibition; `Archive`: all the others): the second
 * list skips the first list's rows (`offset`) instead of showing an arbitrary
 * "first n", and both take that sort. A limit alone put the newest item into
 * both lists and lost the oldest one.
 */
function splitListPairs(merge: SiteCmsMerge): void {
  const byPage = new Map<string, { key: string; ordinal: number; mapping: SiteListMapping }[]>();
  for (const [key, mapping] of merge.mappings) {
    const m = key.match(/^(.*)#list(\d+)$/);
    if (!m || mapping.paginated || mapping.filter || !mapping.shownSlugs || mapping.shownSlugs.length === 0) continue;
    if (!mapping.liveCounts || mapping.liveCounts.length !== 1) continue;
    byPage.set(m[1], [...(byPage.get(m[1]) ?? []), { key, ordinal: Number(m[2]), mapping }]);
  }
  for (const lists of byPage.values()) {
    lists.sort((a, b) => a.ordinal - b.ordinal);
    for (let i = 0; i < lists.length; i++) {
      for (let j = i + 1; j < lists.length; j++) {
        const first = lists[i].mapping;
        const second = lists[j].mapping;
        if (first.planIndex !== second.planIndex || second.offset !== undefined) continue;
        const plan = merge.plans[first.planIndex];
        if (!plan) continue;
        const rows = plan.csv.rows.filter(isPublishableRow);
        const bySlug = new Map(rows.map((r) => [(r['Slug'] ?? '').trim(), r]));
        const shownA = first.shownSlugs!.map((s) => bySlug.get(s));
        const shownB = second.shownSlugs!.map((s) => bySlug.get(s));
        if (shownA.some((r) => !r) || shownB.some((r) => !r)) continue;
        const setA = new Set(first.shownSlugs);
        if (second.shownSlugs!.some((s) => setA.has(s)) || setA.size + new Set(second.shownSlugs).size !== rows.length) continue;
        const sort = sharedSortOf(plan, shownA as Row[], shownB as Row[]);
        if (!sort) continue;
        first.sort = sort;
        second.sort = sort;
        second.offset = setA.size;
        delete second.limit;
      }
    }
  }
}

// ─── Site-only collections ────────────────────────────────────────────────────

const SYSTEM_HEADERS = ['Name', 'Slug', 'Archived', 'Draft', 'Created On', 'Updated On', 'Published On'];

/** `Brandmale der Erde` -> `brandmale-der-erde` (ASCII, like Webflow's own slugs). */
export function slugifyName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function fieldNameFor(node: WfNode, kind: SiteSlotKind, index: number): string {
  if (kind === 'image' || kind === 'background') return 'Image';
  if (kind === 'richText') return 'Rich Text';
  const hint = node.wf.attrs['data-field'] ?? node.wf.attrs['data-wf-field'] ?? '';
  if (hint.trim()) return titleCase(hint);
  const cls = node.wf.siteClasses.find((c) => !/^(w-|div-block|text-block|block|thin|_)/i.test(c)) ?? node.wf.siteClasses[0];
  if (cls) return titleCase(cls.replace(/[-_]?\d+$/, ''));
  if (node.kind === 'heading') return 'Title';
  return `Field ${index}`;
}

interface SiteSample {
  slug: string;
  values: Map<string, SiteSlotValue>;
}

/**
 * One collection under construction from the live site alone: rows keyed by
 * slug, fields named after the slots that show them. Two slots that show the
 * same values on the same items become one field; a slot that shows the
 * item names is the built-in Name.
 */
class SiteCollectionBuild {
  readonly rows = new Map<string, Record<string, string>>();
  readonly headers: string[] = [];
  /** `<page>#list<n>` / `<page>#page` -> mapping; `planIndex` is patched once the plan exists. */
  readonly mappings = new Map<string, SiteListMapping>();
  /** Normalised Name -> every slug with that name (two rows may share one: the same fair in two years). */
  readonly slugsByName = new Map<string, string[]>();
  private readonly valuesByHeader = new Map<string, Map<string, string>>([['Name', new Map()]]);
  private readonly used = new Set<string>(SYSTEM_HEADERS);
  /** Slot kind that created each field (what `rowEvidence` compares its cells as). */
  private readonly kindByHeader = new Map<string, SiteSlotKind>();

  constructor(
    readonly name: string,
    /** Detail folder of the collection (`werke`), null for a collection built from a list alone. */
    readonly folder: string | null,
  ) {}

  row(slug: string): Record<string, string> {
    let row = this.rows.get(slug);
    if (!row) {
      row = newRow([], slug);
      this.rows.set(slug, row);
    }
    return row;
  }

  /**
   * Name of a row. A name read from a slot (`rendered`) replaces one derived
   * from a page title: the slot shows the field itself, the title only a
   * rendering of it.
   */
  setName(slug: string, name: string, rendered = false): void {
    const row = this.row(slug);
    const clean = name.trim();
    const existing = (row['Name'] ?? '').trim();
    if (!clean || (existing && (!rendered || existing === clean))) return;
    if (existing) {
      const oldKey = normText(existing);
      const slugs = (this.slugsByName.get(oldKey) ?? []).filter((s) => s !== slug);
      if (slugs.length > 0) this.slugsByName.set(oldKey, slugs);
      else this.slugsByName.delete(oldKey);
    }
    row['Name'] = clean;
    this.valuesByHeader.get('Name')!.set(slug, clean);
    const key = normText(clean);
    const slugs = this.slugsByName.get(key);
    if (!slugs) this.slugsByName.set(key, [slug]);
    else if (!slugs.includes(slug)) slugs.push(slug);
  }

  /** Slugs of the rows whose Name a live text equals. */
  slugsOfName(text: string): string[] {
    return this.slugsByName.get(normText(text)) ?? [];
  }

  /** `rowEvidence` of a live item against the row of a slug: the values an earlier list already stored there. */
  evidence(item: SiteItem, slug: string): number {
    const row = this.rows.get(slug);
    if (!row) return 0;
    const fields: { header: string; type: WfFieldPlan['type'] }[] = [{ header: 'Name', type: 'text' }];
    for (const header of this.headers) {
      const kind = this.kindByHeader.get(header);
      fields.push({ header, type: kind === 'image' || kind === 'background' ? 'image' : kind === 'richText' ? 'rich_text' : 'text' });
    }
    return rowEvidence(item, row, fields);
  }

  private headerFor(node: WfNode, kind: SiteSlotKind, values: { slug: string; value: string }[]): string | null {
    if (values.length === 0) return null;
    for (const [header, seen] of this.valuesByHeader) {
      let shared = 0;
      let equal = 0;
      for (const v of values) {
        const prev = seen.get(v.slug);
        if (prev === undefined) continue;
        shared++;
        if (normText(prev) === normText(v.value)) equal++;
      }
      // Names seeded from page titles may differ from the rendered name on a
      // few items (a truncated or decorated title): four in five is the Name.
      const same = shared > 0 && (equal === shared || (header === 'Name' && equal * 5 >= shared * 4));
      if (same) {
        if (header !== 'Name') for (const v of values) seen.set(v.slug, v.value);
        return header;
      }
    }
    const base = fieldNameFor(node, kind, this.headers.length + 1);
    let name = base;
    let n = 2;
    while (this.used.has(name)) name = `${base} ${n++}`;
    this.used.add(name);
    this.headers.push(name);
    this.kindByHeader.set(name, kind);
    this.valuesByHeader.set(name, new Map(values.map((v) => [v.slug, v.value])));
    return name;
  }

  /** Map every slot of a template to a field from the live samples and fill the rows. */
  fill(key: string, slots: ExportSlot[], samples: SiteSample[], reason: string): SiteListMapping {
    const mapping: SiteListMapping = { planIndex: -1, slots: new Map(), identified: samples.length, template: slots.map((s) => s.key).join('|') };
    for (const slot of slots) {
      const values = samples.map((s) => ({ slug: s.slug, value: liveCell(s.values.get(slot.key), slot.kind) })).filter((v) => v.value);
      const header = this.headerFor(slot.node, slot.kind, values);
      if (!header) continue;
      mapping.slots.set(slot.key, { header, kind: slot.kind, reason: `${reason} (${values.length} value(s))` });
      for (const v of values) {
        if (header === 'Name') this.setName(v.slug, v.value, true);
        else {
          const row = this.row(v.slug);
          if (!(row[header] ?? '').trim()) row[header] = v.value;
        }
      }
    }
    this.mappings.set(key, mapping);
    return mapping;
  }

  /**
   * A slot without a value on one page (an item whose field is empty there)
   * takes the decision of another list with the same template whose items
   * did show the value.
   */
  borrowTwinSlots(): void {
    const byTemplate = new Map<string, SiteListMapping[]>();
    for (const m of this.mappings.values()) {
      if (!m.template) continue;
      const list = byTemplate.get(m.template) ?? [];
      list.push(m);
      byTemplate.set(m.template, list);
    }
    for (const twins of byTemplate.values()) {
      if (twins.length < 2) continue;
      for (const m of twins) {
        for (const other of twins) {
          if (other === m) continue;
          for (const [slotKey, decided] of other.slots) {
            if (!m.slots.has(slotKey)) m.slots.set(slotKey, { ...decided, reason: `${decided.reason}, same template on another page` });
          }
        }
      }
    }
  }

  toPlan(order: number, livePages: Map<string, SitePage> | undefined): WfCollectionPlan {
    for (const row of this.rows.values()) {
      if (!(row['Name'] ?? '').trim()) {
        const title = livePages?.get(row['Slug'])?.title ?? '';
        row['Name'] = nameFromTitle(title) || titleCase(row['Slug']);
      }
    }
    const allHeaders = [...SYSTEM_HEADERS, ...this.headers];
    const csv: WfCsvCollection = {
      name: this.name,
      webflowId: null,
      filename: `site:${this.folder ?? slugifyName(this.name)}`,
      headers: allHeaders,
      rows: [...this.rows.values()].map((row) => {
        const full: Record<string, string> = {};
        for (const h of allHeaders) full[h] = row[h] ?? '';
        return full;
      }),
      order,
    };
    const [plan] = inferSchema([csv]);
    return plan;
  }
}

/** The rows of `build` whose Name a text slot of the item equals. */
function slugsByNameSlot(item: SiteItem, build: SiteCollectionBuild): string[] {
  if (build.slugsByName.size === 0) return [];
  for (const value of item.values.values()) {
    if (!value.text) continue;
    const slugs = build.slugsOfName(value.text);
    if (slugs.length > 0) return slugs;
  }
  return [];
}

/**
 * What a live list showed, for `finaliseMerge`: its count on every crawled
 * page, pagination and (one page, every item claimed) the exact rows — a list
 * pooled over collection pages shows different rows per page, so no set.
 */
function noteLiveList(mapping: SiteListMapping, live: LiveLists, liveList: SiteList, samples: SiteSample[]): void {
  mapping.liveCounts = live.counts[liveList.ordinal] ?? [liveList.items.length];
  if (liveList.pagination) mapping.paginated = true;
  if (live.current?.[liveList.ordinal]) mapping.currentItem = live.current[liveList.ordinal];
  if (!live.pooled && samples.length === liveList.items.length) mapping.shownSlugs = samples.map((s) => s.slug);
}

/**
 * Best build for a list's live items under `candidatesOf` (majority rule),
 * with the slug of every item it claims. Several candidates (rows sharing a
 * Name) are settled by `assignRows` on the values earlier lists stored, then
 * by exclusion when the list is one static page (`exclusive`: every row at
 * most once), not the pool of a collection page's lists.
 */
function claimItems(items: SiteItem[], builds: SiteCollectionBuild[], candidatesOf: (item: SiteItem, build: SiteCollectionBuild) => string[], exclusive: boolean): { build: SiteCollectionBuild; slugs: (string | null)[] } | null {
  let best: { build: SiteCollectionBuild; slugs: (string | null)[]; count: number } | null = null;
  for (const build of builds) {
    const slugs = assignRows(items, (item) => candidatesOf(item, build), (item, slug) => build.evidence(item, slug), exclusive);
    const count = slugs.filter(Boolean).length;
    if (count > 0 && count * 2 >= items.length && (!best || count > best.count)) best = { build, slugs, count };
  }
  return best ? { build: best.build, slugs: best.slugs } : null;
}

/** Name of a collection built from a list alone: its wrapper class, else the page and list position. */
function standaloneName(page: WfPage, list: WfNode, ordinal: number): string {
  const cls = list.wf.siteClasses.find((c) => !/^(w-|collection|list|wrapper|div-block|block|_)/i.test(c));
  if (cls) return titleCase(cls.replace(/[-_]?\d+$/, ''));
  return `${titleCase(page.name)} List ${ordinal + 1}`;
}

/** Name of a live item without a link or a known name: its heading slot, else its first text slot. */
function itemNameOf(item: SiteItem, slots: ExportSlot[]): string {
  const headingKeys = new Set(slots.filter((s) => s.kind === 'text' && s.node.kind === 'heading').map((s) => s.key));
  let first = '';
  for (const value of item.values.values()) {
    const text = (value.text ?? '').trim();
    if (!text) continue;
    if (headingKeys.has(value.key)) return text;
    if (!first) first = text;
  }
  return first;
}

/**
 * No CSV and no API: one collection per `detail_<folder>` page of the export,
 * items = every live item linking to `/<folder>/<slug>`, every live item whose
 * text equals a name the collection already knows (from its detail-page
 * titles or an earlier list), plus every crawled `/<folder>/<slug>` page;
 * fields = the slots of those templates. A list whose items belong to no
 * detail folder becomes a collection of its own, keyed by the item names
 * (slug = slugified name, else the item's position), so that its fields and
 * items exist and the list can be bound to *its* items instead of the
 * largest collection's.
 */
function buildSitePlans(input: MergeSitePlansInput, merge: SiteCmsMerge): SiteCmsMerge {
  const { site, pages, detailPages, warn } = input;
  merge.siteOnly = true;
  const folderPages = new Map<string, string>();
  for (const [pageName, { folder }] of detailPages) if (!folderPages.has(folder)) folderPages.set(folder, pageName);

  // 1. One build per detail folder, named from the live collection pages first
  //    so that lists can be matched by item name.
  const folderBuilds: SiteCollectionBuild[] = [];
  for (const folder of folderPages.keys()) {
    const build = new SiteCollectionBuild(titleCase(folder), folder);
    for (const [slug, livePage] of site.detail.get(folder) ?? []) build.setName(slug, nameFromTitle(livePage.title));
    folderBuilds.push(build);
  }
  const standalone = new Map<string, SiteCollectionBuild>();

  // 2. Lists of every page: by link, else by name, else on their own. Static
  //    pages first (one page each, rows at most once), then the lists on the
  //    collection pages, pooled over every crawled `/<folder>/<slug>` page the
  //    way the CSV path reads them ("Weitere Werke" on each work's page): that
  //    is where their limit and their slot bindings come from.
  const byLink = (item: SiteItem, build: SiteCollectionBuild) => {
    const slug = slugFromLinks(item.links, build.folder);
    return slug ? [slug] : [];
  };
  const pending: { page: WfPage; entry: ExportList; live: LiveLists; liveList: SiteList; key: string }[] = [];
  const staticFirst = [...pages.filter((p) => !detailPages.has(p.name)), ...pages.filter((p) => detailPages.has(p.name))];
  for (const page of staticFirst) {
    const live = liveListsFor(page, site, detailPages.get(page.name)?.folder ?? null);
    if (!live) continue;
    for (const entry of exportLists(page)) {
      const liveList = live.lists[entry.ordinal];
      if (!liveList || liveList.key !== listKeyOf(entry.list)) continue;
      const key = `${page.name}#list${entry.ordinal}`;
      if (liveList.items.length === 0) {
        merge.unresolvedLists.set(key, 'the live site shows this list without items');
        continue;
      }
      const claim = claimItems(liveList.items, folderBuilds, byLink, !live.pooled);
      if (!claim) {
        pending.push({ page, entry, live, liveList, key });
        continue;
      }
      const { slots } = exportSlots(entry.item, true);
      const samples: SiteSample[] = [];
      liveList.items.forEach((item, i) => {
        const slug = claim.slugs[i];
        if (slug) samples.push({ slug, values: item.values });
      });
      noteLiveList(claim.build.fill(key, slots, samples, 'live site slot'), live, liveList, samples);
    }
  }
  for (const { page, entry, live, liveList, key } of pending) {
    const { slots } = exportSlots(entry.item, true);
    const claim = claimItems(liveList.items, folderBuilds, slugsByNameSlot, !live.pooled);
    if (claim) {
      const samples: SiteSample[] = [];
      liveList.items.forEach((item, i) => {
        const slug = claim.slugs[i];
        if (slug) samples.push({ slug, values: item.values });
      });
      noteLiveList(claim.build.fill(key, slots, samples, 'live site slot, item matched by name'), live, liveList, samples);
      continue;
    }
    // Nothing links or names these items: they are a collection of their own.
    const buildKey = listKeyOf(entry.list);
    let build = standalone.get(buildKey);
    if (!build) {
      build = new SiteCollectionBuild(standaloneName(page, entry.list, entry.ordinal), null);
      standalone.set(buildKey, build);
    }
    const samples: SiteSample[] = [];
    liveList.items.forEach((item, i) => {
      const name = itemNameOf(item, slots);
      let slug = slugifyName(name) || `item-${i + 1}`;
      if (build!.rows.has(slug) && normText(build!.rows.get(slug)!['Name'] ?? '') !== normText(name)) {
        let n = 2;
        while (build!.rows.has(`${slug}-${n}`)) n++;
        slug = `${slug}-${n}`;
      }
      if (name) build!.setName(slug, name);
      samples.push({ slug, values: item.values });
    });
    noteLiveList(build.fill(key, slots, samples, 'live site slot, item keyed by name'), live, liveList, samples);
  }

  // 3. Collection pages: the export's `detail_<folder>` against every live `/<folder>/<slug>` page.
  for (const build of folderBuilds) {
    const detailPage = pages.find((p) => p.name === folderPages.get(build.folder!));
    const livePages = site.detail.get(build.folder!);
    if (!detailPage || !livePages || livePages.size === 0) continue;
    const { slots } = exportSlots(detailPage.roots, false);
    const samples: SiteSample[] = [...livePages].map(([slug, livePage]) => ({ slug, values: livePage.values }));
    build.fill(`${detailPage.name}#page`, slots, samples, 'live collection page slot');
  }

  // 4. Plans, in folder order, then the standalone ones.
  for (const build of [...folderBuilds, ...standalone.values()]) {
    if (build.rows.size === 0) continue;
    build.borrowTwinSlots();
    const planIndex = merge.plans.length;
    const plan = build.toPlan(planIndex, build.folder ? site.detail.get(build.folder) : undefined);
    merge.plans.push(plan);
    merge.stats.collectionsBuilt++;
    for (const [key, mapping] of build.mappings) {
      mapping.planIndex = planIndex;
      merge.mappings.set(key, mapping);
    }
    if (build.folder) {
      const rowBySlug = new Map(plan.csv.rows.map((r) => [r['Slug'], r]));
      const templates = seoTemplatesFor(rowBySlug, site.detail.get(build.folder), plan.fields);
      if (templates) merge.seo.set(build.folder, templates);
    }
    const origin = build.folder ? 'built from the live site alone (no CSV, no API)' : 'built from a list of the live site alone (no CSV, no API, no collection page)';
    warn.add('cms_site_only', `collection "${plan.csv.name}" ${origin}: ${plan.csv.rows.length} item(s), ${build.headers.length} field(s) named after the template slots`);
  }
  return merge;
}

// ─── Binding oracle ───────────────────────────────────────────────────────────

/** Filter, offset or limit of a list the live counts prove (`finaliseMerge`); null when none. */
function listHitOf(mapping: SiteListMapping, collection: WfCollectionInfo): BindingOracleListHit | null {
  const shown = mapping.liveCounts?.[0] ?? 0;
  const total = collection.publishableCount;
  if (mapping.filter) {
    const field = collection.fields.find((f) => f.header === mapping.filter!.header);
    if (field) {
      const what = mapping.filter.operator === 'is' ? `${field.name} set` : `${field.name} ${mapping.filter.operator === 'is_after' ? 'after' : 'before'} today`;
      return { filter: { field, operator: mapping.filter.operator, value: mapping.filter.value }, reason: `live site: the ${shown} item(s) shown of ${total} are exactly the ones with ${what}` };
    }
  }
  const sortField = mapping.sort ? collection.fields.find((f) => f.header === mapping.sort!.header) : undefined;
  const sort = sortField ? { field: sortField, order: mapping.sort!.order } : undefined;
  if (mapping.offset !== undefined && sort) {
    return { offset: mapping.offset, sort, reason: `live site: shows the ${shown} ${collection.name} item(s) an earlier list of the page leaves out, sorted by ${sort.field.name} ${sort.order}` };
  }
  if (mapping.limit !== undefined) {
    const pages = mapping.liveCounts?.length ?? 1;
    const exact = !!mapping.shownSlugs && mapping.shownSlugs.length === mapping.limit;
    return { limit: mapping.limit, exact, ...(sort ? { sort } : {}), reason: `live site: ${pages > 1 ? `each of ${pages} pages shows` : 'shows'} ${mapping.limit} of ${total} ${collection.name} items${exact ? ', no field selects exactly those' : ''}${sort ? `, sorted by ${sort.field.name} ${sort.order} (a later list shows the rest)` : ''}` };
  }
  return null;
}

/**
 * The `BindingOracle` for `bindPages`: looks a list or slot up in the merge
 * result. `cms.collections[i]` is the persisted collection of `plans[i]`
 * (`importCms` keeps the plan order).
 */
export function createSiteOracle(merge: SiteCmsMerge, cms: WfCmsResult, pages: WfPage[]): BindingOracle {
  const ordinalByNode = new Map<string, number>();
  for (const page of pages) {
    for (const entry of exportLists(page)) {
      ordinalByNode.set(entry.list.wf.id, entry.ordinal);
      ordinalByNode.set(entry.item.wf.id, entry.ordinal);
    }
  }
  const keyCache = new Map<string, Map<string, string>>();
  const keysFor = (id: string, container: WfNode | WfNode[], includeRoot: boolean) => {
    let keys = keyCache.get(id);
    if (!keys) {
      keys = exportSlotKeys(container, includeRoot);
      keyCache.set(id, keys);
    }
    return keys;
  };
  let hits = 0;

  return {
    get hits() {
      return hits;
    },
    collection({ page, list }): CollectionChoice | null {
      const ordinal = ordinalByNode.get(list.wf.id);
      if (ordinal === undefined) return null;
      const mapping = merge.mappings.get(`${page.name}#list${ordinal}`);
      if (!mapping) return null;
      const collection = cms.collections[mapping.planIndex];
      if (!collection) return null;
      return { collection, confidence: 1, reason: `live site: ${mapping.identified} item(s) of this list are ${collection.name} items` };
    },
    vetoFallback({ page, list }): string | null {
      const ordinal = ordinalByNode.get(list.wf.id);
      if (ordinal === undefined) return null;
      return merge.unresolvedLists.get(`${page.name}#list${ordinal}`) ?? null;
    },
    list({ page, list }): BindingOracleListHit | null {
      const ordinal = ordinalByNode.get(list.wf.id);
      if (ordinal === undefined) return null;
      const mapping = merge.mappings.get(`${page.name}#list${ordinal}`);
      if (!mapping) return null;
      const collection = cms.collections[mapping.planIndex];
      if (!collection) return null;
      const hit = listHitOf(mapping, collection);
      const current = mapping.currentItem;
      if (!current) return hit;
      const pages = mapping.liveCounts?.length ?? 0;
      const currentReason = current.mode === 'shown'
        ? 'live site: a collection page lists its own item'
        : `live site: none of ${pages} collection pages lists its own item${current.follows ? '; each shows the items that follow its own one, which no list setting reproduces' : ''}`;
      return { ...(hit ?? { reason: currentReason }), current: { mode: current.mode, ...(current.follows ? { follows: true } : {}), reason: currentReason } };
    },
    slot(node, ctx) {
      let mapping: SiteListMapping | undefined;
      let keys: Map<string, string> | undefined;
      if (ctx.source === 'collection') {
        if (!ctx.itemNode) return null;
        const ordinal = ordinalByNode.get(ctx.itemNode.wf.id);
        if (ordinal === undefined) return null;
        mapping = merge.mappings.get(`${ctx.page.name}#list${ordinal}`);
        keys = keysFor(ctx.itemNode.wf.id, ctx.itemNode, true);
      } else {
        mapping = merge.mappings.get(`${ctx.page.name}#page`);
        keys = keysFor(`page:${ctx.page.name}`, ctx.page.roots, false);
      }
      if (!mapping) return null;
      const collection = cms.collections[mapping.planIndex];
      if (!collection || collection.id !== ctx.collection.id) return null;
      const key = keys.get(node.wf.id);
      const m = key ? mapping.slots.get(key) : undefined;
      if (!m) return null;
      const kind = slotKindOf(node);
      if (kind !== m.kind) return null;
      const field = collection.fields.find((f) => f.header === m.header);
      if (!field) return null;
      hits++;
      return { field, kind: m.kind, format: m.format, reason: m.reason };
    },
  };
}

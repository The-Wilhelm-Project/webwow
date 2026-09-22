/**
 * Live-site source, part 1: crawl the published Webflow site and read what the
 * static export does not carry (SPEC B).
 *
 * A code export renders every collection list as ONE empty template item
 * (`w-dyn-bind-empty` slots) and every collection page as an empty shell; the
 * published site renders the real items, the CMS image URLs, the detail pages
 * and — most valuable — a value in every slot, which pins the slot -> field
 * mapping that `binding.ts` otherwise has to guess. This module fetches the
 * pages (bounded, same host only, through `safeFetch`) and turns each one into
 * a value table; `site-cms.ts` merges those tables into the CMS plans and
 * answers the binding oracle.
 *
 * Slot identity between the export and the live DOM: both are walked in
 * pre-order with the same skip rules as `html.ts` (`convertChildren`), and
 * every element gets the key `<tag>.<site classes>#<ordinal among equal keys>`
 * inside its container (a collection item, or the page body with the lists
 * skipped). The live clones of a template share the element sequence with the
 * template, so equal keys mean "the same slot". Loose text runs between
 * elements count like the synthetic text nodes `html.ts` creates for them.
 *
 * Nothing here is fatal: every failure is a `site_*` warning and the import
 * continues with what it has — a page that cannot be parsed (pathological
 * markup) counts as failed, and every walk over the live DOM is iterative and
 * stops `MAX_WALK_DEPTH` levels down, so no page can blow the stack. No
 * cookies, tokens or headers beyond `accept` are ever sent to the site host;
 * no script from the live page is read.
 */

import { parse, HTMLElement, NodeType, type Node } from 'node-html-parser';
import { isFrameworkClass } from './framework-classes';
import { BUDGET_EXHAUSTED_ERROR, ByteBudget, checkUrlSafety, envRelaxedHosts, isAllowedHost, safeFetch, type SafeFetchResult } from './safe-fetch';
import type { Warnings } from './warnings';

// ─── Types ────────────────────────────────────────────────────────────────────

/** One element of a live item / page that may carry a CMS value. */
export interface SiteSlotValue {
  /** `<tag>.<classes>#<ordinal>` — see the module comment. */
  key: string;
  tag: string;
  /** Site classes (framework and state classes removed). */
  classes: string[];
  /** Text of a textual leaf (headings, paragraphs, text-only elements). */
  text?: string;
  /** `<img src>` resolved to an absolute URL. */
  src?: string;
  /** Inline `background-image: url(…)` resolved to an absolute URL. */
  bg?: string;
  /** `<a href>` resolved to an absolute URL. */
  href?: string;
  /** Inner HTML of a `.w-richtext` block. */
  html?: string;
  /** The live element still carries `w-dyn-bind-empty` (the item has no value there). */
  empty: boolean;
}

export interface SiteItem {
  /** Slot key -> value; only value-bearing or empty-marked elements are kept. */
  values: Map<string, SiteSlotValue>;
  /** Same-host link paths inside the item (`/werke/affinitat`). */
  links: string[];
  /** Every image URL inside the item, nested lists included (multi-image galleries). */
  images: string[];
}

export interface SitePagination {
  previous?: string;
  next?: string;
  /** `.w-page-count` text (`Seite 2 von 3`). */
  count?: string;
  /** Query parameter name (`7c3d1e2f_page`). */
  param?: string;
}

export interface SiteList {
  /** n-th top-level `.w-dyn-list` on the page (document order). */
  ordinal: number;
  /** `<tag>.<classes>` of the list element (template identity check). */
  key: string;
  items: SiteItem[];
  pagination?: SitePagination;
}

export interface SitePage {
  /** Normalised path without query (`/`, `/work`, `/werke/affinitat`). */
  path: string;
  /** URL that was fetched. */
  url: string;
  title: string;
  /** `<meta name="description">` content, when the page has one. */
  description?: string;
  lang?: string;
  canonical?: string;
  /** `<link rel="alternate" hreflang>` entries. */
  alternates: { lang: string; href: string }[];
  lists: SiteList[];
  /** Page-level slot values (top-level lists skipped). */
  values: Map<string, SiteSlotValue>;
  /** Same-host link paths found anywhere on the page (discovery). */
  links: string[];
  /** Every image URL on the page outside the top-level lists, nested lists included. */
  images: string[];
}

export interface SiteCrawlLimits {
  /** Default 300. */
  maxPages: number;
  /** Default 4. */
  concurrency: number;
  /** Default 20 000 ms. */
  timeoutMs: number;
  /** Default 20 MiB. */
  maxPageBytes: number;
  /** Default 200 MiB. */
  totalBytes: number;
  /**
   * Wall-clock budget for the whole crawl. Default 120 000 ms — well inside the
   * import route's `maxDuration` (300 s); without it 300 pages x 20 s / 4 could
   * pin the request for 25 minutes. Checked between batches, and the time left
   * caps every page's own timeout so the last batch cannot overrun it.
   */
  totalMs: number;
  /** Sitemap files read at most (index + children). Default 6. */
  maxSitemaps: number;
}

export const DEFAULT_SITE_LIMITS: SiteCrawlLimits = {
  maxPages: 300,
  concurrency: 4,
  timeoutMs: 20_000,
  maxPageBytes: 20 * 2 ** 20,
  totalBytes: 200 * 2 ** 20,
  totalMs: 120_000,
  maxSitemaps: 6,
};

/** Below this many bytes left in the budget no further page is requested (a Webflow page is never that small). */
export const MIN_PAGE_BYTES = 2048;

/** `200 MB`, `0.3 MB` — one decimal below 10 MB so a small test budget does not read as `0 MB`. */
function formatMb(bytes: number): string {
  const mb = bytes / 2 ** 20;
  return String(mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10);
}

/** A collection the export knows about: its detail folder and the item slugs from CSV/API. */
export interface SiteCollectionHint {
  name: string;
  /** Folder slug of the collection pages (`werke` for `detail_werke.html`), null when the export has no detail page. */
  folder: string | null;
  slugs: string[];
}

export type SiteFetch = (url: string, opts: { timeoutMs: number; maxBytes: number; budget: ByteBudget }) => Promise<SafeFetchResult>;

export interface CrawlSiteInput {
  baseUrl: string;
  /** Live paths of the export's static pages (`/`, `/work`, …). */
  pagePaths: string[];
  collections: SiteCollectionHint[];
  warn: Warnings;
  /** Injectable for tests (default: `safeFetch` restricted to the site host). */
  fetch?: SiteFetch;
  /** DNS stub for tests (`checkSiteUrl` of the base URL and of a canonical-host redirect target). */
  lookupImpl?: CheckSiteUrlOptions['lookupImpl'];
  limits?: Partial<SiteCrawlLimits>;
}

export interface WfSiteCrawl {
  baseUrl: string;
  /** Origin the pages were read from: the base URL's, or the one it redirected to (`example.com` -> `www.example.com`). */
  origin: string;
  host: string;
  /** The base URL answered (false -> nothing else was tried). */
  reachable: boolean;
  /** path -> page (static pages and every fetched detail page). */
  pages: Map<string, SitePage>;
  /** folder -> slug -> detail page. */
  detail: Map<string, Map<string, SitePage>>;
  /** Distinct `hreflang` languages seen (without `x-default`). */
  locales: string[];
  stats: { fetched: number; failed: number; skipped: number; bytes: number };
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

export const MAX_SITE_URL_LENGTH = 2048;

export interface CheckSiteUrlOptions {
  lookupImpl?: (host: string) => Promise<{ address: string }[]>;
  /** Hosts that may be private / plain http (default `envRelaxedHosts()`). */
  relaxedHosts?: RegExp[];
}

/**
 * Validate a user-supplied site URL: http(s) only, no credentials, at most
 * 2 KB, default port only (80/443 — a published site never listens elsewhere,
 * and an explicit port would make the crawl a port probe), host public (or
 * operator-listed outside production, which may also use another port — the
 * fixture site of the verification setup). Returns the origin to crawl or the
 * reason it was refused. Used by the import route (`website_invalid`) and by
 * `crawlSite` before the first request.
 */
export async function checkSiteUrl(raw: string, opts: CheckSiteUrlOptions = {}): Promise<{ ok: true; origin: string; host: string } | { ok: false; error: string }> {
  const value = raw.trim();
  if (!value) return { ok: false, error: 'empty URL' };
  if (value.length > MAX_SITE_URL_LENGTH) return { ok: false, error: `URL longer than ${MAX_SITE_URL_LENGTH} characters` };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
  } catch {
    return { ok: false, error: `not a valid URL: ${value}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: `only http(s) URLs are allowed (${url.protocol})` };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, error: 'URL has no host' };
  const relaxed = opts.relaxedHosts ?? envRelaxedHosts();
  const problem = await checkUrlSafety(url, [hostPattern(host)], opts.lookupImpl, { allowHttp: true, relaxedHosts: relaxed });
  if (problem) return { ok: false, error: problem };
  if (url.port && !isAllowedHost(host, relaxed)) return { ok: false, error: `only the default port is allowed (got :${url.port})` };
  return { ok: true, origin: url.origin, host };
}

function hostPattern(host: string): RegExp {
  return new RegExp(`^${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
}

/** `/work/` -> `/work`, `index.html` -> `/`, keeps `/`. Null for off-site or non-page targets. */
export function normalisePath(href: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, `${origin}/`);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  let path = url.pathname.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, '');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (!path.startsWith('/')) path = `/${path}`;
  if (path === '' || path === '/index') path = '/';
  return path;
}

/** Live path of an export page basename: `index` -> `/`, `work` -> `/work`. */
export function pagePathOf(basename: string): string {
  return basename === 'index' ? '/' : `/${basename}`;
}

function firstUrlOf(style: string | undefined): string | null {
  if (!style) return null;
  const m = style.match(/background(?:-image)?\s*:\s*url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/i);
  const raw = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim().replace(/&quot;/g, '');
  return raw || null;
}

function absolute(href: string, pageUrl: string): string {
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return href;
  }
}

// ─── Page parsing ─────────────────────────────────────────────────────────────

const PARSE_OPTIONS = { comment: false, blockTextElements: { script: true, style: true, noscript: true } } as const;
/** Mirrors `html.ts` DROP_TAGS. */
const DROP_TAGS = new Set(['script', 'link', 'meta', 'noscript', 'template', 'style', 'head', 'title', 'base']);
/** Mirrors `html.ts` INLINE_MARKS. */
const INLINE_MARKS = new Set(['strong', 'em', 'b', 'i', 'u', 's', 'span', 'small', 'sup', 'sub', 'mark', 'code', 'abbr', 'del', 'ins']);
/** Elements `html.ts` converts without descending into their children. */
const LEAF_CLASSES = ['w-richtext', 'w-embed', 'w-background-video', 'w-lightbox'];
const LEAF_TAGS = new Set(['svg', 'iframe', 'hr', 'video', 'audio', 'canvas']);
const HEADING_RE = /^h[1-6]$/;

function tagOf(el: HTMLElement): string {
  return (el.rawTagName ?? '').toLowerCase();
}

function classList(el: HTMLElement): string[] {
  return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

function elementChildren(el: HTMLElement): HTMLElement[] {
  return el.childNodes.filter((c): c is HTMLElement => c instanceof HTMLElement);
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * Deepest element level any walk descends to. A Webflow page is a few dozen
 * levels deep; a live page with pathological nesting (30 000 open `<div>`s)
 * would otherwise overflow the stack inside the parser library's recursive
 * `querySelectorAll` / `text` / `innerHTML`, which is why every traversal here
 * is iterative and everything below this depth is skipped.
 */
export const MAX_WALK_DEPTH = 512;

function isElement(node: Node): node is HTMLElement {
  return node instanceof HTMLElement;
}

/** Element descendants of `el` in document order, iteratively, at most `MAX_WALK_DEPTH` levels below `el`. */
function descendantsOf(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  const stack: { el: HTMLElement; depth: number }[] = [];
  for (let i = el.childNodes.length - 1; i >= 0; i--) {
    const c = el.childNodes[i];
    if (isElement(c)) stack.push({ el: c, depth: 1 });
  }
  while (stack.length > 0) {
    const { el: cur, depth } = stack.pop()!;
    out.push(cur);
    if (depth >= MAX_WALK_DEPTH) continue;
    for (let i = cur.childNodes.length - 1; i >= 0; i--) {
      const c = cur.childNodes[i];
      if (isElement(c)) stack.push({ el: c, depth: depth + 1 });
    }
  }
  return out;
}

/** First element below `el` (document order, bounded depth) that satisfies `pred`. */
function findFirst(el: HTMLElement, pred: (e: HTMLElement) => boolean): HTMLElement | null {
  const stack: { el: HTMLElement; depth: number }[] = [];
  for (let i = el.childNodes.length - 1; i >= 0; i--) {
    const c = el.childNodes[i];
    if (isElement(c)) stack.push({ el: c, depth: 1 });
  }
  while (stack.length > 0) {
    const { el: cur, depth } = stack.pop()!;
    if (pred(cur)) return cur;
    if (depth >= MAX_WALK_DEPTH) continue;
    for (let i = cur.childNodes.length - 1; i >= 0; i--) {
      const c = cur.childNodes[i];
      if (isElement(c)) stack.push({ el: c, depth: depth + 1 });
    }
  }
  return null;
}

function hasClass(el: HTMLElement, name: string): boolean {
  return classList(el).includes(name);
}

/** Browser-like text of an element (whitespace collapsed, `<br>` -> newline); iterative, bounded depth. */
export function textOf(el: HTMLElement): string {
  const parts: string[] = [];
  const stack: { node: Node; depth: number }[] = [];
  for (let i = el.childNodes.length - 1; i >= 0; i--) stack.push({ node: el.childNodes[i], depth: 1 });
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (node.nodeType === NodeType.TEXT_NODE) {
      parts.push(collapseWhitespace((node as unknown as { text: string }).text));
      continue;
    }
    if (!isElement(node)) continue;
    if (tagOf(node) === 'br') {
      parts.push('\n');
      continue;
    }
    if (depth >= MAX_WALK_DEPTH) continue;
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push({ node: node.childNodes[i], depth: depth + 1 });
  }
  return parts
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Mirrors `html.ts` isTextual: only text, `<br>` and inline marks without element children, with some text. */
function isTextual(el: HTMLElement): boolean {
  const nodes = el.childNodes;
  if (nodes.length === 0) return false;
  let hasContent = false;
  for (const node of nodes) {
    if (node.nodeType === NodeType.TEXT_NODE) {
      if ((node as unknown as { text: string }).text.trim()) hasContent = true;
      continue;
    }
    if (!(node instanceof HTMLElement)) continue;
    const tag = tagOf(node);
    if (tag === 'br') continue;
    if (!INLINE_MARKS.has(tag)) return false;
    if (elementChildren(node).some((c) => tagOf(c) !== 'br' && !INLINE_MARKS.has(tagOf(c)))) return false;
    if (textOf(node)) hasContent = true;
  }
  return hasContent;
}

/**
 * Ordinal counter shared by one container walk: `next('div', ['thin'])` yields
 * `div.thin#0`, `div.thin#1`, … `site-cms.ts` runs the same counter over the
 * export's `WfNode` template so both sides agree on the key of a slot.
 */
export class SlotKeyCounter {
  private readonly counts = new Map<string, number>();

  next(tag: string, classes: string[]): string {
    const base = `${tag}.${classes.join('.')}`;
    const n = this.counts.get(base) ?? 0;
    this.counts.set(base, n + 1);
    return `${base}#${n}`;
  }
}

interface WalkSink {
  counter: SlotKeyCounter;
  values: Map<string, SiteSlotValue>;
  links: string[];
  images: string[];
  pageUrl: string;
  origin: string;
}

/** `<img src>` and inline background URLs below `el` (the element itself included), for the image fallback table. */
function collectImages(el: HTMLElement, sink: WalkSink): void {
  const add = (raw: string | null | undefined) => {
    const value = (raw ?? '').trim();
    if (!value || /^data:/i.test(value)) return;
    sink.images.push(absolute(value, sink.pageUrl));
  };
  if (tagOf(el) === 'img') add(el.getAttribute('src'));
  add(firstUrlOf(el.getAttribute('style')));
  for (const node of descendantsOf(el)) {
    if (tagOf(node) === 'img') add(node.getAttribute('src'));
    const style = node.getAttribute('style');
    if (style) add(firstUrlOf(style));
  }
}

function recordLinksBelow(el: HTMLElement, sink: WalkSink): void {
  for (const node of descendantsOf(el)) if (tagOf(node) === 'a') recordLink(sink, node.getAttribute('href') ?? '');
}

function recordLink(sink: WalkSink, href: string): void {
  const path = normalisePath(href, sink.origin);
  if (path) sink.links.push(path);
}

/**
 * Walk the children of `el` exactly like `html.ts` converts them, assigning a
 * key to every element that becomes a node there, and collect the values.
 * Top-level and nested `.w-dyn-list` subtrees are skipped: their live clones
 * would shift the ordinals of everything after them.
 */
function walkChildren(el: HTMLElement, sink: WalkSink, depth = 0): void {
  let run = '';
  const flush = () => {
    if (run.trim()) sink.counter.next('div', []);
    run = '';
  };
  for (const child of el.childNodes) {
    if (child.nodeType === NodeType.TEXT_NODE) {
      run += (child as unknown as { text: string }).text;
      continue;
    }
    if (!(child instanceof HTMLElement)) continue;
    if (tagOf(child) === 'br') continue;
    flush();
    visit(child, sink, depth + 1);
  }
  flush();
}

function visit(el: HTMLElement, sink: WalkSink, depth: number): void {
  const tag = tagOf(el);
  if (DROP_TAGS.has(tag)) return;
  // Pathological nesting: everything below the cap is skipped, the page survives.
  if (depth > MAX_WALK_DEPTH) return;
  const classes = classList(el);
  if (classes.includes('w-dyn-empty')) return;
  if (classes.includes('w-dyn-list')) {
    // Not a slot container (its clones would shift every ordinal after it), but
    // its images still belong to the item: a nested gallery list.
    if (sink.images !== NO_IMAGES) collectImages(el, sink);
    return;
  }
  const siteClasses = classes.filter((c) => !isFrameworkClass(c));
  const key = sink.counter.next(tag, siteClasses);
  const value: SiteSlotValue = { key, tag, classes: siteClasses, empty: classes.includes('w-dyn-bind-empty') };
  let carries = value.empty;

  const bg = firstUrlOf(el.getAttribute('style'));
  if (bg && !/^data:/i.test(bg)) {
    value.bg = absolute(bg, sink.pageUrl);
    carries = true;
  }

  if (value.bg) sink.images.push(value.bg);
  if (tag === 'img') {
    const src = (el.getAttribute('src') ?? '').trim();
    if (src && !/^data:/i.test(src)) {
      value.src = absolute(src, sink.pageUrl);
      sink.images.push(value.src);
      carries = true;
    }
    if (carries) sink.values.set(key, value);
    return;
  }

  if (tag === 'a') {
    const href = (el.getAttribute('href') ?? '').trim();
    if (href && !/^(#|javascript:|mailto:|tel:)/i.test(href)) {
      value.href = absolute(href, sink.pageUrl);
      recordLink(sink, href);
      carries = true;
    }
  }

  const leafByClass = LEAF_CLASSES.some((c) => classes.includes(c));
  if (classes.includes('w-richtext')) {
    try {
      value.html = el.innerHTML.trim();
    } catch {
      // The library serialises recursively; a rich text nested beyond the stack is an empty one.
      value.html = '';
    }
    if (value.html) carries = true;
    sink.values.set(key, value);
    recordLinksBelow(el, sink);
    return;
  }
  if (leafByClass || LEAF_TAGS.has(tag)) {
    if (carries) sink.values.set(key, value);
    if (tag !== 'svg') collectImages(el, sink);
    return;
  }

  const children = elementChildren(el);
  const textual = HEADING_RE.test(tag) || tag === 'p' || isTextual(el) || (children.length === 0 && (tag !== 'a' || value.empty));
  if (textual) {
    const text = textOf(el);
    if (text) {
      value.text = text;
      carries = true;
    } else if (children.length === 0) {
      value.text = '';
      carries = true;
    }
    if (carries) sink.values.set(key, value);
    recordLinksBelow(el, sink);
    return;
  }

  if (carries) sink.values.set(key, value);
  walkChildren(el, sink, depth);
}

function isTopLevelList(list: HTMLElement): boolean {
  let cur = list.parentNode as HTMLElement | null;
  while (cur) {
    if (cur instanceof HTMLElement && classList(cur).includes('w-dyn-item')) return false;
    cur = cur.parentNode as HTMLElement | null;
  }
  return true;
}

function nearestList(el: HTMLElement): HTMLElement | null {
  let cur = el.parentNode as HTMLElement | null;
  while (cur) {
    if (cur instanceof HTMLElement && classList(cur).includes('w-dyn-list')) return cur;
    cur = cur.parentNode as HTMLElement | null;
  }
  return null;
}

function parsePagination(list: HTMLElement): SitePagination | undefined {
  const wrapper = findFirst(list, (e) => hasClass(e, 'w-pagination-wrapper'));
  if (!wrapper) return undefined;
  const out: SitePagination = {};
  const prev = findFirst(wrapper, (e) => hasClass(e, 'w-pagination-previous'))?.getAttribute('href');
  const next = findFirst(wrapper, (e) => hasClass(e, 'w-pagination-next'))?.getAttribute('href');
  if (prev) out.previous = prev;
  if (next) out.next = next;
  const count = findFirst(wrapper, (e) => hasClass(e, 'w-page-count'));
  if (count) out.count = textOf(count);
  const param = (next ?? prev ?? '').match(/[?&]([A-Za-z0-9_]+_page)=/);
  if (param) out.param = param[1];
  return out;
}

/** Sentinel for a walk that must not collect nested-list images (never the case today; kept explicit). */
const NO_IMAGES: string[] = [];

/**
 * Pure: one live HTML document -> value tables. `pageUrl` resolves relative
 * links and image URLs. Every traversal is iterative and depth-bounded
 * (`MAX_WALK_DEPTH`); the callers still guard against a throwing parser.
 */
export function parseSitePage(html: string, pageUrl: string): SitePage {
  const root = parse(html, PARSE_OPTIONS);
  const origin = new URL(pageUrl).origin;
  const path = normalisePath(pageUrl, origin) ?? '/';
  const page: SitePage = { path, url: pageUrl, title: '', alternates: [], lists: [], values: new Map(), links: [], images: [] };

  const htmlEl = findFirst(root, (e) => tagOf(e) === 'html');
  const lang = htmlEl?.getAttribute('lang')?.trim();
  if (lang) page.lang = lang;
  const head = findFirst(root, (e) => tagOf(e) === 'head');
  if (head) {
    page.title = textOf(findFirst(head, (e) => tagOf(e) === 'title') ?? head).split('\n')[0] ?? '';
    for (const link of descendantsOf(head)) {
      if (tagOf(link) === 'meta') {
        if ((link.getAttribute('name') ?? '').trim().toLowerCase() === 'description') {
          const content = (link.getAttribute('content') ?? '').trim();
          if (content && page.description === undefined) page.description = content;
        }
        continue;
      }
      if (tagOf(link) !== 'link') continue;
      const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
      const href = (link.getAttribute('href') ?? '').trim();
      if (!href) continue;
      if (rel.includes('canonical')) page.canonical = absolute(href, pageUrl);
      if (rel.includes('alternate')) {
        const hreflang = (link.getAttribute('hreflang') ?? '').trim();
        if (hreflang) page.alternates.push({ lang: hreflang, href: absolute(href, pageUrl) });
      }
    }
  }
  if (!page.title) {
    const title = findFirst(root, (e) => tagOf(e) === 'title');
    page.title = (title ? textOf(title) : '').split('\n')[0] ?? '';
  }

  const body = findFirst(root, (e) => tagOf(e) === 'body') ?? root;
  const pageSink: WalkSink = { counter: new SlotKeyCounter(), values: page.values, links: page.links, images: page.images, pageUrl, origin };
  walkChildren(body, pageSink);

  const lists = descendantsOf(body).filter((e) => hasClass(e, 'w-dyn-list') && isTopLevelList(e));
  lists.forEach((list, ordinal) => {
    const key = `${tagOf(list)}.${classList(list).filter((c) => !isFrameworkClass(c)).join('.')}`;
    const entry: SiteList = { ordinal, key, items: [] };
    const items = descendantsOf(list).filter((item) => hasClass(item, 'w-dyn-item') && nearestList(item) === list);
    for (const item of items) {
      const links: string[] = [];
      const images: string[] = [];
      const values = new Map<string, SiteSlotValue>();
      const sink: WalkSink = { counter: new SlotKeyCounter(), values, links, images, pageUrl, origin };
      // The item element itself is a slot candidate too (a bound background on the card).
      const itemClasses = classList(item).filter((c) => !isFrameworkClass(c));
      const itemKey = sink.counter.next(tagOf(item), itemClasses);
      const bg = firstUrlOf(item.getAttribute('style'));
      if (bg && !/^data:/i.test(bg)) {
        const url = absolute(bg, pageUrl);
        values.set(itemKey, { key: itemKey, tag: tagOf(item), classes: itemClasses, bg: url, empty: false });
        images.push(url);
      }
      walkChildren(item, sink);
      entry.items.push({ values, links, images: [...new Set(images)] });
      for (const l of links) page.links.push(l);
    }
    const pagination = parsePagination(list);
    if (pagination) entry.pagination = pagination;
    page.lists.push(entry);
  });

  for (const a of descendantsOf(body)) {
    if (tagOf(a) !== 'a') continue;
    const path = normalisePath(a.getAttribute('href') ?? '', origin);
    if (path) page.links.push(path);
  }
  page.links = [...new Set(page.links)];
  // The page-level walk skips the top-level lists; a collection page's own
  // gallery (a nested image list bound to the current item) is still its image.
  page.images = [...new Set(page.images)];
  return page;
}

/** `<loc>` entries of a sitemap (or sitemap index), same origin only. */
export function parseSitemap(xml: string, origin: string): { pages: string[]; sitemaps: string[] } {
  const pages: string[] = [];
  const sitemaps: string[] = [];
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const loc = m[1].replace(/&amp;/g, '&');
    let url: URL;
    try {
      url = new URL(loc);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    if (isIndex || /\.xml(\?|$)/i.test(url.pathname)) {
      sitemaps.push(url.toString());
      continue;
    }
    const path = normalisePath(url.toString(), origin);
    if (path) pages.push(path);
  }
  return { pages: [...new Set(pages)], sitemaps: [...new Set(sitemaps)] };
}

// ─── Crawl ────────────────────────────────────────────────────────────────────

function isHtml(result: Extract<SafeFetchResult, { ok: true }>): boolean {
  const type = result.contentType.toLowerCase();
  if (type.includes('html') || type.includes('xhtml')) return true;
  if (type.startsWith('text/') || type === 'application/octet-stream' || !type) {
    const head = result.buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
    return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head');
  }
  return false;
}

function defaultFetch(host: string): SiteFetch {
  const allow = [hostPattern(host)];
  // The relaxation (plain http / private address for an operator-listed host outside
  // production) is passed explicitly: `safeFetch` relaxes nothing on its own.
  const relaxed = envRelaxedHosts();
  return (url, opts) => safeFetch(url, { ...opts, allowHosts: allow, allowHttp: true, relaxedHosts: relaxed });
}

/** `/werke/affinitat` -> `{ folder: 'werke', slug: 'affinitat' }` when `werke` is a known folder. */
function detailOf(path: string, folders: Set<string>): { folder: string; slug: string } | null {
  const m = path.match(/^\/([^/]+)\/([^/?#]+)$/);
  if (!m) return null;
  const folder = m[1].toLowerCase();
  if (!folders.has(folder)) return null;
  return { folder, slug: m[2] };
}

/**
 * Fetch the site's pages (static pages of the export, sitemap entries, one
 * page per collection item, pagination pages and item links discovered on the
 * way) within the limits and return their value tables. Never throws.
 */
export async function crawlSite(input: CrawlSiteInput): Promise<WfSiteCrawl> {
  const { warn } = input;
  const limits: SiteCrawlLimits = { ...DEFAULT_SITE_LIMITS, ...input.limits };
  const budget = new ByteBudget(limits.totalBytes);
  const folders = new Set(input.collections.map((c) => c.folder).filter((f): f is string => !!f));
  const crawl: WfSiteCrawl = {
    baseUrl: input.baseUrl,
    origin: '',
    host: '',
    reachable: false,
    pages: new Map(),
    detail: new Map(),
    locales: [],
    stats: { fetched: 0, failed: 0, skipped: 0, bytes: 0 },
  };
  for (const f of folders) crawl.detail.set(f, new Map());

  const site = await checkSiteUrl(input.baseUrl, input.lookupImpl ? { lookupImpl: input.lookupImpl } : {});
  if (!site.ok) {
    warn.add('site_unreachable', `website ${input.baseUrl} refused: ${site.error}`);
    return crawl;
  }
  let { origin, host } = site;
  crawl.origin = origin;
  crawl.host = host;
  let fetchPage = input.fetch ?? defaultFetch(host);
  const deadline = Date.now() + limits.totalMs;
  const timeLeft = (): number => deadline - Date.now();
  // Every page's own timeout is capped by the time the crawl has left.
  const fetchOpts = (): { timeoutMs: number; maxBytes: number; budget: ByteBudget } => ({
    timeoutMs: Math.max(1, Math.min(limits.timeoutMs, timeLeft())),
    maxBytes: limits.maxPageBytes,
    budget,
  });
  // Pages not read because a budget ran out mid-batch; reported once, aggregated.
  let budgetExhausted = false;
  let heldByBudget = 0;
  let heldByTime = 0;
  const locales = new Set<string>();

  const queue: string[] = [];
  const queued = new Set<string>();
  const enqueue = (path: string, front = false): void => {
    if (queued.has(path)) return;
    queued.add(path);
    if (front) queue.unshift(path);
    else queue.push(path);
  };

  // Pages the site says it has — before the ones we guess from item slugs.
  // (Filled after the probe: a canonical-host redirect may change the origin.)
  const sitemapQueue: string[] = [];
  const sitemapsSeen = new Set<string>();
  let sitemapPaths: string[] = [];

  /** A page the parser cannot digest is a failed page, never a failed import. */
  const parseOrFail = (html: string, url: string, path: string): SitePage | null => {
    try {
      return parseSitePage(html, url);
    } catch {
      crawl.stats.failed++;
      warn.add('site_page_failed', `${path}: could not parse page`);
      return null;
    }
  };

  /**
   * The one host change the crawl accepts: the base URL answers with a redirect
   * to the same site with or without a leading `www.` (a canonical-host
   * redirect, the most common reason a correct address "does not answer").
   * The target is validated like the input; afterwards every request stays on
   * the new origin.
   */
  const rebaseTo = async (target: string): Promise<boolean> => {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return false;
    }
    const to = url.hostname.toLowerCase();
    const from = host.toLowerCase();
    if (to === from || (to !== `www.${from}` && from !== `www.${to}`)) return false;
    const check = await checkSiteUrl(url.origin, input.lookupImpl ? { lookupImpl: input.lookupImpl } : {});
    if (!check.ok) return false;
    origin = check.origin;
    host = check.host;
    crawl.origin = origin;
    crawl.host = host;
    if (!input.fetch) fetchPage = defaultFetch(host);
    return true;
  };

  const fetchOne = async (path: string): Promise<void> => {
    const url = `${origin}${path}`;
    if (budgetExhausted || budget.remaining < MIN_PAGE_BYTES) {
      crawl.stats.skipped++;
      heldByBudget++;
      return;
    }
    if (timeLeft() <= 0) {
      crawl.stats.skipped++;
      heldByTime++;
      return;
    }
    const result = await fetchPage(url, fetchOpts());
    if (!result.ok) {
      if (result.error === BUDGET_EXHAUSTED_ERROR) {
        // Not a page problem: the crawl's own limit. Counted once below.
        budgetExhausted = true;
        crawl.stats.skipped++;
        heldByBudget++;
        return;
      }
      if (timeLeft() <= 0 && /^timeout/.test(result.error)) {
        crawl.stats.skipped++;
        heldByTime++;
        return;
      }
      crawl.stats.failed++;
      warn.add('site_page_failed', `${path}: ${result.error}`);
      return;
    }
    crawl.stats.bytes += result.buffer.length;
    if (!isHtml(result)) {
      crawl.stats.skipped++;
      warn.add('site_page_skipped', `${path}: not an HTML page (${result.contentType})`);
      return;
    }
    const page = parseOrFail(result.buffer.toString('utf8'), url, path);
    if (!page) return;
    crawl.stats.fetched++;
    page.path = path.replace(/\?.*$/, '') || '/';
    for (const alt of page.alternates) {
      const lang = alt.lang.trim().toLowerCase();
      if (lang && lang !== 'x-default') locales.add(lang);
    }
    const query = path.includes('?') ? path.slice(path.indexOf('?')) : '';
    if (query) {
      // A pagination page: append its items to the base page's lists.
      const base = crawl.pages.get(page.path);
      if (base) {
        for (const list of page.lists) {
          const target = base.lists[list.ordinal];
          if (target && target.key === list.key) target.items.push(...list.items);
        }
      }
    } else if (!crawl.pages.has(page.path)) {
      crawl.pages.set(page.path, page);
      const detail = detailOf(page.path, folders);
      if (detail) crawl.detail.get(detail.folder)?.set(detail.slug, page);
    }
    // Discovery: item pages of known folders and the next pagination page.
    for (const link of page.links) {
      if (detailOf(link, folders)) enqueue(link);
    }
    for (const list of page.lists) {
      const next = list.pagination?.next;
      if (!next) continue;
      try {
        const nextUrl = new URL(next, url);
        if (nextUrl.origin !== origin) continue;
        const nextPath = `${page.path}${nextUrl.search}`;
        if (nextUrl.search) enqueue(nextPath, true);
      } catch {
        // ignore malformed pagination links
      }
    }
  };

  // 1. Reachability: the first static page (usually `/`). One redirect to the
  //    same site with / without `www.` re-bases the crawl; any other refused
  //    redirect is an unreachable site.
  const staticPaths = [...new Set(input.pagePaths.map((p) => normalisePath(p, origin) ?? p))].sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : 0));
  const first = staticPaths[0] ?? '/';
  let probe = await fetchPage(`${origin}${first}`, fetchOpts());
  if (!probe.ok && probe.redirect && (await rebaseTo(probe.redirect))) {
    probe = await fetchPage(`${origin}${first}`, fetchOpts());
  }
  if (!probe.ok) {
    warn.add('site_unreachable', `website ${origin} could not be read (${first}: ${probe.error})`);
    return crawl;
  }
  crawl.reachable = true;
  if (isHtml(probe)) {
    crawl.stats.bytes += probe.buffer.length;
    const page = parseOrFail(probe.buffer.toString('utf8'), `${origin}${first}`, first);
    if (page) {
      crawl.stats.fetched++;
      page.path = first;
      crawl.pages.set(first, page);
      for (const alt of page.alternates) {
        const lang = alt.lang.trim().toLowerCase();
        if (lang && lang !== 'x-default') locales.add(lang);
      }
      for (const link of page.links) if (detailOf(link, folders)) enqueue(link);
      for (const list of page.lists) {
        const next = list.pagination?.next;
        if (!next) continue;
        try {
          const nextUrl = new URL(next, `${origin}${first}`);
          if (nextUrl.origin === origin && nextUrl.search) enqueue(`${page.path}${nextUrl.search}`, true);
        } catch {
          // ignore
        }
      }
    }
    queued.add(first);
  } else {
    crawl.stats.skipped++;
    warn.add('site_page_skipped', `${first}: not an HTML page (${probe.contentType})`);
  }

  // 2. Sitemap(s): same origin only, bounded.
  sitemapQueue.push(`${origin}/sitemap.xml`);
  while (sitemapQueue.length > 0 && sitemapsSeen.size < limits.maxSitemaps && timeLeft() > 0 && budget.remaining >= MIN_PAGE_BYTES) {
    const sitemapUrl = sitemapQueue.shift()!;
    if (sitemapsSeen.has(sitemapUrl)) continue;
    sitemapsSeen.add(sitemapUrl);
    const result = await fetchPage(sitemapUrl, fetchOpts());
    if (!result.ok) {
      if (result.error === BUDGET_EXHAUSTED_ERROR) budgetExhausted = true;
      continue;
    }
    crawl.stats.bytes += result.buffer.length;
    const parsed = parseSitemap(result.buffer.toString('utf8'), origin);
    sitemapPaths.push(...parsed.pages);
    for (const child of parsed.sitemaps) if (!sitemapsSeen.has(child)) sitemapQueue.push(child);
  }
  sitemapPaths = [...new Set(sitemapPaths)];

  // 3. Queue order: static pages, sitemap pages, item pages from the CSV/API slugs.
  for (const path of staticPaths) enqueue(path);
  for (const path of sitemapPaths) enqueue(path);
  for (const c of input.collections) {
    if (!c.folder) continue;
    for (const slug of c.slugs) if (slug.trim()) enqueue(`/${c.folder}/${encodeURIComponent(slug.trim()).replace(/%2F/g, '/')}`);
  }

  // 4. Rounds of `concurrency` pages until the queue is empty or the limits are hit.
  //    Each limit is reported once, with the number of pages it kept unread.
  let processed = 1;
  const byteLabel = `download budget of ${formatMb(limits.totalBytes)} MB exhausted`;
  const timeLabel = `time budget of ${Math.round(limits.totalMs / 1000)} s exhausted`;
  const report = (reason: string, held: number): void => {
    const count = held + queue.length;
    crawl.stats.skipped += queue.length;
    if (count > 0) warn.add('site_page_skipped', `${reason}; ${count} page(s) not read`, { count });
    queue.length = 0;
  };
  while (queue.length > 0) {
    if (processed >= limits.maxPages) {
      report(`page limit of ${limits.maxPages} reached`, 0);
      break;
    }
    if (budgetExhausted || budget.remaining < MIN_PAGE_BYTES) {
      report(byteLabel, heldByBudget);
      heldByBudget = 0;
      break;
    }
    if (timeLeft() <= 0) {
      report(timeLabel, heldByTime);
      heldByTime = 0;
      break;
    }
    const room = Math.max(1, Math.min(limits.concurrency, limits.maxPages - processed));
    const batch = queue.splice(0, room);
    processed += batch.length;
    await Promise.all(batch.map((path) => fetchOne(path)));
  }
  // A limit hit inside the last batch, with nothing left in the queue to hold back.
  if (heldByBudget > 0) report(byteLabel, heldByBudget);
  if (heldByTime > 0) report(timeLabel, heldByTime);

  crawl.locales = [...locales].sort();
  if (crawl.locales.length > 1) {
    warn.add('locales_collapsed', `the live site publishes ${crawl.locales.length} languages (${crawl.locales.join(', ')}); the import keeps one`);
  }
  return crawl;
}

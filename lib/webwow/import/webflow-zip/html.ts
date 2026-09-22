/**
 * Webflow page HTML -> `WfPage` (node-html-parser).
 *
 * One exported page becomes a tree of `WfNode`s — upstream's neutral import IR
 * (`ImportNode`, consumed unchanged by `ImportConverter`) plus a `wf` side-car
 * with everything the Webflow-specific passes need (original classes, ids,
 * `data-w-id`, widget roles, binding slots). Framework markup (`w-*` classes)
 * is translated here: navbars, dropdowns, background videos, embeds, rich
 * text and collection lists become roles; `w-dyn-bind-empty` leaves are KEPT
 * as empty binding slots (D2); `.w-dyn-empty` blocks are dropped.
 *
 * Styling per node (SPEC §4.7): reusable refs come from the style model
 * (base class, then every combo chain), framework shims from
 * `framework-classes.ts`, one-off classes from `#w-node-*` grid rules plus the
 * `wf-<name>` namespaced classes residual CSS still needs (D1).
 *
 * `parsePage` is synchronous; SVG files referenced by `<img>` are pre-read
 * with `loadSvgIcons` and handed in through `HtmlContext.svgFiles`.
 */

import { parse, HTMLElement, NodeType, type Node } from 'node-html-parser';
import type { ImportImage, ImportStyleRef } from '@/lib/import/types';
import type { TweenProperties } from '@/types';
import { BREAKPOINT_PREFIX, UNDERLAY_TAGS, liftComboOverBreakpoints, mergePrefixedClasses, namespaceSelector, wfClass, type WfStyleModel } from './css';
import type { CssDeclaration } from './css-tokenizer';
import { richTextStylesFor } from './richtext-styles';
import {
  DROPDOWN_CHEVRON_SVG,
  FRAMEWORK_CLASSES,
  isFrameworkClass,
  isKnownFrameworkClass,
  navFrameworkClasses,
  setsPosition,
} from './framework-classes';
import {
  FORM_CONTROL_TAGS,
  parseLightboxPayload,
  planFormControl,
  resolveWidgetFlags,
  sliderSettingsFromAttrs,
  type WfWidgetFlags,
} from './widgets-native';
import {
  BG_VIDEO_TOGGLE_SCRIPT,
  CODE_BLOCK_CLASSES,
  DROPDOWN_RUNTIME_SCRIPT,
  FILE_UPLOAD_NOTE,
  FILE_UPLOAD_STATE_CLASSES,
  LOCALES_NOTE,
  MAP_KEY_NOTE,
  SEARCH_NOTE,
  UNSUPPORTED_WIDGET_NOTES,
  embedVideoClasses,
  iconFontSvg,
  inlineStyleClasses,
  isSearchForm,
  languageFromClasses,
  planEmbedVideo,
  planLottie,
  planMap,
  sizeFromClasses,
  unsupportedWidgetFamily,
} from './widgets-extra';
import { stateCarrier, stateHandling, stateLabel, stateTweenFromDeclarations, type WfStateRule } from './states';
import type { WfNavCollapse, WfNode, WfNodeMeta, WfNodeRole, WfPage } from './types';
import type { WfZipBundle } from './zip';
import type { Warnings } from './warnings';

// ─── Context ──────────────────────────────────────────────────────────────────

export interface HtmlContext {
  /** Page basename (`index`, `work`, …). */
  page: string;
  styles: WfStyleModel;
  zip: WfZipBundle;
  /** Basenames of every page in the export (href normalisation). */
  pageNames: Set<string>;
  /** ZIP-relative path (`images/x.jpg`) -> materializer key, null when the file is not in the export. */
  assetKey: (relPath: string) => string | null;
  warn: Warnings;
  /** Pre-read SVG files (`images/x.svg` -> sanitised markup) so `<img src="*.svg">` becomes an inline icon; see {@link loadSvgIcons}. */
  svgFiles?: Map<string, string>;
  /** Per-widget kill switches (widgets-native.ts). Unset flags keep their default (on). */
  widgets?: Partial<WfWidgetFlags>;
}

/** Read and sanitise every `.svg` file of the export (input for `HtmlContext.svgFiles`). */
export async function loadSvgIcons(zip: WfZipBundle): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [path, file] of zip.files) {
    if (!/\.svg$/i.test(path)) continue;
    try {
      const text = await file.text();
      if (/<svg[\s>]/i.test(text)) out.set(path, sanitizeSvg(text));
    } catch {
      // unreadable entry: the <img> falls back to an asset upload
    }
  }
  return out;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PARSE_OPTIONS = { comment: false, blockTextElements: { script: true, style: true, noscript: true } } as const;

/** Elements that never become layers. */
const DROP_TAGS = new Set(['script', 'link', 'meta', 'noscript', 'template', 'style', 'head', 'title', 'base']);

/** Inline marks whose text is folded into the parent text node. */
const INLINE_MARKS = new Set(['strong', 'em', 'b', 'i', 'u', 's', 'span', 'small', 'sup', 'sub', 'mark', 'code', 'abbr', 'del', 'ins']);

const HEADING_RE = /^h[1-6]$/;
const WEBFLOW_ID_PREFIX_RE = /^[0-9a-f]{24}_/i;
const DERIVATIVE_RE = /-p-\d+(\.[a-z0-9]+)$/i;

// ─── Public helpers ───────────────────────────────────────────────────────────

/** Browser-like text: whitespace runs collapse to one space, `<br>` -> `\n`, lines trimmed. */
export function textContent(el: HTMLElement): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === NodeType.TEXT_NODE) {
      parts.push(collapseWhitespace((node as unknown as { text: string }).text));
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (tagOf(node) === 'br') {
      parts.push('\n');
      return;
    }
    for (const child of node.childNodes) walk(child);
  };
  for (const child of el.childNodes) walk(child);
  return tidyText(parts.join(''));
}

/** True when the element's children are only text, `<br>` or inline marks without element children (and there is some text). */
export function isTextual(el: HTMLElement): boolean {
  const nodes = el.childNodes;
  if (nodes.length === 0) return false;
  let hasContent = false;
  for (const node of nodes) {
    if (node.nodeType === NodeType.TEXT_NODE) {
      if (/\S/.test((node as unknown as { text: string }).text)) hasContent = true;
      continue;
    }
    if (!(node instanceof HTMLElement)) continue;
    const tag = tagOf(node);
    if (tag === 'br') {
      hasContent = true;
      continue;
    }
    if (!INLINE_MARKS.has(tag)) return false;
    if (node.children.some((c) => tagOf(c) !== 'br')) return false;
    if (/\S/.test(node.text)) hasContent = true;
  }
  return hasContent;
}

/** Strip scripts, event handlers, `<foreignObject>` and `javascript:` hrefs from inline SVG markup. */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/<foreignObject\b[^>]*\/>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:xlink:)?href\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, '')
    .trim();
}

export type HrefKind = 'page' | 'anchor' | 'external' | 'broken' | 'empty';

/**
 * Normalise an exported href: `index.html` -> `/`, `<name>.html` -> `/<name>`
 * (`detail_<x>.html` -> `/<x>`), anchors kept, `#https://…` flagged as broken,
 * `mailto:` / `tel:` / absolute URLs are external, `''` / `#` are empty.
 */
export function normaliseHref(href: string, pageNames: Set<string>): { href: string; kind: HrefKind } {
  const raw = (href ?? '').trim();
  if (raw === '' || raw === '#') return { href: raw, kind: 'empty' };
  if (/^#https?:\/\//i.test(raw)) return { href: raw, kind: 'broken' };
  if (raw.startsWith('#')) return { href: raw, kind: 'anchor' };
  if (/^(mailto|tel|sms):/i.test(raw) || /^(https?:)?\/\//i.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return { href: raw, kind: 'external' };
  }
  const detail = raw.match(/^\/?detail[_-](\w+)\/([^/?#]+)$/);
  if (detail) return { href: raw, kind: 'page' };
  const page = raw.match(/^(?:\.\/)?([\w.-]+)\.html(#[^?]*)?(\?.*)?$/i);
  if (page) {
    const name = page[1];
    const suffix = page[2] ?? '';
    if (name === 'index') return { href: `/${suffix}`, kind: 'page' };
    if (pageNames.has(name)) {
      const detailName = name.match(/^detail[_-](.+)$/);
      return { href: `/${detailName ? detailName[1] : name}${suffix}`, kind: 'page' };
    }
    return { href: raw, kind: 'broken' };
  }
  if (raw.startsWith('/')) return { href: raw, kind: 'page' };
  return { href: raw, kind: 'external' };
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function tagOf(el: HTMLElement): string {
  return (el.rawTagName ?? '').toLowerCase();
}

function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\r\n\f]+/g, ' ');
}

function tidyText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** An `<img width>` a browser maps to a width (`800`, `50%`); not `auto`, empty or junk. */
export function explicitImageWidth(width: string | undefined): boolean {
  return !!width && /^\s*\d+(\.\d+)?(px|%)?\s*$/i.test(width) && parseFloat(width) > 0;
}

/** True when an inline `style` carries `display: none` (Webflow parks its script-driven state boxes that way). */
export function hasInlineDisplayNone(style: string | undefined): boolean {
  if (!style) return false;
  return style.split(';').some((decl) => {
    const idx = decl.indexOf(':');
    return idx !== -1 && decl.slice(0, idx).trim().toLowerCase() === 'display' && decl.slice(idx + 1).trim().toLowerCase().replace(/\s*!important$/, '') === 'none';
  });
}

function classList(el: HTMLElement): string[] {
  return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

/** Every attribute of an element as a plain record (lower-cased keys, as node-html-parser stores them). */
function attributesOf(el: HTMLElement): Record<string, string> {
  return { ...el.attributes };
}

/** Layer-tree label for a form control (`Input (email)`, `Select`, …). */
function friendlyControlName(name: string, type: string | number | boolean | undefined): string {
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  return typeof type === 'string' && type ? `${label} (${type})` : label;
}

function elementChildren(el: HTMLElement): HTMLElement[] {
  return el.childNodes.filter((n): n is HTMLElement => n instanceof HTMLElement);
}

function hasVisibleText(el: HTMLElement): boolean {
  return el.childNodes.some((n) => n.nodeType === NodeType.TEXT_NODE && /\S/.test((n as unknown as { text: string }).text));
}

function relativePath(src: string): string {
  return src.trim().replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/[?#].*$/, '');
}

function isRemoteUrl(src: string): boolean {
  return /^(https?:)?\/\//i.test(src) || /^(data|blob):/i.test(src);
}

function basename(p: string): string {
  return p.split('/').pop() ?? p;
}

/** `images/x-p-500.jpg` -> `images/x.jpg` (srcset derivatives are never uploaded). */
function baseImagePath(rel: string): string {
  return rel.replace(DERIVATIVE_RE, '$1');
}

function firstUrlOf(style: string | undefined): string | null {
  if (!style) return null;
  const m = style.match(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/i);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? '').trim() || null;
}

function isWebflowScript(el: HTMLElement): boolean {
  // `<script type="application/json" class="w-json">` is a lightbox gallery
  // payload, read by convertLightbox — never custom code.
  if (classList(el).includes('w-json')) return true;
  const src = el.getAttribute('src') ?? '';
  if (src) {
    return /jquery/i.test(src) || /webfont\.js/i.test(src) || /d3e54v103j8qbb\.cloudfront\.net/i.test(src) || /^(\.\/)?js\/[^/]+\.js(\?.*)?$/i.test(src);
  }
  const code = el.rawText;
  return /w-mod-/.test(code) || /WebFont\.load\s*\(/.test(code) || /Webflow\.require/.test(code);
}

/** Families requested through `WebFont.load({ google: { families: [...] } })`. */
function googleFamiliesFromScript(code: string): string[] {
  const m = code.match(/families\s*:\s*\[([^\]]*)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1].split(':')[0].trim()).filter(Boolean);
}

/** Families from a `fonts.googleapis.com/css?family=A:400|B` or `css2?family=A:wght@400&family=B` link. */
function googleFamiliesFromHref(href: string): string[] {
  const out: string[] = [];
  const query = href.split('?')[1] ?? '';
  for (const part of query.split('&')) {
    const [key, value] = part.split('=');
    if (key !== 'family' || !value) continue;
    for (const fam of decodeURIComponent(value.replace(/\+/g, ' ')).split('|')) {
      const name = fam.split(':')[0].trim();
      if (name) out.push(name);
    }
  }
  return out;
}

// ─── Style lookup ─────────────────────────────────────────────────────────────

const comboSetIndex = new WeakMap<WfStyleModel, Map<string, ImportStyleRef>>();

function comboBySet(styles: WfStyleModel): Map<string, ImportStyleRef> {
  let index = comboSetIndex.get(styles);
  if (!index) {
    index = new Map();
    for (const [chain, ref] of styles.combos) {
      const key = chain.split('.').sort().join('.');
      if (!index.has(key)) index.set(key, ref);
    }
    comboSetIndex.set(styles, index);
  }
  return index;
}

/** State rules for a chain, also matched order-insensitively (`.b.a.w--open` on an element `a b`). */
function stateRulesFor(styles: WfStyleModel, chain: string): (WfStateRule & { merged?: boolean })[] | undefined {
  const direct = styles.states.get(chain);
  if (direct) return direct;
  const sorted = chain.split('.').sort().join('.');
  for (const [key, rules] of styles.states) {
    if (key.split('.').sort().join('.') === sorted) return rules;
  }
  return undefined;
}

/** Main-breakpoint declarations of the base class and every combo prefix, later chains winning (the toggle's resting values). */
function restingFor(styles: WfStyleModel, siteClasses: string[]): CssDeclaration[] {
  const out: CssDeclaration[] = [];
  for (let i = 1; i <= siteClasses.length; i++) out.push(...(styles.resting.get(siteClasses.slice(0, i).join('.')) ?? []));
  return out;
}

/** Resting values a tab link falls back to when its own classes never set the key (states.ts `fallback`). */
const TAB_LINK_RESTING: TweenProperties = { backgroundColor: '#000000/0' };

/** Breakpoint tier of a merged nav-menu state rule: the narrower of the rule's own breakpoint and the collapse point. */
const COLLAPSE_PREFIX: Record<Exclude<WfNavCollapse, 'none'>, string> = { all: '', medium: 'max-lg:', small: 'max-md:', tiny: 'max-md:' };
const PREFIX_RANK: Record<string, number> = { '': 0, 'max-lg:': 1, 'max-md:': 2 };

/**
 * Scope a nav-menu state rule (`.nav-menu[data-nav-menu-open] { … }`) to the
 * breakpoints on which the menu can be opened at all: the rule's own prefix
 * (`max-md:` for a `small` rule) or the collapse tier, whichever is narrower.
 */
function scopeToCollapse(rule: WfStateRule, collapse: Exclude<WfNavCollapse, 'none'>): string[] {
  const own = BREAKPOINT_PREFIX[rule.breakpoint];
  const tier = COLLAPSE_PREFIX[collapse];
  const prefix = PREFIX_RANK[tier] > PREFIX_RANK[own] ? tier : own;
  if (prefix === own) return rule.classes;
  return rule.classes.map((c) => `${prefix}${c.startsWith(own) ? c.slice(own.length) : c}`);
}

interface StyleInfo {
  styles: ImportStyleRef[];
  boundBackground: boolean;
}

/** Stylesheet position of a class's first rule; a class with no rule of its own (a state-only chip) sorts last, a model without positions keeps the class order. */
function positionOf(styles: WfStyleModel, name: string, index: number): number {
  if (!styles.order) return index;
  return styles.order.get(name) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * The element's chips, lowest first, as the browser cascades Webflow's rules:
 *
 * 1. every class of the list that has a **standalone** rule (`.button` on an
 *    element `heading-2 button` applies exactly like `.heading-2`), ordered
 *    by stylesheet position — equal specificity, so the later rule wins;
 * 2. one combo ref per chain prefix (`a.b`, `a.b.c`, …): more classes, more
 *    specificity, so they sit above every single-class chip.
 *
 * A single class's breakpoint utility (`max-md:` from `.button`) would beat a
 * combo there (equal-weight utilities, the narrower variant sorts later).
 * css.ts lifts the combo's value onto that breakpoint
 * (`liftComboOverBreakpoints`) for every class an element carrying the combo
 * has, which it knows from the export's class lists (`BuildStyleModelInput.classLists`,
 * `coOccurringClasses`), and restates it under 480 px against their `tiny`
 * rules (`comboTinyOverrides`). Without those lists only the chain's own
 * classes are lifted over.
 */
function resolveStyles(siteClasses: string[], styles: WfStyleModel): StyleInfo {
  const refs: ImportStyleRef[] = [];
  let bound = false;
  const bySet = comboBySet(styles);
  const singles = [...new Set(siteClasses)]
    .map((name, index) => ({ name, index, entry: styles.classes.get(name) }))
    .filter((x): x is { name: string; index: number; entry: NonNullable<typeof x.entry> } => x.entry !== undefined)
    .sort((a, b) => positionOf(styles, a.name, a.index) - positionOf(styles, b.name, b.index) || a.index - b.index);
  for (const { entry } of singles) {
    refs.push(entry.ref);
    if (entry.boundBackground) bound = true;
  }
  for (let i = 2; i <= siteClasses.length; i++) {
    const chain = siteClasses.slice(0, i).join('.');
    const combo = styles.combos.get(chain) ?? bySet.get(siteClasses.slice(0, i).sort().join('.'));
    if (combo) refs.push(combo);
    if (styles.boundBackgroundKeys.has(chain)) bound = true;
  }
  if (siteClasses.length > 0 && styles.boundBackgroundKeys.has(siteClasses[0])) bound = true;
  return { styles: refs, boundBackground: bound };
}

// ─── Parser state ─────────────────────────────────────────────────────────────

interface Scope {
  navCollapse?: WfNavCollapse;
  /** The enclosing `.w-nav` has a `.w-nav-button` (a click interaction will own the menu's visibility). */
  navHasButton?: boolean;
}

class PageParser {
  private counter = 0;
  readonly nodeIndex = new Map<string, WfNode>();
  readonly headStyles: string[] = [];
  readonly bodyScripts: string[] = [];
  readonly headScripts: string[] = [];
  readonly googleFonts = new Set<string>();
  private embedDroppedWarned = false;
  private tinyColumnWarned = false;
  private fileUploadWarned = false;
  private mapKeyWarned = false;
  private bgVideoScriptAdded = false;
  private dropdownScriptAdded = false;
  private readonly unsupportedWarned = new Set<string>();
  private readonly flags: WfWidgetFlags;

  constructor(private readonly ctx: HtmlContext) {
    this.flags = resolveWidgetFlags(ctx.widgets);
  }

  private nextId(): string {
    return `${this.ctx.page}#${this.counter++}`;
  }

  private warn(code: Parameters<Warnings['add']>[0], message: string, node?: string): void {
    this.ctx.warn.add(code, message, { page: this.ctx.page, node });
  }

  // ── meta / styling ──

  private meta(el: HTMLElement | null, tag: string, classNames: string[]): WfNodeMeta {
    const attrs: Record<string, string> = {};
    let htmlId: string | undefined;
    let wId: string | undefined;
    if (el) {
      for (const [key, value] of Object.entries(el.attributes)) {
        if (key === 'class') continue;
        if (key === 'id') {
          htmlId = value;
          continue;
        }
        if (key === 'data-w-id') {
          wId = value;
          continue;
        }
        attrs[key] = value;
      }
    }
    const siteClasses = classNames.filter((c) => !isFrameworkClass(c));
    for (const c of new Set(classNames)) {
      if (c.startsWith('w-') && !isKnownFrameworkClass(c)) this.warn('html_unmapped', `framework class .${c} not mapped`);
    }
    const meta: WfNodeMeta = {
      id: this.nextId(),
      page: this.ctx.page,
      tag,
      classNames,
      siteClasses,
      attrs,
      bindEmpty: classNames.includes('w-dyn-bind-empty'),
    };
    if (htmlId) meta.htmlId = htmlId;
    if (wId) meta.wId = wId;
    return meta;
  }

  /** Attach reusable styles, framework shims, one-off classes and underlays (SPEC §4.7 steps 1-7). */
  private style(node: WfNode, scope: Scope, role?: WfNodeRole): void {
    const { styles } = this.ctx;
    const wf = node.wf;
    const info = resolveStyles(wf.siteClasses, styles);
    if (info.styles.length > 0) node.styles = info.styles;
    const states = this.applyStateRules(node, scope, role);

    const framework: string[] = [];
    const addFw = (list: string[]) => {
      for (const c of list) if (!framework.includes(c)) framework.push(c);
    };
    for (const c of wf.classNames) {
      const shim = FRAMEWORK_CLASSES[c];
      if (!shim) continue;
      if (c === 'w-dropdown-list') {
        // The generated dropdown interaction owns the list's visibility (widgets.ts); a
        // Tailwind `hidden` would defeat the runtime's display toggle.
        addFw(shim.filter((x) => x !== 'hidden'));
        continue;
      }
      if (c === 'w-nav-menu') {
        addFw(shim);
        if (!scope.navHasButton) addFw(navFrameworkClasses(scope.navCollapse, 'menu'));
        // The hamburger opens the menu as Webflow's panel below the bar on the
        // collapsed breakpoints — unless the designer positioned the menu
        // (a `position: fixed` slide-in keeps its own layout).
        else if (!setsPosition(info.styles.flatMap((ref) => ref.classes))) addFw(navFrameworkClasses(scope.navCollapse, 'menu-open'));
        continue;
      }
      if (c === 'w-nav-button') {
        addFw(shim);
        addFw(navFrameworkClasses(scope.navCollapse, 'button'));
        continue;
      }
      addFw(shim);
    }
    // A framework class the *site* stylesheet also styles (Webflow writes the
    // designer's Quick Stack values into `.w-layout-layout` there) contributes
    // those translated classes on top of the hand-written shim — otherwise the
    // shim's `grid` arrives without the gaps and padding the page was built with.
    const fromSheet: string[] = [];
    for (const c of wf.classNames) {
      if (!FRAMEWORK_CLASSES[c]) continue;
      const rule = styles.classes.get(c);
      if (rule) fromSheet.push(...rule.ref.classes);
    }
    addFw(fromSheet);
    // A site state rule on a framework class (`.w-dropdown-list.w--open`, two
    // classes) outranks every one-class rule of the element: the framework
    // class's own site rule, and the element's site classes (`.dropdown-list`).
    // Without site chips it goes on top of the framework layer; with them it
    // becomes a one-off above the chips — except where a state rule of the
    // element's own site chain (merged into its chip, equally specific and
    // later in the sheet) sets the same property.
    const stateClasses = this.frameworkStateClasses(states, info.styles, fromSheet);
    if (info.styles.length === 0) addFw(stateClasses);
    if (framework.length > 0) node.frameworkClasses = framework;

    const oneOff: string[] = info.styles.length > 0 ? [...stateClasses] : [];
    if (wf.htmlId) {
      const grid = styles.ids.get(wf.htmlId);
      if (grid) oneOff.push(...grid);
      // A Quick Stack id rule inside a media query ycode has no tier for (`tiny`)
      // stays in the residual stylesheet, which can only match through the id.
      if (styles.residual.ids.has(wf.htmlId)) wf.keepHtmlId = true;
    }
    if (wf.classNames.includes('w-condition-invisible')) {
      // `hidden` is the fallback; binding.ts swaps it for a reconstructed
      // visibility rule when the element's field is known (widgets-extra.ts).
      oneOff.push('hidden');
      if (this.flags.conditionalVisibility) wf.conditionInvisible = true;
    }
    // An inline `display:none` is Webflow's way of parking a state box until its
    // script shows it (`.w-users-userformerrorstate`, `.w-commerce-commerceaddtocarterror`,
    // …). Without the script the box must stay hidden, so the declaration becomes
    // the `hidden` utility; every other inline style is the widget builders' business.
    if (hasInlineDisplayNone(wf.attrs.style)) oneOff.push('hidden');
    for (const c of wf.classNames) {
      if (styles.residual.classNames.has(c)) oneOff.push(wfClass(c));
    }
    if (oneOff.length > 0) node.classes = [...new Set(oneOff)];

    if (UNDERLAY_TAGS.has(wf.tag)) {
      const underlay = styles.tags.get(wf.tag);
      if (underlay && info.styles.length === 0 && framework.length > 0) {
        // No site class to absorb the shims: upstream's converter folds them into
        // the lowest named style, i.e. *above* the tag underlay, so normalize.css's
        // button reset (`border-0`, `text-[inherit]`) would evict the widget's own
        // border and colour (pagination buttons, a bare `.w-button` submit). The
        // underlay goes under the shims instead, inline, and the node keeps no chip.
        node.frameworkClasses = mergePrefixedClasses([...underlay.classes, ...framework]);
      } else if (underlay) {
        node.underlayStyles = [underlay];
      }
    }
    // ycode renders an image's `width` / `height` attributes from its asset when
    // the export had none (every CMS-bound image), and the width attribute is a
    // presentational `width: <n>px` that holds wherever no class sets a width:
    // `height: 100%; max-height: 70vh` then squeezes the picture instead of
    // scaling it down. The export's element had no such hint, so its width was
    // `auto`; that goes under everything else.
    if (node.kind === 'image' && !explicitImageWidth(wf.attrs.width)) node.frameworkClasses = ['w-auto', ...(node.frameworkClasses ?? [])];

    // Webflow's bound-background placeholder URL (css.ts `boundBackgroundKeys`) only ever
    // appears on CMS-bound backgrounds, so the flag is set even when the element has
    // children (`.section.feature` holds the featured item's text on top of its image).
    if (info.boundBackground) wf.boundBackground = true;
    if (role) wf.role = role;
    const friendly = wf.siteClasses[0] ?? wf.tag;
    node.displayName = `${friendly} ${wf.id}`;
    this.nodeIndex.set(wf.id, node);
  }

  /**
   * Webflow state combos of this element's chains (`.dropdown-list.w--open`,
   * states.ts): merged into the chip for elements whose closed state is
   * `display: none`, turned into `wf.stateTween` for a toggle (or a tab link's
   * `w--current`), otherwise reported as `css_state_dropped`. The merge mutates
   * the shared `ImportStyleRef` once per rule (before conversion, so every page
   * sees it).
   *
   * On a nav menu the merged classes are scoped to the navbar's collapsed
   * breakpoints (`max-lg:` for `data-collapse="medium"`, `max-md:` for
   * `small` / `tiny`, none for `all`): above the collapse point the menu is
   * always visible and webflow.js never sets the open state there, so an
   * unscoped `display` / `background` would restyle the desktop bar. A rule
   * that already sits on a narrower breakpoint keeps its own prefix; a navbar
   * that never collapses (`none`) has no open state at all.
   *
   * A site rule on a framework class (`.w-dropdown-toggle.w--open`) is looked
   * up by that class: it has no chip, so merged classes are returned for the
   * element's framework classes, and a tween starts from the class's own
   * site-sheet values.
   */
  private applyStateRules(node: WfNode, scope: Scope, role?: WfNodeRole): { framework: string[]; site: string[] } {
    const { styles } = this.ctx;
    const wf = node.wf;
    let stateTween: WfNodeMeta['stateTween'];
    const frameworkMerged: string[] = [];
    const siteMerged: string[] = [];
    const chains: { rules: (WfStateRule & { merged?: boolean })[]; ref: ImportStyleRef | undefined; resting: string[] }[] = [];
    for (let i = 1; i <= wf.siteClasses.length; i++) {
      const chain = wf.siteClasses.slice(0, i).join('.');
      const rules = stateRulesFor(styles, chain);
      if (!rules) continue;
      const ref = i === 1 ? styles.classes.get(chain)?.ref : (styles.combos.get(chain) ?? comboBySet(styles).get(wf.siteClasses.slice(0, i).sort().join('.')));
      chains.push({ rules, ref, resting: wf.siteClasses.slice(0, i) });
    }
    for (const c of new Set(wf.classNames)) {
      const rules = !wf.siteClasses.includes(c) ? styles.states.get(c) : undefined;
      if (rules) chains.push({ rules, ref: undefined, resting: [c] });
    }
    for (const { rules, ref, resting } of chains) {
      const framework = ref === undefined && resting.length === 1 && !wf.siteClasses.includes(resting[0]);
      for (const rule of rules) {
        const handling = stateHandling(role, rule.state);
        if (handling === 'variant') continue;
        if (handling === 'merge') {
          let classes = rule.classes;
          if (role === 'nav-menu') {
            const collapse = scope.navCollapse ?? 'medium';
            if (collapse === 'none') {
              this.warn('css_state_dropped', `${rule.selector}: the navbar never collapses (data-collapse="none"), so its menu is never opened and the ${stateLabel(rule.state)} state has no ycode counterpart`, wf.id);
              continue;
            }
            classes = scopeToCollapse(rule, collapse);
          }
          if (framework) frameworkMerged.push(...classes);
          else {
            siteMerged.push(...classes);
            if (ref && !rule.merged) {
              ref.classes = mergePrefixedClasses([...ref.classes, ...classes]);
              rule.merged = true;
            }
          }
          continue;
        }
        if (handling === 'tween') {
          if (rule.breakpoint !== 'main') {
            this.warn('css_state_dropped', `${rule.selector}: the ${stateLabel(rule.state)} state on a breakpoint cannot become an interaction tween`, wf.id);
            continue;
          }
          // A tab returns to its resting look when another tab is clicked, so the
          // tab tween needs an explicit value for every key (a transparent
          // background when the tab's own classes never set one).
          const options = role === 'tab-link' ? { fallback: TAB_LINK_RESTING } : {};
          const plan = stateTweenFromDeclarations(rule.declarations, restingFor(styles, resting), options);
          if (plan.dropped.length > 0) this.warn('css_state_dropped', `${rule.selector}: ${plan.dropped.join('; ')} cannot become an interaction tween${role === 'tab-link' ? ' on the tab link' : ''} (ycode tweens background colour, opacity, transform, size and display)`, wf.id);
          if (Object.keys(plan.to).length > 0) stateTween = { from: { ...(stateTween?.from ?? {}), ...plan.from }, to: { ...(stateTween?.to ?? {}), ...plan.to } };
          continue;
        }
        this.warn('css_state_dropped', `${rule.selector}: webflow.js sets .${rule.state} on ${stateCarrier(rule.state)}, not on this ${role ?? wf.tag}; the rule has no ycode counterpart`, wf.id);
      }
    }
    if (stateTween) wf.stateTween = stateTween;
    return { framework: frameworkMerged, site: siteMerged };
  }

  /**
   * The merged classes of state rules on the element's framework classes
   * (`.w-dropdown-list.w--open`), ready to sit above everything a one-class
   * rule gave the element: re-stated on the narrower breakpoints where a chip
   * or the framework class's own site rule sets the same property (two classes
   * beat one on every breakpoint in Webflow), and without what a state rule of
   * the element's site chain sets on the same variant (that rule is equally
   * specific and comes later in the site sheet).
   */
  private frameworkStateClasses(states: { framework: string[]; site: string[] }, chips: ImportStyleRef[], fromSheet: string[]): string[] {
    if (states.framework.length === 0) return [];
    const site = new Set(states.site);
    const lower = [...chips.flatMap((ref) => ref.classes).filter((c) => !site.has(c)), ...fromSheet];
    const lifted = liftComboOverBreakpoints(mergePrefixedClasses(states.framework), lower);
    if (states.site.length === 0) return lifted;
    return lifted.filter((cls) => mergePrefixedClasses([cls, ...states.site]).includes(cls));
  }

  private make(el: HTMLElement | null, kind: WfNode['kind'], tag: string, classNames: string[], scope: Scope, role?: WfNodeRole): WfNode {
    const node: WfNode = { kind, tag, wf: this.meta(el, tag, classNames) };
    this.style(node, scope, role);
    return node;
  }

  /**
   * Give a widget layer a readable name in the layer tree. `style()` writes
   * `"<friendly> <nodeId>"` into `displayName`, which convert-bridge splits back
   * into `customName` (D12), so the name has to be rewritten the same way.
   */
  private rename(node: WfNode, friendly: string): void {
    node.displayName = `${friendly} ${node.wf.id}`;
  }

  // ── head ──

  parseHead(root: HTMLElement, page: WfPage): void {
    const html = root.querySelector('html');
    if (html) {
      const lang = html.getAttribute('lang');
      if (lang) page.lang = lang;
      const wfPage = html.getAttribute('data-wf-page');
      if (wfPage) page.wfPageId = wfPage;
    }
    const head = root.querySelector('head');
    if (!head) return;
    page.title = tidyText(collapseWhitespace(head.querySelector('title')?.text ?? ''));
    page.description = (head.querySelector('meta[name="description"]')?.getAttribute('content') ?? '').trim();
    const og = head.querySelector('meta[property="og:image"]')?.getAttribute('content')?.trim();
    if (og) page.ogImage = this.resolveOgImage(og);
    const canonical = head.querySelector('link[rel="canonical"]')?.getAttribute('href')?.trim();
    if (canonical) page.canonical = canonical;
    for (const link of head.querySelectorAll('link')) {
      const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
      const href = (link.getAttribute('href') ?? '').trim();
      if (!href) continue;
      if (rel.includes('apple-touch-icon')) page.webclip = relativePath(href);
      else if (rel.includes('icon')) page.favicon = relativePath(href);
      if (/fonts\.googleapis\.com/i.test(href)) for (const f of googleFamiliesFromHref(href)) this.googleFonts.add(f);
    }
    for (const style of head.querySelectorAll('style')) {
      const css = style.rawText.trim();
      if (css) this.headStyles.push(css);
    }
    for (const script of head.querySelectorAll('script')) this.handleScript(script, this.headScripts);
  }

  private resolveOgImage(url: string): string {
    if (!isRemoteUrl(url)) return relativePath(url);
    const name = decodeURIComponent(basename(url.split(/[?#]/)[0])).replace(WEBFLOW_ID_PREFIX_RE, '');
    const local = `images/${name}`;
    return this.ctx.zip.files.has(local) ? local : url;
  }

  private handleScript(el: HTMLElement, sink: string[]): void {
    const code = el.rawText;
    if (/WebFont\.load\s*\(/.test(code)) for (const f of googleFamiliesFromScript(code)) this.googleFonts.add(f);
    if (isWebflowScript(el)) return;
    sink.push(el.outerHTML);
    const src = el.getAttribute('src');
    this.warn('embed_script', src ? `external script kept as custom code: ${src}` : 'inline script kept as custom code');
  }

  // ── body ──

  parseBody(root: HTMLElement, page: WfPage): void {
    const body = root.querySelector('body') ?? root;
    page.bodyClassNames = classList(body);
    const structural = elementChildren(body).filter((c) => !DROP_TAGS.has(tagOf(c)));
    page.isEmpty = structural.length === 0;
    if (page.isEmpty) this.warn('page_empty', `${this.ctx.page}.html has no body content`);
    page.roots = this.convertChildren(body, {});
  }

  /** Convert element children; loose text runs between elements become text nodes (footer cells). */
  private convertChildren(el: HTMLElement, scope: Scope, skip?: Set<HTMLElement>): WfNode[] {
    const out: WfNode[] = [];
    let run: string[] = [];
    const flush = () => {
      const text = tidyText(run.join(''));
      run = [];
      if (!text) return;
      const node: WfNode = { kind: 'text', tag: 'div', text, wf: this.meta(null, 'div', []) };
      this.style(node, scope);
      out.push(node);
    };
    for (const child of el.childNodes) {
      if (child.nodeType === NodeType.TEXT_NODE) {
        run.push(collapseWhitespace((child as unknown as { text: string }).text));
        continue;
      }
      if (!(child instanceof HTMLElement)) continue;
      if (skip?.has(child)) continue;
      if (tagOf(child) === 'br') {
        run.push('\n');
        continue;
      }
      flush();
      const node = this.convertElement(child, scope);
      if (node) out.push(node);
    }
    flush();
    return out;
  }

  private convertElement(el: HTMLElement, scope: Scope): WfNode | null {
    const tag = tagOf(el);
    if (tag === 'script') {
      this.handleScript(el, this.bodyScripts);
      return null;
    }
    if (tag === 'style') {
      const css = el.rawText.trim();
      if (css) this.headStyles.push(css);
      return null;
    }
    if (DROP_TAGS.has(tag)) return null;

    const classNames = classList(el);
    const has = (c: string) => classNames.includes(c);

    if (has('w-dyn-empty')) return null;
    // ── widgets-extra.ts (SPEC part C) ──
    if (this.flags.badge && has('w-webflow-badge')) return null;
    if (this.flags.unsupportedWidgets) this.noteUnsupportedWidget(classNames);
    if (this.flags.video && (has('w-video') || has('w-embed-youtubevideo'))) {
      const node = this.convertEmbedVideo(el, tag, classNames, scope);
      if (node) return node;
    }
    if (has('w-embed')) return this.convertEmbed(el, tag, classNames, scope);
    if (has('w-background-video')) return this.convertBackgroundVideo(el, tag, classNames, scope);
    if (this.flags.bgVideoControl && has('w-background-video--control')) return this.convertBgVideoControl(el, classNames, scope);
    if (has('w-richtext')) {
      const node = this.make(el, 'box', tag, classNames, scope, 'rich-text');
      node.wf.layerKind = 'richText';
      node.wf.html = node.wf.bindEmpty ? '' : el.innerHTML.trim();
      node.children = [];
      const textStyles = richTextStylesFor(this.ctx.styles, classNames);
      if (textStyles) node.wf.textStyles = textStyles;
      return node;
    }
    if (has('w-dyn-list')) return this.convertDynList(el, tag, classNames, scope);
    if (has('w-dyn-items')) return this.convertDynItems(el, tag, classNames, scope);
    if (has('w-dyn-item')) {
      const node = this.make(el, 'collection', tag, classNames, scope, 'dyn-item');
      node.children = this.convertChildren(el, scope);
      return node;
    }
    if (has('w-nav')) {
      const collapse = (el.getAttribute('data-collapse') ?? 'medium').toLowerCase() as WfNavCollapse;
      const navScope: Scope = {
        navCollapse: ['all', 'medium', 'small', 'tiny', 'none'].includes(collapse) ? collapse : 'medium',
        navHasButton: el.querySelector('.w-nav-button') !== null,
      };
      const node = this.make(el, 'box', tag, classNames, navScope, 'nav');
      node.wf.navCollapse = navScope.navCollapse;
      node.children = this.convertChildren(el, navScope);
      return node;
    }
    if (has('w-nav-menu')) return this.box(el, 'nav', classNames, scope, 'nav-menu');
    if (has('w-nav-button')) return this.box(el, tag, classNames, scope, 'nav-button');
    if (has('w-nav-brand')) return this.convertLink(el, classNames, scope, 'nav-brand');
    if (has('w-dropdown')) {
      const node = this.box(el, tag, classNames, scope, 'dropdown');
      node.wf.dropdownHover = (el.getAttribute('data-hover') ?? '').toLowerCase() === 'true';
      if (!this.dropdownScriptAdded) {
        this.dropdownScriptAdded = true;
        this.bodyScripts.push(DROPDOWN_RUNTIME_SCRIPT);
      }
      return node;
    }
    if (has('w-dropdown-toggle')) return this.box(el, tag, classNames, scope, 'dropdown-toggle');
    if (has('w-dropdown-list')) return this.box(el, tag, classNames, scope, 'dropdown-list');
    if (has('w-icon-dropdown-toggle')) {
      const node = this.make(el, 'icon', tag, classNames, scope, 'dropdown-icon');
      node.svg = DROPDOWN_CHEVRON_SVG;
      return node;
    }
    if (has('w-layout-layout')) return this.box(el, tag, classNames, scope, 'grid');
    if (has('w-layout-cell')) return this.box(el, tag, classNames, scope, 'cell');

    // ── Extra widgets (widgets-extra.ts), each behind its own flag ──
    if (this.flags.locales && has('w-locales-list')) return this.convertLocales(el, tag, classNames, scope);
    if (this.flags.lottie && has('w-lottie')) return this.convertLottie(el, tag, classNames, scope);
    if (this.flags.codeBlock && has('w-code-block')) return this.convertCodeBlock(el, tag, classNames, scope);
    if (this.flags.map && has('w-widget-map')) return this.convertMap(el, tag, classNames, scope);
    if (this.flags.fileUpload && has('w-file-upload')) return this.convertFileUpload(el, tag, classNames, scope);
    if (this.flags.pagination && has('w-pagination-wrapper')) return this.convertPagination(el, tag, classNames, scope);
    if (this.flags.iconFont) {
      const glyph = iconFontSvg(classNames);
      if (glyph) {
        const node = this.make(el, 'icon', tag, classNames, scope, 'icon-font');
        node.svg = glyph.svg;
        this.rename(node, glyph.className.replace(/^w-icon-/, 'Icon '));
        return node;
      }
    }

    // ── Native widgets (widgets-native.ts), each behind its own flag ──
    if (this.flags.slider && has('w-slider')) return this.convertSlider(el, tag, classNames, scope);
    if (this.flags.lightbox && has('w-lightbox')) return this.convertLightbox(el, classNames, scope);
    // `<form class="w-form">` (the search form) IS the form; only a wrapper div gets the wrapper path.
    if (this.flags.form && has('w-form') && tag !== 'form') return this.convertFormWrapper(el, tag, classNames, scope);
    if (this.flags.form && has('w-form-done')) return this.convertFormAlert(el, tag, classNames, scope, 'success');
    if (this.flags.form && has('w-form-fail')) return this.convertFormAlert(el, tag, classNames, scope, 'error');
    if (this.flags.form && tag === 'form') {
      const node = this.box(el, tag, classNames, scope, 'form');
      node.wf.layerKind = 'form';
      node.wf.formId = (el.getAttribute('id') || el.getAttribute('name') || '').trim() || undefined;
      this.rename(node, 'Form');
      if (this.flags.search && isSearchForm(node.wf.attrs)) {
        this.rename(node, 'Search form');
        this.warn('widget_unsupported', SEARCH_NOTE, node.wf.id);
      }
      return node;
    }
    if (this.flags.form && FORM_CONTROL_TAGS.has(tag)) return this.convertFormControl(el, tag, classNames, scope);
    if (this.flags.form && tag === 'label') return this.convertLabel(el, classNames, scope);
    if (this.flags.tabs && has('w-tabs')) {
      const node = this.box(el, tag, classNames, scope, 'tabs');
      this.rename(node, 'Tabs');
      return node;
    }
    if (this.flags.tabs && has('w-tab-menu')) return this.box(el, tag, classNames, scope, 'tab-menu');
    if (this.flags.tabs && has('w-tab-content')) return this.box(el, tag, classNames, scope, 'tab-content');
    if (this.flags.tabs && (has('w-tab-link') || has('w-tab-pane'))) return this.convertTabPart(el, tag, classNames, scope, has('w-tab-link'));
    if (this.flags.columns && has('w-row')) {
      const node = this.box(el, tag, classNames, scope, 'row');
      this.rename(node, 'Row');
      return node;
    }
    if (this.flags.columns && has('w-col')) return this.convertColumn(el, tag, classNames, scope);

    if (tag === 'svg') {
      const node = this.make(el, 'icon', tag, classNames, scope);
      node.svg = sanitizeSvg(el.outerHTML);
      return node;
    }
    if (tag === 'img') return this.convertImage(el, classNames, scope);
    if (tag === 'iframe') {
      const node = this.make(el, 'box', tag, classNames, scope, 'iframe');
      node.wf.layerKind = 'iframe';
      node.children = [];
      return node;
    }
    if (tag === 'hr') {
      const node = this.make(el, 'box', tag, classNames, scope, 'hr');
      node.wf.layerKind = 'hr';
      node.children = [];
      return node;
    }
    if (HEADING_RE.test(tag)) {
      const node = this.make(el, 'heading', tag, classNames, scope);
      node.text = node.wf.bindEmpty ? '' : textContent(el);
      return node;
    }
    if (tag === 'a') return this.convertLink(el, classNames, scope);

    const bindEmpty = classNames.includes('w-dyn-bind-empty');
    if (tag === 'p' || isTextual(el) || (bindEmpty && elementChildren(el).length === 0)) {
      const node = this.make(el, 'text', tag, classNames, scope);
      node.text = bindEmpty ? '' : textContent(el);
      return node;
    }
    return this.box(el, tag, classNames, scope);
  }

  private box(el: HTMLElement, tag: string, classNames: string[], scope: Scope, role?: WfNodeRole): WfNode {
    const node = this.make(el, 'box', tag, classNames, scope, role);
    node.children = this.convertChildren(el, scope);
    return node;
  }

  private convertLink(el: HTMLElement, classNames: string[], scope: Scope, role?: WfNodeRole): WfNode {
    const node = this.make(el, 'link', 'a', classNames, scope, role ?? (classNames.includes('w-button') ? 'button' : undefined));
    const { href, kind } = normaliseHref(el.getAttribute('href') ?? '', this.ctx.pageNames);
    if (kind === 'broken') this.warn('link_broken', `link target kept verbatim: ${href}`, node.wf.id);
    node.link = { href };
    const target = el.getAttribute('target');
    if (target) node.link.target = target;
    const rel = el.getAttribute('rel');
    if (rel) node.link.rel = rel;
    if (classNames.includes('w-button')) node.button = true;
    if (node.wf.bindEmpty && elementChildren(el).length === 0) {
      node.text = '';
    } else if (isTextual(el)) {
      node.text = textContent(el);
    } else {
      node.children = this.convertChildren(el, scope);
    }
    return node;
  }

  private convertImage(el: HTMLElement, classNames: string[], scope: Scope): WfNode {
    const alt = el.getAttribute('alt') ?? '';
    const bindEmpty = classNames.includes('w-dyn-bind-empty');
    const src = (el.getAttribute('src') ?? '').trim();
    if (!bindEmpty && src && !isRemoteUrl(src)) {
      const rel = relativePath(src);
      const base = baseImagePath(rel);
      const local = this.ctx.zip.files.has(base) ? base : this.ctx.zip.files.has(rel) ? rel : null;
      if (local && /\.svg$/i.test(local)) {
        const svg = this.ctx.svgFiles?.get(local);
        if (svg) {
          const node = this.make(el, 'icon', 'img', classNames, scope);
          node.svg = svg;
          return node;
        }
      }
    }
    const node = this.make(el, 'image', 'img', classNames, scope);
    const image: ImportImage = { alt };
    if (!bindEmpty) {
      if (src && !isRemoteUrl(src)) {
        const base = baseImagePath(relativePath(src));
        image.src = this.ctx.assetKey(base) ?? src;
      } else if (src) {
        image.src = src;
      }
      const width = el.getAttribute('width');
      const height = el.getAttribute('height');
      if (width && width !== 'auto') image.width = width;
      if (height && height !== 'auto') image.height = height;
    }
    node.image = image;
    return node;
  }

  private convertEmbed(el: HTMLElement, tag: string, classNames: string[], scope: Scope): WfNode | null {
    const children = elementChildren(el);
    const hasText = hasVisibleText(el);
    if (children.length > 0 && !hasText && children.every((c) => tagOf(c) === 'style')) {
      for (const style of children) {
        const css = style.rawText.trim();
        if (css) this.headStyles.push(css);
      }
      return null;
    }
    if (children.length === 1 && !hasText && tagOf(children[0]) === 'svg') {
      const node = this.make(el, 'icon', tag, classNames, scope);
      node.svg = sanitizeSvg(children[0].outerHTML);
      return node;
    }
    const node = this.make(el, 'box', tag, classNames, scope, 'embed-script');
    node.wf.layerKind = 'htmlEmbed';
    node.wf.html = el.innerHTML.trim();
    node.children = [];
    this.warn('embed_script', `custom code embed kept as an HTML embed (${node.wf.siteClasses.join(' ') || tag})`, node.wf.id);
    return node;
  }

  // ── Native widgets ──

  /**
   * `.w-slider` -> `slider > slides > slide…`.
   *
   * Webflow's own chrome (`.w-slider-arrow-left/right`, `.w-slider-nav`) is
   * dropped: in ycode the arrows and bullets ARE layers, and convert-bridge
   * regenerates them from the element library's own templates. Only the
   * `.w-slider-mask` and its `.w-slide` children carry content.
   */
  private convertSlider(el: HTMLElement, tag: string, classNames: string[], scope: Scope): WfNode {
    const node = this.make(el, 'box', tag, classNames, scope, 'slider');
    node.wf.layerKind = 'slider';
    this.rename(node, 'Slider');

    const mask = elementChildren(el).find((c) => classList(c).includes('w-slider-mask')) ?? null;
    const hasNav = el.querySelector('.w-slider-nav') !== null;
    const { settings, unmapped } = sliderSettingsFromAttrs(node.wf.attrs, hasNav);
    node.wf.slider = settings;
    if (unmapped.length > 0) {
      this.warn('widget_partial', `slider: ${unmapped.join(', ')} has no ycode equivalent`, node.wf.id);
    }

    const slidesNode = this.make(mask, 'box', mask ? tagOf(mask) : 'div', mask ? classList(mask) : ['w-slider-mask'], scope, 'slides');
    slidesNode.wf.layerKind = 'slides';
    this.rename(slidesNode, 'Slides');

    const source = mask ?? el;
    const slideEls = elementChildren(source).filter((c) => classList(c).includes('w-slide'));
    slidesNode.children = slideEls.map((slideEl, i) => {
      const slide = this.make(slideEl, 'box', tagOf(slideEl), classList(slideEl), scope, 'slide');
      slide.wf.layerKind = 'slide';
      slide.children = this.convertChildren(slideEl, scope);
      this.rename(slide, `Slide ${i + 1}`);
      return slide;
    });
    if (slidesNode.children.length === 0) {
      this.warn('widget_partial', 'slider has no .w-slide children: imported as an empty slider', node.wf.id);
    }

    node.children = [slidesNode];
    return node;
  }

  /**
   * `.w-lightbox` (an `<a>` wrapping the thumbnail) -> a native `lightbox` layer.
   *
   * The gallery lives in the `<script class="w-json">` payload; its urls are
   * Webflow CDN links, which `index.ts` pre-uploads so convert-bridge can turn
   * them into asset ids. The link itself is dropped — a lightbox layer opens the
   * overlay, it does not navigate.
   */
  private convertLightbox(el: HTMLElement, classNames: string[], scope: Scope): WfNode {
    const node = this.make(el, 'box', 'div', classNames, scope, 'lightbox');
    node.wf.layerKind = 'lightbox';
    this.rename(node, 'Lightbox');

    const script = el.querySelector('script.w-json');
    const payload = parseLightboxPayload(script ? script.rawText : '');
    const files = payload.urls.map((url) => (isRemoteUrl(url) ? url : this.ctx.assetKey(relativePath(url)) ?? url));
    node.wf.lightbox = { files, group: payload.group || (el.getAttribute('data-w-lb') ?? '') };

    if (payload.nonImage > 0) {
      this.warn('widget_partial', `lightbox: ${payload.nonImage} non-image gallery item(s) dropped (ycode lightboxes hold images)`, node.wf.id);
    }
    if (files.length === 0) {
      this.warn('widget_partial', 'lightbox without a gallery payload: opens its own thumbnail only', node.wf.id);
    }
    node.children = this.convertChildren(el, scope);
    return node;
  }

  /**
   * `.w-form` wraps a `<form>` plus the `.w-form-done` / `.w-form-fail` blocks
   * as SIBLINGS of the form. ycode's submit handler looks its alerts up with
   * `form.querySelector('[data-alert-type=…]')`, so they are re-parented into
   * the form layer; without that move the success and error states never show.
   */
  private convertFormWrapper(el: HTMLElement, tag: string, classNames: string[], scope: Scope): WfNode {
    const node = this.make(el, 'box', tag, classNames, scope, 'form-wrapper');
    const children = this.convertChildren(el, scope);
    const formNode = children.find((c) => c.wf.role === 'form');
    const alerts = children.filter((c) => c.wf.role === 'form-alert');

    if (formNode && alerts.length > 0) {
      formNode.children = [...alerts, ...(formNode.children ?? [])];
      node.children = children.filter((c) => !alerts.includes(c));
    } else {
      node.children = children;
      if (!formNode) this.warn('widget_partial', '.w-form without a <form> child: no native form layer created', node.wf.id);
    }
    return node;
  }

  private convertFormAlert(el: HTMLElement, tag: string, classNames: string[], scope: Scope, kind: 'success' | 'error'): WfNode {
    const node = this.box(el, tag, classNames, scope, 'form-alert');
    node.wf.layerKind = 'formAlert';
    node.wf.formAlert = kind;
    this.rename(node, kind === 'success' ? 'Success alert' : 'Error alert');
    return node;
  }

  /**
   * `<input>` / `<textarea>` / `<select>` / `<option>` / `<button>` -> the ycode
   * layer of the same name, carrying the attributes the control needs to submit
   * (`name` above all: the submit handler builds its payload from `FormData`).
   * Without this they hit upstream's `convertBox`, which has no entry for these
   * tags and produces an empty `div`.
   */
  private convertFormControl(el: HTMLElement, tag: string, classNames: string[], scope: Scope): WfNode {
    const plan = planFormControl(tag, attributesOf(el), textContent(el));
    if (!plan) return this.box(el, tag, classNames, scope);

    const node = this.make(el, 'box', plan.name === 'button' ? 'button' : tag, classNames, scope, 'form-control');
    node.wf.layerKind = 'formControl';
    node.wf.formControl = plan;

    if (plan.name === 'button') {
      node.button = true;
      if (elementChildren(el).length > 0) node.children = this.convertChildren(el, scope);
      else node.text = plan.text ?? '';
    } else if (plan.name === 'select') {
      node.children = this.convertChildren(el, scope);
    } else {
      node.children = [];
    }
    this.rename(node, friendlyControlName(plan.name, plan.attributes.type));
    return node;
  }

  /** `.w-tab-link` / `.w-tab-pane`: DOM kept, switching rebuilt as a generated interaction (widgets.ts). */
  private convertTabPart(el: HTMLElement, tag: string, classNames: string[], scope: Scope, isLink: boolean): WfNode {
    // A tab link is an `<a href="#w-tabs-0-data-w-pane-0">`; as a link layer it
    // would navigate to a fragment that no longer exists, so it becomes a box.
    const node = this.box(el, isLink ? 'div' : tag, classNames, scope, isLink ? 'tab-link' : 'tab-pane');
    const id = (el.getAttribute('data-w-tab') ?? '').trim();
    const active = classNames.includes('w--tab-active') || (isLink && classNames.includes('w--current'));
    node.wf.tab = { id, active };
    if (!id) this.warn('widget_partial', `tab ${isLink ? 'link' : 'pane'} without data-w-tab: not wired to a tab`, node.wf.id);
    this.rename(node, isLink ? `Tab ${id || 'link'}` : `Pane ${id || ''}`.trim());
    return node;
  }

  /** `.w-col` / `.w-col-N`: the width comes from the framework shims; this only names it. */
  private convertColumn(el: HTMLElement, tag: string, classNames: string[], scope: Scope): WfNode {
    const node = this.box(el, tag, classNames, scope, 'col');
    const span = classNames.map((c) => /^w-col-(\d{1,2})$/.exec(c)).find(Boolean);
    this.rename(node, span ? `Column ${span[1]}/12` : 'Column');
    if (!this.tinyColumnWarned && classNames.some((c) => /^w-col-tiny-\d{1,2}$/.test(c))) {
      this.tinyColumnWarned = true;
      this.warn('widget_partial', 'w-col-tiny-* (<= 479px) has no ycode breakpoint tier: the small-screen column width is not translated', node.wf.id);
    }
    return node;
  }

  private convertBackgroundVideo(el: HTMLElement, tag: string, classNames: string[], scope: Scope): WfNode {
    const node = this.make(el, 'box', tag, classNames, scope, 'bg-video');
    node.wf.layerKind = 'video';
    // Everything but the `<video>` itself (and its `<noscript>` fallback) is
    // real content Webflow lets the designer place on top of the video — the
    // hero heading, the play/pause button. convert-bridge prepends the video.
    const skip = new Set(elementChildren(el).filter((c) => tagOf(c) === 'video' || tagOf(c) === 'noscript'));
    node.children = this.convertChildren(el, scope, skip);
    const candidates: string[] = [];
    for (const source of el.querySelectorAll('source')) {
      const src = source.getAttribute('src');
      if (src) candidates.push(relativePath(src));
    }
    for (const url of (el.getAttribute('data-video-urls') ?? '').split(',')) {
      const rel = relativePath(url);
      if (rel) candidates.push(rel);
    }
    const sources: string[] = [];
    for (const rel of [...new Set(candidates)]) {
      if (this.ctx.zip.files.has(rel)) sources.push(rel);
      else this.warn('video_missing_file', `background video file missing from the export: ${rel}`, node.wf.id);
    }
    sources.sort((a, b) => Number(/_mp4\.mp4$|\.mp4$/i.test(b)) - Number(/_mp4\.mp4$|\.mp4$/i.test(a)));
    let poster: string | undefined;
    const posterAttr = el.getAttribute('data-poster-url') ?? firstUrlOf(el.querySelector('video')?.getAttribute('style'));
    if (posterAttr) {
      const rel = relativePath(posterAttr);
      if (this.ctx.zip.files.has(rel)) poster = rel;
      else this.warn('asset_missing', `background video poster missing from the export: ${rel}`, node.wf.id);
    }
    node.wf.video = {
      sources,
      autoplay: (el.getAttribute('data-autoplay') ?? 'true').toLowerCase() !== 'false',
      loop: (el.getAttribute('data-loop') ?? 'true').toLowerCase() !== 'false',
    };
    if (poster) node.wf.video.poster = poster;
    if (!this.embedDroppedWarned && !this.flags.bgVideoControl) {
      this.embedDroppedWarned = true;
      this.warn('embed_dropped', 'background video controls / noscript fallback dropped');
    }
    return node;
  }

  // ── Extra widgets (widgets-extra.ts) ──

  /** `.w-users-*` / `.w-commerce-*`: no ycode equivalent; reported once per page, the markup converts as usual. */
  private noteUnsupportedWidget(classNames: string[]): void {
    const family = unsupportedWidgetFamily(classNames);
    if (!family || this.unsupportedWarned.has(family)) return;
    this.unsupportedWarned.add(family);
    this.warn('widget_unsupported', UNSUPPORTED_WIDGET_NOTES[family]);
  }

  /**
   * `.w-video.w-embed > iframe` (embedly-wrapped YouTube / Vimeo) and
   * `.w-embed-youtubevideo > iframe` -> `video` (YouTube) or `iframe` layer.
   * Returns null when no player iframe is found, so the generic embed path runs.
   */
  private convertEmbedVideo(el: HTMLElement, tag: string, classNames: string[], scope: Scope): WfNode | null {
    const iframe = el.querySelector('iframe');
    if (!iframe) return null;
    const plan = planEmbedVideo({
      src: iframe.getAttribute('src') ?? '',
      style: el.getAttribute('style') ?? undefined,
      width: iframe.getAttribute('width') ?? undefined,
      height: iframe.getAttribute('height') ?? undefined,
      title: iframe.getAttribute('title') ?? undefined,
    });
    if (!plan) return null;
    const node = this.make(el, 'box', tag, classNames, scope, 'embed-video');
    node.wf.layerKind = 'embedVideo';
    node.wf.embedVideo = plan;
    node.children = [];
    // One-off classes go through upstream's converter (per-chip override), the
    // only place that survives ycode's re-flatten of `layer.classes` on publish.
    node.classes = [...new Set([...(node.classes ?? []), ...embedVideoClasses(plan)])];
    this.rename(node, plan.provider === 'youtube' ? 'YouTube video' : plan.provider === 'vimeo' ? 'Vimeo video' : 'Video embed');
    return node;
  }

  /** `.w-lottie[data-src]` -> `htmlEmbed` with `<lottie-player>` (convert-bridge); the JSON is an asset. */
  private convertLottie(el: HTMLElement, tag: string, classNames: string[], scope: Scope): WfNode {
    const node = this.make(el, 'box', tag, classNames, scope, 'lottie');
    node.wf.layerKind = 'lottie';
    node.children = [];
    const raw = (el.getAttribute('data-src') ?? '').trim();
    let src = raw;
    if (raw && !isRemoteUrl(raw)) {
      const rel = relativePath(raw);
      src = this.ctx.assetKey(rel) ?? rel;
      if (!this.ctx.zip.files.has(rel)) this.warn('asset_missing', `lottie animation missing from the export: ${rel}`, node.wf.id);
    }
    const size = sizeFromClasses((node.styles ?? []).flatMap((ref) => ref.classes));
    node.wf.lottie = planLottie(node.wf.attrs, src, size);
    if (node.wf.lottie.ix2) {
      this.warn('widget_partial', 'lottie is driven by an interaction (data-is-ix2-target); imported as a plain player, the scroll/hover control is not reproduced', node.wf.id);
    }
    if (!raw) this.warn('widget_partial', 'lottie without data-src: empty player', node.wf.id);
    this.rename(node, 'Lottie');
    return node;
  }

  /** `.w-code-block > pre > code` -> `<pre>` box + `<code>` text child with the code verbatim (convert-bridge). */
  private convertCodeBlock(el: HTMLElement, tag: string, classNames: string[], scope: Scope): WfNode {
    const node = this.make(el, 'box', tag, classNames, scope, 'code-block');
    node.wf.layerKind = 'codeBlock';
    node.children = [];
    const pre = el.querySelector('pre') ?? el;
    const code = pre.querySelector('code') ?? pre;
    // `.text` decodes entities and keeps every space, tab and newline; the
    // highlight.js spans are dropped with the markup.
    node.wf.codeBlock = {
      code: code.text.replace(/^\n/, ''),
      language: languageFromClasses([...classList(code), ...classList(pre)]),
    };
    const inline = [
      ...CODE_BLOCK_CLASSES,
      ...inlineStyleClasses(el.getAttribute('style') ?? undefined),
      ...inlineStyleClasses(pre === el ? undefined : pre.getAttribute('style') ?? undefined),
    ];
    node.classes = [...new Set([...(node.classes ?? []), ...inline])];
    this.rename(node, 'Code block');
    return node;
  }

  /**
   * `.w-file-upload`: only the default state (input + label + info) survives —
   * the uploading / success / error boxes are driven by webflow.js. The input
   * stays a real `<input type="file">`, but ycode's form handler posts JSON,
   * so the file never reaches the server (reported as `widget_partial`).
   */
  private convertFileUpload(el: HTMLElement, tag: string, classNames: string[], scope: Scope): WfNode {
    const skip = new Set(elementChildren(el).filter((c) => classList(c).some((cls) => FILE_UPLOAD_STATE_CLASSES.has(cls))));
    const node = this.make(el, 'box', tag, classNames, scope, 'file-upload');
    node.children = this.convertChildren(el, scope, skip);
    this.rename(node, 'File upload');
    if (!this.fileUploadWarned) {
      this.fileUploadWarned = true;
      this.warn('widget_partial', FILE_UPLOAD_NOTE, node.wf.id);
    }
    return node;
  }

  /** `.w-widget-map[data-widget-*]` -> `map` layer with `settings.map`. */
  private convertMap(el: HTMLElement, tag: string, classNames: string[], scope: Scope): WfNode {
    const node = this.make(el, 'box', tag, classNames, scope, 'map');
    node.wf.layerKind = 'map';
    node.children = [];
    node.wf.map = planMap(node.wf.attrs);
    for (const note of node.wf.map.notes) this.warn('widget_partial', `map: ${note}`, node.wf.id);
    if (!this.mapKeyWarned) {
      this.mapKeyWarned = true;
      this.warn('widget_partial', MAP_KEY_NOTE, node.wf.id);
    }
    this.rename(node, 'Map');
    return node;
  }

  /** `.w-locales-list > .w-locales-items > .w-locales-item > a[hreflang]` -> `localeSelector` layer. */
  private convertLocales(el: HTMLElement, tag: string, classNames: string[], scope: Scope): WfNode {
    const node = this.make(el, 'box', tag, classNames, scope, 'locales');
    node.wf.layerKind = 'localeSelector';
    node.children = [];
    const links = el.querySelectorAll('a[hreflang]');
    const current = links.find((a) => classList(a).includes('w--current') || a.getAttribute('aria-current') === 'page') ?? links[0];
    node.wf.locales = {
      current: current ? textContent(current) : '',
      codes: links.map((a) => (a.getAttribute('hreflang') ?? '').trim()).filter(Boolean),
    };
    this.warn('widget_partial', LOCALES_NOTE, node.wf.id);
    this.rename(node, 'Locales');
    return node;
  }

  /** `.w-dyn-list`: a `.w-pagination-wrapper` child is wired to the list's item (convert-bridge builds ycode's pagination). */
  private convertDynList(el: HTMLElement, tag: string, classNames: string[], scope: Scope): WfNode {
    const node = this.box(el, tag, classNames, scope, 'dyn-list');
    if (!this.flags.pagination) return node;
    const children = node.children ?? [];
    const pagination = children.find((c) => c.wf.role === 'pagination');
    if (!pagination) return node;
    const items = children.find((c) => c.wf.role === 'dyn-items');
    const item = items?.children?.find((c) => c.wf.role === 'dyn-item');
    if (!items || !item) {
      this.warn('widget_partial', 'pagination without a collection item: controls dropped', pagination.wf.id);
      node.children = children.filter((c) => c !== pagination);
      return node;
    }
    item.wf.pagination = { itemsPerPage: Math.max(1, items.wf.dynItemCount ?? 1) };
    pagination.wf.paginationFor = item.wf.id;
    return node;
  }

  /**
   * `.w-dyn-items`: a paginated export ships one template item per page slot;
   * only the first becomes the collection layer (ycode repeats it), the count
   * is the page size.
   */
  private convertDynItems(el: HTMLElement, tag: string, classNames: string[], scope: Scope): WfNode {
    const node = this.make(el, 'box', tag, classNames, scope, 'dyn-items');
    const items = elementChildren(el).filter((c) => classList(c).includes('w-dyn-item'));
    node.wf.dynItemCount = items.length;
    const parent = el.parentNode instanceof HTMLElement ? el.parentNode : null;
    const paginated = this.flags.pagination && parent !== null && elementChildren(parent).some((c) => classList(c).includes('w-pagination-wrapper'));
    const skip = paginated ? new Set(items.slice(1)) : undefined;
    node.children = this.convertChildren(el, scope, skip);
    return node;
  }

  /** `.w-pagination-wrapper` -> wrapper + prev / next buttons + page info; ids and attributes come from convert-bridge. */
  private convertPagination(el: HTMLElement, tag: string, classNames: string[], scope: Scope): WfNode {
    const node = this.make(el, 'box', tag, classNames, scope, 'pagination');
    node.wf.layerKind = 'pagination';
    node.children = [];
    this.rename(node, 'Pagination');
    for (const child of elementChildren(el)) {
      const cls = classList(child);
      if (cls.includes('w-pagination-previous') || cls.includes('w-pagination-next')) {
        const isPrev = cls.includes('w-pagination-previous');
        // Webflow's `<a href="?…_page=N">` navigates; ycode's controls are buttons
        // the client-side pager listens to, so the href is dropped on purpose.
        const button = this.make(child, 'box', 'button', cls, scope, isPrev ? 'pagination-prev' : 'pagination-next');
        button.button = true;
        button.wf.layerKind = 'paginationButton';
        button.children = this.convertChildren(child, scope);
        this.rename(button, isPrev ? 'Previous' : 'Next');
        node.children.push(button);
        continue;
      }
      if (cls.includes('w-page-count')) {
        const info = this.make(child, 'text', tagOf(child), cls, scope, 'pagination-info');
        info.wf.layerKind = 'paginationInfo';
        info.text = textContent(child);
        this.rename(info, 'Page info');
        node.children.push(info);
        continue;
      }
      const other = this.convertElement(child, scope);
      if (other) node.children.push(other);
    }
    return node;
  }

  /**
   * `.w-background-video--control`: Webflow's play/pause button. Two `<span>`s
   * hold the pause and play glyphs (the second starts `hidden`) plus a
   * visually hidden label each. The button keeps both glyphs as children; the
   * constant runtime line (`BG_VIDEO_TOGGLE_SCRIPT`) toggles them.
   */
  private convertBgVideoControl(el: HTMLElement, classNames: string[], scope: Scope): WfNode {
    const node = this.make(el, 'box', 'button', classNames, scope, 'bg-video-control');
    node.button = true;
    node.wf.layerKind = 'bgVideoControl';
    const labels: string[] = [];
    const glyphs: WfNode[] = [];
    for (const span of elementChildren(el)) {
      const label = span.querySelector('.w-hidden');
      labels.push(label ? textContent(label) : '');
      const glyph = elementChildren(span).find((c) => tagOf(c) === 'svg' || tagOf(c) === 'img');
      const converted = glyph ? this.convertElement(glyph, scope) : null;
      if (!converted) continue;
      if (span.hasAttribute('hidden') || glyphs.length === 1) converted.classes = [...new Set([...(converted.classes ?? []), 'hidden'])];
      this.rename(converted, glyphs.length === 0 ? 'Pause icon' : 'Play icon');
      glyphs.push(converted);
    }
    node.children = glyphs;
    node.wf.bgVideoControl = { labelPause: labels[0] || (el.getAttribute('aria-label') ?? ''), labelPlay: labels[1] || '' };
    if (!this.bgVideoScriptAdded) {
      this.bgVideoScriptAdded = true;
      this.bodyScripts.push(BG_VIDEO_TOGGLE_SCRIPT);
    }
    this.rename(node, 'Video control');
    return node;
  }

  /** `<label for>`: keeps its tag and `for`, so clicking it still focuses the control (file inputs depend on it). */
  private convertLabel(el: HTMLElement, classNames: string[], scope: Scope): WfNode {
    let node: WfNode;
    if (isTextual(el)) {
      node = this.make(el, 'text', 'label', classNames, scope, 'label');
      node.text = textContent(el);
    } else {
      node = this.box(el, 'label', classNames, scope, 'label');
    }
    node.wf.layerKind = 'label';
    const target = (el.getAttribute('for') ?? '').trim();
    if (target) node.wf.labelFor = target;
    return node;
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function parsePage(html: string, ctx: HtmlContext): WfPage {
  const root = parse(html, PARSE_OPTIONS);
  const parser = new PageParser(ctx);
  const page: WfPage = {
    name: ctx.page,
    title: '',
    description: '',
    lang: 'en',
    bodyClassNames: [],
    roots: [],
    nodeIndex: parser.nodeIndex,
    headStyles: parser.headStyles,
    bodyScripts: parser.bodyScripts,
    isEmpty: false,
  };
  parser.parseHead(root, page);
  parser.parseBody(root, page);
  if (parser.headScripts.length > 0) page.headScripts = parser.headScripts;
  if (parser.googleFonts.size > 0) page.googleFontFamilies = [...parser.googleFonts];
  namespacePageStyles(page);
  return page;
}

/** `.pageLayout` inside a page's own `<style>` -> `.wf-pagelayout`, plus the hook on the layers. */
const CLASS_TOKEN_RE = /\.(-?[_a-zA-Z][\w-]*)/g;

/** Namespace every class selector of a stylesheet; at-rule preludes stay verbatim. */
function namespaceCssClasses(css: string): { css: string; classes: Set<string> } {
  const classes = new Set<string>();
  let out = '';
  let buf = '';
  for (const ch of css) {
    if (ch === '{') {
      const trimmed = buf.trim();
      if (trimmed && !trimmed.startsWith('@') && trimmed.includes('.')) {
        for (const m of trimmed.matchAll(CLASS_TOKEN_RE)) classes.add(m[1]);
        out += buf.replace(trimmed, namespaceSelector(trimmed));
      } else {
        out += buf;
      }
      out += ch;
      buf = '';
    } else if (ch === '}' || ch === ';') {
      out += buf + ch;
      buf = '';
    } else {
      buf += ch;
    }
  }
  return { css: out + buf, classes };
}

/**
 * A page's embedded `<style>` blocks target Webflow class names, and v2 does not
 * put those on layers (D1). Their selectors are namespaced like the site
 * residual CSS and every node carrying the original class gets the inert
 * `wf-<name>` hook — otherwise the block is stored, served and matches nothing
 * (the print stylesheet of `catalog.html` is a whole page layout).
 */
export function namespacePageStyles(page: WfPage): void {
  if (page.headStyles.length === 0) return;
  const wanted = new Set<string>();
  page.headStyles = page.headStyles.map((css) => {
    const result = namespaceCssClasses(css);
    for (const c of result.classes) wanted.add(c);
    return result.css;
  });
  if (wanted.size === 0) return;
  for (const node of page.nodeIndex.values()) {
    const hooks = node.wf.classNames.filter((c) => wanted.has(c)).map(wfClass);
    if (hooks.length === 0) continue;
    node.classes = [...new Set([...(node.classes ?? []), ...hooks])];
  }
}

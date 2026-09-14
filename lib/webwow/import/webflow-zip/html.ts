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
import { UNDERLAY_TAGS, namespaceSelector, wfClass, type WfStyleModel } from './css';
import {
  DROPDOWN_CHEVRON_SVG,
  FRAMEWORK_CLASSES,
  isFrameworkClass,
  isKnownFrameworkClass,
  navFrameworkClasses,
} from './framework-classes';
import {
  FORM_CONTROL_TAGS,
  parseLightboxPayload,
  planFormControl,
  resolveWidgetFlags,
  sliderSettingsFromAttrs,
  type WfWidgetFlags,
} from './widgets-native';
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

interface StyleInfo {
  styles: ImportStyleRef[];
  boundBackground: boolean;
}

/** Base ref for the first site class, then one combo ref per chain prefix (`a.b`, `a.b.c`, …). */
function resolveStyles(siteClasses: string[], styles: WfStyleModel): StyleInfo {
  const refs: ImportStyleRef[] = [];
  let bound = false;
  const bySet = comboBySet(styles);
  for (let i = 1; i <= siteClasses.length; i++) {
    const chain = siteClasses.slice(0, i).join('.');
    if (i === 1) {
      const entry = styles.classes.get(chain);
      if (entry) {
        refs.push(entry.ref);
        if (entry.boundBackground) bound = true;
      }
      continue;
    }
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
    for (const c of wf.classNames) {
      if (!FRAMEWORK_CLASSES[c]) continue;
      const fromSheet = styles.classes.get(c);
      if (fromSheet) addFw(fromSheet.ref.classes);
    }
    if (framework.length > 0) node.frameworkClasses = framework;

    const oneOff: string[] = [];
    if (wf.htmlId) {
      const grid = styles.ids.get(wf.htmlId);
      if (grid) oneOff.push(...grid);
      // A Quick Stack id rule inside a media query ycode has no tier for (`tiny`)
      // stays in the residual stylesheet, which can only match through the id.
      if (styles.residual.ids.has(wf.htmlId)) wf.keepHtmlId = true;
    }
    if (wf.classNames.includes('w-condition-invisible')) oneOff.push('hidden');
    for (const c of wf.classNames) {
      if (styles.residual.classNames.has(c)) oneOff.push(wfClass(c));
    }
    if (oneOff.length > 0) node.classes = [...new Set(oneOff)];

    if (UNDERLAY_TAGS.has(wf.tag)) {
      const underlay = styles.tags.get(wf.tag);
      if (underlay) node.underlayStyles = [underlay];
    }

    // Webflow's bound-background placeholder URL (css.ts `boundBackgroundKeys`) only ever
    // appears on CMS-bound backgrounds, so the flag is set even when the element has
    // children (`.section.feature` holds the featured item's text on top of its image).
    if (info.boundBackground) wf.boundBackground = true;
    if (role) wf.role = role;
    const friendly = wf.siteClasses[0] ?? wf.tag;
    node.displayName = `${friendly} ${wf.id}`;
    this.nodeIndex.set(wf.id, node);
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
  private convertChildren(el: HTMLElement, scope: Scope): WfNode[] {
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
    if (has('w-embed')) return this.convertEmbed(el, tag, classNames, scope);
    if (has('w-background-video')) return this.convertBackgroundVideo(el, tag, classNames, scope);
    if (has('w-richtext')) {
      const node = this.make(el, 'box', tag, classNames, scope, 'rich-text');
      node.wf.layerKind = 'richText';
      node.wf.html = node.wf.bindEmpty ? '' : el.innerHTML.trim();
      node.children = [];
      return node;
    }
    if (has('w-dyn-list')) return this.box(el, tag, classNames, scope, 'dyn-list');
    if (has('w-dyn-items')) return this.box(el, tag, classNames, scope, 'dyn-items');
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

    // ── Native widgets (widgets-native.ts), each behind its own flag ──
    if (this.flags.slider && has('w-slider')) return this.convertSlider(el, tag, classNames, scope);
    if (this.flags.lightbox && has('w-lightbox')) return this.convertLightbox(el, classNames, scope);
    if (this.flags.form && has('w-form')) return this.convertFormWrapper(el, tag, classNames, scope);
    if (this.flags.form && has('w-form-done')) return this.convertFormAlert(el, tag, classNames, scope, 'success');
    if (this.flags.form && has('w-form-fail')) return this.convertFormAlert(el, tag, classNames, scope, 'error');
    if (this.flags.form && tag === 'form') {
      const node = this.box(el, tag, classNames, scope, 'form');
      node.wf.layerKind = 'form';
      node.wf.formId = (el.getAttribute('id') || el.getAttribute('name') || '').trim() || undefined;
      this.rename(node, 'Form');
      return node;
    }
    if (this.flags.form && FORM_CONTROL_TAGS.has(tag)) return this.convertFormControl(el, tag, classNames, scope);
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
    node.children = [];
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
    if (!this.embedDroppedWarned) {
      this.embedDroppedWarned = true;
      this.warn('embed_dropped', 'background video controls / noscript fallback dropped');
    }
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

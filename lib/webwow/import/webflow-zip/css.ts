/**
 * Webflow site CSS -> style model.
 *
 * Every single-class, combo (`.a.b`) and id (`#w-node-…`) rule of the site
 * stylesheet(s) is converted into Tailwind classes through upstream's
 * `cssToClasses`, prefixed per breakpoint / state and merged per selector into
 * an `ImportStyleRef` the converter turns into a reusable `LayerStyle`. Tag
 * rules (`p`, `a`, `h1`…) go through upstream's `parseGlobalStylesheet` /
 * `ruleToClasses` and become underlay styles.
 *
 * Whatever cannot be expressed as classes stays CSS: the `tiny` (<= 479 px)
 * breakpoint (D11 — ycode has no fourth tier), `min-width` / unknown media,
 * non-state pseudos (`:focus-visible`, `::before`), combinators and attribute
 * selectors. Those rules are rendered verbatim as *residual CSS* with every
 * class selector rewritten to a `wf-<name>` one-off class (D1 — raw Webflow
 * class names never reach `layer.classes`, where Tailwind would misread `grid`,
 * `container`, `hidden`…). Residual selectors are additionally scoped under
 * `html` so they beat same-specificity Tailwind utilities regardless of
 * stylesheet order (the residual rule always came *later* in Webflow's
 * cascade). `neutraliseCss` runs on the rendered text before it is stored.
 */

import { cssToClasses } from '@/lib/import/css';
import { kebabClassName, parseGlobalStylesheet, ruleToClasses } from '@/lib/import/adapters/webflow/global-styles';
import { splitVariant } from '@/lib/layer-style-resolve';
import { getAffectedProperties, removeConflictsForClass } from '@/lib/tailwind-class-mapper';
import type { ImportStyleRef } from '@/lib/import/types';
import {
  parseSelector,
  resolveVars,
  tokenizeCss,
  type CssDeclaration,
  type CssFontFace,
  type CssRule,
  type CssSheet,
} from './css-tokenizer';
import { neutraliseCss } from './css-sanitize';
import type { Warnings } from './warnings';

// ─── Constants ────────────────────────────────────────────────────────────────

export type WfBreakpoint = 'main' | 'medium' | 'small' | 'tiny';

/** Webflow breakpoint -> ycode desktop-first prefix. `tiny` has no tier and goes to residual CSS (D11). */
export const BREAKPOINT_PREFIX: Record<Exclude<WfBreakpoint, 'tiny'>, string> = {
  main: '',
  medium: 'max-lg:',
  small: 'max-md:',
};

export const STATE_PREFIX: Record<string, string> = {
  ':hover': 'hover:',
  ':focus': 'focus:',
  ':active': 'active:',
};

/** Webflow's CMS-bound background image placeholder (declaration dropped, node becomes a binding slot). */
export const BOUND_BG_PLACEHOLDER = 'd3e54v103j8qbb.cloudfront.net/img/background-image.svg';
/** Webflow's CMS-bound `<img>` placeholder (never downloaded). */
export const BOUND_IMG_PLACEHOLDER = 'd3e54v103j8qbb.cloudfront.net/plugins/Basic/assets/placeholder';

/**
 * Friendly layer-style names for global tag rules. Copy of
 * `lib/import/adapters/webflow/parse.ts` TAG_STYLE_NAMES (ycode 1.30.15) — the
 * upstream constant is not exported.
 */
export const TAG_STYLE_NAMES: Record<string, string> = {
  h1: 'Heading 1',
  h2: 'Heading 2',
  h3: 'Heading 3',
  h4: 'Heading 4',
  h5: 'Heading 5',
  h6: 'Heading 6',
  a: 'Link',
  p: 'Paragraph',
  li: 'List item',
  blockquote: 'Blockquote',
  body: 'Body',
};

/** Tags upstream's `parseGlobalStylesheet` indexes (global-styles.ts TAG_SELECTORS). */
const UPSTREAM_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'p', 'a', 'li', 'ul', 'ol', 'strong', 'em', 'b', 'i', 'small', 'figure', 'figcaption', 'img', 'button', 'label', 'body']);

/** Tags html.ts attaches a tag underlay to (SPEC §4.7 step 5). Other tag rules are global -> residual. */
export const UNDERLAY_TAGS = new Set(['p', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote', 'figure', 'figcaption', 'img', 'button', 'label']);

const GENERIC_FAMILIES = new Set(['inherit', 'initial', 'unset', 'revert', 'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong']);

// ─── Model ────────────────────────────────────────────────────────────────────

export type ResidualReason = 'tiny' | 'media' | 'pseudo' | 'complex' | 'important-only';

export interface ResidualRule {
  selector: string;
  /** Declarations re-serialised (`!important` kept, vars resolved, urls rewritten). */
  block: string;
  media: string | null;
  reason: ResidualReason;
}

export interface WfStyleModel {
  /** key = original class name; `ref.key = wf:<name>`, `ref.name = <name>`. */
  classes: Map<string, { ref: ImportStyleRef; boundBackground: boolean }>;
  /** key = ordered chain `a.b.c`; `ref.key = wf:<chain>`, `ref.name` = chain joined with spaces, `combo: true`. */
  combos: Map<string, ImportStyleRef>;
  /** `w-node-…` (no `#`) -> prefixed Tailwind classes (one-off). */
  ids: Map<string, string[]>;
  /** `p`, `a`, … -> key `wf-tag:<tag>`, name from TAG_STYLE_NAMES. */
  tags: Map<string, ImportStyleRef>;
  residual: { rules: ResidualRule[]; classNames: Set<string>; ids: Set<string> };
  /** Rendered, namespaced, neutralised; `@media` grouped. */
  residualCss: string;
  fontFaces: CssFontFace[];
  fontFamilies: string[];
  /** Class names AND combo chains whose rules carry the bound-background placeholder. */
  boundBackgroundKeys: Set<string>;
}

export interface CssAssetResolver {
  /** `'../images/x.jpg'` -> `/storage/v1/object/public/assets/website/…` (null = keep the original). */
  (relativeUrl: string): string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** `wf-<kebab class name>` — the inert one-off class residual CSS selectors are rewritten to. */
export function wfClass(name: string): string {
  return `wf-${kebabClassName(name)}`;
}

const IDENT_CHAR = /[-\w\u00A0-\uFFFF]/;

/**
 * Rewrite every `.token` class selector to `.wf-<token>` (`'.a.b:hover .c'` ->
 * `'.wf-a.wf-b:hover .wf-c'`). Ids, tags, pseudos and strings are untouched;
 * attribute selectors (`[data-x=".5"]`) are copied verbatim; class selectors
 * inside functional pseudos (`:not(.x)`) are rewritten too.
 */
export function namespaceSelector(selector: string): string {
  let out = '';
  let i = 0;
  const n = selector.length;
  let quote: string | null = null;
  let attr = 0;
  while (i < n) {
    const ch = selector[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < n) {
        out += selector[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '[') attr++;
    else if (ch === ']') attr = Math.max(0, attr - 1);
    if (ch === '.' && attr === 0) {
      let j = i + 1;
      let ident = '';
      while (j < n) {
        if (selector[j] === '\\' && j + 1 < n) {
          ident += selector[j] + selector[j + 1];
          j += 2;
          continue;
        }
        if (!IDENT_CHAR.test(selector[j])) break;
        ident += selector[j];
        j++;
      }
      if (ident && /^-?[_a-zA-Z\\\u00A0-\uFFFF]/.test(ident)) {
        out += `.${wfClass(ident)}`;
        i = j;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Property-aware, prefix-scoped class merge (later wins). Same contract as
 * upstream's `mergeClassStack`, but conflicts are detected on the bare utility
 * so prefixed classes (`max-lg:p-[50px]` vs `max-lg:p-[40px]`) and shorthand /
 * longhand pairs (`pt-[20px]` then `p-[60px]`) resolve correctly.
 */
export function mergePrefixedClasses(ordered: string[]): string[] {
  const merged: string[] = [];
  for (const cls of ordered) {
    if (!cls) continue;
    const { prefix, base } = splitVariant(cls);
    if (getAffectedProperties(base).length > 0) {
      const sameIdx: number[] = [];
      const sameBases: string[] = [];
      merged.forEach((m, i) => {
        const s = splitVariant(m);
        if (s.prefix === prefix) {
          sameIdx.push(i);
          sameBases.push(s.base);
        }
      });
      const keptCount = new Map<string, number>();
      for (const k of removeConflictsForClass(sameBases, base)) keptCount.set(k, (keptCount.get(k) ?? 0) + 1);
      for (let j = sameIdx.length - 1; j >= 0; j--) {
        const b = sameBases[j];
        const c = keptCount.get(b) ?? 0;
        if (c > 0) keptCount.set(b, c - 1);
        else merged.splice(sameIdx[j], 1);
      }
    }
    if (!merged.includes(cls)) merged.push(cls);
  }
  return merged;
}

/** Tailwind arbitrary values must not contain whitespace (`w-[calc(100% - 1px)]` -> `w-[calc(100%_-_1px)]`). */
function fixClassWhitespace(cls: string): string {
  return cls.trim().replace(/\s+/g, '_');
}

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) return v.slice(1, -1);
  return v;
}

const SAFE_URL_CHARS = /^[^\s'"()\\]+$/;
const URL_TOKEN_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;

function urlToken(target: string): string {
  return SAFE_URL_CHARS.test(target) ? `url(${target})` : `url("${target.replace(/"/g, '\\"')}")`;
}

/**
 * Rewrite `url(…)` references: relative export paths (`../images/x.jpg`) are
 * resolved through `assetUrl` to their re-hosted absolute URL (null keeps the
 * original and reports `asset_missing`); absolute URLs are unquoted (Tailwind
 * v4 breaks on quotes inside background-image arbitrary values); `data:` / `#` URLs are kept as-is.
 */
export function rewriteCssUrls(value: string, assetUrl: CssAssetResolver, warn?: Warnings): string {
  return value.replace(URL_TOKEN_RE, (match, dq?: string, sq?: string, bare?: string) => {
    const target = (dq ?? sq ?? bare ?? '').trim();
    if (!target) return match;
    if (/^(data:|blob:|#)/i.test(target)) return match;
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target) || target.startsWith('/')) return urlToken(target);
    const resolved = assetUrl(target);
    if (resolved) return urlToken(resolved);
    warn?.add('asset_missing', `CSS url() has no file in the export: ${target}`);
    return urlToken(target);
  });
}

const VENDOR_PREFIX_RE = /^-(webkit|moz|ms|o)-/;
/** Same vectors `css-sanitize.ts` drops from residual CSS. */
const DANGEROUS_VALUE_RE = /expression\s*\(|-moz-binding|behavior\s*:|javascript:/i;
const FLEX_DIRECTIONS = new Set(['row', 'row-reverse', 'column', 'column-reverse']);
const FLEX_WRAPS = new Set(['wrap', 'nowrap', 'wrap-reverse']);

interface NormaliseContext {
  vars: Record<string, string>;
  assetUrl: CssAssetResolver;
  warn?: Warnings;
  /** `convert`: prepare for cssToClasses (drop vendor / custom props, first font family, expand flex-flow). `residual`: keep everything. */
  mode: 'convert' | 'residual';
}

function normaliseOne(decl: CssDeclaration, ctx: NormaliseContext): { decls: CssDeclaration[]; boundBackground: boolean; dropped: boolean } {
  let value = resolveVars(decl.value, ctx.vars).trim();
  const prop = decl.prop;
  if ((prop === 'background-image' || prop === 'background') && value.includes(BOUND_BG_PLACEHOLDER)) {
    return { decls: [], boundBackground: true, dropped: false };
  }
  if (/url\(/i.test(value)) value = rewriteCssUrls(value, ctx.assetUrl, ctx.warn);

  if (ctx.mode === 'residual') {
    return { decls: [{ prop, value, important: decl.important }], boundBackground: false, dropped: false };
  }

  if (prop.startsWith('--') || VENDOR_PREFIX_RE.test(prop)) {
    ctx.warn?.add('css_dropped', `dropped unsupported declaration ${prop}`);
    return { decls: [], boundBackground: false, dropped: true };
  }
  if (DANGEROUS_VALUE_RE.test(value) || /[<>]/.test(value)) {
    // Defence in depth: classes bypass `neutraliseCss` and end up verbatim in the
    // generated stylesheet, so legacy script vectors and markup (`content:"</style>"`)
    // never reach Tailwind. Angle brackets have no use in a Webflow value outside strings.
    ctx.warn?.add('css_dropped', `dropped unsafe declaration ${prop}`);
    return { decls: [], boundBackground: false, dropped: true };
  }
  if (prop === 'font-family') {
    const first = unquote(value.split(',')[0] ?? '').trim().replace(/\s+/g, '_');
    if (!first) return { decls: [], boundBackground: false, dropped: true };
    return { decls: [{ prop, value: first, important: false }], boundBackground: false, dropped: false };
  }
  if (prop === 'flex-flow') {
    const out: CssDeclaration[] = [];
    for (const tok of value.split(/\s+/)) {
      if (FLEX_DIRECTIONS.has(tok)) out.push({ prop: 'flex-direction', value: tok, important: false });
      else if (FLEX_WRAPS.has(tok)) out.push({ prop: 'flex-wrap', value: tok, important: false });
    }
    if (out.length === 0) return { decls: [{ prop, value, important: false }], boundBackground: false, dropped: false };
    return { decls: out, boundBackground: false, dropped: false };
  }
  return { decls: [{ prop, value, important: false }], boundBackground: false, dropped: false };
}

/** Collapse a declaration list so each property appears once with its LAST value (CSS cascade within one block). */
function dedupeByProp(decls: CssDeclaration[]): CssDeclaration[] {
  const order: string[] = [];
  const byProp = new Map<string, CssDeclaration>();
  for (const d of decls) {
    if (!byProp.has(d.prop)) order.push(d.prop);
    byProp.set(d.prop, d);
  }
  return order.map((p) => byProp.get(p)!);
}

/**
 * Prepare a declaration block for `cssToClasses`: variables resolved,
 * `!important` stripped, first font family only (spaces -> `_`), urls
 * rewritten to absolute re-hosted URLs, bound-background placeholder dropped
 * (flagged), `flex-flow` expanded, vendor-prefixed / custom properties dropped.
 */
export function normaliseDeclarations(
  decls: CssDeclaration[],
  vars: Record<string, string>,
  assetUrl: CssAssetResolver,
  warn: Warnings,
): { css: string; boundBackground: boolean; dropped: CssDeclaration[] } {
  const ctx: NormaliseContext = { vars, assetUrl, warn, mode: 'convert' };
  const out: CssDeclaration[] = [];
  const dropped: CssDeclaration[] = [];
  let boundBackground = false;
  for (const decl of decls) {
    const r = normaliseOne(decl, ctx);
    if (r.boundBackground) boundBackground = true;
    if (r.dropped) dropped.push(decl);
    out.push(...r.decls);
  }
  const css = dedupeByProp(out).map((d) => `${d.prop}: ${d.value}`).join('; ');
  return { css, boundBackground, dropped };
}

/** Serialise declarations for residual CSS (vars resolved, urls rewritten, `!important` kept). */
function residualBlock(decls: CssDeclaration[], vars: Record<string, string>, assetUrl: CssAssetResolver, warn: Warnings): string {
  const ctx: NormaliseContext = { vars, assetUrl, warn, mode: 'residual' };
  const out: CssDeclaration[] = [];
  for (const decl of decls) out.push(...normaliseOne(decl, ctx).decls);
  return out.map((d) => `${d.prop}:${d.value}${d.important ? ' !important' : ''};`).join('');
}

/** Declaration block -> whitespace-safe Tailwind classes. */
function convertBlock(decls: CssDeclaration[], vars: Record<string, string>, assetUrl: CssAssetResolver, warn: Warnings): { classes: string[]; boundBackground: boolean } {
  const { css, boundBackground } = normaliseDeclarations(decls, vars, assetUrl, warn);
  const classes = css ? cssToClasses(css).map(fixClassWhitespace).filter(Boolean) : [];
  return { classes, boundBackground };
}

// ─── Variant bucketing ────────────────────────────────────────────────────────

type ConvertibleBreakpoint = Exclude<WfBreakpoint, 'tiny'>;
const BP_RANK: Record<ConvertibleBreakpoint, number> = { main: 0, medium: 1, small: 2 };
const STATE_RANK: Record<string, number> = { '': 0, ':hover': 1, ':focus': 2, ':active': 3 };

/** Classes accumulated per selector key, bucketed by variant so the final order is main, medium, small, then states. */
class VariantAccumulator {
  private readonly buckets = new Map<string, { rank: number; classes: string[] }>();

  add(bp: ConvertibleBreakpoint, state: string, classes: string[]): void {
    const prefix = `${BREAKPOINT_PREFIX[bp]}${STATE_PREFIX[state] ?? ''}`;
    const rank = (STATE_RANK[state] ?? 0) * 10 + BP_RANK[bp];
    let bucket = this.buckets.get(prefix);
    if (!bucket) {
      bucket = { rank, classes: [] };
      this.buckets.set(prefix, bucket);
    }
    for (const cls of classes) bucket.classes.push(`${prefix}${cls}`);
  }

  merged(): string[] {
    const ordered = [...this.buckets.values()].sort((a, b) => a.rank - b.rank).flatMap((b) => b.classes);
    return mergePrefixedClasses(ordered);
  }
}

function breakpointOf(rule: CssRule): ConvertibleBreakpoint | 'tiny' | 'unknown' | 'none' {
  if (!rule.media) return 'none';
  if (rule.minWidth !== null) return 'unknown';
  if (rule.maxWidth === null) return 'unknown';
  if (rule.maxWidth <= 479) return 'tiny';
  if (rule.maxWidth <= 767) return 'small';
  if (rule.maxWidth <= 991) return 'medium';
  return 'unknown';
}

/** `screen and (max-width: 479px)` -> `(max-width:479px)` (grouping key and rendered query). */
export function mediaKey(media: string | null): string {
  if (!media) return '';
  return media
    .replace(/^\s*(only\s+)?(screen|all)\s+and\s+/i, '')
    .replace(/\s*:\s*/g, ':')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A `complex` selector that is really one compound with an unsupported pseudo
 * (`.a::before`, `.a:focus-visible`, `a:visited`, `.a:not(.b)`) is reported as
 * `pseudo`; combinators, attribute selectors and `*` stay `complex`.
 */
function residualReasonForComplex(parsed: ReturnType<typeof parseSelector>): ResidualReason {
  if (parsed.pseudo.length === 0) return 'complex';
  const withoutPseudo = parsed.raw.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '');
  return /[\s>+~[\]*]/.test(withoutPseudo) ? 'complex' : 'pseudo';
}

function scopeSelector(selector: string): string {
  if (/^(html|:root)(\b|$)/i.test(selector)) return selector;
  return `html ${selector}`;
}

// ─── Model builder ────────────────────────────────────────────────────────────

export interface BuildStyleModelInput {
  siteCss: string[];
  assetUrl: CssAssetResolver;
  warn: Warnings;
}

export function buildStyleModel(input: BuildStyleModelInput): WfStyleModel {
  const { assetUrl, warn } = input;

  // 1. Tokenize every sheet in order; merge :root vars (later sheets win).
  const sheets: CssSheet[] = input.siteCss.map((css) => tokenizeCss(css));
  const vars: Record<string, string> = {};
  const rules: CssRule[] = [];
  const atRules: CssSheet['atRules'] = [];
  const fontFaces: CssFontFace[] = [];
  let orderOffset = 0;
  for (const sheet of sheets) {
    Object.assign(vars, sheet.rootVars);
    for (const rule of sheet.rules) rules.push({ ...rule, order: rule.order + orderOffset });
    orderOffset += sheet.rules.length + 1;
    atRules.push(...sheet.atRules);
    fontFaces.push(...sheet.fontFaces);
  }

  const classAccum = new Map<string, VariantAccumulator>();
  const comboAccum = new Map<string, VariantAccumulator>();
  const idAccum = new Map<string, VariantAccumulator>();
  const boundBackgroundKeys = new Set<string>();
  const residual: WfStyleModel['residual'] = { rules: [], classNames: new Set(), ids: new Set() };
  const tagCss: string[] = [];
  const fontFamilies: string[] = [];
  const seenFamily = new Set<string>();

  const addFamily = (family: string) => {
    const f = unquote(family).trim();
    if (!f || GENERIC_FAMILIES.has(f.toLowerCase()) || seenFamily.has(f.toLowerCase())) return;
    seenFamily.add(f.toLowerCase());
    fontFamilies.push(f);
  };
  const noteResidual = (rule: CssRule, parsed: ReturnType<typeof parseSelector>, reason: ResidualReason) => {
    const block = residualBlock(rule.declarations, vars, assetUrl, warn);
    if (!block) return;
    residual.rules.push({ selector: parsed.raw, block, media: rule.media, reason });
    for (const c of parsed.classes) residual.classNames.add(c);
    if (parsed.id) residual.ids.add(parsed.id);
    warn.add('css_residual', `residual CSS rule kept verbatim (${reason})`);
  };

  for (const rule of rules) {
    for (const d of rule.declarations) {
      if (d.prop === 'font-family') addFamily(resolveVars(d.value, vars).split(',')[0] ?? '');
    }
    const parsed = parseSelector(rule.selector);
    const bp = breakpointOf(rule);

    if (parsed.kind === 'tag') {
      const tag = parsed.tag ?? '';
      const statePseudo = parsed.pseudo.length === 0 || (parsed.pseudo.length === 1 && parsed.pseudo[0] in STATE_PREFIX);
      const convertible = bp !== 'tiny' && bp !== 'unknown';
      if (UPSTREAM_TAGS.has(tag) && statePseudo && convertible) {
        // Feed upstream's parser a synthetic sheet (vars already resolved; tiny rules excluded — D11).
        const block = normaliseDeclarations(rule.declarations, vars, assetUrl, warn).css;
        if (block) {
          const wrapped = rule.media && bp !== 'none' ? `@media (max-width: ${rule.maxWidth}px) { ${parsed.raw} { ${block} } }` : `${parsed.raw} { ${block} }`;
          tagCss.push(wrapped);
        }
      }
      if (!UNDERLAY_TAGS.has(tag) || !statePseudo || !convertible) {
        noteResidual(rule, parsed, !convertible ? (bp === 'tiny' ? 'tiny' : 'media') : 'complex');
      }
      continue;
    }

    if (parsed.kind === 'complex') {
      noteResidual(rule, parsed, residualReasonForComplex(parsed));
      continue;
    }
    if (bp === 'tiny') {
      noteResidual(rule, parsed, 'tiny');
      continue;
    }
    if (bp === 'unknown') {
      noteResidual(rule, parsed, 'media');
      continue;
    }
    const state = parsed.pseudo[0] ?? '';
    if (state && !(state in STATE_PREFIX)) {
      noteResidual(rule, parsed, 'pseudo');
      continue;
    }

    const { classes, boundBackground } = convertBlock(rule.declarations, vars, assetUrl, warn);
    const breakpoint: ConvertibleBreakpoint = bp === 'none' ? 'main' : bp;
    let key: string;
    let accum: Map<string, VariantAccumulator>;
    if (parsed.kind === 'id') {
      key = parsed.id ?? '';
      accum = idAccum;
    } else if (parsed.kind === 'combo') {
      key = parsed.classes.join('.');
      accum = comboAccum;
    } else {
      key = parsed.classes[0];
      accum = classAccum;
    }
    if (!key) continue;
    if (boundBackground) boundBackgroundKeys.add(key);
    let a = accum.get(key);
    if (!a) {
      a = new VariantAccumulator();
      accum.set(key, a);
    }
    a.add(breakpoint, state, classes);
  }

  // 2. Tag underlays via upstream (parseGlobalStylesheet + ruleToClasses), only `tagRules`.
  const tags = new Map<string, ImportStyleRef>();
  if (tagCss.length > 0) {
    const global = parseGlobalStylesheet(tagCss.join('\n'));
    for (const [tag, rule] of global.tagRules) {
      const classes = mergePrefixedClasses(ruleToClasses(rule).map(fixClassWhitespace));
      tags.set(tag, {
        key: `wf-tag:${tag}`,
        name: TAG_STYLE_NAMES[tag] ?? tag.charAt(0).toUpperCase() + tag.slice(1),
        classes,
      });
    }
  }

  // 3. Refs.
  const classes = new Map<string, { ref: ImportStyleRef; boundBackground: boolean }>();
  for (const [name, a] of classAccum) {
    classes.set(name, { ref: { key: `wf:${name}`, name, classes: a.merged() }, boundBackground: boundBackgroundKeys.has(name) });
  }
  const combos = new Map<string, ImportStyleRef>();
  for (const [chain, a] of comboAccum) {
    combos.set(chain, { key: `wf:${chain}`, name: chain.split('.').join(' '), classes: a.merged(), combo: true });
  }
  const ids = new Map<string, string[]>();
  for (const [id, a] of idAccum) ids.set(id, a.merged());

  // 4. Residual CSS: group by media, namespace + scope selectors, neutralise.
  const groups = new Map<string, string[]>();
  groups.set('', []);
  for (const rule of residual.rules) {
    const key = mediaKey(rule.media);
    let lines = groups.get(key);
    if (!lines) {
      lines = [];
      groups.set(key, lines);
    }
    lines.push(`${scopeSelector(namespaceSelector(rule.selector))}{${rule.block}}`);
  }
  const rendered: string[] = [];
  for (const [key, lines] of groups) {
    if (lines.length === 0) continue;
    rendered.push(key ? `@media ${key}{\n${lines.join('\n')}\n}` : lines.join('\n'));
  }
  for (const at of atRules) {
    if (at.name === 'keyframes' || at.name === 'property' || at.name === 'font-feature-values') rendered.push(at.raw);
    else if (at.name !== 'import' && at.name !== 'charset') warn.add('css_dropped', `dropped @${at.name} block`);
  }
  const neutralised = neutraliseCss(rendered.join('\n'));
  if (neutralised.changes > 0) warn.add('css_neutralised', 'residual CSS contained markup or unsafe values that were neutralised', { count: neutralised.changes });

  // 5. Fonts.
  const faces: CssFontFace[] = [];
  const seenFace = new Set<string>();
  for (const face of fontFaces) {
    const k = `${face.family.toLowerCase()}|${face.weight}|${face.style}`;
    if (seenFace.has(k)) continue;
    seenFace.add(k);
    faces.push(face);
    addFamily(face.family);
  }

  return {
    classes,
    combos,
    ids,
    tags,
    residual,
    residualCss: neutralised.css,
    fontFaces: faces,
    fontFamilies,
    boundBackgroundKeys,
  };
}

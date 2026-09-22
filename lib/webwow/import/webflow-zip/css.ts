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
import { mergeClassStack, splitVariant } from '@/lib/layer-style-resolve';
import { getAffectedProperties, removeConflictsForClass } from '@/lib/tailwind-class-mapper';
import type { ImportStyleRef } from '@/lib/import/types';
import {
  parseSelector,
  resolveVars,
  splitCompoundsWithCombinators,
  tokenizeCss,
  type CssDeclaration,
  type CssFontFace,
  type CssRule,
  type CssSheet,
} from './css-tokenizer';
import { neutraliseCss } from './css-sanitize';
import { isFrameworkClass } from './framework-classes';
import { carrierRoles, isStateClass, stateImpliedBy, type WfStateClass, type WfStateRule } from './states';
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

/**
 * Tags a rich-text container styles through descendant rules (`.w-richtext figure`,
 * `.rich-text-block p`). Such a rule feeds `layer.textStyles` of the rich-text
 * layer (richtext-styles.ts) instead of the residual CSS.
 */
export const RICH_TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'strong', 'b', 'em', 'i', 'blockquote', 'figure', 'figcaption', 'img', 'hr']);

/** `.scope tag`, `.scope > tag`, `.scope tag tag`, optionally with a trailing state pseudo. */
const RICH_TEXT_DESCENDANT_RE = new RegExp(`^\\.[^\\s>+~.#:[]+(?:(?:\\s*>\\s*|\\s+)(?:${[...RICH_TEXT_TAGS].join('|')}))+(?::(?:hover|focus|active))?$`);

/**
 * The rich-text container class a descendant rule belongs to, or `null`. Only
 * `.w-richtext` and the classes of the export's rich-text elements (`scopes`,
 * collected by `collectRichTextClasses`) count: `.hero p` stays a residual rule
 * because a `<p>` under a plain box is a layer the residual CSS still reaches.
 */
export function richTextDescendantScope(parsed: ReturnType<typeof parseSelector>, scopes: ReadonlySet<string>): string | null {
  if (parsed.classes.length !== 1 || parsed.id || !parsed.tag || !RICH_TEXT_TAGS.has(parsed.tag)) return null;
  if (parsed.pseudo.length > 1 || (parsed.pseudo.length === 1 && !(parsed.pseudo[0] in STATE_PREFIX))) return null;
  if (!RICH_TEXT_DESCENDANT_RE.test(parsed.raw)) return null;
  const scope = parsed.classes[0];
  return scope === 'w-richtext' || scopes.has(scope) ? scope : null;
}

/**
 * `"Neue Haas", Arial, sans-serif` -> `{ family: 'Neue Haas', fallback: 'Arial, sans-serif' }`
 * (names unquoted, commas inside quotes respected); `fallback` is empty for a single family.
 */
export function fontStackOf(value: string): { family: string; fallback: string } {
  const names = splitFontStack(value);
  return { family: unquote(names[0] ?? '').trim(), fallback: names.slice(1).join(', ') };
}

/** Top-level comma split of a `font-family` value (commas inside quotes kept), entries trimmed, empties dropped. */
function splitFontStack(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === '\'') {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

/** One font-stack entry: a quoted name without markup / block / escape characters, or a plain identifier sequence. */
const SAFE_FONT_ENTRY_RE = /^(?:"[^"<>{};\\\n\r\f]*"|'[^'<>{};\\\n\r\f]*'|[\p{L}\p{N}_ -]+)$/u;

/**
 * A fallback stack from the export (`Arial, "Helvetica Neue", sans-serif`) that
 * is safe to store as a font row's `category`, or null. ycode writes the
 * category verbatim into a `<style>` element (`buildFontClassesCss`), so an
 * entry that could close the declaration, the rule or the element (`"x}</style>…"`)
 * rejects the whole stack.
 */
export function safeFontFallback(fallback: string): string | null {
  const entries = splitFontStack(fallback);
  if (entries.length === 0) return null;
  return entries.every((e) => SAFE_FONT_ENTRY_RE.test(e)) ? entries.join(', ') : null;
}

/**
 * A family name (from `@font-face` or a rule's stack) that ycode may quote into
 * a stylesheet (`font-family: "<name>"`): no quotes, markup, block or escape
 * characters, no control characters.
 */
export function isSafeFontFamilyName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return name.trim().length > 0 && !/["'<>{};\\\u0000-\u001f\u007f]/.test(name);
}

const GENERIC_FAMILIES = new Set(['inherit', 'initial', 'unset', 'revert', 'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong']);

// ─── Model ────────────────────────────────────────────────────────────────────

/**
 * Why a rule is residual CSS. `combo` and `state` are not verbatim rules but
 * translated ones: `combo` re-states a combo's declarations under 480 px where
 * a `tiny` rule of a lower class would otherwise beat the combo's utilities
 * ({@link comboTinyOverrides}); `state` is a state rule inside a complex
 * selector, rewritten to what ycode renders ({@link contextualStateOf}).
 */
export type ResidualReason = 'tiny' | 'media' | 'pseudo' | 'complex' | 'important-only' | 'combo' | 'state';

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
  /**
   * Stylesheet position of the first rule of a class or combo chain: the order
   * two single-class rules cascade in (`.button` before `.heading-2` means
   * `.heading-2` wins on an element `heading-2 button`; html.ts `resolveStyles`).
   */
  order?: Map<string, number>;
  /** `w-node-…` (no `#`) -> prefixed Tailwind classes (one-off). */
  ids: Map<string, string[]>;
  /** `p`, `a`, … -> key `wf-tag:<tag>`, name from TAG_STYLE_NAMES. */
  tags: Map<string, ImportStyleRef>;
  residual: { rules: ResidualRule[]; classNames: Set<string>; ids: Set<string> };
  /** Rendered, namespaced, neutralised; `@media` grouped ({@link renderResidualCss}). */
  residualCss: string;
  fontFaces: CssFontFace[];
  fontFamilies: string[];
  /**
   * Fallback stack per family (lower-cased key), from the first site rule that
   * names one: `NeueHaas, Arial, sans-serif` -> `neuehaas` -> `Arial, sans-serif`.
   * ycode's font class carries one family plus the font row's `category`
   * (`buildFontClassesCss`), so fonts.ts stores the stack there.
   */
  fontFallbacks?: Map<string, string>;
  /** Class names AND combo chains whose rules carry the bound-background placeholder. */
  boundBackgroundKeys: Set<string>;
  /**
   * Webflow state-combo rules (`.dropdown-list.w--open`, `.nav-menu[data-nav-menu-open]`)
   * keyed by the chain without the state class (`dropdown-list`, `a.b`); html.ts merges
   * them into the chip or turns them into a tween per element role (states.ts).
   */
  states: Map<string, WfStateRule[]>;
  /** Main-breakpoint declarations per class / combo chain: the resting values a state tween starts from. */
  resting: Map<string, CssDeclaration[]>;
  /**
   * Descendant tag rules of rich-text containers: container class (`w-richtext`,
   * `rich-text-block`) -> tag -> prefixed Tailwind classes. Feeds
   * `layer.textStyles` (richtext-styles.ts); these rules are not residual CSS.
   */
  richTextTags?: Map<string, Map<string, string[]>>;
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
 * Utility classes of a page's `<body>`: the `body` tag rule, then the classes
 * the export put on the element (`<body class="body">`), later ones winning.
 * A body class the residual stylesheet still selects (its `tiny` rule, a
 * pseudo-element) keeps its `wf-<name>` hook exactly like every other layer
 * (D1), so `html .wf-body { … }` reaches the rendered body.
 */
export function bodyClassesFor(bodyClassNames: string[], model: Pick<WfStyleModel, 'tags' | 'classes' | 'residual'>): string {
  const stack: string[] = [...(model.tags.get('body')?.classes ?? [])];
  for (const name of bodyClassNames) {
    const entry = model.classes.get(name);
    if (entry) stack.push(...entry.ref.classes);
    if (model.residual.classNames.has(name)) stack.push(wfClass(name));
  }
  return mergeClassStack(stack).join(' ').trim();
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
    // Arbitrary properties (`[border-top-style:none]`, `[background-color:…]`) are invisible to
    // upstream's conflict rules: a later class evicts one (or is evicting one) by CSS longhands.
    const covers = cssLonghandsOfUtility(base);
    if (covers.length > 0) {
      for (let i = merged.length - 1; i >= 0; i--) {
        const m = splitVariant(merged[i]);
        if (m.prefix !== prefix || (!arbitraryPropertyOf(m.base) && !arbitraryPropertyOf(base))) continue;
        const earlier = cssLonghandsOfUtility(m.base);
        if (earlier.length > 0 && earlier.every((p) => covers.includes(p))) merged.splice(i, 1);
      }
    }
    if (!merged.includes(cls)) merged.push(cls);
  }
  return merged;
}

/** Tailwind arbitrary values must not contain whitespace (`w-[calc(100% - 1px)]` -> `w-[calc(100%_-_1px)]`). */
/**
 * Tidy one produced class: whitespace inside arbitrary values becomes `_`, and
 * the arbitrary-property fallback for a border reset (`border: 0` / `none`,
 * which normalize.css puts on `button`, `img`, `legend`) becomes the `border-0`
 * utility. The fallback `[border:0]` has no affected properties, so the stack
 * merge could never evict it and it kept winning over a class's real border
 * (`border border-solid border-[#ccc]`) in the generated stylesheet; `border-0`
 * is a border-width utility the merge replaces like any other.
 */
function fixClassWhitespace(cls: string): string {
  const tidy = cls.trim().replace(/\s+/g, '_');
  const m = tidy.match(/^((?:[a-z-]+:)*)\[border:(?:0|0px|none|initial)\]$/);
  if (m) return `${m[1]}border-0`;
  return tidy;
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

/** CSS `font-weight` keywords -> the numeric weight ycode's design panel and Tailwind both understand. */
export const FONT_WEIGHT_KEYWORDS: Record<string, string> = { bold: '700', normal: '400', bolder: '700', lighter: '300' };

/** `font-[bold]` -> `font-[700]` (any variant prefix kept); everything else unchanged. */
export function repairFontWeightClass(cls: string): string {
  const m = cls.match(/^(.*:)?font-\[([a-z]+)\]$/i);
  if (!m) return cls;
  const numeric = FONT_WEIGHT_KEYWORDS[m[2].toLowerCase()];
  return numeric ? `${m[1] ?? ''}font-[${numeric}]` : cls;
}

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
  if (prop === 'font-weight') {
    // Keywords become numbers before upstream's converter sees them: it emits
    // `font-[<value>]` verbatim, and Tailwind v4 reads a non-numeric arbitrary
    // `font-[…]` as a font *family* — `font-[bold]` made headings serif and thin.
    const numeric = FONT_WEIGHT_KEYWORDS[value.toLowerCase()];
    if (numeric) value = numeric;
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
  const side = expandBorderSide(prop, value);
  if (side) return { decls: side, boundBackground: false, dropped: false };
  return { decls: [{ prop, value, important: false }], boundBackground: false, dropped: false };
}

const BORDER_STYLES = new Set(['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset']);
const BORDER_WIDTH_RE = /^(thin|medium|thick|-?\d*\.?\d+[a-z%]*|calc\(.*\))$/i;
/** `border-top` & co: the per-side longhands, which convertBlock keeps as arbitrary properties. */
export const BORDER_SIDE_LONGHAND_RE = /^border-(top|right|bottom|left)-(width|style|color)$/;

/**
 * `border-top: 1px #000` -> `border-top-width: 1px; border-top-style: none;
 * border-top-color: #000` (omitted parts get their initial value, as the
 * shorthand resets them). Kept as one arbitrary `[border-top:…]` class, the
 * shorthand beat a combo's longhand (`.section.small { border-top-style: solid }`):
 * Tailwind sorts unknown properties after known ones, and no merge ever evicts
 * an arbitrary shorthand. As longhands, the combo's `[border-top-style:solid]`
 * replaces the base's `[border-top-style:none]` in the layer's stack
 * (convert-bridge `dropShadowedClasses` keys arbitrary properties by name).
 * Null for anything else (a global keyword or a variable stays one declaration).
 */
export function expandBorderSide(prop: string, value: string): CssDeclaration[] | null {
  const m = prop.match(/^border-(top|right|bottom|left)$/);
  if (!m || /var\(|^(inherit|initial|unset|revert)$/i.test(value.trim())) return null;
  const tokens: string[] = [];
  let current = '';
  let depth = 0;
  for (const ch of value.trim()) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  let width = 'medium';
  let style = 'none';
  let color = 'currentcolor';
  for (const t of tokens) {
    if (BORDER_STYLES.has(t.toLowerCase())) style = t.toLowerCase();
    else if (BORDER_WIDTH_RE.test(t)) width = t;
    else color = t;
  }
  const side = m[1];
  return [
    { prop: `border-${side}-width`, value: width, important: false },
    { prop: `border-${side}-style`, value: style, important: false },
    { prop: `border-${side}-color`, value: color, important: false },
  ];
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
): { css: string; normalised: CssDeclaration[]; boundBackground: boolean; dropped: CssDeclaration[] } {
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
  const normalised = dedupeByProp(out);
  const css = normalised.map((d) => `${d.prop}: ${d.value}`).join('; ');
  return { css, normalised, boundBackground, dropped };
}

/** Serialise declarations for residual CSS (vars resolved, urls rewritten, `!important` kept). */
function residualBlock(decls: CssDeclaration[], vars: Record<string, string>, assetUrl: CssAssetResolver, warn: Warnings): string {
  const ctx: NormaliseContext = { vars, assetUrl, warn, mode: 'residual' };
  const out: CssDeclaration[] = [];
  for (const decl of decls) out.push(...normaliseOne(decl, ctx).decls);
  return out.map((d) => `${d.prop}:${d.value}${d.important ? ' !important' : ''};`).join('');
}

/** Declaration block -> whitespace-safe Tailwind classes. */
/**
 * Convert one declaration block to utility classes, **one declaration at a
 * time**, so that
 *
 *  a) a value containing a `;` (a `url(data:…;base64,…)`) cannot corrupt the
 *     declaration after it — upstream's `cssToClasses` splits its input on `;`;
 *  b) every declaration that yields no class at all is counted in a
 *     `css_dropped` warning naming the property. Without this the loss is
 *     invisible: `cssToClasses` silently returns `[]` for anything its
 *     arbitrary-value fallback refuses (SPEC §4.5, target "every dropped
 *     declaration is counted").
 */
function convertBlock(decls: CssDeclaration[], vars: Record<string, string>, assetUrl: CssAssetResolver, warn: Warnings, selector: string): { classes: string[]; boundBackground: boolean; normalised: CssDeclaration[] } {
  const { normalised, boundBackground } = normaliseDeclarations(decls, vars, assetUrl, warn);
  const classes: string[] = [];
  for (const decl of normalised) {
    // Per-side border longhands stay arbitrary properties: `border-t-[1px]` would also set
    // `border-top-style` (Tailwind's `--tw-border-style`, solid), which Webflow's rule never does.
    const produced = BORDER_SIDE_LONGHAND_RE.test(decl.prop)
      ? [fixClassWhitespace(`[${decl.prop}:${decl.value}]`)]
      : cssToClasses(`${decl.prop}: ${decl.value}`).map(fixClassWhitespace).map(repairFontWeightClass).filter(Boolean);
    if (produced.length === 0) {
      warn.add('css_dropped', `declaration ${decl.prop} on ${selector} produced no utility class`);
      continue;
    }
    classes.push(...produced);
  }
  return { classes, boundBackground, normalised };
}

// ─── Variant bucketing ────────────────────────────────────────────────────────

type ConvertibleBreakpoint = Exclude<WfBreakpoint, 'tiny'>;
const BP_RANK: Record<ConvertibleBreakpoint, number> = { main: 0, medium: 1, small: 2 };
const STATE_RANK: Record<string, number> = { '': 0, ':hover': 1, ':focus': 2, ':active': 3 };
/** Accumulator state key for `.x.w--current` -> ycode's `current:` variant (`aria-current="page"`). */
const CURRENT_STATE: WfStateClass = 'w--current';
const CURRENT_PREFIX = 'current:';

/** Classes accumulated per selector key, bucketed by variant so the final order is main, medium, small, then states. */
class VariantAccumulator {
  private readonly buckets = new Map<string, { rank: number; classes: string[] }>();

  add(bp: ConvertibleBreakpoint, state: string, classes: string[]): void {
    const prefix = `${BREAKPOINT_PREFIX[bp]}${state === CURRENT_STATE ? CURRENT_PREFIX : (STATE_PREFIX[state] ?? '')}`;
    const rank = (state === CURRENT_STATE ? 4 : (STATE_RANK[state] ?? 0)) * 10 + BP_RANK[bp];
    let bucket = this.buckets.get(prefix);
    if (!bucket) {
      bucket = { rank, classes: [] };
      this.buckets.set(prefix, bucket);
    }
    for (const cls of classes) bucket.classes.push(`${prefix}${cls}`);
  }

  merged(): string[] {
    const ordered = [...this.buckets.values()].sort((a, b) => a.rank - b.rank).flatMap((b) => keepColourBesideGradient(b.classes));
    return mergePrefixedClasses(ordered);
  }
}

/** `bg-[linear-gradient(…)]`: a background-image upstream's mapper files under `backgroundColor`. */
export function isGradientBackgroundClass(base: string): boolean {
  return /^bg-\[.*gradient\(/.test(base);
}

/** `bg-[#00000070]` -> `#00000070` for a plain background-colour utility; null for anything else. */
function plainBackgroundColour(base: string): string | null {
  const m = base.match(/^bg-\[(.+)\]$/);
  if (!m || isGradientBackgroundClass(base)) return null;
  const props = getAffectedProperties(base);
  return props.length === 1 && props[0] === 'backgroundColor' ? m[1] : null;
}

/**
 * A colour and a gradient of one variant bucket (`.section.shadow { background-color:
 * #00000070; background-image: linear-gradient(…) }`) are two CSS properties that
 * both paint, but upstream's merge files the gradient class under `backgroundColor`
 * and evicts the colour (in the chip here, in the layer's stack on every
 * re-flatten). The colour becomes an arbitrary property there, which no upstream
 * merge evicts: `[background-color:#00000070] bg-[linear-gradient(…)]`.
 */
export function keepColourBesideGradient(classes: string[]): string[] {
  const hasGradient = classes.some((c) => isGradientBackgroundClass(splitVariant(c).base));
  if (!hasGradient) return classes;
  return classes.map((c) => {
    const { prefix, base } = splitVariant(c);
    const colour = plainBackgroundColour(base);
    return colour ? `${prefix}[background-color:${colour}]` : c;
  });
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

// ─── Combo precedence ─────────────────────────────────────────────────────────
//
// In Webflow's stylesheet `.section.small { padding: 10px 20px }` beats every
// `.section` rule, whatever breakpoint the latter sits on: two classes outrank
// one. As chips both are utilities of equal weight, so a base rule on a
// *narrower* breakpoint (`max-lg:p-[50px]` from `.section` at 991 px, or the
// residual `html .wf-section { … }` of its `tiny` rule) would win over the
// combo's main-breakpoint value. Two repairs restore Webflow's cascade:
//
// - {@link liftComboOverBreakpoints}: the combo chip re-states its value on
//   every narrower breakpoint where a lower chip touches the same property
//   (`max-lg:p-[10px_20px]`), so the stack merge evicts the base's utility.
// - {@link comboTinyOverrides}: under 480 px there is no tier, so the combo's
//   effective declarations for the properties of the base's `tiny` rules are
//   emitted as a residual rule of higher specificity (`html .wf-section.wf-small`).

const LIFT_PREFIXES = ['', 'max-lg:', 'max-md:'];

/** `[border-top-style:solid]` -> `border-top-style`; null for anything that is not an arbitrary property. */
function arbitraryPropertyOf(cls: string): string | null {
  const m = cls.match(/^\[(-?[a-z][a-z-]*):/);
  return m ? m[1] : null;
}

/** Design keys of upstream's class map whose CSS property is not simply the kebab-cased key. */
const DESIGN_KEY_CSS: Record<string, string[]> = {
  paddingX: ['padding-left', 'padding-right'],
  paddingY: ['padding-top', 'padding-bottom'],
  marginX: ['margin-left', 'margin-right'],
  marginY: ['margin-top', 'margin-bottom'],
  gridColumnSpan: ['grid-column-start', 'grid-column-end'],
  gridRowSpan: ['grid-row-start', 'grid-row-end'],
  underlineOffset: ['text-underline-offset'],
  duration: ['transition-duration'],
  easing: ['transition-timing-function'],
  delay: ['transition-delay'],
  blur: ['filter'],
  backdropBlur: ['backdrop-filter'],
  // `translate-x-*` / `translate-y-*` each set their own variable of the shared `translate`.
  translateX: ['--tw-translate-x'],
  translateY: ['--tw-translate-y'],
  // `underline` / `line-through` set the line only, never the decoration colour.
  textDecoration: ['text-decoration-line'],
};

/**
 * The CSS longhands a utility sets: an arbitrary property by its name
 * (`[border-top-style:none]`, `[padding:0]`), anything else through upstream's
 * `getAffectedProperties` (`pt-[5px]` -> `padding-top`, `border-[#000]` -> the
 * four `border-*-color`s). Empty for a class neither knows.
 */
export function cssLonghandsOfUtility(cls: string): string[] {
  const arbitrary = arbitraryPropertyOf(cls);
  if (arbitrary) return longhandsOf(arbitrary);
  // Upstream files `bg-[linear-gradient(…)]` under `backgroundColor`; in CSS it is an image.
  if (isGradientBackgroundClass(splitVariant(cls).base)) return ['background-image'];
  const out = new Set<string>();
  for (const key of getAffectedProperties(cls)) {
    for (const prop of DESIGN_KEY_CSS[key] ?? [key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)]) {
      for (const longhand of longhandsOf(prop)) out.add(longhand);
    }
  }
  return [...out];
}

/**
 * Two utilities set the same property (also shorthand vs longhand: `p-[…]` /
 * `pl-[…]`): by upstream's own conflict rules for two regular utilities, by
 * CSS longhands as soon as one of them is an arbitrary property
 * (`[border-top-style:solid]` vs `[border-top-style:none]` or `border-solid`).
 */
function utilitiesConflict(a: string, b: string): boolean {
  if (arbitraryPropertyOf(a) || arbitraryPropertyOf(b)) {
    const la = cssLonghandsOfUtility(a);
    return cssLonghandsOfUtility(b).some((p) => la.includes(p));
  }
  if (getAffectedProperties(a).length === 0 || getAffectedProperties(b).length === 0) return false;
  return !removeConflictsForClass([a], b).includes(a) || !removeConflictsForClass([b], a).includes(b);
}

function sameProperties(a: string, b: string): boolean {
  if (arbitraryPropertyOf(a) || arbitraryPropertyOf(b)) {
    const pa = cssLonghandsOfUtility(a).sort().join(',');
    return pa !== '' && pa === cssLonghandsOfUtility(b).sort().join(',');
  }
  const pa = [...getAffectedProperties(a)].sort().join(',');
  return pa !== '' && pa === [...getAffectedProperties(b)].sort().join(',');
}

/**
 * Re-state a combo's utilities on the narrower breakpoints where a lower chip
 * (a class of the chain, a shorter combo, or any other class the combo's
 * elements carry) sets the same property, so the combo keeps winning there as
 * it does in Webflow. Only there: a property no lower chip touches on that
 * breakpoint is left alone, and a property the combo has its own value for on
 * that breakpoint keeps it.
 *
 * Per breakpoint, the combo's values above it are re-stated widest source
 * first (main, then `max-lg:`), so the stack merge (later wins) leaves exactly
 * what cascades to that breakpoint in Webflow: a narrower longhand
 * (`max-lg:pl-[5px]`) refines a wider shorthand (`p-[10px]`), a narrower
 * shorthand replaces a wider longhand. A value that overlaps an already
 * re-stated one is re-stated with it, even when no lower chip touches it
 * (`p-[10px]` lifted for a lower `max-md:pt-…` drags the combo's
 * `max-lg:pl-[5px]` along, or the lift would reset padding-left to 10px).
 */
export function liftComboOverBreakpoints(combo: string[], lower: string[]): string[] {
  // Widest source first.
  const own = combo
    .map((c) => ({ ...splitVariant(c), rank: LIFT_PREFIXES.indexOf(splitVariant(c).prefix) }))
    .filter((c) => c.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  const lowerByRank = new Map<number, string[]>();
  for (const cls of lower) {
    const low = splitVariant(cls);
    const rank = LIFT_PREFIXES.indexOf(low.prefix);
    if (rank <= 0) continue;
    lowerByRank.set(rank, [...(lowerByRank.get(rank) ?? []), low.base]);
  }
  const added: string[] = [];
  for (const rank of [...lowerByRank.keys()].sort((a, b) => a - b)) {
    const prefix = LIFT_PREFIXES[rank];
    const lows = lowerByRank.get(rank)!;
    const marked: typeof own = [];
    for (const c of own) {
      if (c.rank >= rank) continue;
      if (lows.some((l) => utilitiesConflict(c.base, l)) || marked.some((m) => utilitiesConflict(m.base, c.base))) marked.push(c);
    }
    for (const c of marked) {
      // The combo already speaks for exactly these properties on that breakpoint (its own rule there wins anyway).
      const covered = combo.some((x) => {
        const sx = splitVariant(x);
        return sx.prefix === prefix && (sx.base === c.base || sameProperties(sx.base, c.base));
      });
      if (!covered) added.push(`${prefix}${c.base}`);
    }
  }
  // Re-stated values first: a combo's own longhand on that breakpoint (`max-lg:pt-[5px]`)
  // still refines a re-stated shorthand (`max-lg:p-[0]`).
  return added.length > 0 ? mergePrefixedClasses([...added, ...combo]) : combo;
}

/** CSS shorthands -> the longhands they set (enough to tell whether two declarations touch the same property). */
const CSS_SHORTHANDS: Record<string, string[]> = {
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  inset: ['top', 'right', 'bottom', 'left'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
  background: ['background-color', 'background-image', 'background-position', 'background-size', 'background-repeat', 'background-attachment', 'background-origin', 'background-clip'],
  font: ['font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch', 'line-height'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  gap: ['row-gap', 'column-gap'],
  'grid-gap': ['row-gap', 'column-gap'],
  'grid-row-gap': ['row-gap'],
  'grid-column-gap': ['column-gap'],
  overflow: ['overflow-x', 'overflow-y'],
  'grid-column': ['grid-column-start', 'grid-column-end'],
  'grid-row': ['grid-row-start', 'grid-row-end'],
  'grid-area': ['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end'],
  'grid-template': ['grid-template-rows', 'grid-template-columns', 'grid-template-areas'],
  grid: ['grid-template-rows', 'grid-template-columns', 'grid-template-areas', 'grid-auto-rows', 'grid-auto-columns', 'grid-auto-flow'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
  'place-self': ['align-self', 'justify-self'],
  outline: ['outline-width', 'outline-style', 'outline-color'],
  'list-style': ['list-style-type', 'list-style-position', 'list-style-image'],
  'text-decoration': ['text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness'],
  transition: ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'],
  columns: ['column-width', 'column-count'],
};
CSS_SHORTHANDS.border = [...CSS_SHORTHANDS['border-width'], ...CSS_SHORTHANDS['border-style'], ...CSS_SHORTHANDS['border-color']];

function longhandsOf(prop: string): string[] {
  const p = prop.trim().toLowerCase();
  return CSS_SHORTHANDS[p] ?? [p];
}

/** `padding` vs `padding-left`, `border` vs `border-top-color`, or the same property. */
export function declarationsOverlap(a: string, b: string): boolean {
  const la = longhandsOf(a);
  return longhandsOf(b).some((p) => la.includes(p));
}

/**
 * Per combo chain: the site classes (framework classes excluded, as html.ts does)
 * that elements carrying the combo have besides the chain itself. An element
 * carries a combo when its site classes start with the chain (in any order of
 * that prefix, as html.ts `resolveStyles` matches them).
 */
export function coOccurringClasses(chains: string[], classLists: readonly (readonly string[])[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (classLists.length === 0) return out;
  const bySet = new Map<string, string[]>();
  for (const chain of chains) {
    const key = chain.split('.').sort().join('.');
    bySet.set(key, [...(bySet.get(key) ?? []), chain]);
  }
  for (const list of classLists) {
    const site = list.filter((c) => !isFrameworkClass(c));
    for (let n = 2; n <= site.length; n++) {
      const hits = bySet.get(site.slice(0, n).sort().join('.'));
      if (!hits) continue;
      const others = site.filter((c, i) => i >= n && !site.slice(0, n).includes(c));
      if (others.length === 0) continue;
      for (const chain of hits) out.set(chain, [...new Set([...(out.get(chain) ?? []), ...others])]);
    }
  }
  return out;
}

/**
 * Across chips, a gradient and a plain colour must not evict each other either
 * ({@link keepColourBesideGradient}): the layer's stack is re-flattened by
 * upstream's merge, which files both under `backgroundColor`. Where a lower
 * chip has a plain colour on a variant the combo has a gradient on (or the other
 * way round), the combo's class becomes the arbitrary property it really is
 * (`[background-image:…]` / `[background-color:…]`), which that merge leaves
 * alone; a lower class of the same property is still dropped per layer
 * (convert-bridge `dropShadowedClasses`, by CSS longhands).
 */
export function keepBackgroundLayersApart(combo: string[], lower: string[]): string[] {
  const kinds = new Map<string, Set<'colour' | 'gradient'>>();
  for (const cls of lower) {
    const { prefix, base } = splitVariant(cls);
    const kind = isGradientBackgroundClass(base) ? 'gradient' : plainBackgroundColour(base) !== null ? 'colour' : null;
    if (!kind) continue;
    kinds.set(prefix, new Set([...(kinds.get(prefix) ?? []), kind]));
  }
  if (kinds.size === 0) return combo;
  return combo.map((cls) => {
    const { prefix, base } = splitVariant(cls);
    const below = kinds.get(prefix);
    if (!below) return cls;
    if (isGradientBackgroundClass(base) && below.has('colour')) return `${prefix}[background-image:${base.slice(4, -1)}]`;
    const colour = plainBackgroundColour(base);
    if (colour !== null && below.has('gradient')) return `${prefix}[background-color:${colour}]`;
    return cls;
  });
}

/** The media query the derived tiny overrides sit in (same group key as Webflow's `screen and (max-width: 479px)`). */
const TINY_MEDIA = '(max-width: 479px)';

/** Declarations of a class / combo chain per breakpoint (raw, `!important` kept). */
type BlocksByBreakpoint = Partial<Record<ConvertibleBreakpoint, CssDeclaration[]>>;

/**
 * For a combo chain whose base class (or a shorter combo of the chain) has a
 * `tiny` rule (or any other class of an element carrying the combo, `otherClasses`):
 * the combo's effective declarations (main, then medium, then
 * small — all apply under 480 px) for every property that tiny rule touches.
 * Empty when nothing overlaps. An `!important` tiny declaration keeps winning
 * unless the combo's is important too, as in the original cascade.
 */
export function comboTinyOverrides(chain: string, blocks: Map<string, BlocksByBreakpoint>, tinyByKey: Map<string, CssDeclaration[]>, otherClasses: string[] = []): CssDeclaration[] {
  const parts = chain.split('.');
  const lowerKeys = [...parts, ...otherClasses];
  for (let i = 2; i < parts.length; i++) lowerKeys.push(parts.slice(0, i).join('.'));
  const tiny = lowerKeys.flatMap((k) => tinyByKey.get(k) ?? []);
  if (tiny.length === 0) return [];
  const own = blocks.get(chain);
  if (!own) return [];
  // The combo's own `tiny` rule comes later in the residual CSS and wins by itself.
  const ownTiny = new Set((tinyByKey.get(chain) ?? []).flatMap((t) => longhandsOf(t.prop)));
  const effective = dedupeByProp([...(own.main ?? []), ...(own.medium ?? []), ...(own.small ?? [])]);
  return effective.filter((d) => !longhandsOf(d.prop).every((p) => ownTiny.has(p)) && tiny.some((t) => declarationsOverlap(t.prop, d.prop) && (!t.important || d.important)));
}

/** Declarations of one chain's state variant (`:hover`, `[aria-current]`) per breakpoint. */
type StateBlocks = Map<string, BlocksByBreakpoint>;

/** Residual selector suffix of a chip variant: the pseudo class, or ycode's current-page marker for `w--current`. */
const CURRENT_SELECTOR = '[aria-current]';

/**
 * For a class or combo chain with state variants (`hover:`, `current:`) and a
 * `tiny` rule under it — its own, one of its classes', a shorter combo's, or
 * any other class of an element carrying the combo (`otherClasses`) — the
 * state's effective declarations (main, then medium, then small) for every
 * property such a tiny rule touches, per selector suffix in chip order
 * (`:hover`, `:focus`, `:active`, `[aria-current]`). Those tiny rules (and a
 * combo's derived one, {@link comboTinyOverrides}) are unlayered residual CSS
 * that beats every utility, while in Webflow `.a.b:hover` / `.a.b.w--current`
 * outranks them; restated as residual rules of the state's own selector
 * (`html .wf-a.wf-b:hover`, one pseudo class more) the variant keeps winning.
 * An `!important` tiny declaration keeps winning unless the state's is
 * important too.
 */
export function stateTinyOverrides(chain: string, stateBlocks: StateBlocks | undefined, tinyByKey: Map<string, CssDeclaration[]>, otherClasses: string[] = []): { suffix: string; declarations: CssDeclaration[] }[] {
  if (!stateBlocks || stateBlocks.size === 0) return [];
  const parts = chain.split('.');
  const keys = [chain, ...parts, ...otherClasses];
  for (let i = 2; i < parts.length; i++) keys.push(parts.slice(0, i).join('.'));
  const tiny = [...new Set(keys)].flatMap((k) => tinyByKey.get(k) ?? []);
  if (tiny.length === 0) return [];
  const rank = (suffix: string) => (suffix === CURRENT_SELECTOR ? 4 : (STATE_RANK[suffix] ?? 5));
  const out: { suffix: string; declarations: CssDeclaration[] }[] = [];
  for (const suffix of [...stateBlocks.keys()].sort((a, b) => rank(a) - rank(b))) {
    const blocks = stateBlocks.get(suffix)!;
    const effective = dedupeByProp([...(blocks.main ?? []), ...(blocks.medium ?? []), ...(blocks.small ?? [])]);
    const declarations = effective.filter((d) => tiny.some((t) => declarationsOverlap(t.prop, d.prop) && (!t.important || d.important)));
    if (declarations.length > 0) out.push({ suffix, declarations });
  }
  return out;
}

/**
 * Render the residual rules: grouped by media query, every class selector
 * namespaced (`.wf-…`) and scoped under `html`, the kept at-rules appended,
 * the whole text neutralised.
 */
function renderResidualCss(model: { residual: WfStyleModel['residual']; residualAtRules: string[] }): { css: string; changes: number } {
  const groups = new Map<string, string[]>();
  groups.set('', []);
  for (const rule of model.residual.rules) {
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
  rendered.push(...model.residualAtRules);
  const neutralised = neutraliseCss(rendered.join('\n'));
  return { css: neutralised.css, changes: neutralised.changes };
}

// ─── State combos ─────────────────────────────────────────────────────────────

interface StateSelector {
  state: WfStateClass;
  /** The chain without the state class, selector order (`['dropdown-list']`, `['a', 'b']`). */
  rest: string[];
  pseudo: string[];
}

/**
 * `.x.w--open`, `.a.b.w--current`, `.x[data-nav-menu-open]` -> the state and
 * the chain it belongs to; null for every other selector. The attribute form is
 * what webflow.js sets on an opened nav menu (`data-nav-menu-open`), Webflow's
 * `components.css` styles it that way, and site sheets copy the pattern.
 */
function stateSelectorOf(parsed: ReturnType<typeof parseSelector>): StateSelector | null {
  if (parsed.kind === 'complex') {
    const m = parsed.raw.match(/^([^\s>+~[\]]+)\[data-nav-menu-open(?:=(?:""|''|[^\]]*))?\]$/);
    if (!m) return null;
    const inner = parseSelector(m[1]);
    if (inner.kind !== 'class' && inner.kind !== 'combo') return null;
    return { state: 'w--nav-menu-open', rest: inner.classes.filter((c) => !isStateClass(c)), pseudo: inner.pseudo };
  }
  if (parsed.kind !== 'class' && parsed.kind !== 'combo') return null;
  const states = parsed.classes.filter(isStateClass);
  if (states.length === 0) return null;
  return { state: states[0], rest: parsed.classes.filter((c) => !isStateClass(c)), pseudo: parsed.pseudo };
}

/** A Webflow framework class (`w-dropdown-toggle`): never part of an element's site chain in html.ts. */
function isFrameworkChainClass(name: string): boolean {
  return name.startsWith('w-') || name === 'wf-layout-layout';
}

const STATE_TOKEN_RE = /\.(w--open|w--current|w--tab-active|w--nav-menu-open)(?![-\w\\])|\[data-nav-menu-open(?:=(?:""|''|[^\]]*))?\]/g;

/** A state rule inside a complex selector: its rewritten form, or why it has none. */
export type ContextualState = { selector: string; state: WfStateClass } | { dropped: string };

/**
 * A state class inside a complex selector (`.dropdown-list.w--open .link`,
 * `.nav .link.w--current`, `.w-locales-item a.w--current`) -> the selector
 * ycode can render, or the reason there is none (states.ts module comment):
 *
 * - `w--current` becomes `[aria-current]`, the attribute ycode sets on links
 *   to the current page (the `current:` variant is `&[aria-current]`);
 * - `w--open` / `w--tab-active` is dropped from the selector when every
 *   element of the export that carries the compound's classes is a dropdown
 *   list / tab pane (`classLists`, states.ts `stateImpliedBy`);
 * - anything else is reported.
 *
 * Null for a selector without a state class.
 */
export function contextualStateOf(raw: string, classLists: Iterable<readonly string[]>): ContextualState | null {
  const tokens = [...raw.matchAll(STATE_TOKEN_RE)];
  if (tokens.length === 0) return null;
  const states = new Set(tokens.map((t) => (t[1] ?? 'w--nav-menu-open') as WfStateClass));
  if (states.size > 1 || tokens.length > 1) return { dropped: 'more than one Webflow state class in one selector has no ycode counterpart' };
  const state = [...states][0];
  if (state === 'w--current') return { selector: raw.replace(STATE_TOKEN_RE, '[aria-current]'), state };
  if (state === 'w--nav-menu-open') return { dropped: 'the open nav menu inside a descendant selector has no ycode counterpart (the menu opens through the navbar interaction)' };
  const { compounds } = splitCompoundsWithCombinators(raw);
  const carrierCompound = compounds.find((c) => new RegExp(STATE_TOKEN_RE.source).test(c)) ?? '';
  const carrier = parseSelector(carrierCompound.replace(STATE_TOKEN_RE, '')).classes;
  if (carrier.length === 0) return { dropped: `the element carrying .${state} has no class to identify it by` };
  const roles = carrierRoles(carrier, classLists);
  const chain = `.${carrier.join('.')}`;
  if (roles.length === 0) return { dropped: `no element of the export carries ${chain}` };
  if (roles.every((role) => stateImpliedBy(role, state))) return { selector: raw.replace(STATE_TOKEN_RE, ''), state };
  const other = roles.find((role) => !stateImpliedBy(role, state)) ?? null;
  if (other === null) return { dropped: `${chain} is not a Webflow ${state === 'w--open' ? 'dropdown or nav' : 'tab'} element on every page, so webflow.js never sets .${state} there and the rule cannot lose it` };
  if (other === 'dropdown-toggle' || other === 'nav-button') return { dropped: `the open ${other} styles its descendants or surroundings here, and ycode has no open state for them (interaction tweens change the ${other} itself only)` };
  return { dropped: `on a ${other} the .${state} state is not implied by visibility, and ycode has no class-based state` };
}

// ─── Model builder ────────────────────────────────────────────────────────────

export interface BuildStyleModelInput {
  siteCss: string[];
  /**
   * Webflow's own `normalize.css` / `components.css`. Only their **tag** rules
   * are read — `h1 { font-size: 38px }` and friends, which every Webflow page
   * relies on and which no site class repeats. Their `.w-*` rules are covered
   * by `framework-classes.ts`, and nothing from these sheets ever reaches the
   * residual CSS: v1 shipped all 54 KB of them verbatim, which is exactly what
   * v2 exists to stop.
   */
  frameworkCss?: string[];
  /**
   * Classes of the export's rich-text elements (`collectRichTextClasses`), so
   * `.rich-text-block p` is read as a rich-text rule rather than residual CSS.
   * `.w-richtext` itself is always a scope (also from the framework sheets).
   */
  richTextClasses?: Iterable<string>;
  /**
   * Distinct class lists of the export's elements (`"dropdown-list w-dropdown-list"`,
   * states.ts `collectClassLists`): which elements a state rule inside a complex
   * selector targets. Without them such a rule (other than `w--current`) is reported.
   */
  classLists?: Iterable<string>;
  assetUrl: CssAssetResolver;
  warn: Warnings;
}

export function buildStyleModel(input: BuildStyleModelInput): WfStyleModel {
  const { assetUrl, warn } = input;

  // 1. Tokenize every sheet in order; merge :root vars (later sheets win).
  // Framework sheets come first so the site stylesheet always overrides them.
  const sources: { css: string; framework: boolean }[] = [
    ...(input.frameworkCss ?? []).map((css) => ({ css, framework: true })),
    ...input.siteCss.map((css) => ({ css, framework: false })),
  ];
  const vars: Record<string, string> = {};
  const rules: (CssRule & { framework?: boolean })[] = [];
  const atRules: CssSheet['atRules'] = [];
  const fontFaces: CssFontFace[] = [];
  let orderOffset = 0;
  for (const source of sources) {
    const sheet: CssSheet = tokenizeCss(source.css);
    if (!source.framework) {
      Object.assign(vars, sheet.rootVars);
      atRules.push(...sheet.atRules);
      fontFaces.push(...sheet.fontFaces);
    }
    for (const rule of sheet.rules) rules.push({ ...rule, order: rule.order + orderOffset, framework: source.framework });
    orderOffset += sheet.rules.length + 1;
  }

  const classAccum = new Map<string, VariantAccumulator>();
  const comboAccum = new Map<string, VariantAccumulator>();
  const idAccum = new Map<string, VariantAccumulator>();
  const richTextAccum = new Map<string, VariantAccumulator>();
  const richTextScopes = new Set<string>(input.richTextClasses ?? []);
  const classLists = [...new Set(input.classLists ?? [])].map((l) => l.split(/\s+/).filter(Boolean));
  const boundBackgroundKeys = new Set<string>();
  const states = new Map<string, WfStateRule[]>();
  const resting = new Map<string, CssDeclaration[]>();
  const order = new Map<string, number>();
  /** Raw declarations per class / combo chain and breakpoint (the combo precedence repairs). */
  const blocksByKey = new Map<string, BlocksByBreakpoint>();
  /** Raw `tiny` declarations per class / combo chain. */
  const tinyByKey = new Map<string, CssDeclaration[]>();
  /** Raw declarations of the state variants per class / combo chain (stateTinyOverrides). */
  const stateBlocksByKey = new Map<string, StateBlocks>();
  const noteStateBlock = (key: string, suffix: string, breakpoint: ConvertibleBreakpoint, decls: CssDeclaration[]) => {
    let byState = stateBlocksByKey.get(key);
    if (!byState) {
      byState = new Map();
      stateBlocksByKey.set(key, byState);
    }
    const blocks = byState.get(suffix) ?? {};
    blocks[breakpoint] = [...(blocks[breakpoint] ?? []), ...decls];
    byState.set(suffix, blocks);
  };
  const residual: WfStyleModel['residual'] = { rules: [], classNames: new Set(), ids: new Set() };
  const tagCss: string[] = [];
  const fontFamilies: string[] = [];
  const fontFallbacks = new Map<string, string>();
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
    const parsed = parseSelector(rule.selector);
    // Framework sheets contribute tag defaults and nothing else: no class
    // styles (the `.w-*` shims live in framework-classes.ts), no residual CSS,
    // no font families of their own.
    const richTextScope = parsed.kind === 'complex' ? richTextDescendantScope(parsed, richTextScopes) : null;
    if (rule.framework && richTextScope === null && (parsed.kind !== 'tag' || !UPSTREAM_TAGS.has(parsed.tag ?? ''))) continue;
    if (!rule.framework) {
      for (const d of rule.declarations) {
        if (d.prop !== 'font-family') continue;
        const stack = fontStackOf(resolveVars(d.value, vars));
        addFamily(stack.family);
        const key = stack.family.toLowerCase();
        if (!stack.fallback || fontFallbacks.has(key)) continue;
        const fallback = safeFontFallback(stack.fallback);
        if (fallback && isSafeFontFamilyName(stack.family)) fontFallbacks.set(key, fallback);
        else warn.add('css_dropped', `font fallback stack for ${JSON.stringify(stack.family.slice(0, 60))} dropped: it contains characters a font-family list never needs`);
      }
    }
    const bp = breakpointOf(rule);

    // Webflow state combos: `webflow.js` sets the state class at runtime, so the
    // rule can never be a chip of its own (states.ts). `w--current` becomes the
    // `current:` variant of the chain's chip right here; the others are kept per
    // chain for html.ts, which knows the element's role.
    const stateSel = rule.framework ? null : stateSelectorOf(parsed);
    if (stateSel) {
      const chain = stateSel.rest.join('.');
      if (!chain) {
        warn.add('css_state_dropped', `${parsed.raw}: the rule selects only Webflow's runtime state class, which no element of the export carries`);
        continue;
      }
      if (bp === 'tiny' || bp === 'unknown') {
        warn.add('css_state_dropped', `${parsed.raw}: state rule inside a media query ycode has no tier for (${mediaKey(rule.media)})`);
        continue;
      }
      if (stateSel.pseudo.length > 0) {
        warn.add('css_state_dropped', `${parsed.raw}: a state class combined with ${stateSel.pseudo.join('')} has no ycode variant`);
        continue;
      }
      // html.ts looks a state rule up by the element's site chain, or by one framework
      // class (`.w-dropdown-toggle.w--open`); a chain mixing both is never looked up.
      const framework = stateSel.rest.filter(isFrameworkChainClass);
      if (framework.length > 0 && (framework.length !== 1 || stateSel.rest.length !== 1)) {
        warn.add('css_state_dropped', `${parsed.raw}: a state rule on a chain of several framework classes, or of site and framework classes, has no ycode counterpart`);
        continue;
      }
      const breakpoint: ConvertibleBreakpoint = bp === 'none' ? 'main' : bp;
      const converted = convertBlock(rule.declarations, vars, assetUrl, warn, parsed.raw);
      // The chip the state styles belong to must exist even when the chain has no rule of its
      // own — except for a framework class, which has no chip (html.ts adds its merged
      // classes to the element's framework classes); its `current:` classes still need the entry.
      if (framework.length === 0 || stateSel.state === CURRENT_STATE) {
        const accum = stateSel.rest.length === 1 ? classAccum : comboAccum;
        let a = accum.get(chain);
        if (!a) {
          a = new VariantAccumulator();
          accum.set(chain, a);
        }
        // `w--current` is also kept as a state rule: on a tab link it marks the active
        // tab, which ycode never flags with `aria-current` (html.ts, states.ts).
        if (stateSel.state === CURRENT_STATE) {
          a.add(breakpoint, CURRENT_STATE, converted.classes);
          noteStateBlock(chain, CURRENT_SELECTOR, breakpoint, rule.declarations);
        }
      }
      let list = states.get(chain);
      if (!list) {
        list = [];
        states.set(chain, list);
      }
      list.push({
        state: stateSel.state,
        selector: parsed.raw,
        classes: converted.classes.map((c) => `${BREAKPOINT_PREFIX[breakpoint]}${c}`),
        declarations: breakpoint === 'main' ? converted.normalised : [],
        breakpoint,
      });
      continue;
    }
    // A state class inside a complex selector: translated into residual CSS
    // ycode renders, or reported — never kept verbatim (it would match nothing).
    const contextual = rule.framework || parsed.kind !== 'complex' ? null : contextualStateOf(parsed.raw, classLists);
    if (contextual) {
      if ('dropped' in contextual) {
        warn.add('css_state_dropped', `${parsed.raw}: ${contextual.dropped}`);
        continue;
      }
      const block = residualBlock(rule.declarations, vars, assetUrl, warn);
      if (!block) continue;
      const translated = parseSelector(contextual.selector);
      residual.rules.push({ selector: contextual.selector, block, media: rule.media, reason: 'state' });
      for (const c of translated.classes) residual.classNames.add(c);
      continue;
    }

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
      if (!rule.framework && (!UNDERLAY_TAGS.has(tag) || !statePseudo || !convertible)) {
        noteResidual(rule, parsed, !convertible ? (bp === 'tiny' ? 'tiny' : 'media') : 'complex');
      }
      continue;
    }

    if (richTextScope !== null) {
      // `.w-richtext figure { max-width: 60% }`, `.rich-text-block p { … }`:
      // the rich-text layer carries these in `textStyles`, not the stylesheet.
      if (bp === 'tiny' || bp === 'unknown') {
        if (!rule.framework) noteResidual(rule, parsed, bp === 'tiny' ? 'tiny' : 'media');
        continue;
      }
      const { classes } = convertBlock(rule.declarations, vars, assetUrl, warn, parsed.raw);
      const k = `${richTextScope}\u0000${parsed.tag}`;
      let a = richTextAccum.get(k);
      if (!a) {
        a = new VariantAccumulator();
        richTextAccum.set(k, a);
      }
      a.add(bp === 'none' ? 'main' : bp, parsed.pseudo[0] ?? '', classes);
      continue;
    }
    if (parsed.kind === 'complex') {
      noteResidual(rule, parsed, residualReasonForComplex(parsed));
      continue;
    }
    if (bp === 'tiny') {
      // Remembered per chain so a combo of the chain can restate its values under 480 px (comboTinyOverrides).
      if (parsed.kind !== 'id' && parsed.pseudo.length === 0) {
        const key = parsed.classes.join('.');
        tinyByKey.set(key, [...(tinyByKey.get(key) ?? []), ...rule.declarations]);
      }
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

    const { classes, boundBackground, normalised } = convertBlock(rule.declarations, vars, assetUrl, warn, parsed.raw);
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
    if (parsed.kind !== 'id' && !order.has(key)) order.set(key, rule.order);
    if (parsed.kind !== 'id' && breakpoint === 'main' && !state) resting.set(key, [...(resting.get(key) ?? []), ...normalised]);
    if (parsed.kind !== 'id' && state) noteStateBlock(key, state, breakpoint, rule.declarations);
    if (parsed.kind !== 'id' && !state) {
      let blocks = blocksByKey.get(key);
      if (!blocks) {
        blocks = {};
        blocksByKey.set(key, blocks);
      }
      blocks[breakpoint] = [...(blocks[breakpoint] ?? []), ...rule.declarations];
    }
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

  // 3b. Combo precedence (see "Combo precedence" above): lift the combo's values
  // over the narrower breakpoints of its lower chips, and restate them under
  // 480 px where a `tiny` rule of a lower chip would win as residual CSS. The
  // lower chips are the classes of the chain, its shorter combos, and every
  // other class an element carrying the combo has (`h l btn` with a combo
  // `h.l`: `.btn`'s 767 px rule is one class against two). Shorter combos go
  // first, so a longer one is lifted over what they re-stated.
  const coClasses = coOccurringClasses([...combos.keys()], classLists);
  for (const [chain, ref] of [...combos].sort((a, b) => a[0].split('.').length - b[0].split('.').length)) {
    const parts = chain.split('.');
    const singles = [...new Set([...parts, ...(coClasses.get(chain) ?? [])])];
    const lower: string[] = [];
    for (const c of singles) lower.push(...(classes.get(c)?.ref.classes ?? []));
    for (let i = 2; i < parts.length; i++) lower.push(...(combos.get(parts.slice(0, i).join('.'))?.classes ?? []));
    ref.classes = keepBackgroundLayersApart(liftComboOverBreakpoints(ref.classes, lower), lower);
    const overrides = comboTinyOverrides(chain, blocksByKey, tinyByKey, singles.filter((c) => !parts.includes(c)));
    if (overrides.length === 0) continue;
    const block = residualBlock(overrides, vars, assetUrl, warn);
    if (!block) continue;
    // Before the verbatim tiny rules of the same group: a `tiny` rule of the combo itself still wins.
    const at = residual.rules.findIndex((r) => mediaKey(r.media) === mediaKey(TINY_MEDIA));
    const derived: ResidualRule = { selector: `.${chain}`, block, media: TINY_MEDIA, reason: 'combo' };
    if (at === -1) residual.rules.push(derived);
    else residual.rules.splice(at, 0, derived);
    for (const c of parts) residual.classNames.add(c);
  }
  // 3c. The state variants of a chain against the `tiny` rules under it (stateTinyOverrides).
  for (const [chain, byState] of stateBlocksByKey) {
    const parts = chain.split('.');
    const others = parts.length > 1 ? (coClasses.get(chain) ?? []).filter((c) => !parts.includes(c)) : [];
    for (const { suffix, declarations } of stateTinyOverrides(chain, byState, tinyByKey, others)) {
      const block = residualBlock(declarations, vars, assetUrl, warn);
      if (!block) continue;
      const at = residual.rules.findIndex((r) => mediaKey(r.media) === mediaKey(TINY_MEDIA) && r.reason !== 'combo');
      const derived: ResidualRule = { selector: `.${chain}${suffix}`, block, media: TINY_MEDIA, reason: 'combo' };
      if (at === -1) residual.rules.push(derived);
      else residual.rules.splice(at, 0, derived);
      for (const c of parts) residual.classNames.add(c);
    }
  }
  const richTextTags = new Map<string, Map<string, string[]>>();
  for (const [k, a] of richTextAccum) {
    const [scope, tag] = k.split('\u0000');
    let byTag = richTextTags.get(scope);
    if (!byTag) {
      byTag = new Map();
      richTextTags.set(scope, byTag);
    }
    byTag.set(tag, a.merged());
  }

  // 4. Residual CSS: group by media, namespace + scope selectors, neutralise.
  const residualAtRules: string[] = [];
  for (const at of atRules) {
    if (at.name === 'keyframes' || at.name === 'property' || at.name === 'font-feature-values') residualAtRules.push(at.raw);
    else if (at.name !== 'import' && at.name !== 'charset') warn.add('css_dropped', `dropped @${at.name} block`);
  }
  const neutralised = renderResidualCss({ residual, residualAtRules });
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
    order,
    ids,
    tags,
    residual,
    residualCss: neutralised.css,
    fontFaces: faces,
    fontFamilies,
    fontFallbacks,
    boundBackgroundKeys,
    states,
    resting,
    richTextTags,
  };
}

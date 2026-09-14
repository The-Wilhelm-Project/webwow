/**
 * Small, dependency-free CSS tokenizer for Webflow site stylesheets.
 *
 * Upstream's `parseGlobalStylesheet` only indexes single-class and tag rules; a
 * Webflow export also relies on combo rules (`.a.b`), id rules (`#w-node-…`
 * grid placement), the `tiny` breakpoint, `@font-face` files and a few pseudo
 * selectors. This scanner is string-, comment- and paren-aware (never
 * regex-only), flattens `@media` blocks into per-rule `maxWidth` / `minWidth`
 * numbers and splits selector lists into one rule per selector so the style
 * model (css.ts) can classify every rule on its own.
 */

export interface CssDeclaration {
  prop: string;
  value: string;
  important: boolean;
}

export interface CssRule {
  selector: string;
  declarations: CssDeclaration[];
  /** Raw media query (whitespace-collapsed) when the rule sits inside `@media`, else null. */
  media: string | null;
  maxWidth: number | null;
  minWidth: number | null;
  /** Source order (selector lists share one number). */
  order: number;
}

export interface CssFontFace {
  family: string;
  weight: string;
  style: string;
  /** First `url()` of `src` (unquoted). */
  src: string;
  format?: string;
  raw: string;
}

export interface CssSheet {
  rules: CssRule[];
  fontFaces: CssFontFace[];
  /** Top-level `:root { --x: … }` custom properties. */
  rootVars: Record<string, string>;
  atRules: { name: string; raw: string }[];
}

export type SelectorKind = 'class' | 'combo' | 'id' | 'tag' | 'complex';

export interface ParsedSelector {
  kind: SelectorKind;
  /** Every class referenced anywhere in the selector (also for `complex`). */
  classes: string[];
  id?: string;
  tag?: string;
  /** Pseudo classes/elements with their colons (`:hover`, `::before`, `:not(.x)`). */
  pseudo: string[];
  raw: string;
}

const STATE_PSEUDOS = new Set([':hover', ':focus', ':active']);

// ─── Low-level scanning helpers ───────────────────────────────────────────────

/** Remove `/* … *\/` comments while respecting quoted strings. */
export function stripCssComments(css: string): string {
  let out = '';
  let i = 0;
  const n = css.length;
  let quote: string | null = null;
  while (i < n) {
    const ch = css[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < n) {
        out += css[i + 1];
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
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Split on a single-character separator at the top level, i.e. outside quoted
 * strings and outside `()` / `[]` / `{}` nesting. Empty parts are kept so the
 * caller decides how to treat them.
 */
export function splitTopLevel(input: string, sep: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && i + 1 < input.length) {
        current += input[i + 1];
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Index of the matching closing brace for the `{` at `open` (string-aware). Returns -1 when unbalanced. */
function matchBrace(css: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Position of the first top-level `{`, `;` or `}` at/after `from` (string- and paren-aware). */
function scanPrelude(css: string, from: number): { end: number; term: string } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === '{' || ch === ';' || ch === '}')) return { end: i, term: ch };
  }
  return { end: css.length, term: '' };
}

const IMPORTANT_RE = /\s*!\s*important\s*$/i;

/** Parse a declaration block (`a: b; c: d !important`) into declarations. */
export function parseDeclarations(body: string): CssDeclaration[] {
  const out: CssDeclaration[] = [];
  for (const part of splitTopLevel(body, ';')) {
    const decl = part.trim();
    if (!decl) continue;
    const colon = indexOfTopLevel(decl, ':');
    if (colon === -1) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    let value = decl.slice(colon + 1).trim();
    if (!prop) continue;
    let important = false;
    if (IMPORTANT_RE.test(value)) {
      important = true;
      value = value.replace(IMPORTANT_RE, '').trim();
    }
    if (!value) continue;
    out.push({ prop, value, important });
  }
  return out;
}

/** First `sep` outside quotes and parens. */
function indexOfTopLevel(input: string, sep: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) return i;
  }
  return -1;
}

// ─── Media queries ────────────────────────────────────────────────────────────

interface MediaContext {
  raw: string;
  maxWidth: number | null;
  minWidth: number | null;
}

/**
 * Flatten a media query into numbers. Only `screen|all … (max-width: Npx)` /
 * `(min-width: Npx)` are understood; every other feature (`print`, `prefers-*`,
 * `orientation`, em units, …) yields both null so the rule stays raw.
 */
export function parseMediaQuery(query: string): { maxWidth: number | null; minWidth: number | null } {
  const q = query.trim().replace(/\s+/g, ' ');
  const features = [...q.matchAll(/\(([^()]*)\)/g)].map((m) => m[1].trim());
  const rest = q.replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const restOk = rest.split(' ').filter(Boolean).every((tok) => ['screen', 'all', 'and', 'only'].includes(tok));
  if (!restOk) return { maxWidth: null, minWidth: null };
  let maxWidth: number | null = null;
  let minWidth: number | null = null;
  for (const f of features) {
    const m = f.match(/^(max|min)-width\s*:\s*(\d+(?:\.\d+)?)px$/i);
    if (!m) return { maxWidth: null, minWidth: null };
    const n = Number(m[2]);
    if (m[1].toLowerCase() === 'max') maxWidth = maxWidth === null ? n : Math.min(maxWidth, n);
    else minWidth = minWidth === null ? n : Math.max(minWidth, n);
  }
  return { maxWidth, minWidth };
}

function combineMedia(outer: MediaContext | null, query: string): MediaContext {
  const parsed = parseMediaQuery(query);
  const raw = query.trim().replace(/\s+/g, ' ');
  if (!outer) return { raw, ...parsed };
  const bothKnown = (outer.maxWidth !== null || outer.minWidth !== null) && (parsed.maxWidth !== null || parsed.minWidth !== null);
  if (!bothKnown) return { raw: `${outer.raw} and ${raw}`, maxWidth: null, minWidth: null };
  return {
    raw: `${outer.raw} and ${raw}`,
    maxWidth: outer.maxWidth === null ? parsed.maxWidth : parsed.maxWidth === null ? outer.maxWidth : Math.min(outer.maxWidth, parsed.maxWidth),
    minWidth: outer.minWidth === null ? parsed.minWidth : parsed.minWidth === null ? outer.minWidth : Math.max(outer.minWidth, parsed.minWidth),
  };
}

// ─── @font-face ───────────────────────────────────────────────────────────────

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) return v.slice(1, -1);
  return v;
}

/** Extract the argument of the first `url(…)` in a value (unquoted), or null. */
export function firstUrl(value: string): string | null {
  const m = value.match(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/i);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? '').trim();
}

function parseFontFace(body: string, raw: string): CssFontFace | null {
  const decls = parseDeclarations(body);
  const get = (prop: string) => decls.filter((d) => d.prop === prop).pop()?.value;
  const family = get('font-family');
  const src = get('src');
  if (!family || !src) return null;
  // The first source that has a url() wins; `format("x")` is read from the same source.
  const sources = splitTopLevel(src, ',');
  let url: string | null = null;
  let format: string | undefined;
  for (const s of sources) {
    const u = firstUrl(s);
    if (!u) continue;
    url = u;
    const f = s.match(/format\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/i);
    if (f) format = (f[1] ?? f[2] ?? f[3] ?? '').trim() || undefined;
    break;
  }
  if (!url) return null;
  return {
    family: unquote(family),
    weight: (get('font-weight') ?? '400').trim(),
    style: (get('font-style') ?? 'normal').trim(),
    src: url,
    format,
    raw,
  };
}

// ─── Sheet tokenizer ──────────────────────────────────────────────────────────

const NESTING_AT_RULES = new Set(['media', 'supports', 'layer', 'container', 'document']);

interface TokenizeState {
  sheet: CssSheet;
  order: number;
}

function tokenizeBlock(css: string, media: MediaContext | null, state: TokenizeState, insideSupports: boolean): void {
  let i = 0;
  const n = css.length;
  while (i < n) {
    const { end, term } = scanPrelude(css, i);
    const prelude = css.slice(i, end).trim();
    if (term === '') break;
    if (term === '}') {
      // Stray closing brace — skip.
      i = end + 1;
      continue;
    }
    if (term === ';') {
      if (prelude.startsWith('@')) {
        const name = prelude.slice(1).split(/[\s(]/)[0].toLowerCase();
        state.sheet.atRules.push({ name, raw: `${prelude};` });
      }
      i = end + 1;
      continue;
    }
    // term === '{'
    const close = matchBrace(css, end);
    const body = close === -1 ? css.slice(end + 1) : css.slice(end + 1, close);
    i = close === -1 ? n : close + 1;

    if (prelude.startsWith('@')) {
      const name = prelude.slice(1).split(/[\s({]/)[0].toLowerCase();
      const param = prelude.slice(1 + name.length).trim();
      if (name === 'media') {
        tokenizeBlock(body, combineMedia(media, param), state, insideSupports);
        continue;
      }
      if (name === 'font-face') {
        const face = parseFontFace(body, `${prelude}{${body}}`);
        if (face) state.sheet.fontFaces.push(face);
        continue;
      }
      if (name === 'supports' || name === 'layer' || name === 'container' || name === 'document') {
        // Conditional groups can't be represented in the style model; keep them
        // raw so they can go to residual CSS verbatim.
        state.sheet.atRules.push({ name, raw: `${prelude}{${body}}` });
        continue;
      }
      state.sheet.atRules.push({ name, raw: `${prelude}{${body}}` });
      continue;
    }

    const declarations = parseDeclarations(body);
    const selectors = splitTopLevel(prelude, ',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    if (selectors.length === 0) continue;
    const order = state.order++;
    for (const selector of selectors) {
      if (selector === ':root' && !media && !insideSupports) {
        for (const d of declarations) {
          if (d.prop.startsWith('--')) state.sheet.rootVars[d.prop] = d.value;
        }
        continue;
      }
      state.sheet.rules.push({
        selector,
        declarations,
        media: media ? media.raw : null,
        maxWidth: media ? media.maxWidth : null,
        minWidth: media ? media.minWidth : null,
        order,
      });
    }
  }
}

export function tokenizeCss(css: string): CssSheet {
  const state: TokenizeState = {
    sheet: { rules: [], fontFaces: [], rootVars: {}, atRules: [] },
    order: 0,
  };
  const clean = stripCssComments(css.replace(/^\uFEFF/, ''));
  tokenizeBlock(clean, null, state, false);
  return state.sheet;
}

// ─── Selectors ────────────────────────────────────────────────────────────────

const IDENT_START = /[-_a-zA-Z\\\u00A0-\uFFFF]/;
const IDENT_CHAR = /[-\w\\\u00A0-\uFFFF]/;

function readIdent(s: string, from: number): string {
  let i = from;
  let out = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      out += ch + s[i + 1];
      i += 2;
      continue;
    }
    if (!IDENT_CHAR.test(ch)) break;
    out += ch;
    i++;
  }
  return out;
}

interface Compound {
  tag?: string;
  ids: string[];
  classes: string[];
  pseudo: string[];
  attributes: number;
  universal: boolean;
  /** Something unparseable / unsupported was found. */
  odd: boolean;
  /** True when a class/id/tag simple selector follows a pseudo (e.g. `.a:hover.b`). */
  pseudoNotTrailing: boolean;
}

function parseCompound(text: string): Compound {
  const c: Compound = { ids: [], classes: [], pseudo: [], attributes: 0, universal: false, odd: false, pseudoNotTrailing: false };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '.' || ch === '#') {
      const ident = readIdent(text, i + 1);
      if (!ident || !IDENT_START.test(ident[0]) && !/\d/.test(ident[0])) {
        c.odd = true;
        i++;
        continue;
      }
      if (c.pseudo.length > 0) c.pseudoNotTrailing = true;
      (ch === '.' ? c.classes : c.ids).push(ident);
      i += 1 + ident.length;
      continue;
    }
    if (ch === ':') {
      let j = i + 1;
      let colons = ':';
      if (text[j] === ':') {
        colons = '::';
        j++;
      }
      const name = readIdent(text, j);
      if (!name) {
        c.odd = true;
        i = j;
        continue;
      }
      j += name.length;
      let args = '';
      if (text[j] === '(') {
        let depth = 0;
        let k = j;
        for (; k < n; k++) {
          if (text[k] === '(') depth++;
          else if (text[k] === ')') {
            depth--;
            if (depth === 0) break;
          }
        }
        args = text.slice(j, Math.min(k + 1, n));
        j = Math.min(k + 1, n);
      }
      c.pseudo.push(`${colons}${name.toLowerCase()}${args}`);
      i = j;
      continue;
    }
    if (ch === '[') {
      const close = text.indexOf(']', i);
      c.attributes++;
      if (c.pseudo.length > 0) c.pseudoNotTrailing = true;
      i = close === -1 ? n : close + 1;
      continue;
    }
    if (ch === '*') {
      c.universal = true;
      i++;
      continue;
    }
    if (IDENT_START.test(ch) && i === 0) {
      const ident = readIdent(text, i);
      c.tag = ident.toLowerCase();
      i += ident.length;
      continue;
    }
    c.odd = true;
    i++;
  }
  return c;
}

/**
 * Split a selector into compounds at top-level combinators (descendant space,
 * `>`, `+`, `~`). Strings, parens and attribute brackets are respected.
 */
function splitCompounds(selector: string): string[] {
  const compounds: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;
  const flush = () => {
    if (current.trim()) compounds.push(current.trim());
    current = '';
  };
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && i + 1 < selector.length) {
        current += selector[i + 1];
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ' ' || ch === '\t' || ch === '\n' || ch === '>' || ch === '+' || ch === '~')) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return compounds;
}

/**
 * Classify a single selector (no lists).
 *
 * - more than one compound (combinators), attribute selectors, `*`, `::before` /
 *   `::after`, `:not(…)`, `:nth-*`, `:focus-visible`, `:visited`, … -> `complex`
 * - `#id` (trailing classes kept) -> `id`
 * - `.a` -> `class`, `.a.b…` -> `combo` (order as written)
 * - bare tag -> `tag`
 * - at most one trailing `:hover` / `:focus` / `:active` is reported in `pseudo`
 *   without making the selector complex.
 */
export function parseSelector(selector: string): ParsedSelector {
  const raw = selector.trim().replace(/\s+/g, ' ');
  const compounds = splitCompounds(raw).map(parseCompound);
  const classes: string[] = [];
  const pseudo: string[] = [];
  let id: string | undefined;
  let tag: string | undefined;
  for (const c of compounds) {
    classes.push(...c.classes);
    pseudo.push(...c.pseudo);
    if (!id && c.ids.length > 0) id = c.ids[0];
  }
  const complex = (): ParsedSelector => ({ kind: 'complex', classes, id, tag, pseudo, raw });

  if (compounds.length !== 1) {
    if (compounds.length > 1) tag = compounds[compounds.length - 1].tag;
    return complex();
  }
  const c = compounds[0];
  tag = c.tag;
  const nonState = c.pseudo.filter((p) => !STATE_PSEUDOS.has(p));
  const stateCount = c.pseudo.length - nonState.length;
  if (c.odd || c.universal || c.attributes > 0 || c.ids.length > 1 || nonState.length > 0 || stateCount > 1 || c.pseudoNotTrailing) {
    return complex();
  }
  if (c.ids.length === 1) {
    if (c.tag) return complex();
    return { kind: 'id', classes, id, tag, pseudo, raw };
  }
  if (c.classes.length > 0) {
    if (c.tag) return complex();
    return { kind: c.classes.length === 1 ? 'class' : 'combo', classes, id, tag, pseudo, raw };
  }
  if (c.tag) return { kind: 'tag', classes, id, tag, pseudo, raw };
  return complex();
}

// ─── Custom properties ────────────────────────────────────────────────────────

/**
 * Replace `var(--x[, fallback])` with the variable's literal value (recursively,
 * depth <= 5). Fallbacks may nest (`var(--a, var(--b, 1px))`). Unknown variables
 * without a fallback are left untouched.
 */
export function resolveVars(value: string, vars: Record<string, string>): string {
  let current = value;
  for (let depth = 0; depth < 5; depth++) {
    const next = resolveOnce(current, vars);
    if (next === current) break;
    current = next;
  }
  return current;
}

function resolveOnce(value: string, vars: Record<string, string>): string {
  let out = '';
  let i = 0;
  const n = value.length;
  while (i < n) {
    const at = value.indexOf('var(', i);
    if (at === -1) {
      out += value.slice(i);
      break;
    }
    // Only a standalone `var(` counts (not `--foo-var(`).
    if (at > 0 && /[\w-]/.test(value[at - 1])) {
      out += value.slice(i, at + 4);
      i = at + 4;
      continue;
    }
    out += value.slice(i, at);
    let depth = 0;
    let end = -1;
    for (let k = at + 3; k < n; k++) {
      if (value[k] === '(') depth++;
      else if (value[k] === ')') {
        depth--;
        if (depth === 0) {
          end = k;
          break;
        }
      }
    }
    if (end === -1) {
      out += value.slice(at);
      break;
    }
    const inner = value.slice(at + 4, end);
    const parts = splitTopLevel(inner, ',');
    const name = parts[0].trim();
    const fallback = parts.length > 1 ? parts.slice(1).join(',').trim() : undefined;
    const resolved = vars[name];
    if (resolved !== undefined) out += resolved;
    else if (fallback !== undefined) out += fallback;
    else out += value.slice(at, end + 1);
    i = end + 1;
  }
  return out;
}

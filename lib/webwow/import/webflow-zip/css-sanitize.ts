/**
 * Neutralise untrusted CSS before it is stored in `custom_code_head` /
 * `settings.custom_code.head` (rendered raw into the public page head).
 *
 * The HTML parser ends a `<style>` block at the first `</style` regardless of
 * CSS context (strings, comments, url() included), so every `<` is escaped —
 * as a CSS hex escape (`\3c `) in normal text and strings, percent-encoded
 * inside `url(…)`. `>` is escaped the same way inside declarations and strings
 * but kept in selector preludes (child combinator). On top of that:
 *   - `@import` / `@charset` statements are dropped,
 *   - declarations containing `expression(`, `-moz-binding`, `behavior:` or
 *     `javascript:` are dropped,
 *   - declarations whose `url()` scheme is not https:, http:, data:image/,
 *     data:font/, data:application/font or a site-relative `/storage/` path are
 *     dropped.
 * The transform is idempotent: running it on its own output reports 0 changes.
 */

export interface NeutraliseResult {
  css: string;
  changes: number;
}

const DANGEROUS_DECL_RE = /expression\s*\(|-moz-binding|behavior\s*:|javascript:/i;
const AT_STATEMENT_DROP_RE = /^@(import|charset)\b/i;
const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;

function urlAllowed(target: string): boolean {
  const t = target.trim();
  if (!t) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^data:(image\/|font\/|application\/font)/i.test(t)) return true;
  if (t.startsWith('/storage/')) return true;
  return false;
}

/** Escape angle brackets outside `url()` as CSS hex escapes, inside `url()` as percent-encoding. */
function escapeAngles(text: string, escapeGt: boolean): { text: string; changes: number } {
  let changes = 0;
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const m = /url\(/i.exec(text.slice(i));
    const at = m ? i + m.index : -1;
    const plain = at === -1 ? text.slice(i) : text.slice(i, at);
    out += plain.replace(/[<>]/g, (ch) => {
      if (ch === '>' && !escapeGt) return ch;
      changes++;
      return ch === '<' ? '\\3c ' : '\\3e ';
    });
    if (at === -1) break;
    // Copy the url(...) token, percent-encoding angle brackets inside it.
    let depth = 0;
    let quote: string | null = null;
    let k = at;
    for (; k < n; k++) {
      const ch = text[k];
      if (quote) {
        if (ch === '\\') {
          k++;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === '\'') {
        quote = ch;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const token = text.slice(at, Math.min(k + 1, n));
    out += token.replace(/[<>]/g, (ch) => {
      changes++;
      return ch === '<' ? '%3C' : '%3E';
    });
    i = Math.min(k + 1, n);
  }
  return { text: out, changes };
}

/** Position of the next top-level `{`, `;` or `}` (outside strings/parens/comments). */
function scanStatement(css: string, from: number): { end: number; term: string } {
  let depth = 0;
  let quote: string | null = null;
  let i = from;
  const n = css.length;
  while (i < n) {
    const ch = css[i];
    if (quote) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === '{' || ch === ';' || ch === '}')) return { end: i, term: ch };
    i++;
  }
  return { end: n, term: '' };
}

function processDeclaration(stmt: string): { text: string; changes: number } | null {
  const trimmed = stmt.trim();
  if (!trimmed) return { text: stmt, changes: 0 };
  if (AT_STATEMENT_DROP_RE.test(trimmed)) return null;
  if (DANGEROUS_DECL_RE.test(trimmed)) return null;
  for (const m of trimmed.matchAll(URL_RE)) {
    const target = m[1] ?? m[2] ?? m[3] ?? '';
    if (!urlAllowed(target)) return null;
  }
  return escapeAngles(stmt, true);
}

export function neutraliseCss(css: string): NeutraliseResult {
  let out = '';
  let changes = 0;
  let i = 0;
  const n = css.length;
  while (i < n) {
    const { end, term } = scanStatement(css, i);
    const stmt = css.slice(i, end);
    if (term === '{') {
      const escaped = escapeAngles(stmt, false);
      out += escaped.text + '{';
      changes += escaped.changes;
    } else {
      const processed = processDeclaration(stmt);
      if (processed === null) {
        changes++;
        // Keep the block terminator; the dropped statement's own `;` goes with it.
        if (term === '}') out += '}';
      } else {
        out += processed.text + term;
        changes += processed.changes;
      }
    }
    i = end + 1;
  }
  return { css: out, changes };
}

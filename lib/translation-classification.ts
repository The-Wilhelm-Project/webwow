/**
 * Translation Content Classification
 *
 * Single source of truth for deciding whether a value carries rich-text
 * formatting (and therefore must be rendered with the sheet editor) vs.
 * being plain text suitable for a simple <input>.
 *
 * Used by:
 *  - localisation-utils.ts (source-side extraction)
 *  - management/lib/legacy-migration.ts (import-time classification)
 */

/**
 * Returns `true` when `html` contains tags that imply rich-text formatting.
 * Matches block-level structure (paragraphs, headings, lists, blockquotes,
 * horizontal rules, tables) and inline marks (bold, italic, underline,
 * links, code, etc.) as well as hard breaks (`<br>`).
 *
 * Does NOT match:
 *  - `<span>` without formatting attributes (wrapper-only, no semantic meaning)
 *  - `<ycode-inline-variable>` (variables don't imply formatting)
 *  - `<div>` without semantic significance (wrapper-only)
 */
export function looksLikeFormattedHtml(html: string): boolean {
  if (typeof html !== 'string') return false;
  if (!html.includes('<') || !html.includes('>')) return false;

  return FORMATTED_HTML_RE.test(html);
}

const FORMATTED_HTML_RE =
  /<(?:p|h[1-6]|ul|ol|li|blockquote|pre|hr|table|thead|tbody|tfoot|tr|td|th|br|strong|b|em|i|u|s|strike|sub|sup|code|a|small|mark|kbd)\b[^>]*\/?>/i;

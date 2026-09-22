/**
 * Webflow rich-text HTML -> ycode TipTap document.
 *
 * `lib/csv-utils.ts htmlToTipTapJSON` (upstream, used for CMS `rich_text`
 * values) is regex-based and folds every inline tag away: `parseInlineNodes`
 * runs `.replace(/<[^>]+>/g, '')` over everything that is not an `<a>`, so
 * `<strong>`, `<em>`, `<u>`, `<s>` and `<code>` reach the document as plain
 * text. Webflow's rich-text fields use those constantly.
 *
 * This converter walks the real tree (`node-html-parser`, already a dependency
 * of html.ts) and keeps the marks, while emitting exactly the node and mark
 * shapes ycode's schema defines:
 *
 *   link mark   `{ type:'richTextLink', attrs:{ type:'url', url:{type:'dynamic_text',data:{content}}, target } }`
 *               (`lib/tiptap-extensions/rich-text-link.ts`)
 *   image node  `{ type:'richTextImage', attrs:{ src, alt, assetId, link } }`
 *               (`lib/tiptap-extensions/rich-text-image.ts`)
 *   marks       bold / italic / underline / strike / code
 *               (`app/(builder)/ycode/components/RichTextEditor.tsx`)
 *
 * Images are block-level in ycode's schema, so an `<img>` inside a paragraph is
 * lifted out as a sibling block (same rule as upstream's `pushParagraphWithImages`).
 * Webflow's `<figure class="w-richtext-figure-type-image">` wrapper becomes the
 * image plus a paragraph for its `<figcaption>`.
 *
 * `convertRichTextHtml` returns `null` when the fragment yields nothing, so the
 * caller can fall back to upstream's converter rather than store an empty doc.
 */

import { parse, HTMLElement, NodeType, type Node } from 'node-html-parser';

export interface TipTapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TipTapNode {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: TipTapMark[];
  content?: TipTapNode[];
  text?: string;
}

export interface TipTapDoc {
  type: 'doc';
  content: TipTapNode[];
}

/** `<tag>` -> mark name. `del`/`ins` follow what the editor's Strike/Underline extensions parse. */
const MARK_BY_TAG: Record<string, string> = {
  strong: 'bold',
  b: 'bold',
  em: 'italic',
  i: 'italic',
  u: 'underline',
  ins: 'underline',
  s: 'strike',
  strike: 'strike',
  del: 'strike',
  code: 'code',
};

const HEADING_RE = /^h([1-6])$/;

/** Elements that never contribute content (Webflow ships `<script class="w-json">` inside rich text figures for videos). */
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template']);

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&(nbsp|amp|lt|gt|quot|apos);|&#39;/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function tagOf(el: HTMLElement): string {
  return (el.rawTagName || '').toLowerCase();
}

/** Browser-like whitespace collapsing; a non-breaking space survives, as it does in a browser. */
function collapse(text: string): string {
  return decodeEntities(text).replace(/[\t\n\r ]+/g, ' ');
}

// ─── Inline ───────────────────────────────────────────────────────────────────

interface InlineOut {
  /** Inline nodes of the current paragraph-ish block. */
  inline: TipTapNode[];
  /** Block nodes lifted out of it (images). */
  lifted: TipTapNode[];
}

function linkMark(href: string, target: string | null): TipTapMark {
  return {
    type: 'richTextLink',
    attrs: {
      type: 'url',
      url: { type: 'dynamic_text', data: { content: href } },
      target: target || null,
    },
  };
}

function imageNode(el: HTMLElement, link: { href: string; target: string | null } | null): TipTapNode | null {
  const src = (el.getAttribute('src') ?? '').trim();
  if (!src) return null;
  const alt = el.getAttribute('alt');
  return {
    type: 'richTextImage',
    attrs: {
      src,
      alt: alt ? decodeEntities(alt) : null,
      assetId: null,
      link: link ? { type: 'url', url: { type: 'dynamic_text', data: { content: link.href } }, target: link.target || undefined } : null,
    },
  };
}

function pushText(out: InlineOut, text: string, marks: TipTapMark[]): void {
  if (!text) return;
  const last = out.inline[out.inline.length - 1];
  // Merge adjacent runs that carry the same marks so `<b>a</b><b>b</b>` is one node.
  if (last && last.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(marks)) {
    last.text = (last.text ?? '') + text;
    return;
  }
  out.inline.push(marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text });
}

function walkInline(node: Node, marks: TipTapMark[], link: { href: string; target: string | null } | null, out: InlineOut): void {
  if (node.nodeType === NodeType.TEXT_NODE) {
    pushText(out, collapse((node as unknown as { rawText: string }).rawText ?? ''), marks);
    return;
  }
  if (!(node instanceof HTMLElement)) return;
  const tag = tagOf(node);
  if (SKIP_TAGS.has(tag)) return;

  if (tag === 'br') {
    out.inline.push({ type: 'hardBreak' });
    return;
  }
  if (tag === 'img') {
    // Block-level in ycode's schema: lift it out of the paragraph.
    const image = imageNode(node, link);
    if (image) out.lifted.push(image);
    return;
  }
  if (tag === 'a') {
    const href = (node.getAttribute('href') ?? '').trim();
    const target = node.getAttribute('target') ?? null;
    const nextLink = href ? { href, target } : link;
    const nextMarks = href ? [...marks.filter((m) => m.type !== 'richTextLink'), linkMark(href, target)] : marks;
    for (const child of node.childNodes) walkInline(child, nextMarks, nextLink, out);
    return;
  }

  const mark = MARK_BY_TAG[tag];
  const nextMarks = mark && !marks.some((m) => m.type === mark) ? [...marks, { type: mark }] : marks;
  for (const child of node.childNodes) walkInline(child, nextMarks, link, out);
}

/** Inline content of one block element, plus any images lifted out of it. */
function inlineContent(el: HTMLElement): InlineOut {
  const out: InlineOut = { inline: [], lifted: [] };
  for (const child of el.childNodes) walkInline(child, [], null, out);
  trimEdges(out.inline);
  return out;
}

function trimEdges(nodes: TipTapNode[]): void {
  while (nodes.length > 0 && nodes[0].type === 'hardBreak') nodes.shift();
  while (nodes.length > 0 && nodes[nodes.length - 1].type === 'hardBreak') nodes.pop();
  const first = nodes[0];
  if (first?.type === 'text' && first.text) first.text = first.text.replace(/^\s+/, '');
  const last = nodes[nodes.length - 1];
  if (last?.type === 'text' && last.text) last.text = last.text.replace(/\s+$/, '');
  // A run trimmed down to nothing must not stay as an empty text node (invalid in TipTap).
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].type === 'text' && !nodes[i].text) nodes.splice(i, 1);
  }
}

function hasContent(nodes: TipTapNode[]): boolean {
  return nodes.some((n) => (n.type === 'text' ? Boolean(n.text?.trim()) : true));
}

// ─── Blocks ───────────────────────────────────────────────────────────────────

/** The `<img>` of a Webflow rich-text `<figure>`, with the `<a>` around it when there is one. */
function figureImage(el: HTMLElement): TipTapNode | null {
  const img = el.querySelector('img');
  if (!img) return null;
  let link: { href: string; target: string | null } | null = null;
  let parent = img.parentNode as HTMLElement | null;
  while (parent && parent !== el) {
    if (tagOf(parent) === 'a') {
      const href = (parent.getAttribute('href') ?? '').trim();
      if (href) link = { href, target: parent.getAttribute('target') ?? null };
      break;
    }
    parent = parent.parentNode as HTMLElement | null;
  }
  return imageNode(img, link);
}

function walkBlock(el: HTMLElement, out: TipTapNode[]): void {
  const tag = tagOf(el);
  if (SKIP_TAGS.has(tag)) return;

  if (tag === 'hr') {
    out.push({ type: 'horizontalRule' });
    return;
  }

  if (tag === 'img') {
    const image = imageNode(el, null);
    if (image) out.push(image);
    return;
  }

  if (tag === 'figure') {
    // `w-richtext-figure-type-video` carries an embed, which has no TipTap node
    // here — its caption still survives as a paragraph.
    const image = figureImage(el);
    if (image) out.push(image);
    const caption = el.querySelector('figcaption');
    if (caption) {
      const inner = inlineContent(caption);
      if (hasContent(inner.inline)) out.push({ type: 'paragraph', content: inner.inline });
      out.push(...inner.lifted);
    }
    return;
  }

  const heading = HEADING_RE.exec(tag);
  if (heading) {
    const inner = inlineContent(el);
    if (hasContent(inner.inline)) out.push({ type: 'heading', attrs: { level: Number(heading[1]) }, content: inner.inline });
    out.push(...inner.lifted);
    return;
  }

  if (tag === 'ul' || tag === 'ol') {
    const items: TipTapNode[] = [];
    const lifted: TipTapNode[] = [];
    for (const li of el.childNodes) {
      if (!(li instanceof HTMLElement) || tagOf(li) !== 'li') continue;
      const nested: TipTapNode[] = [];
      const inner = inlineContentSkippingBlocks(li, nested);
      const content: TipTapNode[] = [];
      if (hasContent(inner.inline)) content.push({ type: 'paragraph', content: inner.inline });
      content.push(...nested);
      lifted.push(...inner.lifted);
      if (content.length > 0) items.push({ type: 'listItem', content });
    }
    if (items.length > 0) out.push({ type: tag === 'ol' ? 'orderedList' : 'bulletList', content: items });
    out.push(...lifted);
    return;
  }

  if (tag === 'blockquote') {
    const nested: TipTapNode[] = [];
    const inner = inlineContentSkippingBlocks(el, nested);
    const content: TipTapNode[] = [];
    if (hasContent(inner.inline)) content.push({ type: 'paragraph', content: inner.inline });
    content.push(...nested.filter((n) => n.type === 'paragraph'));
    if (content.length > 0) out.push({ type: 'blockquote', content });
    out.push(...inner.lifted, ...nested.filter((n) => n.type !== 'paragraph'));
    return;
  }

  // `p` and anything else that holds blocks (`div`, `section`, …).
  const nested: TipTapNode[] = [];
  const inner = inlineContentSkippingBlocks(el, nested);
  if (hasContent(inner.inline)) out.push({ type: 'paragraph', content: inner.inline });
  out.push(...inner.lifted, ...nested);
}

const BLOCK_TAGS = new Set(['p', 'div', 'ul', 'ol', 'blockquote', 'figure', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer', 'table', 'pre']);

/**
 * Split an element's children into the inline run that belongs to this block and
 * the block-level descendants that must become siblings — Webflow nests `<p>`
 * inside `<li>` and `<blockquote>`, and wraps stray text in `<div>`s.
 */
function inlineContentSkippingBlocks(el: HTMLElement, blocksOut: TipTapNode[]): InlineOut {
  const out: InlineOut = { inline: [], lifted: [] };
  for (const child of el.childNodes) {
    if (child instanceof HTMLElement && BLOCK_TAGS.has(tagOf(child))) {
      walkBlock(child, blocksOut);
      continue;
    }
    walkInline(child, [], null, out);
  }
  trimEdges(out.inline);
  return out;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Convert a Webflow rich-text fragment. Returns `null` when the fragment has no
 * convertible content, so the caller can fall back to upstream's converter.
 */
export function convertRichTextHtml(html: string): TipTapDoc | null {
  if (!html.trim()) return null;
  let root: HTMLElement;
  try {
    root = parse(html, { comment: false, blockTextElements: { script: true, style: true, noscript: true } });
  } catch {
    return null;
  }

  const content: TipTapNode[] = [];
  const looseInline: InlineOut = { inline: [], lifted: [] };
  const flushLoose = () => {
    trimEdges(looseInline.inline);
    if (hasContent(looseInline.inline)) content.push({ type: 'paragraph', content: [...looseInline.inline] });
    content.push(...looseInline.lifted);
    looseInline.inline = [];
    looseInline.lifted = [];
  };

  for (const child of root.childNodes) {
    if (child instanceof HTMLElement && BLOCK_TAGS.has(tagOf(child))) {
      flushLoose();
      walkBlock(child, content);
      continue;
    }
    walkInline(child, [], null, looseInline);
  }
  flushLoose();

  if (content.length === 0) return null;
  return { type: 'doc', content };
}

/**
 * Convert Webflow rich-text HTML into a TipTap JSON document string.
 *
 * Webflow's CMS RichText fields are returned as raw HTML. YCode's `rich_text`
 * field expects a serialized TipTap document. This converter handles the
 * common subset (paragraphs, headings, lists, bold/italic/links) and falls
 * back to a single paragraph with stripped text for anything unrecognized.
 *
 * No DOM is required — uses string parsing only so it's safe to run inside
 * server-side migrations.
 */

interface TiptapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface TiptapNode {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: TiptapMark[];
  content?: TiptapNode[];
  text?: string;
}

const EMPTY_DOC = JSON.stringify({ type: 'doc', content: [] });

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** Decode the small set of HTML entities Webflow tends to emit. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/** Strip all HTML tags from a string and return decoded plain text. */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ')).trim();
}

/**
 * Parse the inline content of a block (anything between the open/close tag of
 * a paragraph, heading, or list item) into TipTap inline nodes. Recognizes
 * `<a>`, `<strong>`/`<b>`, `<em>`/`<i>`, `<u>`, `<code>`, and `<br>`.
 */
function parseInline(html: string): TiptapNode[] {
  const nodes: TiptapNode[] = [];
  const inlineRegex = /<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>|<(strong|b|em|i|u|code)\b[^>]*>([\s\S]*?)<\/\3>|<br\s*\/?\s*>/gi;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const pushText = (text: string, marks?: TiptapMark[]) => {
    const decoded = decodeEntities(text);
    if (!decoded) return;
    nodes.push(marks ? { type: 'text', text: decoded, marks } : { type: 'text', text: decoded });
  };

  while ((match = inlineRegex.exec(html)) !== null) {
    if (match.index > lastIndex) {
      pushText(html.slice(lastIndex, match.index));
    }

    if (match[0].startsWith('<a')) {
      const href = match[1];
      const inner = stripTags(match[2]);
      pushText(inner || href, [{ type: 'link', attrs: { href } }]);
    } else if (match[3]) {
      const tag = match[3].toLowerCase();
      const inner = stripTags(match[4]);
      const markType =
        tag === 'strong' || tag === 'b' ? 'bold' :
          tag === 'em' || tag === 'i' ? 'italic' :
            tag === 'u' ? 'underline' :
              tag === 'code' ? 'code' :
                tag;
      pushText(inner, [{ type: markType }]);
    } else {
      // <br> — TipTap uses an explicit hardBreak node
      nodes.push({ type: 'hardBreak' });
    }

    lastIndex = inlineRegex.lastIndex;
  }

  if (lastIndex < html.length) {
    pushText(html.slice(lastIndex));
  }

  return nodes;
}

/** Convert a list block (`<ul>` / `<ol>`) into a TipTap list node. */
function parseList(html: string, ordered: boolean): TiptapNode {
  const items: TiptapNode[] = [];
  const itemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(html)) !== null) {
    const inner = match[1].trim();
    items.push({
      type: 'listItem',
      content: [{ type: 'paragraph', content: parseInline(inner) }],
    });
  }

  return {
    type: ordered ? 'orderedList' : 'bulletList',
    content: items,
  };
}

/**
 * Walk through top-level blocks (paragraphs / headings / lists / blockquotes)
 * and convert each into a TipTap node. Anything outside a recognized block
 * wraps into a fallback paragraph.
 */
function parseBlocks(html: string): TiptapNode[] {
  const nodes: TiptapNode[] = [];
  const blockRegex = /<(p|h1|h2|h3|h4|h5|h6|ul|ol|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  const flushText = (text: string) => {
    const stripped = stripTags(text);
    if (stripped) {
      nodes.push({ type: 'paragraph', content: [{ type: 'text', text: stripped }] });
    }
  };

  while ((match = blockRegex.exec(html)) !== null) {
    if (match.index > lastIndex) {
      flushText(html.slice(lastIndex, match.index));
    }

    const tag = match[1].toLowerCase();
    const inner = match[2];

    if (tag === 'p') {
      const inline = parseInline(inner);
      nodes.push({ type: 'paragraph', content: inline.length > 0 ? inline : [] });
    } else if (HEADING_TAGS.has(tag)) {
      nodes.push({
        type: 'heading',
        attrs: { level: parseInt(tag.slice(1), 10) },
        content: parseInline(inner),
      });
    } else if (tag === 'ul' || tag === 'ol') {
      nodes.push(parseList(inner, tag === 'ol'));
    } else if (tag === 'blockquote') {
      nodes.push({
        type: 'blockquote',
        content: parseBlocks(inner),
      });
    }

    lastIndex = blockRegex.lastIndex;
  }

  if (lastIndex < html.length) {
    flushText(html.slice(lastIndex));
  }

  return nodes;
}

/** Convert a Webflow HTML rich-text string into TipTap JSON. */
export function htmlToTiptapJson(html: string): string {
  if (!html || typeof html !== 'string') return EMPTY_DOC;

  const trimmed = html.trim();
  if (trimmed.length === 0) return EMPTY_DOC;

  const blocks = parseBlocks(trimmed);

  // No recognized blocks — fall back to a single paragraph with stripped text.
  if (blocks.length === 0) {
    const stripped = stripTags(trimmed);
    if (!stripped) return EMPTY_DOC;
    return JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: stripped }] }],
    });
  }

  return JSON.stringify({ type: 'doc', content: blocks });
}

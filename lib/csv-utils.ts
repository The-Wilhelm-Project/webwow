/**
 * CSV Utilities
 *
 * Parsing and validation utilities for CSV imports.
 */

import type { CollectionField, CollectionFieldType } from '@/types';

// ============================================================================
// Constants
// ============================================================================

/** Value used in column mapping to indicate a column should be skipped */
export const SKIP_COLUMN = '__skip__';

/** Auto-generated field keys that are set automatically during import */
export const AUTO_FIELD_KEYS = ['id', 'created_at', 'updated_at'] as const;

/** Field types that contain asset URLs and need to be downloaded */
export const ASSET_FIELD_TYPES: CollectionFieldType[] = ['image', 'video', 'audio', 'document'];

/**
 * Check if a field type is an asset type that needs URL downloading
 */
export function isAssetFieldType(type: CollectionFieldType): boolean {
  return ASSET_FIELD_TYPES.includes(type);
}

/**
 * Check if a value looks like a URL
 */
export function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Check if a value is a base64-encoded data image URI (e.g. `data:image/png;base64,...`) */
export function isDataImageUrl(value: string): boolean {
  return /^data:image\/[^;,]+;base64,/i.test(value.trim());
}

/** Decoded parts of a base64 data image URI */
export interface ParsedDataImage {
  mimeType: string;
  base64: string;
  extension: string;
}

/**
 * Decode a base64 data image URI into its mime type, base64 payload and file extension.
 * Returns null when the value is not a valid base64 data image.
 */
export function parseDataImageUri(value: string): ParsedDataImage | null {
  const match = value.trim().match(/^data:(image\/[^;,]+);base64,([\s\S]*)$/);
  if (!match) return null;
  const mimeType = match[1];
  const base64 = match[2];
  if (!base64) return null;
  return { mimeType, base64, extension: mimeType.split('/')[1]?.split('+')[0] || 'bin' };
}

// ============================================================================
// Helper utilities
// ============================================================================

/** Truncate a value for display in error messages */
export function truncateValue(value: string, maxLength: number = 50): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

/** Extract error message from unknown error */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

// TipTap JSON types
interface TipTapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface TipTapNode {
  type: string;
  content?: TipTapNode[];
  text?: string;
  marks?: TipTapMark[];
  attrs?: Record<string, unknown>;
}

/**
 * Parse inline HTML into TipTap text nodes, preserving <a> links as richTextLink marks.
 * All other tags are stripped, keeping only their text content.
 */
function parseInlineNodes(html: string): TipTapNode[] {
  const nodes: TipTapNode[] = [];
  const linkRegex = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let lastIndex = 0;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    if (match.index > lastIndex) {
      const raw = html.slice(lastIndex, match.index).replace(/<[^>]+>/g, '');
      const text = decodeHtmlEntities(raw);
      if (text.trim()) nodes.push({ type: 'text', text });
    }

    const href = match[1];
    const linkText = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, ''));
    if (linkText.trim()) {
      const targetMatch = match[0].match(/target=["']([^"']+)["']/i);
      nodes.push({
        type: 'text',
        text: linkText,
        marks: [{
          type: 'richTextLink',
          attrs: {
            type: 'url',
            url: { type: 'dynamic_text', data: { content: href } },
            target: targetMatch?.[1] || null,
          },
        }],
      });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < html.length) {
    const raw = html.slice(lastIndex).replace(/<[^>]+>/g, '');
    const text = decodeHtmlEntities(raw);
    if (text.trim()) nodes.push({ type: 'text', text });
  }

  // Trim only the outermost edges, preserving internal spacing
  if (nodes.length > 0) {
    nodes[0].text = nodes[0].text!.replace(/^\s+/, '');
    nodes[nodes.length - 1].text = nodes[nodes.length - 1].text!.replace(/\s+$/, '');
  }

  return nodes.filter(n => n.text);
}

/** Extract src/alt from an <img> tag (or <a><img></a> wrapper) and return a richTextImage node */
function parseImgTag(html: string, link?: { href: string; target?: string | null }): TipTapNode | null {
  // When the html contains an <a> wrapper, extract the <img> portion for src/alt
  const imgTagMatch = html.match(/<img\s[^>]*\/?>/i);
  const imgHtml = imgTagMatch ? imgTagMatch[0] : html;

  const srcMatch = imgHtml.match(/src=["']([^"']+)["']/i);
  if (!srcMatch) return null;
  const altMatch = imgHtml.match(/alt=["']([^"']*)["']/i);

  const linkSettings = link?.href
    ? { type: 'url', url: { type: 'dynamic_text', data: { content: link.href } }, target: link.target || undefined }
    : null;

  return {
    type: 'richTextImage',
    attrs: {
      src: srcMatch[1],
      alt: altMatch?.[1] || null,
      assetId: null,
      link: linkSettings,
    },
  };
}

/** Extract href and target from an <a> tag string */
function parseLinkAttrs(html: string): { href: string; target?: string | null } | null {
  const hrefMatch = html.match(/<a\s[^>]*href=["']([^"']+)["']/i);
  if (!hrefMatch) return null;
  const targetMatch = html.match(/<a\s[^>]*target=["']([^"']+)["']/i);
  return { href: hrefMatch[1], target: targetMatch?.[1] || null };
}

/**
 * Push paragraph content that may contain <img> tags (standalone or wrapped in <a>).
 * Images are extracted as sibling richTextImage nodes so they are block-level.
 */
function pushParagraphWithImages(innerHtml: string, content: TipTapNode[]): void {
  // Match: <a ...><img .../></a> | standalone <img .../>
  const parts = innerHtml.split(/(<a\s[^>]*>\s*<img\s[^>]*\/?>\s*<\/a>|<img\s[^>]*\/?>)/gi);
  for (const part of parts) {
    if (!part.trim()) continue;
    if (/^<img\s/i.test(part)) {
      const imgNode = parseImgTag(part);
      if (imgNode) content.push(imgNode);
    } else if (/^<a\s[^>]*>\s*<img/i.test(part)) {
      const link = parseLinkAttrs(part);
      const imgNode = parseImgTag(part, link ?? undefined);
      if (imgNode) content.push(imgNode);
    } else {
      const inlineNodes = parseInlineNodes(part);
      if (inlineNodes.length > 0) {
        content.push({ type: 'paragraph', content: inlineNodes });
      }
    }
  }
}

/**
 * Convert HTML string to TipTap JSON format
 * Handles common HTML tags: p, strong, b, em, i, u, s, strike, ol, ul, li, h1-h6, blockquote, br, a, img, hr
 * Preserves the original order of elements
 */
function htmlToTipTapJSON(html: string): TipTapNode {
  // Check if the string looks like HTML
  const hasHtmlTags = /<[a-z][\s\S]*>/i.test(html);

  if (!hasHtmlTags) {
    // Plain text - wrap in paragraph
    return {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: html ? [{ type: 'text', text: html }] : [],
        },
      ],
    };
  }

  const content: TipTapNode[] = [];

  // Clean up the HTML
  const cleanHtml = html
    .replace(/\s+class="[^"]*"/gi, '') // Remove class attributes
    .replace(/<br\s*\/?>/gi, '\n'); // Normalize br tags

  // Regex to match block-level elements, self-closing img tags, and hr tags
  const blockRegex = /<(p|ol|ul|h[1-6]|blockquote|div)(?:\s[^>]*)?>[\s\S]*?<\/\1>|<img\s[^>]*\/?>|<hr\s*\/?>/gi;

  let lastIndex = 0;
  let match;

  while ((match = blockRegex.exec(cleanHtml)) !== null) {
    const fullMatch = match[0];
    const tagName = (match[1] || '').toLowerCase();

    // Process any text between the last match and this one
    if (match.index > lastIndex) {
      const textBetween = cleanHtml.slice(lastIndex, match.index).trim();
      if (textBetween) {
        const inlineNodes = parseInlineNodes(textBetween);
        if (inlineNodes.length > 0) {
          content.push({ type: 'paragraph', content: inlineNodes });
        }
      }
    }

    // Handle self-closing tags (<img>, <hr>)
    if (fullMatch.toLowerCase().startsWith('<img')) {
      const imgNode = parseImgTag(fullMatch);
      if (imgNode) {
        content.push(imgNode);
      }
      lastIndex = match.index + fullMatch.length;
      continue;
    }

    if (fullMatch.toLowerCase().startsWith('<hr')) {
      content.push({ type: 'horizontalRule' });
      lastIndex = match.index + fullMatch.length;
      continue;
    }

    // Process the matched element
    if (tagName === 'p' || tagName === 'div') {
      // Extract inline images from inside the paragraph
      const innerContent = fullMatch.replace(/<\/?(?:p|div)[^>]*>/gi, '');
      pushParagraphWithImages(innerContent, content);
    } else if (tagName === 'ol' || tagName === 'ul') {
      // List — extract text for list items, and pull images out as sibling blocks
      const isOrdered = tagName === 'ol';
      const listItems: TipTapNode[] = [];
      const trailingImages: TipTapNode[] = [];

      const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let liMatch;
      while ((liMatch = liRegex.exec(fullMatch)) !== null) {
        let itemContent = liMatch[1].trim();

        // Pull <img> tags out of the list item (they become block-level siblings)
        const imgMatches = itemContent.match(/<img\s[^>]*\/?>/gi) || [];
        for (const imgTag of imgMatches) {
          const imgNode = parseImgTag(imgTag);
          if (imgNode) trailingImages.push(imgNode);
        }

        // Strip <img> tags (already extracted above), then strip <p>/<div> wrappers
        itemContent = itemContent.replace(/<img\s[^>]*\/?>/gi, '');
        itemContent = itemContent.replace(/<\/?(?:p|div)[^>]*>/gi, '').trim();
        const inlineNodes = parseInlineNodes(itemContent);

        if (inlineNodes.length > 0) {
          listItems.push({
            type: 'listItem',
            content: [{ type: 'paragraph', content: inlineNodes }],
          });
        }
      }

      if (listItems.length > 0) {
        content.push({
          type: isOrdered ? 'orderedList' : 'bulletList',
          content: listItems,
        });
      }
      // Append extracted images after the list
      content.push(...trailingImages);
    } else if (tagName.match(/^h[1-6]$/)) {
      const level = parseInt(tagName[1], 10);
      const innerContent = fullMatch.replace(/<\/?h[1-6][^>]*>/gi, '').trim();
      const inlineNodes = parseInlineNodes(innerContent);
      if (inlineNodes.length > 0) {
        content.push({
          type: 'heading',
          attrs: { level },
          content: inlineNodes,
        });
      }
    } else if (tagName === 'blockquote') {
      const innerContent = fullMatch.replace(/<\/?blockquote[^>]*>/gi, '').trim();
      const inlineNodes = parseInlineNodes(innerContent);
      if (inlineNodes.length > 0) {
        content.push({
          type: 'blockquote',
          content: [{ type: 'paragraph', content: inlineNodes }],
        });
      }
    }

    lastIndex = match.index + fullMatch.length;
  }

  // Process any remaining text after the last match
  if (lastIndex < cleanHtml.length) {
    const remaining = cleanHtml.slice(lastIndex).trim();
    if (remaining) {
      pushParagraphWithImages(remaining, content);
    }
  }

  // Ensure we have at least one content node
  if (content.length === 0) {
    content.push({
      type: 'paragraph',
      content: [],
    });
  }

  return {
    type: 'doc',
    content,
  };
}

/**
 * Decode HTML entities
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&#x([a-fA-F0-9]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export interface ParsedCSV {
  headers: string[];
  rows: Record<string, string>[];
}

/**
 * Escape a single CSV field (RFC 4180): wraps in quotes when needed and
 * doubles internal quote characters.
 */
function escapeCSVField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Convert an array of objects into a CSV string. The provided headers
 * define both the column order and the keys read from each row.
 */
export function rowsToCSV<T extends Record<string, unknown>>(
  headers: string[],
  rows: T[]
): string {
  const headerLine = headers.map(escapeCSVField).join(',');
  const dataLines = rows.map((row) =>
    headers.map((header) => escapeCSVField(row[header])).join(',')
  );
  return [headerLine, ...dataLines].join('\n');
}

/**
 * Trigger a browser download for the given CSV string. No-op on the server.
 */
export function downloadCSV(csv: string, filename: string): void {
  if (typeof window === 'undefined') return;

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Parse CSV text into headers and rows.
 * Handles quoted fields, escaped quotes, and multi-line values inside quotes.
 */
export function parseCSVText(csvText: string): ParsedCSV {
  if (!csvText.trim()) {
    return { headers: [], rows: [] };
  }

  const records = parseCSVRecords(csvText);

  if (records.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = records[0];
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < records.length; i++) {
    const values = records[i];
    const row: Record<string, string> = {};

    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });

    rows.push(row);
  }

  return { headers, rows };
}

/**
 * Low-level CSV record parser that correctly handles multi-line quoted fields.
 * Parses character by character so newlines inside quotes are preserved as
 * part of the field value instead of splitting into extra rows.
 */
function parseCSVRecords(text: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      current += char;
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (char === ',') {
      fields.push(current.trim());
      current = '';
      i++;
      continue;
    }

    if (char === '\r' || char === '\n') {
      // End of record
      if (char === '\r' && text[i + 1] === '\n') i++;
      fields.push(current.trim());
      current = '';

      // Skip blank rows (all-empty fields)
      if (fields.some(f => f !== '')) {
        records.push(fields);
      }
      fields = [];
      i++;
      continue;
    }

    current += char;
    i++;
  }

  // Handle last field / record (file may not end with newline)
  fields.push(current.trim());
  if (fields.some(f => f !== '')) {
    records.push(fields);
  }

  return records;
}

/**
 * Parse CSV file and return headers and rows
 */
export async function parseCSVFile(file: File): Promise<ParsedCSV> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const result = parseCSVText(text);
        resolve(result);
      } catch (error) {
        reject(new Error('Failed to parse CSV file'));
      }
    };

    reader.onerror = () => {
      reject(new Error('Failed to read CSV file'));
    };

    reader.readAsText(file);
  });
}

/**
 * Convert CSV value to appropriate type based on field type
 */
export function convertValueForFieldType(
  value: string,
  fieldType: CollectionFieldType
): string | null {
  if (!value || value.trim() === '') {
    return null;
  }

  const trimmedValue = value.trim();

  switch (fieldType) {
    case 'text':
    case 'email':
    case 'phone':
    case 'link':
      return trimmedValue;

    case 'number': {
      const num = parseFloat(trimmedValue);
      if (isNaN(num)) {
        return null;
      }
      return String(num);
    }

    case 'boolean': {
      const lower = trimmedValue.toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(lower)) {
        return 'true';
      }
      if (['false', '0', 'no', 'n'].includes(lower)) {
        return 'false';
      }
      return null;
    }

    case 'date':
    case 'date_only': {
      const date = new Date(trimmedValue);
      if (isNaN(date.getTime())) {
        return null;
      }
      return date.toISOString();
    }

    case 'rich_text':
      // Convert HTML to TipTap JSON format
      return JSON.stringify(htmlToTipTapJSON(trimmedValue));

    case 'image':
    case 'video':
    case 'audio':
    case 'document':
      // Assume URL is provided
      return trimmedValue;

    case 'reference':
    case 'multi_reference':
      // Reference IDs should be provided as-is or comma-separated
      return trimmedValue;

    default:
      return trimmedValue;
  }
}

/**
 * Validate CSV data against collection fields
 * Returns array of validation errors
 */
export function validateCSVMapping(
  columnMapping: Record<string, string>,
  fields: CollectionField[]
): string[] {
  const errors: string[] = [];
  const fieldMap = new Map(fields.map(f => [f.id, f]));
  const mappedFieldIds = new Set<string>();

  // Check for duplicate field mappings
  Object.entries(columnMapping).forEach(([, fieldId]) => {
    // Skip empty or skipped values
    if (!fieldId || fieldId === SKIP_COLUMN) return;

    if (mappedFieldIds.has(fieldId)) {
      const field = fieldMap.get(fieldId);
      errors.push(`Field "${field?.name || fieldId}" is mapped to multiple columns`);
    }
    mappedFieldIds.add(fieldId);
  });

  return errors;
}

/**
 * Get suggested field mapping based on CSV header names
 * Matches by name (case-insensitive) or key
 */
export function suggestColumnMapping(
  headers: string[],
  fields: CollectionField[]
): Record<string, string> {
  const mapping: Record<string, string> = {};

  headers.forEach(header => {
    const normalizedHeader = header.toLowerCase().trim();

    // Try to match by field name or key
    const matchedField = fields.find(field => {
      const fieldName = field.name.toLowerCase().trim();
      const fieldKey = field.key?.toLowerCase().trim();
      return fieldName === normalizedHeader || fieldKey === normalizedHeader;
    });

    if (matchedField) {
      mapping[header] = matchedField.id;
    } else {
      mapping[header] = SKIP_COLUMN; // No match, skip this column
    }
  });

  return mapping;
}

/**
 * Get field type label for display
 */
export function getFieldTypeLabel(type: CollectionFieldType): string {
  const labels: Record<CollectionFieldType, string> = {
    text: 'Text',
    number: 'Number',
    boolean: 'Boolean',
    date: 'Date & Time',
    date_only: 'Date',
    color: 'Color',
    reference: 'Reference',
    multi_reference: 'Multi Reference',
    rich_text: 'Rich Text',
    image: 'Image',
    video: 'Video',
    audio: 'Audio',
    document: 'Document',
    link: 'Link',
    email: 'Email',
    phone: 'Phone',
    option: 'Option',
    count: 'Count',
    status: 'Status',
  };
  return labels[type] || type;
}

/** An image URL found inside TipTap rich-text JSON that needs downloading */
export interface RichTextImageRef {
  src: string;
}

/** Walk TipTap JSON to collect all richTextImage src URLs */
export function extractRichTextImageUrls(json: string): RichTextImageRef[] {
  try {
    const doc = JSON.parse(json);
    const refs: RichTextImageRef[] = [];
    walkTipTapNodes(doc, (node) => {
      const attrs = node.attrs as Record<string, unknown> | undefined;
      const src = attrs?.src as string | undefined;
      // Remote URLs (downloaded) and inline base64 data images (decoded) are both
      // uploaded to the asset manager so they never get stored inline in content.
      if (node.type === 'richTextImage' && src && (isValidUrl(src) || isDataImageUrl(src))) {
        refs.push({ src });
      }
    });
    return refs;
  } catch {
    return [];
  }
}

/** Replace image src URLs in TipTap JSON and set assetId */
export function replaceRichTextImageUrls(
  json: string,
  urlToAsset: Map<string, { assetId: string; publicUrl: string }>
): string {
  try {
    const doc = JSON.parse(json);
    walkTipTapNodes(doc, (node) => {
      const attrs = node.attrs as Record<string, unknown> | undefined;
      if (node.type === 'richTextImage' && attrs?.src) {
        const replacement = urlToAsset.get(attrs.src as string);
        if (replacement) {
          attrs.src = replacement.publicUrl;
          attrs.assetId = replacement.assetId;
        }
      }
    });
    return JSON.stringify(doc);
  } catch {
    return json;
  }
}

function walkTipTapNodes(node: Record<string, unknown>, cb: (n: Record<string, unknown>) => void): void {
  cb(node);
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      walkTipTapNodes(child as Record<string, unknown>, cb);
    }
  }
}

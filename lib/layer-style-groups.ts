/**
 * Maps layer element names and RichText sublayer keys to style groups.
 * Styles are scoped to their group so a "text" style cannot be applied
 * to a "block" element and vice-versa.
 */

const LAYER_NAME_TO_GROUP: Record<string, string> = {
  heading: 'text',
  text: 'text',
  richText: 'text',

  div: 'block',
  section: 'block',
  hr: 'block',
  slider: 'block',
  lightbox: 'block',
  htmlEmbed: 'block',
  filter: 'block',
  localeSelector: 'block',

  button: 'button',

  image: 'media',
  icon: 'media',
  video: 'media',
  audio: 'media',

  form: 'form',
  input: 'form',
  textarea: 'form',
  select: 'form',
  label: 'form',
};

const TEXT_STYLE_KEY_TO_GROUP: Record<string, string> = {
  paragraph: 'text',
  h1: 'text',
  h2: 'text',
  h3: 'text',
  h4: 'text',
  h5: 'text',
  h6: 'text',
  blockquote: 'text',
  code: 'text',
  bold: 'text',
  italic: 'text',
  underline: 'text',
  strike: 'text',
  subscript: 'text',
  superscript: 'text',

  bulletList: 'list',
  orderedList: 'list',
  listItem: 'list',

  link: 'button',

  table: 'table',
  tableHeader: 'table',
  tableCell: 'table',
  tableRow: 'table',
};

/**
 * Returns the style group for a given layer element name.
 * Falls back to "block" for unknown elements.
 */
export function getStyleGroup(layerName: string): string {
  return LAYER_NAME_TO_GROUP[layerName] ?? 'block';
}

/**
 * Returns the style group for a RichText sublayer text-style key.
 * Falls back to "text" for unknown keys.
 */
export function getTextStyleGroup(textStyleKey: string): string {
  return TEXT_STYLE_KEY_TO_GROUP[textStyleKey] ?? 'text';
}

/**
 * Groups that are all equivalent to 'text' (includes transitional names).
 */
const TEXT_EQUIVALENT_GROUPS = new Set(['text', 'heading', 'paragraph', 'richtext', 'inline']);

/**
 * Check whether a style's group is compatible with the target group.
 * All text-related groups are treated as interchangeable.
 */
export function isStyleGroupCompatible(styleGroup: string | null | undefined, targetGroup: string): boolean {
  if (!styleGroup) return true;
  if (styleGroup === targetGroup) return true;

  if (TEXT_EQUIVALENT_GROUPS.has(styleGroup) && TEXT_EQUIVALENT_GROUPS.has(targetGroup)) {
    return true;
  }

  return false;
}

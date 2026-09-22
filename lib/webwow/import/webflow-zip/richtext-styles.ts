/**
 * Rich-text element styles (`layer.textStyles`) for `richText` layers.
 *
 * ycode renders the blocks of a rich-text layer (`<p>`, `<h2>`, `<ul>`, …) from
 * `layer.textStyles` — a `Record<styleKey, TextStyle>` whose keys are the ones
 * `DEFAULT_TEXT_STYLES` (`lib/text-format-utils.ts`) defines: `paragraph`,
 * `h1`…`h6`, `bulletList`, `orderedList`, `listItem`, `link`, `bold`, `italic`,
 * `blockquote`, `richTextImage`, `horizontalRule`. A layer entry replaces the
 * default for that key wholesale, and the builder shows its `design` data in
 * the design panel (`LayerStylesPanel` reads `layer.textStyles[key]`).
 *
 * Webflow styles the same blocks with plain tag rules — `normalize.css`
 * (`b, strong { font-weight: bold }`), `components.css` (`p { margin: 0 0 10px }`,
 * `h1 { font-size: 38px; … }`, `ul, ol { padding-left: 40px }`), the site sheet
 * (`p { margin-bottom: 10px }`) — plus descendant rules scoped to the rich-text
 * container (`.w-richtext figure { max-width: 60% }`, `.rich-text-block p { … }`).
 * None of that reaches a rich-text child in ycode: tag underlays are layer styles
 * (a `<p>` inside a rich-text layer is not a layer), and a descendant rule would
 * only survive as residual CSS with a namespaced class the layer does not carry.
 *
 * So every `richText` layer gets its `textStyles` derived here:
 *   1. the tag underlays of the style model (framework + site tag rules), then
 *   2. the descendant rules of `.w-richtext` and of the element's own site
 *      classes (`css.ts` collects them as `model.richTextTags`, in place of the
 *      residual CSS), later classes winning,
 *   3. on top of a small baseline of browser defaults that Tailwind's preflight
 *      resets and no Webflow sheet repeats (`underline` on links, list markers,
 *      bold / italic marks).
 *
 * Margins are part of the entry (`mt-0 mb-[10px]` on paragraphs), which is why
 * the importer never adds the `flex flex-col gap-[16px]` of ycode's own Rich
 * Text element to the container: the gaps would double the spacing.
 */

import { buildDesign } from '@/lib/import/design';

import { RICH_TEXT_TAGS, mergePrefixedClasses, type WfStyleModel } from './css';

import type { TextStyle } from '@/types';

/**
 * Text-style key -> the tags whose rules feed it, in merge order (later wins).
 * `richTextImage` takes the `<img>` reset first and the `<figure>` box on top:
 * ycode renders the image without a figure, so the figure's margins and
 * max-width belong to the image itself.
 */
export const TEXT_STYLE_TAGS: Record<string, string[]> = {
  paragraph: ['p'],
  h1: ['h1'],
  h2: ['h2'],
  h3: ['h3'],
  h4: ['h4'],
  h5: ['h5'],
  h6: ['h6'],
  bulletList: ['ul'],
  orderedList: ['ol'],
  listItem: ['li'],
  link: ['a'],
  bold: ['b', 'strong'],
  italic: ['i', 'em'],
  blockquote: ['blockquote'],
  richTextImage: ['img', 'figure'],
  horizontalRule: ['hr'],
};

/** Labels as `DEFAULT_TEXT_STYLES` names them (that module is React-bound, so the labels are repeated here). */
const LABELS: Record<string, string> = {
  paragraph: 'Paragraph',
  h1: 'Heading 1',
  h2: 'Heading 2',
  h3: 'Heading 3',
  h4: 'Heading 4',
  h5: 'Heading 5',
  h6: 'Heading 6',
  bulletList: 'Bullet list',
  orderedList: 'Ordered list',
  listItem: 'List Item',
  link: 'Link',
  bold: 'Bold',
  italic: 'Italic',
  blockquote: 'Blockquote',
  richTextImage: 'Image',
  horizontalRule: 'Separator',
};

/**
 * Browser defaults that Tailwind's preflight removes (`a { text-decoration:
 * inherit }`, `ul { list-style: none }`, `h1 { font-weight: inherit }` …) and
 * that Webflow relies on without restating them. They sit under the CSS-derived
 * classes so any real rule wins.
 */
const BASELINE: Record<string, string[]> = {
  link: ['underline'],
  bulletList: ['list-disc'],
  orderedList: ['list-decimal'],
  bold: ['font-[700]'],
  italic: ['italic'],
};

const CLASS_ATTR_RE = /\bclass\s*=\s*"([^"]*)"|\bclass\s*=\s*'([^']*)'/gi;

/**
 * Class names of every rich-text element (`.w-richtext …`) in a page, so the
 * style model knows which descendant rules (`.rich-text-block p`) belong to a
 * rich-text container before any page is parsed.
 */
export function collectRichTextClasses(html: string, out: Set<string>): void {
  for (const m of html.matchAll(CLASS_ATTR_RE)) {
    const list = (m[1] ?? m[2] ?? '').split(/\s+/).filter(Boolean);
    if (!list.includes('w-richtext')) continue;
    for (const c of list) out.add(c);
  }
}

/**
 * `textStyles` for one rich-text element from its class list (all classes,
 * `w-richtext` included, in document order). Returns `undefined` when no rule
 * touches any of the keys, so a layer without Webflow styling keeps ycode's
 * defaults untouched.
 */
export function richTextStylesFor(model: WfStyleModel, classNames: readonly string[]): Record<string, TextStyle> | undefined {
  const scopes = ['w-richtext', ...classNames.filter((c) => c !== 'w-richtext')];
  const out: Record<string, TextStyle> = {};

  for (const [key, tags] of Object.entries(TEXT_STYLE_TAGS)) {
    const fromRules: string[] = [];
    for (const tag of tags) {
      const underlay = model.tags.get(tag);
      if (underlay) fromRules.push(...underlay.classes);
    }
    for (const scope of scopes) {
      const byTag = model.richTextTags?.get(scope);
      if (!byTag) continue;
      for (const tag of tags) {
        const classes = byTag.get(tag);
        if (classes) fromRules.push(...classes);
      }
    }
    if (fromRules.length === 0) continue;

    const classes = mergePrefixedClasses([...(BASELINE[key] ?? []), ...fromRules]).join(' ');
    if (!classes) continue;
    const entry: TextStyle = { classes };
    const label = LABELS[key];
    if (label) entry.label = label;
    const design = buildDesign(classes);
    if (design) entry.design = design;
    out[key] = entry;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/** Style keys a `.w-richtext` descendant rule can feed (for tests and diagnostics). */
export function textStyleKeyForTag(tag: string): string | undefined {
  if (!RICH_TEXT_TAGS.has(tag)) return undefined;
  for (const [key, tags] of Object.entries(TEXT_STYLE_TAGS)) {
    if (tags.includes(tag)) return key;
  }
  return undefined;
}

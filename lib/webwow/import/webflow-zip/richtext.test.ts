/**
 * Rich-text conversion — the shapes are checked against ycode's own schema
 * (`lib/tiptap-extensions/rich-text-link.ts`, `rich-text-image.ts`) and against
 * what upstream's converter produces for the same fragment, so the two stay
 * interchangeable except where this one is deliberately better (inline marks).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { convertValueForFieldType } from '@/lib/csv-utils';
import { buildStyleModel, type WfStyleModel } from './css';
import { convertRichTextHtml, type TipTapNode } from './richtext';
import { collectRichTextClasses, richTextStylesFor, textStyleKeyForTag } from './richtext-styles';
import { Warnings } from './warnings';

/** A Webflow rich-text field with everything the designer panel can produce. */
const WEBFLOW_RICH_TEXT = `
<h2>Ausstellung</h2>
<p>Ein Text mit <strong>fett</strong>, <em>kursiv</em>, <u>unterstrichen</u>, <s>gestrichen</s>, <code>code</code> und einem <a href="/werke" target="_blank">Link</a>.</p>
<ul role="list"><li>Erstens</li><li>Zweitens mit <strong>Nachdruck</strong></li></ul>
<ol role="list"><li>Eins</li></ol>
<blockquote>Kunst ist eine Wunde, die zu Licht wird.</blockquote>
<figure style="max-width:800px" class="w-richtext-figure-type-image w-richtext-align-center" data-rt-type="image" data-rt-align="center">
  <div><img src="https://cdn.prod.website-files.com/x/atelier.jpg" loading="lazy" alt="Atelier"></div>
  <figcaption>Im Atelier, 2024</figcaption>
</figure>
<p>Nachwort mit <a href="https://example.com"><img src="images/inline.jpg" alt="inline"></a> darin.</p>
<hr>
`;

function find(doc: { content: TipTapNode[] }, type: string): TipTapNode | undefined {
  const stack = [...doc.content];
  while (stack.length > 0) {
    const n = stack.shift()!;
    if (n.type === type) return n;
    if (n.content) stack.push(...n.content);
  }
  return undefined;
}

function marksOf(doc: { content: TipTapNode[] }, text: string): string[] {
  const stack = [...doc.content];
  while (stack.length > 0) {
    const n = stack.shift()!;
    if (n.type === 'text' && n.text === text) return (n.marks ?? []).map((m) => m.type);
    if (n.content) stack.push(...n.content);
  }
  return [];
}

test('inline marks survive — upstream folds them into plain text, this does not', () => {
  const doc = convertRichTextHtml(WEBFLOW_RICH_TEXT);
  assert.ok(doc);
  assert.deepEqual(marksOf(doc, 'fett'), ['bold']);
  assert.deepEqual(marksOf(doc, 'kursiv'), ['italic']);
  assert.deepEqual(marksOf(doc, 'unterstrichen'), ['underline']);
  assert.deepEqual(marksOf(doc, 'gestrichen'), ['strike']);
  assert.deepEqual(marksOf(doc, 'code'), ['code']);
  assert.deepEqual(marksOf(doc, 'Nachdruck'), ['bold'], 'marks inside a list item too');

  // The regression this exists for: upstream's converter loses all of them.
  const upstream = JSON.parse(convertValueForFieldType(WEBFLOW_RICH_TEXT, 'rich_text') as string);
  const upstreamMarks = marksOf(upstream, 'fett');
  assert.deepEqual(upstreamMarks, [], 'if upstream starts keeping marks, this module can be retired');
});

test('links use ycode\'s canonical richTextLink mark shape', () => {
  const doc = convertRichTextHtml(WEBFLOW_RICH_TEXT)!;
  const stack = [...doc.content];
  let linkNode: TipTapNode | undefined;
  while (stack.length > 0) {
    const n = stack.shift()!;
    if (n.marks?.some((m) => m.type === 'richTextLink')) { linkNode = n; break; }
    if (n.content) stack.push(...n.content);
  }
  assert.ok(linkNode, 'no linked text node');
  assert.equal(linkNode.text, 'Link');
  assert.deepEqual(linkNode.marks![0], {
    type: 'richTextLink',
    attrs: { type: 'url', url: { type: 'dynamic_text', data: { content: '/werke' } }, target: '_blank' },
  });
});

test('images are richTextImage blocks, not `image` nodes, and keep an assetId slot', () => {
  const doc = convertRichTextHtml(WEBFLOW_RICH_TEXT)!;
  const img = find(doc, 'richTextImage');
  assert.ok(img);
  assert.equal(img.attrs!.src, 'https://cdn.prod.website-files.com/x/atelier.jpg');
  assert.equal(img.attrs!.alt, 'Atelier');
  assert.equal(img.attrs!.assetId, null, 'the slot lib/asset-utils.ts re-wires must exist');
  assert.equal(img.attrs!.link, null);

  // The figcaption becomes the paragraph that follows the image.
  const i = doc.content.findIndex((n) => n.type === 'richTextImage');
  assert.equal(doc.content[i + 1].type, 'paragraph');
  assert.equal(doc.content[i + 1].content![0].text, 'Im Atelier, 2024');
});

test('an <img> inside a paragraph is lifted out as a sibling block, with its link', () => {
  const doc = convertRichTextHtml('<p>Vor <a href="https://example.com"><img src="images/inline.jpg" alt="inline"></a> nach.</p>')!;
  assert.deepEqual(doc.content.map((n) => n.type), ['paragraph', 'richTextImage']);
  const img = doc.content[1];
  assert.equal(img.attrs!.src, 'images/inline.jpg');
  assert.deepEqual(img.attrs!.link, { type: 'url', url: { type: 'dynamic_text', data: { content: 'https://example.com' } }, target: undefined });
  assert.equal(doc.content[0].content!.map((n) => n.text).join(''), 'Vor  nach.');
});

test('block structure matches ycode\'s node names', () => {
  const doc = convertRichTextHtml(WEBFLOW_RICH_TEXT)!;
  assert.deepEqual(doc.content.map((n) => n.type), [
    'heading', 'paragraph', 'bulletList', 'orderedList', 'blockquote',
    'richTextImage', 'paragraph', 'paragraph', 'richTextImage', 'horizontalRule',
  ]);
  assert.equal(doc.content[0].attrs!.level, 2);
  assert.equal(doc.content[2].content!.length, 2);
  assert.equal(doc.content[2].content![0].type, 'listItem');
  assert.equal(doc.content[2].content![0].content![0].type, 'paragraph');
  assert.equal(doc.content[4].content![0].type, 'paragraph');
});

test('entities, <br> and nested marks', () => {
  const doc = convertRichTextHtml('<p>A&nbsp;&amp;&nbsp;B<br><strong><em>beides</em></strong></p>')!;
  const para = doc.content[0];
  assert.equal(para.content![0].text, 'A & B');
  assert.equal(para.content![1].type, 'hardBreak');
  assert.deepEqual(para.content![2].marks!.map((m) => m.type), ['bold', 'italic']);
});

test('nothing convertible -> null, so the caller can fall back to upstream', () => {
  assert.equal(convertRichTextHtml(''), null);
  assert.equal(convertRichTextHtml('   '), null);
  assert.equal(convertRichTextHtml('<p></p>'), null);
  assert.equal(convertRichTextHtml('<script>alert(1)</script>'), null);
});

test('plain text without tags still becomes a paragraph', () => {
  const doc = convertRichTextHtml('Nur Text')!;
  assert.deepEqual(doc, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nur Text' }] }] });
});

test('every paragraph stays its own paragraph node, so per-block margins apply', () => {
  const doc = convertRichTextHtml('<p>Samstag 28. Februar</p>\n<p>Sonntag 1. März</p><p></p><p>Ende</p>')!;
  assert.deepEqual(doc.content.map((n) => n.type), ['paragraph', 'paragraph', 'paragraph']);
  assert.deepEqual(doc.content.map((n) => n.content![0].text), ['Samstag 28. Februar', 'Sonntag 1. März', 'Ende']);
  // Upstream's converter (CMS rich_text values) keeps them apart as well.
  const upstream = JSON.parse(convertValueForFieldType('<p>A</p><p>B</p>', 'rich_text')!);
  assert.deepEqual(upstream.content.map((n: TipTapNode) => n.type), ['paragraph', 'paragraph']);
});

// ─── textStyles from the stylesheet (richtext-styles.ts) ──────────────────────

function styleModel(siteCss: string, frameworkCss: string, richTextClasses: string[] = []): WfStyleModel {
  return buildStyleModel({ siteCss: [siteCss], frameworkCss: [frameworkCss], richTextClasses, assetUrl: () => null, warn: new Warnings() });
}

const WEBFLOW_TAG_RULES = `
  b, strong { font-weight: bold }
  h1, h2, h3, h4, h5, h6 { font-weight: bold; margin-bottom: 10px }
  h2 { font-size: 32px; line-height: 36px; margin-top: 20px }
  p { margin-top: 0; margin-bottom: 10px }
  blockquote { margin: 0 0 10px 0; padding: 10px 20px; border-left: 5px solid #E2E2E2; font-size: 18px; line-height: 22px }
  figure { margin: 0; margin-bottom: 10px }
  ul, ol { margin-top: 0px; margin-bottom: 10px; padding-left: 40px }
  img { max-width: 100%; display: inline-block }
  .w-richtext ol, .w-richtext ul { overflow: hidden }
  .w-richtext figure { position: relative; max-width: 60% }
  .w-richtext figure img { width: 100% }
`;

test('richTextStylesFor maps tag and .w-richtext rules onto ycode\'s text-style keys with design data', () => {
  const model = styleModel('p { margin-bottom: 10px } a { color: #000 }', WEBFLOW_TAG_RULES);
  const styles = richTextStylesFor(model, ['rich-text-block', 'w-richtext'])!;

  assert.equal(styles.paragraph.classes, 'mt-[0] mb-[10px]');
  assert.deepEqual(styles.paragraph.design, { spacing: { isActive: true, marginTop: '0', marginBottom: '10px' } });
  assert.equal(styles.paragraph.label, 'Paragraph');

  assert.equal(styles.h2.classes, 'font-[700] mb-[10px] text-[32px] leading-[36px] mt-[20px]');
  assert.equal(styles.h2.design?.typography?.fontSize, '32px');
  assert.equal(styles.h2.design?.typography?.fontWeight, '700');
  assert.equal(styles.h2.design?.spacing?.marginTop, '20px');
  assert.equal(styles.h1.classes, 'font-[700] mb-[10px]', 'the group rule alone');

  assert.equal(styles.bulletList.classes, 'list-disc mt-[0px] mb-[10px] pl-[40px] overflow-hidden', 'list marker baseline + tag rule + .w-richtext rule');
  assert.equal(styles.orderedList.classes, 'list-decimal mt-[0px] mb-[10px] pl-[40px] overflow-hidden');
  assert.equal(styles.bulletList.design?.spacing?.paddingLeft, '40px');

  assert.equal(styles.link.classes, 'underline text-[#000]', 'browser underline stays, colour from the site rule');
  assert.equal(styles.link.design?.typography?.color, '#000');
  assert.equal(styles.bold.classes, 'font-[700]');
  assert.equal(styles.italic, undefined, 'no rule touches <em>, so ycode\'s default stays');
  assert.equal(styles.listItem, undefined);

  assert.ok(styles.blockquote.classes!.includes('pl-[20px]'));
  assert.equal(styles.blockquote.design?.spacing?.paddingLeft, '20px');
  assert.equal(styles.blockquote.design?.typography?.fontSize, '18px');

  // The image carries the figure box: ycode renders it without a <figure>.
  assert.equal(styles.richTextImage.classes, 'inline-block m-[0] mb-[10px] w-full relative max-w-[60%]');
  assert.equal(styles.richTextImage.design?.sizing?.maxWidth, '60%');
  assert.equal(styles.richTextImage.design?.spacing?.marginBottom, '10px');

  // Nothing about the container: spacing comes from the margins, never from a gap.
  for (const entry of Object.values(styles)) assert.ok(!/(^|\s)gap-/.test(entry.classes ?? ''));
});

test('richTextStylesFor: the element\'s own classes win over .w-richtext and the tag rules, in class order', () => {
  const model = styleModel(
    'p { margin-bottom: 10px } .rich-text-block p { margin-bottom: 24px; font-size: 18px } .rich-text-block h2 { font-size: 40px } .article p { margin-bottom: 32px }',
    WEBFLOW_TAG_RULES,
    ['rich-text-block', 'article'],
  );
  const one = richTextStylesFor(model, ['rich-text-block', 'w-richtext'])!;
  assert.equal(one.paragraph.classes, 'mt-[0] mb-[24px] text-[18px]');
  assert.equal(one.h2.classes, 'font-[700] mb-[10px] leading-[36px] mt-[20px] text-[40px]');

  const two = richTextStylesFor(model, ['rich-text-block', 'article', 'w-richtext'])!;
  assert.equal(two.paragraph.classes, 'mt-[0] text-[18px] mb-[32px]', 'later class wins');
  assert.equal(two.paragraph.design?.spacing?.marginBottom, '32px');

  const other = richTextStylesFor(model, ['w-richtext'])!;
  assert.equal(other.paragraph.classes, 'mt-[0] mb-[10px]', 'a rich text without the class keeps the tag rule');
});

test('richTextStylesFor returns undefined without any rule, and collectRichTextClasses finds the container classes', () => {
  assert.equal(richTextStylesFor(styleModel('.hero { padding: 10px }', ''), ['w-richtext']), undefined);
  const found = new Set<string>();
  collectRichTextClasses('<div class="rich-text-block w-richtext"><p>x</p></div><div class="text-block"></div><div class=\'article w-richtext w-dyn-bind-empty\'></div>', found);
  assert.deepEqual([...found].sort(), ['article', 'rich-text-block', 'w-dyn-bind-empty', 'w-richtext']);
  assert.equal(textStyleKeyForTag('figure'), 'richTextImage');
  assert.equal(textStyleKeyForTag('strong'), 'bold');
  assert.equal(textStyleKeyForTag('div'), undefined);
});

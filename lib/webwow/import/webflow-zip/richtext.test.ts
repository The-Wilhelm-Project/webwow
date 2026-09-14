/**
 * Rich-text conversion — the shapes are checked against ycode's own schema
 * (`lib/tiptap-extensions/rich-text-link.ts`, `rich-text-image.ts`) and against
 * what upstream's converter produces for the same fragment, so the two stay
 * interchangeable except where this one is deliberately better (inline marks).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { convertValueForFieldType } from '@/lib/csv-utils';
import { convertRichTextHtml, type TipTapNode } from './richtext';

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

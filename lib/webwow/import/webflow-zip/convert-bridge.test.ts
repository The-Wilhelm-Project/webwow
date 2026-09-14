import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ImportConverter } from '@/lib/import/convert';
import { MULTI_ASSET_COLLECTION_ID } from '@/lib/collection-field-utils';

import { applyNodeLayerPostProcessing, convertPage, dropShadowedClasses, pinBackgroundBindingClasses, resolveShadowedChipClasses } from './convert-bridge';
import { mergeClassStack, resolveLayerClasses } from '@/lib/layer-style-resolve';

import { parsePage, type HtmlContext } from './html';
import { Warnings } from './warnings';
import type { WfStyleModel } from './css';
import type { WfNode, WfPage } from './types';
import type { WfZipBundle, WfZipFile } from './zip';

import type { ImportMaterializer } from '@/lib/import/materializer';
import type { Component, ComponentVariable, Layer, LayerStyle } from '@/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function emptyStyles(): WfStyleModel {
  return {
    classes: new Map(),
    combos: new Map(),
    ids: new Map(),
    tags: new Map(),
    residual: { rules: [], classNames: new Set(), ids: new Set() },
    residualCss: '',
    fontFaces: [],
    fontFamilies: [],
    boundBackgroundKeys: new Set(),
  };
}

function fakeFile(p: string): WfZipFile {
  const buf = Buffer.from('');
  return { path: p, size: 0, data: async () => buf, text: async () => '' };
}

function fakeZip(paths: string[]): WfZipBundle {
  return {
    root: '',
    pages: new Map(),
    errorPages: new Map(),
    css: { site: [] },
    js: [],
    files: new Map(paths.map((p) => [p, fakeFile(p)])),
    missing: [],
    skipped: [],
  };
}

function ctxFor(zip: WfZipBundle, page = 'index'): HtmlContext {
  return {
    page,
    styles: emptyStyles(),
    zip,
    pageNames: new Set(['index', 'work', 'detail_werke']),
    assetKey: (p) => (zip.files.has(p) ? p : null),
    warn: new Warnings(),
  };
}

function doc(body: string): string {
  return `<!DOCTYPE html><html data-wf-page="abc" lang="de"><head><title>T</title></head><body class="body">${body}</body></html>`;
}

/** Materializer stub: no styles (so classes stay inline), assets resolved by key. */
class StubMaterializer {
  readonly components: { name: string; layers: Layer[] }[] = [];
  constructor(private readonly assets: Record<string, string> = {}) {}
  async getOrCreateStyle(): Promise<null> {
    return null;
  }
  async prepareStyles(): Promise<void> {}
  async uploadAsset(key: string): Promise<string | null> {
    return this.assets[key] ?? null;
  }
  async createComponent(name: string, layers: Layer[], _variables?: ComponentVariable[]): Promise<Component | null> {
    this.components.push({ name, layers });
    return { id: `cmp-${this.components.length}`, name, layers, is_published: false } as Component;
  }
}

function converterFor(assets: Record<string, string> = {}): ImportConverter {
  return new ImportConverter(new StubMaterializer(assets) as unknown as ImportMaterializer);
}

function allNodes(page: WfPage): WfNode[] {
  return [...page.nodeIndex.values()];
}

function classSet(layer: Layer): Set<string> {
  const str = Array.isArray(layer.classes) ? layer.classes.join(' ') : layer.classes ?? '';
  return new Set(str.split(/\s+/).filter(Boolean));
}

function nodeOf(page: WfPage, predicate: (n: WfNode) => boolean): WfNode {
  const hit = allNodes(page).find(predicate);
  assert.ok(hit, 'fixture node not found');
  return hit;
}

const noAssets = { idOf: () => null };

// ─── Mapping ──────────────────────────────────────────────────────────────────

test('every parsed node maps to a layer and the friendly customName is restored', async () => {
  const page = parsePage(doc(`
    <section class="section hero">
      <h1 class="title">Valeska</h1>
      <div class="wrapper"><p class="copy">Text</p></div>
    </section>
  `), ctxFor(fakeZip([])));

  const { roots, layerByNode } = await convertPage(page, converterFor());

  assert.equal(roots.length, 1);
  for (const node of allNodes(page)) {
    assert.ok(layerByNode.has(node.wf.id), `no layer for ${node.wf.id} (${node.wf.tag})`);
  }

  // The carrier is gone: no customName still ends in a node id.
  for (const layer of layerByNode.values()) {
    assert.ok(!/ \w+#\d+$/.test(layer.customName ?? ''), `carrier left on ${layer.customName}`);
  }

  const wrapper = layerByNode.get(nodeOf(page, (n) => n.wf.siteClasses[0] === 'wrapper').wf.id)!;
  assert.equal(wrapper.name, 'div');
  assert.equal(wrapper.customName, 'wrapper');
  const heading = layerByNode.get(nodeOf(page, (n) => n.wf.tag === 'h1').wf.id)!;
  assert.equal(heading.name, 'heading');
  assert.equal(heading.customName, 'title');
});

test('a friendly name identical to the layer name is dropped rather than duplicated', async () => {
  const page = parsePage(doc('<div class="div"><p class="copy">a</p></div>'), ctxFor(fakeZip([])));
  const { layerByNode } = await convertPage(page, converterFor());
  const div = layerByNode.get(nodeOf(page, (n) => n.wf.siteClasses[0] === 'div').wf.id)!;
  assert.equal(div.name, 'div');
  assert.equal(div.customName, undefined);
});

// ─── Layer kinds ──────────────────────────────────────────────────────────────

test('html embeds, rich text, iframes and hr become their own layer kinds', async () => {
  const page = parsePage(doc(`
    <div class="embed w-embed w-script"><script>console.log(1)</script></div>
    <div class="rich w-richtext"><h2>Head</h2><p>Body</p></div>
    <iframe class="frame" src="https://player.vimeo.com/video/1"></iframe>
    <hr class="rule">
  `), ctxFor(fakeZip([])));

  const { layerByNode } = await convertPage(page, converterFor());
  applyNodeLayerPostProcessing(page, layerByNode, noAssets);

  const embed = layerByNode.get(nodeOf(page, (n) => n.wf.layerKind === 'htmlEmbed').wf.id)!;
  assert.equal(embed.name, 'htmlEmbed');
  assert.match(embed.settings?.htmlEmbed?.code ?? '', /console\.log/);
  assert.equal(embed.children, undefined);

  const rich = layerByNode.get(nodeOf(page, (n) => n.wf.layerKind === 'richText').wf.id)!;
  assert.equal(rich.name, 'richText');
  assert.equal(rich.restrictions?.editText, true);
  const doc1 = (rich.variables?.text as { data: { content: { type: string; content: unknown[] } } }).data.content;
  assert.equal(doc1.type, 'doc');
  assert.ok(doc1.content.length > 0);

  const iframe = layerByNode.get(nodeOf(page, (n) => n.wf.layerKind === 'iframe').wf.id)!;
  assert.equal(iframe.name, 'iframe');
  assert.deepEqual(iframe.variables?.iframe, { src: { type: 'dynamic_text', data: { content: 'https://player.vimeo.com/video/1' } } });

  const hr = layerByNode.get(nodeOf(page, (n) => n.wf.layerKind === 'hr').wf.id)!;
  assert.equal(hr.name, 'hr');
  assert.equal(hr.children, undefined);
});

test('an empty rich-text slot becomes an empty doc, not the placeholder markup', async () => {
  const page = parsePage(doc('<div class="rich w-richtext w-dyn-bind-empty"><p>placeholder</p></div>'), ctxFor(fakeZip([])));
  const { layerByNode } = await convertPage(page, converterFor());
  applyNodeLayerPostProcessing(page, layerByNode, noAssets);
  const rich = layerByNode.get(nodeOf(page, (n) => n.wf.layerKind === 'richText').wf.id)!;
  assert.deepEqual((rich.variables?.text as { data: { content: unknown } }).data.content, { type: 'doc', content: [{ type: 'paragraph' }] });
});

test('a background video becomes a muted autoplay video child inside the wrapper', async () => {
  const zip = fakeZip(['videos/clip.mp4', 'images/poster.jpg']);
  const page = parsePage(doc(`
    <div class="bg w-background-video" data-poster-url="images/poster.jpg" data-video-urls="videos/clip.mp4" data-autoplay="true" data-loop="true">
      <video></video>
    </div>
  `), ctxFor(zip));

  const { layerByNode } = await convertPage(page, converterFor());
  applyNodeLayerPostProcessing(page, layerByNode, { idOf: (key) => ({ 'videos/clip.mp4': 'asset-video', 'images/poster.jpg': 'asset-poster' } as Record<string, string>)[key] ?? null });

  const wrapper = layerByNode.get(nodeOf(page, (n) => n.wf.layerKind === 'video').wf.id)!;
  assert.equal(wrapper.children?.length, 1);
  const video = wrapper.children![0];
  assert.equal(video.name, 'video');
  assert.deepEqual(video.attributes, { autoplay: true, muted: true, loop: true, controls: false, preload: 'metadata' });
  assert.deepEqual(video.variables?.video?.src, { type: 'asset', data: { asset_id: 'asset-video' } });
  assert.deepEqual(video.variables?.video?.poster, { type: 'asset', data: { asset_id: 'asset-poster' } });
  assert.ok(classSet(video).has('object-cover'));
  assert.ok(video.design?.positioning, 'the generated video layer carries design data');
});

test('only one background video source survives and the dropped webm is reported', async () => {
  const zip = fakeZip(['videos/clip.mp4', 'videos/clip.webm']);
  const page = parsePage(doc(`
    <div class="bg w-background-video" data-video-urls="videos/clip.mp4,videos/clip.webm" data-autoplay="true" data-loop="true">
      <video></video>
    </div>
  `), ctxFor(zip));

  const warn = new Warnings();
  const ids: Record<string, string> = { 'videos/clip.mp4': 'asset-mp4', 'videos/clip.webm': 'asset-webm' };
  const { layerByNode } = await convertPage(page, converterFor());
  applyNodeLayerPostProcessing(page, layerByNode, { idOf: (key) => ids[key] ?? null }, warn);

  const wrapper = layerByNode.get(nodeOf(page, (n) => n.wf.layerKind === 'video').wf.id)!;
  assert.deepEqual(wrapper.children![0].variables?.video?.src, { type: 'asset', data: { asset_id: 'asset-mp4' } });
  const dropped = warn.list.filter((w) => w.code === 'embed_dropped' && w.message.includes('clip.webm'));
  assert.equal(dropped.length, 1, 'the dropped alternative source is warned about');
  assert.ok(dropped[0].message.includes('videos/clip.mp4'), 'the warning names the source that was kept');
});

test('a non-Webflow element id becomes settings.id, a w-node grid id does not', async () => {
  const page = parsePage(doc('<div class="a" id="contact"></div><div class="b" id="w-node-abc-1"></div>'), ctxFor(fakeZip([])));
  const { layerByNode } = await convertPage(page, converterFor());
  applyNodeLayerPostProcessing(page, layerByNode, noAssets);
  const anchor = layerByNode.get(nodeOf(page, (n) => n.wf.htmlId === 'contact').wf.id)!;
  assert.equal(anchor.settings?.id, 'contact');
  const grid = layerByNode.get(nodeOf(page, (n) => n.wf.htmlId === 'w-node-abc-1').wf.id)!;
  assert.equal(grid.settings?.id, undefined);
});

// ─── CMS binding shapes (findings-cms §4.1/§4.2) ──────────────────────────────

test('a bound Werke item produces the documented collection / field / link shapes', async () => {
  const page = parsePage(doc(`
    <div class="collection-list-wrapper w-dyn-list">
      <div class="collection-list w-dyn-items">
        <div class="collection-item w-dyn-item">
          <a href="#" class="div-block-2 w-inline-block">
            <div class="div-block"></div>
          </a>
          <div class="div-block-6"><div class="w-dyn-bind-empty"></div></div>
        </div>
      </div>
    </div>
  `), ctxFor(fakeZip([])));

  const item = nodeOf(page, (n) => n.wf.role === 'dyn-item');
  const link = nodeOf(page, (n) => n.kind === 'link');
  const bg = nodeOf(page, (n) => n.wf.siteClasses[0] === 'div-block');
  const title = nodeOf(page, (n) => n.wf.bindEmpty && n.wf.siteClasses.length === 0);

  item.wf.collection = {
    collectionId: 'col-werke',
    sortBy: 'field-order',
    sortOrder: 'asc',
    filters: [{ fieldId: 'field-feature', fieldType: 'boolean', value: 'true' }],
    confidence: 0.9,
    reason: 'test',
  };
  link.wf.binding = {
    kind: 'link', fieldId: 'field-slug', fieldType: 'text', fieldName: 'Slug', source: 'collection',
    collectionNodeId: item.wf.id, link: { pageId: 'page-werke', collectionItemId: 'current-collection' },
    confidence: 0.9, reason: 'test',
  };
  bg.wf.binding = {
    kind: 'background', fieldId: 'field-werk', fieldType: 'image', fieldName: 'Werk', source: 'collection',
    collectionNodeId: item.wf.id, confidence: 0.9, reason: 'test',
  };
  title.wf.binding = {
    kind: 'text', fieldId: 'field-name', fieldType: 'text', fieldName: 'Name', source: 'collection',
    collectionNodeId: item.wf.id, confidence: 0.9, reason: 'test',
  };

  const { layerByNode } = await convertPage(page, converterFor());
  applyNodeLayerPostProcessing(page, layerByNode, noAssets);

  const itemLayer = layerByNode.get(item.wf.id)!;
  assert.deepEqual(itemLayer.variables?.collection, {
    id: 'col-werke',
    sort_by: 'field-order',
    sort_order: 'asc',
    filters: {
      groups: [{ id: 'vc-g-1', conditions: [{ id: 'vc-1', source: 'collection_field', fieldId: 'field-feature', fieldType: 'boolean', operator: 'is', value: 'true' }] }],
    },
  });

  const linkLayer = layerByNode.get(link.wf.id)!;
  assert.deepEqual(linkLayer.variables?.link, { type: 'page', page: { id: 'page-werke', collection_item_id: 'current-collection' } });

  const bgLayer = layerByNode.get(bg.wf.id)!;
  const bgClasses = classSet(bgLayer);
  for (const c of ['bg-cover', 'bg-center', 'bg-no-repeat', 'bg-[image:var(--bg-img)]']) assert.ok(bgClasses.has(c), `missing ${c}`);
  assert.deepEqual(bgLayer.design?.backgrounds, {
    isActive: true, backgroundImage: '--bg-img', backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat',
  });
  assert.deepEqual(bgLayer.variables?.backgroundImage, {
    src: { type: 'field', data: { field_id: 'field-werk', field_type: 'image', relationships: [], source: 'collection', collection_layer_id: itemLayer.id } },
  });

  const titleLayer = layerByNode.get(title.wf.id)!;
  assert.deepEqual((titleLayer.variables?.text as { data: { content: unknown } }).data.content, {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{
        type: 'dynamicVariable',
        attrs: {
          variable: { type: 'field', data: { field_id: 'field-name', field_type: 'text', relationships: [], source: 'collection', collection_layer_id: itemLayer.id } },
          label: 'Name',
        },
      }],
    }],
  });
});

test('a page-source image binding carries no collection_layer_id and a date carries its format', async () => {
  const page = parsePage(doc('<img class="image-7 w-dyn-bind-empty" alt=""><div class="thin w-dyn-bind-empty"></div>'), ctxFor(fakeZip([])));
  const image = nodeOf(page, (n) => n.kind === 'image');
  const date = nodeOf(page, (n) => n.wf.siteClasses[0] === 'thin');

  image.wf.binding = { kind: 'image', fieldId: 'field-werk', fieldType: 'image', fieldName: 'Werk', source: 'page', confidence: 0.9, reason: 'test' };
  date.wf.binding = { kind: 'text', fieldId: 'field-datum', fieldType: 'date', fieldName: 'Datum', source: 'page', format: 'part-year', confidence: 0.9, reason: 'test' };

  const { layerByNode } = await convertPage(page, converterFor());
  applyNodeLayerPostProcessing(page, layerByNode, noAssets);

  assert.deepEqual(layerByNode.get(image.wf.id)!.variables?.image, {
    src: { type: 'field', data: { field_id: 'field-werk', field_type: 'image', relationships: [], source: 'page' } },
    alt: { type: 'dynamic_text', data: { content: '' } },
  });

  const dateDoc = (layerByNode.get(date.wf.id)!.variables?.text as { data: { content: { content: { content: { attrs: { variable: { data: Record<string, unknown> } } }[] }[] } } }).data.content;
  assert.deepEqual(dateDoc.content[0].content[0].attrs.variable.data, {
    field_id: 'field-datum', field_type: 'date', relationships: [], source: 'page', format: 'part-year',
  });
});

test('a nested multi-image list becomes a __multi_asset__ collection whose image binds __asset_url', async () => {
  const page = parsePage(doc(`
    <div class="collection-list-wrapper w-dyn-list">
      <div class="collection-list w-dyn-items">
        <div class="collection-item w-dyn-item">
          <img class="w-dyn-bind-empty" alt="">
        </div>
      </div>
    </div>
  `), ctxFor(fakeZip([])));

  const nested = nodeOf(page, (n) => n.wf.role === 'dyn-item');
  const image = nodeOf(page, (n) => n.kind === 'image');
  nested.wf.collection = {
    collectionId: MULTI_ASSET_COLLECTION_ID,
    multiAsset: { fieldId: 'field-images', source: 'collection', parentCollectionNodeId: 'index#1' },
    confidence: 0.8,
    reason: 'test',
  };
  image.wf.binding = {
    kind: 'image', fieldId: '__asset_url', fieldType: 'image', fieldName: 'images', source: 'collection',
    collectionNodeId: nested.wf.id, confidence: 0.8, reason: 'test',
  };

  const { layerByNode } = await convertPage(page, converterFor());
  applyNodeLayerPostProcessing(page, layerByNode, noAssets);

  const nestedLayer = layerByNode.get(nested.wf.id)!;
  assert.deepEqual(nestedLayer.variables?.collection, {
    id: MULTI_ASSET_COLLECTION_ID,
    source_field_id: 'field-images',
    source_field_type: 'multi_asset',
    source_field_source: 'collection',
  });
  assert.deepEqual(layerByNode.get(image.wf.id)!.variables?.image?.src, {
    type: 'field',
    data: { field_id: '__asset_url', field_type: 'image', relationships: [], source: 'collection', collection_layer_id: nestedLayer.id },
  });
});

// ─── Shadowed classes ─────────────────────────────────────────────────────────

test('a combo background evicts its base background (upstream merge misses this)', () => {
  const base = 'bg-[linear-gradient(#00000080,#00000080),url(/s/base.webp)]';
  const combo = 'bg-[linear-gradient(#0000005c,#0000005c),url(/s/combo.webp)]';
  assert.equal(
    dropShadowedClasses(`${base} justify-start items-center h-[30vw] ${combo}`),
    `justify-start items-center h-[30vw] ${combo}`,
  );
});

test('classes that affect different properties all survive', () => {
  const input = 'text-[24px] text-[#fff] bg-[#000] bg-[url(/s/x.webp)] p-[10px] pt-[4px]';
  assert.equal(dropShadowedClasses(input), input);
});

test('breakpoint and state variants are independent of the main class', () => {
  const input = 'h-[30vw] max-lg:h-[40vw] max-md:h-[50vw] hover:h-[60vw]';
  assert.equal(dropShadowedClasses(input), input);
  assert.equal(dropShadowedClasses('h-[30vw] h-[10vw] max-lg:h-[40vw] max-lg:h-[20vw]'), 'h-[10vw] max-lg:h-[20vw]');
});

test('unmapped one-off classes are never dropped', () => {
  assert.equal(dropShadowedClasses('wf-topheader wf-artist flex'), 'wf-topheader wf-artist flex');
});

test('resolveShadowedChipClasses moves the fix into a per-chip override so publishing keeps it', () => {
  const base = 'bg-[linear-gradient(#00000080,#00000080),url(/s/base.webp)] h-[30vw] p-[100px]';
  const combo = 'bg-[linear-gradient(#0000005c,#0000005c),url(/s/combo.webp)]';
  const styles = new Map([['sty-base', base], ['sty-combo', combo]]);
  const layer: Layer = {
    id: 'lyr-1',
    name: 'div',
    classes: mergeClassStack([...base.split(' '), ...combo.split(' ')]).join(' '),
    styleIds: ['sty-base', 'sty-combo'],
  };

  assert.equal(resolveShadowedChipClasses([layer], (id) => styles.get(id)), 1);

  // The shared base style keeps its background; only this layer's chip drops it.
  assert.equal(styles.get('sty-base'), base);
  assert.equal(layer.styleOverridesByStyle?.['sty-base']?.classes, 'h-[30vw] p-[100px]');
  assert.equal(layer.styleOverridesByStyle?.['sty-combo'], undefined);

  // What publishing re-flattens from the chips is what the import persisted.
  assert.equal(resolveLayerClasses(layer, (id) => ({ id, name: id, classes: styles.get(id)!, is_published: false } as LayerStyle)), layer.classes);
  assert.equal(layer.classes.includes('#00000080'), false);
  assert.equal(layer.design?.backgrounds?.backgroundColor?.includes('#0000005c'), true);
});

test('a CMS-bound background keeps its classes through a chip re-flatten', () => {
  const base = '[background-position:50%] [background-size:cover] flex';
  const combo = 'aspect-[2/3] mix-blend-multiply';
  const styles = new Map([['sty-base', base], ['sty-combo', combo]]);
  const layer: Layer = {
    id: 'lyr-bg',
    name: 'div',
    classes: mergeClassStack([...base.split(' '), ...combo.split(' ')]).join(' '),
    styleIds: ['sty-base', 'sty-combo'],
    variables: { backgroundImage: { src: { type: 'field', data: { field_id: 'f1', field_type: 'image', relationships: [], source: 'collection' } } } } as Layer['variables'],
  };

  assert.equal(pinBackgroundBindingClasses([layer], (id) => styles.get(id)), 1);
  assert.ok(layer.classes.includes('bg-[image:var(--bg-img)]'), 'the layer consumes --bg-img');
  // The shared style rows stay untouched — only this layer's top chip is overridden.
  assert.equal(styles.get('sty-combo'), combo);
  assert.ok(layer.styleOverridesByStyle?.['sty-combo']?.classes?.includes('bg-[image:var(--bg-img)]'));

  // What publishing re-flattens from the chips still carries the four classes.
  const reflattened = resolveLayerClasses(layer, (id) => ({ id, name: id, classes: styles.get(id)!, is_published: false } as LayerStyle));
  for (const cls of ['bg-cover', 'bg-center', 'bg-no-repeat', 'bg-[image:var(--bg-img)]']) {
    assert.ok(reflattened.includes(cls), `${cls} survives the re-flatten`);
  }
  assert.equal(layer.design?.backgrounds?.backgroundImage, '--bg-img');
});

test('a background-bound layer without a style chip keeps the classes inline', () => {
  const layer: Layer = {
    id: 'lyr-bg2',
    name: 'div',
    classes: 'flex',
    variables: { backgroundImage: { src: { type: 'field', data: { field_id: 'f1', field_type: 'image', relationships: [], source: 'collection' } } } } as Layer['variables'],
  };
  assert.equal(pinBackgroundBindingClasses([layer], () => undefined), 1);
  assert.ok(layer.classes.includes('bg-[image:var(--bg-img)]'));
  assert.equal(layer.styleOverridesByStyle, undefined);
});

test('a stack upstream already resolves gets no override', () => {
  const styles = new Map([['sty-base', 'p-[100px] flex'], ['sty-combo', 'p-[25px]']]);
  const layer: Layer = { id: 'lyr-2', name: 'div', classes: 'flex p-[25px]', styleIds: ['sty-base', 'sty-combo'] };
  assert.equal(resolveShadowedChipClasses([layer], (id) => styles.get(id)), 0);
  assert.equal(layer.styleOverridesByStyle, undefined);
});

test('an arbitrary-property class is overridden by a later one for the same property', () => {
  assert.equal(
    dropShadowedClasses('[background-position:0_0,0_30%] [background-size:auto,cover] [background-position:0_0,0%]'),
    '[background-size:auto,cover] [background-position:0_0,0%]',
  );
  // different properties, and different breakpoints, stay untouched
  assert.equal(
    dropShadowedClasses('[inset:0] max-lg:[inset:4px] [border-top:1px_#000]'),
    '[inset:0] max-lg:[inset:4px] [border-top:1px_#000]',
  );
});

test('a w-node grid id survives when the residual stylesheet still selects it', () => {
  const keep: WfNode = { kind: 'box', tag: 'div', wf: { id: 'p#1', page: 'artist', tag: 'div', classNames: [], siteClasses: [], attrs: {}, bindEmpty: false, htmlId: 'w-node-abc', keepHtmlId: true } };
  const drop: WfNode = { kind: 'box', tag: 'div', wf: { id: 'p#2', page: 'artist', tag: 'div', classNames: [], siteClasses: [], attrs: {}, bindEmpty: false, htmlId: 'w-node-def' } };
  const anchor: WfNode = { kind: 'box', tag: 'div', wf: { id: 'p#3', page: 'artist', tag: 'div', classNames: [], siteClasses: [], attrs: {}, bindEmpty: false, htmlId: 'contact' } };
  const page = { name: 'artist', title: '', description: '', lang: 'en', bodyClassNames: [], roots: [keep, drop, anchor], nodeIndex: new Map([['p#1', keep], ['p#2', drop], ['p#3', anchor]]), headStyles: [], bodyScripts: [], isEmpty: false } as WfPage;
  const layers = new Map<string, Layer>([
    ['p#1', { id: 'l1', name: 'div', classes: '' }],
    ['p#2', { id: 'l2', name: 'div', classes: '' }],
    ['p#3', { id: 'l3', name: 'div', classes: '' }],
  ]);

  applyNodeLayerPostProcessing(page, layers, { idOf: () => null });

  assert.equal(layers.get('p#1')!.settings?.id, 'w-node-abc');
  assert.equal(layers.get('p#2')!.settings?.id, undefined);
  assert.equal(layers.get('p#3')!.settings?.id, 'contact');
});

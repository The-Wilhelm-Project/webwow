/**
 * Extra widget builders (widgets-extra.ts): every Webflow widget of SPEC part C
 * from a verbatim export markup string to the ycode layer shape it must become.
 * Same pipeline order as `index.ts`: parse -> convert -> post-process.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ImportConverter } from '@/lib/import/convert';

import { extractCrossPageComponents, type PageLayers } from './components';
import { applyNodeLayerPostProcessing, convertPage } from './convert-bridge';
import { parsePage, type HtmlContext } from './html';
import { Warnings } from './warnings';
import {
  BG_VIDEO_TOGGLE_SCRIPT,
  LOTTIE_PLAYER_SCRIPT,
  aspectClass,
  inlineStyleClasses,
  lottieEmbedCode,
  parsePaginationInfo,
  planConditionalVisibility,
  planEmbedVideo,
  planMap,
  sizeFromClasses,
  variantNameFromClasses,
} from './widgets-extra';
import { resolveWidgetFlags } from './widgets-native';

import type { WfCollectionInfo } from './cms';
import type { WfStyleModel } from './css';
import type { WfNode, WfPage } from './types';
import type { WfZipBundle, WfZipFile } from './zip';
import type { ImportMaterializer } from '@/lib/import/materializer';
import type { Component, ComponentVariant, Layer } from '@/types';

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
    states: new Map(),
    resting: new Map(),
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

function ctxFor(zip: WfZipBundle, overrides: Partial<HtmlContext> = {}): HtmlContext & { warn: Warnings } {
  const warn = new Warnings();
  return {
    page: 'index',
    styles: emptyStyles(),
    zip,
    pageNames: new Set(['index', 'search']),
    assetKey: (p) => (zip.files.has(p) ? p : null),
    warn,
    ...overrides,
  };
}

function doc(body: string): string {
  return `<!DOCTYPE html><html lang="de"><head><title>T</title></head><body class="body">${body}</body></html>`;
}

class StubMaterializer {
  readonly created: { name: string; layers: Layer[]; variants?: ComponentVariant[] }[] = [];
  async getOrCreateStyle(): Promise<null> {
    return null;
  }
  async prepareStyles(): Promise<void> {}
  async uploadAsset(): Promise<string | null> {
    return null;
  }
  async createComponent(name: string, layers: Layer[], _variables?: unknown, variants?: ComponentVariant[]): Promise<Component> {
    this.created.push({ name, layers, variants });
    return { id: `cmp-${this.created.length}`, name, layers, variants, is_published: false } as Component;
  }
}

function converter(): ImportConverter {
  return new ImportConverter(new StubMaterializer() as unknown as ImportMaterializer);
}

interface BuildOptions {
  assets?: Record<string, string>;
  urls?: Record<string, string>;
  ctx?: Partial<HtmlContext>;
  /** Runs between parse and convert (stands in for binding.ts). */
  beforeConvert?: (page: WfPage) => void;
}

/** parse -> convert -> post-process, the same order `index.ts` runs them in. */
async function build(html: string, opts: BuildOptions = {}) {
  const ctx = ctxFor(fakeZip(Object.keys(opts.assets ?? {})), opts.ctx);
  const page = parsePage(doc(html), ctx);
  opts.beforeConvert?.(page);
  const { roots, layerByNode } = await convertPage(page, converter());
  const assets = { idOf: (key: string) => opts.assets?.[key] ?? null, urlOf: (key: string) => opts.urls?.[key] ?? null };
  applyNodeLayerPostProcessing(page, layerByNode, assets, ctx.warn, opts.ctx?.widgets);
  return { page, roots, layerByNode, warn: ctx.warn };
}

function node(page: WfPage, predicate: (n: WfNode) => boolean): WfNode {
  const hit = [...page.nodeIndex.values()].find(predicate);
  assert.ok(hit, 'fixture node not found');
  return hit;
}

function layerOf(page: WfPage, layerByNode: Map<string, Layer>, predicate: (n: WfNode) => boolean): Layer {
  const layer = layerByNode.get(node(page, predicate).wf.id);
  assert.ok(layer, 'no layer for the fixture node');
  return layer;
}

function classes(layer: Layer): Set<string> {
  const str = Array.isArray(layer.classes) ? layer.classes.join(' ') : layer.classes ?? '';
  return new Set(str.split(/\s+/).filter(Boolean));
}

function flatten(layers: Layer[]): Layer[] {
  const out: Layer[] = [];
  const walk = (l: Layer) => { out.push(l); (l.children ?? []).forEach(walk); };
  layers.forEach(walk);
  return out;
}

/** Plain text of a layer's text variable (`dynamic_text` string or a TipTap doc). */
function textOf(layer: Layer): string {
  const content = (layer.variables?.text?.data as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as { text?: string; content?: unknown[] };
    if (typeof node.text === 'string') parts.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(content);
  return parts.join('');
}

function messages(warn: Warnings, code: string): string[] {
  return warn.list.filter((w) => w.code === code).map((w) => w.message);
}

/** Minimal `WfCollectionInfo` for the binding-time helpers. */
function collection(fields: { id: string; name: string; type: string; key?: string }[]): WfCollectionInfo {
  return {
    id: 'col-1',
    name: 'Posts',
    webflowId: null,
    fields: fields.map((f) => ({ id: f.id, key: f.key ?? null, name: f.name, header: f.name, type: f.type, multiple: false, referenceCollectionId: null })),
    slugFieldId: 'f-slug',
    nameFieldId: 'f-name',
    itemIdBySlug: new Map(),
    itemIdByWebflowId: new Map(),
    itemIdByName: new Map(),
    rowCount: 8,
    publishableCount: 8,
    dateFormatByField: {},
    fillCountByField: {},
  } as unknown as WfCollectionInfo;
}

// ─── Video ────────────────────────────────────────────────────────────────────

const EMBEDLY_YOUTUBE = '//cdn.embedly.com/widgets/media.html?src=https%3A%2F%2Fwww.youtube.com%2Fembed%2FdQw4w9WgXcQ%3Ffeature%3Doembed&amp;display_name=YouTube&amp;url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&amp;image=https%3A%2F%2Fi.ytimg.com%2Fvi%2FdQw4w9WgXcQ%2Fhqdefault.jpg&amp;type=text%2Fhtml&amp;schema=youtube';
const EMBEDLY_VIMEO = '//cdn.embedly.com/widgets/media.html?src=https%3A%2F%2Fplayer.vimeo.com%2Fvideo%2F76979871%3Fapp_id%3D122963&amp;dntp=1&amp;display_name=Vimeo&amp;url=https%3A%2F%2Fvimeo.com%2F76979871&amp;type=text%2Fhtml&amp;schema=vimeo';

const VIDEO_HTML = `
<div style="padding-top:56.17021276595745%" class="video w-video w-embed"><iframe class="embedly-embed" src="${EMBEDLY_YOUTUBE}" width="940" height="528" scrolling="no" allowfullscreen title="Atelierfilm"></iframe></div>
<div style="padding-top:56.25%" class="video-vimeo w-video w-embed"><iframe class="embedly-embed" src="${EMBEDLY_VIMEO}" width="940" height="529" scrolling="no" allowfullscreen title="The New Vimeo Player"></iframe></div>
<div class="youtube w-embed-youtubevideo" style="padding-bottom:56.17021276595745%;background-image:url(https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg)"><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0&amp;controls=1&amp;autoplay=0&amp;mute=0&amp;start=42" frameborder="0" style="position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:auto" allow="autoplay; encrypted-media" allowfullscreen="" title="Atelierfilm (YouTube)"></iframe></div>
<div class="youtube-autoplay w-embed-youtubevideo" style="padding-bottom:56.17021276595745%"><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?rel=1&amp;controls=0&amp;autoplay=1&amp;mute=1&amp;loop=1&amp;playlist=dQw4w9WgXcQ&amp;start=0" frameborder="0" allow="autoplay; encrypted-media" allowfullscreen="" title="Atelierfilm (autoplay)"></iframe></div>`;

test('video: the embedly wrapper is unwrapped and the provider, id and player flags are read from the URL', () => {
  const yt = planEmbedVideo({ src: EMBEDLY_YOUTUBE.replace(/&amp;/g, '&'), style: 'padding-top:56.17021276595745%' })!;
  assert.equal(yt.provider, 'youtube');
  assert.equal(yt.videoId, 'dQw4w9WgXcQ');
  assert.equal(yt.target, 'video', 'a plain YouTube id is a native video layer');
  assert.equal(yt.controls, true);
  assert.equal(yt.aspect, 'aspect-[16/9]');

  const vimeo = planEmbedVideo({ src: EMBEDLY_VIMEO.replace(/&amp;/g, '&'), width: '940', height: '529' })!;
  assert.equal(vimeo.provider, 'vimeo');
  assert.equal(vimeo.videoId, '76979871');
  assert.equal(vimeo.target, 'iframe', 'ycode has no Vimeo provider');
  assert.equal(vimeo.url, 'https://player.vimeo.com/video/76979871', 'oEmbed-only params are dropped');

  const start = planEmbedVideo({ src: 'https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0&controls=1&autoplay=0&mute=0&start=42' })!;
  assert.equal(start.target, 'iframe', 'VideoVariable cannot express a start offset');
  assert.equal(start.start, 42);
  assert.match(start.url, /start=42/);

  const auto = planEmbedVideo({ src: 'https://www.youtube.com/embed/dQw4w9WgXcQ?controls=0&autoplay=1&mute=1&loop=1&playlist=dQw4w9WgXcQ&start=0' })!;
  assert.deepEqual([auto.autoplay, auto.muted, auto.loop, auto.controls, auto.target], [true, true, true, false, 'video']);
  assert.equal(planEmbedVideo({ src: '' }), null);
});

test('video: aspect ratio comes from the padding trick or the iframe size', () => {
  assert.equal(aspectClass({ style: 'padding-bottom:56.25%' }), 'aspect-[16/9]');
  assert.equal(aspectClass({ style: 'padding-top:75%' }), 'aspect-[4/3]');
  assert.equal(aspectClass({ style: 'padding-top:40%' }), 'aspect-[100/40]');
  assert.equal(aspectClass({ width: '940', height: '528' }), 'aspect-[16/9]');
  assert.equal(aspectClass({ width: '600', height: '400' }), 'aspect-[3/2]');
  assert.equal(aspectClass({}), 'aspect-[16/9]');
});

test('video: .w-video / .w-embed-youtubevideo become video (YouTube) or iframe (Vimeo, start offset) layers', async () => {
  const { page, layerByNode, warn } = await build(VIDEO_HTML);

  const yt = layerOf(page, layerByNode, (n) => n.wf.siteClasses.includes('video'));
  assert.equal(yt.name, 'video');
  assert.deepEqual(yt.variables?.video?.src, { type: 'video', data: { provider: 'youtube', video_id: 'dQw4w9WgXcQ' } });
  assert.equal(yt.attributes?.controls, true, 'controls must be true or the renderer appends controls=0');
  assert.ok(classes(yt).has('aspect-[16/9]'));
  assert.ok(classes(yt).has('w-full'));
  assert.equal(yt.children, undefined);

  const vimeo = layerOf(page, layerByNode, (n) => n.wf.siteClasses.includes('video-vimeo'));
  assert.equal(vimeo.name, 'iframe');
  assert.equal(vimeo.variables?.iframe?.src.data.content, 'https://player.vimeo.com/video/76979871');
  assert.equal(vimeo.attributes?.allowFullScreen, true);
  assert.equal(vimeo.attributes?.title, 'The New Vimeo Player');

  const start = layerOf(page, layerByNode, (n) => n.wf.siteClasses.includes('youtube'));
  assert.equal(start.name, 'iframe');
  assert.match(String(start.variables?.iframe?.src.data.content), /^https:\/\/www\.youtube\.com\/embed\/dQw4w9WgXcQ\?.*start=42/);

  const auto = layerOf(page, layerByNode, (n) => n.wf.siteClasses.includes('youtube-autoplay'));
  assert.equal(auto.name, 'video');
  assert.deepEqual([auto.attributes?.autoplay, auto.attributes?.muted, auto.attributes?.loop, auto.attributes?.controls], [true, true, true, false]);

  assert.equal(warn.count('embed_script'), 0, 'no raw-iframe embeds are left');
  assert.equal(warn.count('html_unmapped'), 0);
});

test('video: the flag turns the builder off and the old htmlEmbed path returns', async () => {
  const { page, layerByNode, warn } = await build(VIDEO_HTML, { ctx: { widgets: { video: false } } });
  const yt = layerOf(page, layerByNode, (n) => n.wf.siteClasses.includes('video'));
  assert.equal(yt.name, 'htmlEmbed');
  assert.ok(warn.count('embed_script') >= 1);
});

// ─── Lottie ───────────────────────────────────────────────────────────────────

const LOTTIE_HTML = `
<div class="lottie-animation w-lottie" data-w-id="4e5f" data-animation-type="lottie" data-src="documents/anim.json" data-loop="1" data-direction="1" data-autoplay="1" data-is-ix2-target="0" data-renderer="svg" data-default-duration="2" data-duration="0"></div>
<div class="lottie-scroll w-lottie" data-w-id="4e5g" data-animation-type="lottie" data-src="documents/anim.json" data-loop="0" data-direction="1" data-autoplay="0" data-is-ix2-target="1" data-renderer="svg" data-default-duration="2" data-duration="0"></div>`;

test('lottie: the embed carries the constant player line and a <lottie-player> pointing at the uploaded JSON', async () => {
  const { page, layerByNode, warn } = await build(LOTTIE_HTML, {
    assets: { 'documents/anim.json': 'ast_anim' },
    urls: { 'documents/anim.json': 'https://cdn.example/storage/anim.json' },
  });
  const lottie = layerOf(page, layerByNode, (n) => n.wf.siteClasses.includes('lottie-animation'));
  assert.equal(lottie.name, 'htmlEmbed');
  const code = lottie.settings?.htmlEmbed?.code ?? '';
  assert.ok(code.startsWith(LOTTIE_PLAYER_SCRIPT), 'the player script is constant and importer-owned');
  assert.match(code, /<lottie-player src="https:\/\/cdn\.example\/storage\/anim\.json"[^>]* loop autoplay><\/lottie-player>/);
  assert.equal(lottie.children, undefined);

  const scroll = layerOf(page, layerByNode, (n) => n.wf.siteClasses.includes('lottie-scroll'));
  const scrollCode = scroll.settings?.htmlEmbed?.code ?? '';
  assert.doesNotMatch(scrollCode, / loop| autoplay/);
  assert.equal(warn.count('widget_partial'), 1, 'the IX2-driven one is reported');
  assert.match(messages(warn, 'widget_partial')[0], /data-is-ix2-target/);
  assert.equal(warn.count('html_unmapped'), 0);
});

test('lottie: the player gets an explicit size from the element\'s translated class, else a fallback height', () => {
  assert.deepEqual(sizeFromClasses(['block', 'w-[200px]', 'h-[200px]']), { width: '200px', height: '200px' });
  assert.deepEqual(sizeFromClasses(['flex']), {});
  const sized = lottieEmbedCode({ src: 'documents/anim.json', loop: true, autoplay: true, reverse: false, ix2: false, width: '120px', height: '120px' }, 'https://x/anim.json');
  assert.match(sized, /style="width:120px;height:120px"/);
  const fallback = lottieEmbedCode({ src: 'documents/anim.json', loop: false, autoplay: false, reverse: true, ix2: false }, 'https://x/anim.json');
  assert.match(fallback, /style="width:100%;height:300px" direction="-1"/);
});

// ─── Code block ───────────────────────────────────────────────────────────────

const CODE_HTML = `
<div class="w-code-block" style="margin: 0 0 20px 0; padding: 12px; background-color: #2b2b2b; border-radius: 6px">
<pre class="language-javascript" style="white-space: pre-wrap"><code class="language-javascript hljs" style="background: none; padding: 0; font-family: monospace"><span class="hljs-keyword">function</span> <span class="hljs-title function_">greet</span>(<span class="hljs-params">name</span>) {
  <span class="hljs-keyword">const</span> text = <span class="hljs-string">\`Hallo, \${name}!\`</span>;
  <span class="hljs-keyword">if</span> (name.<span class="hljs-property">length</span> &gt; <span class="hljs-number">3</span> &amp;&amp; name !== <span class="hljs-string">"&lt;anonym&gt;"</span>) {
    <span class="hljs-built_in">console</span>.<span class="hljs-title function_">log</span>(text);
  }
}</code></pre>
</div>
<div class="w-code-block" style="padding: 12px; background-color: #f5f5f5">
<pre class="language-html"><code class="language-html hljs"><span class="hljs-tag">&lt;<span class="hljs-name">div</span>&gt;</span>
\t<span class="hljs-tag">&lt;<span class="hljs-name">p</span>&gt;</span>Zwei  Leerzeichen und ein Tab.<span class="hljs-tag">&lt;/<span class="hljs-name">p</span>&gt;</span>
<span class="hljs-tag">&lt;/<span class="hljs-name">div</span>&gt;</span></code></pre>
</div>`;

test('code block: <pre><code> with the code verbatim — entities decoded, highlight spans gone, whitespace intact', async () => {
  const { page, layerByNode, warn } = await build(CODE_HTML);
  const blocks = [...page.nodeIndex.values()].filter((n) => n.wf.role === 'code-block');
  assert.equal(blocks.length, 2);

  const js = layerByNode.get(blocks[0].wf.id)!;
  assert.equal(js.name, 'div');
  assert.equal(js.settings?.tag, 'pre');
  assert.ok(classes(js).has('whitespace-pre-wrap'));
  assert.ok(classes(js).has('font-mono'));
  // Wrapper inline styles arrive as layer classes.
  for (const cls of ['mb-[20px]', 'p-[12px]', 'bg-[#2b2b2b]', 'rounded-[6px]']) assert.ok(classes(js).has(cls), `${cls} missing from ${[...classes(js)].join(' ')}`);

  assert.equal(js.children?.length, 1);
  const code = js.children![0];
  assert.equal(code.name, 'text');
  assert.equal(code.settings?.tag, 'code');
  assert.equal(code.settings?.customAttributes?.['data-language'], 'javascript');
  assert.equal(
    code.variables?.text?.data.content,
    'function greet(name) {\n  const text = `Hallo, ${name}!`;\n  if (name.length > 3 && name !== "<anonym>") {\n    console.log(text);\n  }\n}',
  );

  const html = layerByNode.get(blocks[1].wf.id)!.children![0];
  assert.equal(html.variables?.text?.data.content, '<div>\n\t<p>Zwei  Leerzeichen und ein Tab.</p>\n</div>', 'two spaces and the tab survive');
  assert.equal(html.settings?.customAttributes?.['data-language'], 'html');
  assert.equal(warn.count('html_unmapped'), 0);
});

test('code block: inline style translation covers the properties Webflow writes', () => {
  assert.deepEqual(inlineStyleClasses('margin: 0 0 20px 0; padding: 12px; background-color: #2b2b2b; border-radius: 6px'), ['mt-0', 'mr-0', 'mb-[20px]', 'ml-0', 'p-[12px]', 'bg-[#2b2b2b]', 'rounded-[6px]']);
  assert.deepEqual(inlineStyleClasses('background: none; padding: 0; font-family: monospace; white-space: pre-wrap'), ['p-0', 'font-mono', 'whitespace-pre-wrap']);
  assert.deepEqual(inlineStyleClasses(undefined), []);
});

// ─── File upload ──────────────────────────────────────────────────────────────

const UPLOAD_HTML = `
<div class="form-block w-form">
  <form id="wf-form-Bewerbung" name="wf-form-Bewerbung" method="get" class="form">
    <label for="name">Name</label><input class="w-input" maxlength="256" name="name" placeholder="Ihr Name" type="text" id="name" required="">
    <label for="file">Portfolio (PDF)</label>
    <div class="w-file-upload">
      <div class="w-file-upload-default">
        <input class="w-file-upload-input" accept=".pdf, .jpg" name="file" aria-hidden="true" type="file" id="file" data-max-file-size="10485760">
        <label for="file" role="button" class="upload-button w-file-upload-label">
          <div class="w-icon-file-upload-icon"></div>
          <div class="w-inline-block">Datei auswählen</div>
        </label>
        <div class="w-file-upload-info">Max. Dateigröße 10 MB.</div>
      </div>
      <div class="w-file-upload-uploading w-hidden"><div class="w-file-upload-uploading-btn"><svg class="w-icon-file-upload-uploading" viewBox="0 0 20 20"><path d="M1 1"></path></svg><div class="w-inline-block">Wird hochgeladen…</div></div></div>
      <div class="w-file-upload-success w-hidden"><div class="w-file-upload-file"><div class="w-file-upload-file-name">Datei</div><div role="button" tabindex="0" class="w-file-remove-link"><div class="w-icon-file-upload-remove"></div></div></div></div>
      <div class="w-file-upload-error w-hidden"><div class="w-file-upload-error-msg" data-w-size-error="Zu groß.">Upload fehlgeschlagen.</div></div>
    </div>
    <input type="submit" class="button w-button" value="Absenden">
  </form>
  <div class="w-form-done"><div>Danke!</div></div>
  <div class="w-form-fail"><div>Hoppla.</div></div>
</div>`;

test('file upload: the file input stays inside the form with its label; the upload state boxes are dropped', async () => {
  const { page, layerByNode, roots, warn } = await build(UPLOAD_HTML);
  const form = layerOf(page, layerByNode, (n) => n.wf.role === 'form');
  assert.equal(form.name, 'form');

  const input = layerOf(page, layerByNode, (n) => n.wf.tag === 'input' && n.wf.htmlId === 'file');
  assert.equal(input.name, 'input');
  assert.equal(input.attributes?.type, 'file');
  assert.equal(input.attributes?.name, 'file');
  assert.equal(input.attributes?.accept, '.pdf, .jpg');
  assert.ok(flatten([form]).includes(input), 'the input is a descendant of the form layer');

  const label = layerOf(page, layerByNode, (n) => n.wf.role === 'label' && n.wf.labelFor === 'file' && n.kind === 'box');
  assert.equal(label.settings?.tag, 'label');
  assert.equal(label.attributes?.for, 'file');
  assert.ok(flatten([label]).some((l) => l.name === 'icon'), 'the upload glyph is an inline SVG icon');

  const all = flatten(roots);
  assert.ok(all.some((l) => textOf(l) === 'Datei auswählen'), 'the default state label survives');
  assert.equal(all.some((l) => textOf(l) === 'Datei'), false, 'success state dropped');
  assert.equal(all.some((l) => textOf(l) === 'Upload fehlgeschlagen.'), false, 'error state dropped');

  assert.ok(messages(warn, 'widget_partial').some((m) => /Datei-Uploads werden nicht gespeichert/.test(m)));
  assert.equal(warn.count('html_unmapped'), 0);
});

// ─── Map ──────────────────────────────────────────────────────────────────────

const MAP_HTML = `
<div class="map w-widget w-widget-map" data-widget-style="roadmap" data-widget-latlng="48.15330,11.61120" aria-label="Atelier" data-enable-scroll="true" role="region" title="Atelier" data-enable-touch="true" data-widget-zoom="14" data-widget-tooltip="Atelier Studio von Brase"></div>
<div class="map-satellite w-widget w-widget-map" data-widget-style="satellite" data-widget-latlng="48.8583,2.2945" data-enable-scroll="false" role="region" data-enable-touch="false" data-widget-zoom="16" data-widget-tooltip=""></div>`;

test('map: data-widget-* becomes settings.map on a map layer', async () => {
  const { page, layerByNode, warn } = await build(MAP_HTML);
  const map = layerOf(page, layerByNode, (n) => n.wf.siteClasses.includes('map'));
  assert.equal(map.name, 'map');
  assert.equal(map.settings?.map?.provider, 'google');
  assert.equal(map.settings?.map?.latitude, 48.1533);
  assert.equal(map.settings?.map?.longitude, 11.6112);
  assert.equal(map.settings?.map?.zoom, 14);
  assert.equal(map.settings?.map?.search, 'Atelier Studio von Brase');
  assert.equal(map.settings?.map?.google.style, 'roadmap');
  assert.equal(map.settings?.map?.google.scrollZoom, true);
  assert.equal(map.children, undefined);

  const sat = layerOf(page, layerByNode, (n) => n.wf.siteClasses.includes('map-satellite'));
  assert.equal(sat.settings?.map?.google.style, 'satellite');
  assert.equal(sat.settings?.map?.google.scrollZoom, false);
  assert.equal(sat.settings?.map?.google.interactive, false);
  assert.equal(sat.settings?.map?.search, '48.8583,2.2945');

  assert.ok(messages(warn, 'widget_partial').some((m) => /API-Key/.test(m)), 'the key requirement is reported once');
  assert.equal(warn.count('html_unmapped'), 0);
});

test('map: hybrid / terrain are approximated and said so', () => {
  const { settings, notes } = planMap({ 'data-widget-style': 'terrain', 'data-widget-latlng': '1,2', 'data-widget-zoom': '3' });
  assert.equal(settings.google.style, 'roadmap');
  assert.match(notes[0], /terrain/);
});

// ─── Search ───────────────────────────────────────────────────────────────────

test('search: form.w-form[action="/search"] is a normal form and reported as unsupported', async () => {
  const { page, layerByNode, warn } = await build('<form action="/search" class="search w-form"><input class="search-input w-input" maxlength="256" name="query" placeholder="Suchen…" type="search" id="search" required=""><input type="submit" class="search-button w-button" value="Suchen"></form>');
  const form = layerOf(page, layerByNode, (n) => n.wf.role === 'form');
  assert.equal(form.name, 'form');
  assert.equal(form.customName, 'Search form');
  const query = layerOf(page, layerByNode, (n) => n.wf.tag === 'input' && n.wf.htmlId === 'search');
  assert.equal(query.name, 'input');
  assert.equal(query.attributes?.name, 'query');
  assert.equal(query.attributes?.type, 'search');
  assert.equal(warn.count('widget_unsupported'), 1);
  assert.equal(warn.count('widget_partial'), 0, 'no ".w-form without a <form> child" any more');
  // The submit keeps Webflow's `.w-button` defaults under its site class (which sets nothing here).
  const submit = layerOf(page, layerByNode, (n) => n.wf.classNames.includes('w-button'));
  for (const c of ['py-[9px]', 'px-[15px]', 'bg-[#3898ec]', 'text-[#fff]', 'leading-[inherit]', 'border-0', 'cursor-pointer']) {
    assert.ok(classes(submit).has(c), `submit carries ${c}: ${[...classes(submit)].join(' ')}`);
  }
});

// ─── Locales ──────────────────────────────────────────────────────────────────

test('locales: .w-locales-list becomes a localeSelector with the current label and the chevron', async () => {
  const { page, layerByNode, warn } = await build(`
    <div class="w-locales-list"><div role="list" class="w-locales-items">
      <div role="listitem" class="w-locales-item"><a hreflang="de" href="index.html" aria-current="page" class="w--current">Deutsch</a></div>
      <div role="listitem" class="w-locales-item"><a hreflang="en" href="en/index.html">English</a></div>
    </div></div>`);
  const selector = layerOf(page, layerByNode, (n) => n.wf.role === 'locales');
  assert.equal(selector.name, 'localeSelector');
  assert.deepEqual(selector.settings?.locale, { format: 'locale' });
  assert.equal(selector.attributes?.display_type, 'name');
  assert.ok(classes(selector).has('relative'), 'the overlay select is positioned against the wrapper');
  assert.deepEqual(selector.children?.map((c) => c.name), ['text', 'icon']);
  assert.equal(selector.children![0].key, 'localeSelectorLabel');
  assert.equal(selector.children![0].variables?.text?.data.content, 'Deutsch');
  assert.equal(selector.children![0].restrictions?.ancestor, 'localeSelector');
  assert.deepEqual(node(page, (n) => n.wf.role === 'locales').wf.locales?.codes, ['de', 'en']);
  assert.equal(warn.count('widget_partial'), 1);
  assert.equal(warn.count('html_unmapped'), 0);
});

// ─── Pagination + conditional visibility ──────────────────────────────────────

const ITEM = `
<div role="listitem" class="post w-dyn-item">
  <a href="#" class="post-link w-inline-block"><img src="https://d3e54v103j8qbb.cloudfront.net/plugins/Basic/assets/placeholder.60f9b1840c.svg" loading="lazy" alt="" class="post-image w-dyn-bind-empty">
    <h3 class="post-title w-dyn-bind-empty"></h3>
    <p class="post-teaser w-dyn-bind-empty"></p>
    <div class="badge w-condition-invisible">Empfohlen</div>
  </a>
</div>`;

const LIST_HTML = `
<div class="posts-list w-dyn-list">
  <div role="list" class="posts-items w-dyn-items">${ITEM}${ITEM}${ITEM}</div>
  <div class="w-dyn-empty"><div>Keine Beiträge gefunden.</div></div>
  <div role="navigation" aria-label="List" class="pagination w-pagination-wrapper">
    <a href="?7c3d1e2f_page=1" aria-label="Previous Page" class="w-pagination-previous"><svg class="w-pagination-previous-icon" height="12px" width="7px" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 12"><path fill="none" stroke="currentColor" d="M5.8 1L1.4 5.5l4.4 4.5" stroke-width="1.5"></path></svg><div class="w-inline-block">Zurück</div></a>
    <a href="?7c3d1e2f_page=3" aria-label="Next Page" class="w-pagination-next"><div class="w-inline-block">Weiter</div><svg class="w-pagination-next-icon" height="12px" width="7px" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 12"><path fill="none" stroke="currentColor" d="M1 1l4.4 4.5L1 10" stroke-width="1.5"></path></svg></a>
    <div class="w-page-count">Seite 2 von 3</div>
  </div>
</div>
<div class="note w-condition-invisible">Dieser Hinweis ist per Bedingung ausgeblendet.</div>
<div class="note">Dieser Hinweis ist sichtbar.</div>`;

/** Stand-in for binding.ts: bind the list to a collection and run the visibility pass. */
function bindList(page: WfPage, warn: Warnings): void {
  const posts = collection([
    { id: 'f-name', name: 'Name', type: 'text', key: 'name' },
    { id: 'f-slug', name: 'Slug', type: 'text', key: 'slug' },
    { id: 'f-teaser', name: 'Teaser', type: 'text' },
    { id: 'f-bild', name: 'Bild', type: 'image' },
    { id: 'f-empfohlen', name: 'Empfohlen', type: 'boolean' },
  ]);
  const item = node(page, (n) => n.wf.role === 'dyn-item');
  item.wf.collection = { collectionId: posts.id, confidence: 1, reason: 'test' };
  for (const n of page.nodeIndex.values()) {
    if (n.wf.conditionInvisible && n.wf.siteClasses.includes('badge')) {
      planConditionalVisibility(n, posts, 'collection', warn, { page: 'index', label: 'list' });
    }
  }
}

test('pagination: only the first template item becomes the collection layer; its page size is the template count', async () => {
  const { page, layerByNode } = await build(LIST_HTML, { beforeConvert: (p) => bindList(p, new Warnings()) });
  const items = [...page.nodeIndex.values()].filter((n) => n.wf.role === 'dyn-item');
  assert.equal(items.length, 1, 'the two extra template items are not converted');
  const list = layerOf(page, layerByNode, (n) => n.wf.role === 'dyn-item');
  assert.deepEqual(list.variables?.collection?.pagination, { enabled: true, mode: 'pages', items_per_page: 3 });
});

test('pagination: the wrapper becomes ycode\'s pagination layers keyed on the collection layer id', async () => {
  const { page, layerByNode, roots, warn } = await build(LIST_HTML, { beforeConvert: (p) => bindList(p, new Warnings()) });
  const cid = layerOf(page, layerByNode, (n) => n.wf.role === 'dyn-item').id;

  const wrapper = layerOf(page, layerByNode, (n) => n.wf.role === 'pagination');
  assert.equal(wrapper.id, `${cid}-pagination-wrapper`);
  assert.equal(wrapper.attributes?.['data-pagination-for'], cid);
  assert.equal(wrapper.attributes?.['data-pagination-mode'], 'pages');
  assert.ok(flatten(roots).includes(wrapper), 'the wrapper sits in the page tree outside the collection layer');
  assert.equal(flatten([layerOf(page, layerByNode, (n) => n.wf.role === 'dyn-item')]).includes(wrapper), false);

  const prev = layerOf(page, layerByNode, (n) => n.wf.role === 'pagination-prev');
  assert.equal(prev.id, `${cid}-pagination-prev`);
  assert.equal(prev.name, 'button');
  assert.equal(prev.attributes?.['data-pagination-action'], 'prev');
  assert.equal(prev.attributes?.['data-collection-layer-id'], cid);
  assert.equal(prev.variables?.link, undefined, 'the ?…_page=N href is gone');
  assert.ok(flatten([prev]).some((l) => l.name === 'icon'), 'the chevron survives as an icon');
  assert.ok(flatten([prev]).some((l) => textOf(l) === 'Zurück'), 'the export\'s button text survives');

  const next = layerOf(page, layerByNode, (n) => n.wf.role === 'pagination-next');
  assert.equal(next.id, `${cid}-pagination-next`);
  assert.equal(next.attributes?.['data-pagination-action'], 'next');

  const info = layerOf(page, layerByNode, (n) => n.wf.role === 'pagination-info');
  assert.equal(info.id, `${cid}-pagination-info`);
  const content = (info.variables?.text?.data as { content: { content: { content: { type: string; text?: string; attrs?: { variable: { type: string; data: { key: string } } } }[] }[] } }).content;
  const parts = content.content[0].content.map((n) => (n.type === 'text' ? n.text : `{${n.attrs!.variable.data.key}}`));
  assert.deepEqual(parts, ['Seite ', '{current}', ' von ', '{pages}'], 'the export\'s wording wraps ycode\'s pagination chips');
  assert.equal(warn.count('html_unmapped'), 0);
});

test('pagination: the info text parser keeps the wording around the two numbers', () => {
  assert.deepEqual(parsePaginationInfo('Seite 2 von 3'), { before: 'Seite ', between: ' von ', after: '' });
  assert.deepEqual(parsePaginationInfo('2 / 3 pages'), { before: '', between: ' / ', after: ' pages' });
  assert.equal(parsePaginationInfo('no numbers'), null);
});

test('pagination: an unbound list keeps the controls as plain layers and says so', async () => {
  const { page, layerByNode, warn } = await build(LIST_HTML);
  const wrapper = layerOf(page, layerByNode, (n) => n.wf.role === 'pagination');
  assert.doesNotMatch(wrapper.id, /-pagination-wrapper$/);
  assert.ok(messages(warn, 'widget_partial').some((m) => /not bound to a collection/.test(m)));
});

test('conditional visibility: a static badge naming a switch field becomes "field is true"; the rest stays hidden', async () => {
  const warn = new Warnings();
  const { page, layerByNode, warn: buildWarn } = await build(LIST_HTML, { beforeConvert: (p) => bindList(p, warn) });

  const badgeNode = node(page, (n) => n.wf.siteClasses.includes('badge'));
  assert.equal(badgeNode.wf.visibility?.fieldId, 'f-empfohlen');
  assert.equal(badgeNode.wf.visibility?.operator, 'is');
  assert.equal(badgeNode.classes, undefined, 'the hidden fallback is gone');
  const badge = layerByNode.get(badgeNode.wf.id)!;
  assert.deepEqual(badge.variables?.conditionalVisibility, {
    groups: [{ id: 'vc-g-1', conditions: [{ id: 'vc-1', source: 'collection_field', fieldId: 'f-empfohlen', fieldType: 'boolean', operator: 'is', value: 'true' }] }],
  });
  assert.equal(classes(badge).has('hidden'), false);
  assert.equal(warn.count('widget_partial'), 0, 'the reconstructed rule is not a partial mapping');

  const note = layerOf(page, layerByNode, (n) => n.wf.siteClasses.includes('note') && n.wf.conditionInvisible === true);
  assert.ok(classes(note).has('hidden'), 'outside any bound list the element stays hidden');
  assert.equal(note.variables?.conditionalVisibility, undefined);
  assert.ok(messages(buildWarn, 'widget_partial').some((m) => /outside a bound collection kept hidden/.test(m)));
});

test('empty values: a bound `w-dyn-bind-empty` slot gets conditionalVisibility "is present" on its layer, without a hidden class', async () => {
  const { page, layerByNode } = await build(LIST_HTML, {
    beforeConvert: (p) => {
      bindList(p, new Warnings());
      const teaser = node(p, (n) => n.wf.siteClasses.includes('post-teaser'));
      teaser.wf.binding = { kind: 'text', fieldId: 'f-teaser', fieldType: 'text', fieldName: 'Teaser', source: 'collection', confidence: 1, reason: 't' };
      teaser.wf.visibility = { fieldId: 'f-teaser', fieldType: 'text', operator: 'is_present', source: 'collection', reason: 'w-dyn-bind-empty' };
      const image = node(p, (n) => n.wf.siteClasses.includes('post-image'));
      image.wf.binding = { kind: 'image', fieldId: 'f-bild', fieldType: 'image', fieldName: 'Bild', source: 'collection', confidence: 1, reason: 't' };
      image.wf.visibility = { fieldId: 'f-bild', fieldType: 'image', operator: 'is_present', source: 'collection', reason: 'w-dyn-bind-empty' };
    },
  });
  const teaser = layerOf(page, layerByNode, (n) => n.wf.siteClasses.includes('post-teaser'));
  assert.deepEqual(teaser.variables?.conditionalVisibility, {
    groups: [{ id: 'vc-g-1', conditions: [{ id: 'vc-1', source: 'collection_field', fieldId: 'f-teaser', fieldType: 'text', operator: 'is_present' }] }],
  });
  assert.equal(classes(teaser).has('hidden'), false);
  const image = layerOf(page, layerByNode, (n) => n.wf.siteClasses.includes('post-image'));
  assert.equal(image.variables?.conditionalVisibility?.groups[0].conditions[0].fieldId, 'f-bild');
  const title = layerOf(page, layerByNode, (n) => n.wf.siteClasses.includes('post-title'));
  assert.equal(title.variables?.conditionalVisibility, undefined, 'an unbound slot has no rule');
});

test('conditional visibility: a bound slot becomes "field is present"; no match is reported and stays hidden', () => {
  const posts = collection([{ id: 'f-teaser', name: 'Teaser', type: 'text' }]);
  const warn = new Warnings();
  const slot: WfNode = { kind: 'text', tag: 'p', classes: ['hidden'], text: '', wf: { id: 'index#1', page: 'index', tag: 'p', classNames: ['p', 'w-condition-invisible', 'w-dyn-bind-empty'], siteClasses: ['p'], attrs: {}, bindEmpty: true, conditionInvisible: true, binding: { kind: 'text', fieldId: 'f-teaser', fieldType: 'text', fieldName: 'Teaser', source: 'collection', confidence: 1, reason: 't' } } };
  const plan = planConditionalVisibility(slot, posts, 'collection', warn, { page: 'index', label: 'list' });
  assert.equal(plan?.operator, 'is_present');
  assert.equal(plan?.fieldId, 'f-teaser');
  assert.equal(slot.classes, undefined);

  const orphan: WfNode = { kind: 'text', tag: 'div', classes: ['hidden'], text: 'Neu', wf: { id: 'index#2', page: 'index', tag: 'div', classNames: ['tag', 'w-condition-invisible'], siteClasses: ['tag'], attrs: {}, bindEmpty: false, conditionInvisible: true } };
  assert.equal(planConditionalVisibility(orphan, posts, 'collection', warn, { page: 'index', label: 'list' }), null);
  assert.deepEqual(orphan.classes, ['hidden']);
  assert.equal(orphan.wf.visibilityChecked, true);
  assert.equal(warn.count('widget_partial'), 1);
});

// ─── Background-video control ─────────────────────────────────────────────────

const BG_VIDEO_HTML = `
<div data-poster-url="videos/studio_poster.jpg" data-video-urls="videos/studio_mp4.mp4,videos/studio_webm.webm" data-autoplay="true" data-loop="true" data-wf-ignore="true" id="hero" class="hero-video w-background-video w-background-video-atom"><video id="v-video" autoplay="" loop="" style="background-image:url(&quot;videos/studio_poster.jpg&quot;)" muted="" playsinline="" data-wf-ignore="true" data-object-fit="cover">
    <source src="videos/studio_mp4.mp4" data-wf-ignore="true">
    <source src="videos/studio_webm.webm" data-wf-ignore="true">
  </video>
  <div class="hero-content"><h1 class="heading-hero">Widgets</h1></div>
  <div aria-live="polite"><button type="button" data-w-bg-video-control="true" aria-controls="v-video" data-w-id="9f8e" class="video-control w-backgroundvideo-backgroundvideoplaypausebutton w-background-video--control"><span><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="5" width="4" height="14" fill="currentColor"></rect></svg><span class="w-hidden">Pause video</span></span><span hidden=""><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 5L19 12L7 19V5Z" fill="currentColor"></path></svg><span class="w-hidden">Play video</span></span></button></div>
</div>`;

test('background video: the content on top of the video survives and the control becomes a runtime-driven button', async () => {
  const { page, layerByNode, warn } = await build(BG_VIDEO_HTML, { assets: { 'videos/studio_mp4.mp4': 'ast_mp4', 'videos/studio_poster.jpg': 'ast_poster' } });
  const wrapper = layerOf(page, layerByNode, (n) => n.wf.role === 'bg-video');
  assert.equal(wrapper.children?.[0].name, 'video', 'the video is the first child, behind the content');
  assert.equal(wrapper.children?.[0].attributes?.controls, false, 'no native controls');
  assert.deepEqual(wrapper.children?.[0].variables?.video?.src, { type: 'asset', data: { asset_id: 'ast_mp4' } });
  assert.ok(flatten(wrapper.children ?? []).some((l) => l.name === 'heading'), 'the hero heading is kept');

  const button = layerOf(page, layerByNode, (n) => n.wf.role === 'bg-video-control');
  assert.equal(button.name, 'button');
  assert.equal(button.attributes?.type, 'button');
  assert.equal(button.settings?.customAttributes?.['data-webwow-video-toggle'], '');
  assert.equal(button.settings?.customAttributes?.['aria-label'], 'Pause video');
  assert.equal(button.settings?.customAttributes?.['data-label-play'], 'Play video');
  assert.deepEqual(button.children?.map((c) => c.name), ['icon', 'icon']);
  assert.equal(classes(button.children![0]).has('hidden'), false);
  assert.ok(classes(button.children![1]).has('hidden'), 'the play glyph starts hidden, like Webflow\'s');
  assert.ok(flatten([wrapper]).includes(button), 'the button stays inside the video wrapper so the runtime finds its <video>');

  assert.deepEqual(page.bodyScripts, [BG_VIDEO_TOGGLE_SCRIPT], 'the constant runtime line, once per page');
  assert.match(BG_VIDEO_TOGGLE_SCRIPT, /data-webwow-video-toggle/);
  assert.match(BG_VIDEO_TOGGLE_SCRIPT, /w--paused/);
  assert.equal(messages(warn, 'embed_dropped').some((m) => /controls/.test(m)), false, 'the controls are no longer dropped');
  assert.equal(warn.count('html_unmapped'), 0);
});

test('background video: two controls on one page add the runtime line once', async () => {
  const { page } = await build(`${BG_VIDEO_HTML}${BG_VIDEO_HTML.replace('id="hero"', 'id="hero-2"')}`);
  assert.equal(page.bodyScripts.length, 1);
});

// ─── Icon font ────────────────────────────────────────────────────────────────

test('icon font: every webflow-icons glyph becomes an inline SVG icon layer', async () => {
  const { page, layerByNode, warn } = await build(`
    <div class="icon-row">
      <div class="w-icon-dropdown-toggle"></div>
      <div class="w-icon-nav-menu"></div>
      <div class="w-icon-slider-left"></div>
      <div class="w-icon-slider-right"></div>
      <div class="w-icon-arrow-down"></div>
      <div class="w-icon-file-upload-icon"></div>
      <div class="w-icon-file-upload-remove"></div>
    </div>`);
  const row = layerOf(page, layerByNode, (n) => n.wf.siteClasses.includes('icon-row'));
  assert.deepEqual(row.children?.map((c) => c.name), ['icon', 'icon', 'icon', 'icon', 'icon', 'icon', 'icon']);
  const burger = layerOf(page, layerByNode, (n) => n.wf.classNames.includes('w-icon-nav-menu'));
  const svgOf = (layer: Layer): string => String((layer.variables?.icon?.src?.data as { content?: string } | undefined)?.content ?? '');
  assert.match(svgOf(burger), /<svg[^>]*>(<line[^>]*>){3}<\/svg>/);
  assert.ok(classes(burger).has('w-[1em]'), 'sized like the glyph (font-size)');
  const chevron = layerOf(page, layerByNode, (n) => n.wf.classNames.includes('w-icon-arrow-down'));
  assert.match(svgOf(chevron), /polyline points="6 9 12 15 18 9"/);
  assert.equal(warn.count('html_unmapped'), 0);
});

// ─── Users / Ecommerce / badge ────────────────────────────────────────────────

const USERS_HTML = `
<div class="w-users-userformpagewrapper"><div class="w-users-userformwrapper">
  <form method="post" data-wf-user-form-type="login" class="w-users-userloginform">
    <div class="w-users-userformcontent">
      <label for="wf-log-in-email">E-Mail</label><input class="w-input" maxlength="256" name="wf-log-in-email" type="email" id="wf-log-in-email" required="">
      <input type="submit" class="w-button" value="Anmelden">
    </div>
    <div style="display:none" data-wf-user-form-error="true" class="w-users-userformerrorstate"><div class="w-users-userformerrormsg">Anmeldung fehlgeschlagen.</div></div>
  </form>
</div></div>
<div data-node-type="commerce-add-to-cart-wrapper" class="w-commerce-commerceaddtocartform default-state">
  <form data-node-type="commerce-add-to-cart-form" data-commerce-sku-id="sku" class="add-to-cart">
    <div class="w-commerce-commerceaddtocartoptionpillgroup"><div class="w-commerce-commerceaddtocartoptionpill">Klein</div></div>
    <input type="number" name="commerce-add-to-cart-quantity-input" min="1" class="w-commerce-commerceaddtocartquantityinput" value="1">
    <input type="submit" class="w-commerce-commerceaddtocartbutton" value="In den Warenkorb">
  </form>
</div>
<a class="w-webflow-badge" href="https://webflow.com?utm_campaign=brandjs"><img src="https://d3e54v103j8qbb.cloudfront.net/img/webflow-badge-icon-d2.svg" alt=""><img src="https://d3e54v103j8qbb.cloudfront.net/img/webflow-badge-text-d2.svg" alt="Made in Webflow"></a>`;

test('users / ecommerce: reported once per family, forms stay native forms, the badge disappears', async () => {
  const { page, layerByNode, roots, warn } = await build(USERS_HTML);
  assert.equal(warn.count('widget_unsupported'), 2);
  assert.ok(messages(warn, 'widget_unsupported').some((m) => /Memberships/.test(m)));
  assert.ok(messages(warn, 'widget_unsupported').some((m) => /Ecommerce/.test(m)));
  assert.equal(warn.count('html_unmapped'), 0, 'the families do not fall through class by class');

  const forms = [...page.nodeIndex.values()].filter((n) => n.wf.role === 'form');
  assert.equal(forms.length, 2);
  const login = layerByNode.get(forms[0].wf.id)!;
  assert.equal(login.name, 'form');
  const email = layerOf(page, layerByNode, (n) => n.wf.htmlId === 'wf-log-in-email');
  assert.equal(email.attributes?.type, 'email');

  const all = flatten(roots);
  assert.equal(all.some((l) => JSON.stringify(l.variables?.link ?? '').includes('webflow.com')), false, 'no badge link');
  assert.equal(all.some((l) => JSON.stringify(l.variables?.image ?? '').includes('webflow-badge')), false, 'no badge images');

  // The error box Webflow parks with an inline `display:none` stays hidden without webflow.js.
  const errorBox = layerOf(page, layerByNode, (n) => n.wf.classNames.includes('w-users-userformerrorstate'));
  assert.ok(classes(errorBox).has('hidden'), `error state hidden: ${[...classes(errorBox)].join(' ')}`);
  const content = layerOf(page, layerByNode, (n) => n.wf.classNames.includes('w-users-userformcontent'));
  assert.ok(!classes(content).has('hidden'));
  // The bare login submit gets Webflow's button defaults (blue, padded, white text).
  const loginSubmit = layerOf(page, layerByNode, (n) => n.wf.classNames.includes('w-button'));
  assert.ok(classes(loginSubmit).has('bg-[#3898ec]') && classes(loginSubmit).has('py-[9px]'));
});

// ─── Navbar variants ──────────────────────────────────────────────────────────

let counter = 0;
const id = (prefix: string) => `${prefix}-${++counter}`;

function navbar(opts: { black?: boolean; brandHref?: string } = {}): { layer: Layer; ids: string[] } {
  const rootId = id('lyr');
  const brandId = id('lyr');
  const buttonId = id('lyr');
  const layer: Layer = {
    id: rootId,
    name: 'div',
    classes: opts.black ? 'relative z-[1000] bg-[#000]' : 'relative z-[1000] bg-transparent',
    children: [
      {
        id: brandId,
        name: 'div',
        classes: 'inline-block',
        variables: { link: { type: 'url', url: { type: 'dynamic_text', data: { content: opts.brandHref ?? '/' } } } },
        children: [{ id: id('lyr'), name: 'image', classes: opts.black ? 'w-[120px] invert' : 'w-[120px]', variables: { image: { src: { type: 'asset', data: { asset_id: 'ast_logo' } }, alt: { type: 'dynamic_text', data: { content: '' } } } } }],
      },
      { id: buttonId, name: 'div', classes: opts.black ? 'menu black' : 'menu', children: [{ id: id('lyr'), name: 'text', classes: '', variables: { text: { type: 'dynamic_text', data: { content: 'Menu' } } } }] },
    ],
  };
  return { layer, ids: [rootId, brandId, buttonId] };
}

function body(children: Layer[]): Layer {
  return { id: 'body', name: 'body', classes: '', children };
}

test('navbar variants: the same navbar with different classes on another page becomes one component with two variants', async () => {
  const index = navbar();
  const work = navbar();
  const detail = navbar({ black: true });
  const pages: PageLayers[] = [
    { page: 'index', body: body([index.layer]) },
    { page: 'work', body: body([work.layer]) },
    { page: 'detail_werke', body: body([detail.layer]) },
  ];
  const siteClasses = new Map<string, string[]>([
    [index.ids[0], ['navbar']], [work.ids[0], ['navbar']], [detail.ids[0], ['navbar', 'black']],
    [index.ids[2], ['menu-button']], [work.ids[2], ['menu-button']], [detail.ids[2], ['menu-button', 'black']],
  ]);
  const stub = new StubMaterializer();
  const warn = new Warnings();

  const result = await extractCrossPageComponents(pages, stub as unknown as Parameters<typeof extractCrossPageComponents>[1], warn, {
    hintOf: (layerId) => ([index.ids[0], work.ids[0], detail.ids[0]].includes(layerId) ? 'nav' : undefined),
    classesOf: (layerId) => siteClasses.get(layerId),
  });

  assert.equal(result.components, 1);
  assert.equal(result.instances, 3);
  assert.equal(stub.created.length, 1);
  assert.equal(stub.created[0].name, 'Navbar');
  const variants = stub.created[0].variants!;
  assert.deepEqual(variants.map((v) => v.name), ['Default', 'Black']);
  assert.ok(variants.every((v) => /^cmpvar-/.test(v.id)));
  assert.equal(variants[0].layers[0].classes, 'relative z-[1000] bg-transparent');
  assert.equal(variants[1].layers[0].classes, 'relative z-[1000] bg-[#000]');
  assert.deepEqual(stub.created[0].layers, variants[0].layers, '`layers` mirrors the default variant');

  const instanceIndex = pages[0].body.children![0];
  const instanceDetail = pages[2].body.children![0];
  assert.equal(instanceIndex.componentId, 'cmp-1');
  assert.equal(instanceIndex.componentVariantId, variants[0].id);
  assert.equal(instanceDetail.componentId, 'cmp-1');
  assert.equal(instanceDetail.componentVariantId, variants[1].id);
  assert.equal(warn.count('component_skipped'), 0, 'a class-only difference is a variant, not a near-miss');
});

test('navbar variants: a different link target is still a near-miss, not a variant', async () => {
  const a = navbar();
  const b = navbar();
  const c = navbar({ black: true, brandHref: '/other' });
  const pages: PageLayers[] = [
    { page: 'index', body: body([a.layer]) },
    { page: 'work', body: body([b.layer]) },
    { page: 'detail_werke', body: body([c.layer]) },
  ];
  const stub = new StubMaterializer();
  const warn = new Warnings();
  const nav = new Set([a.ids[0], b.ids[0], c.ids[0]]);
  const result = await extractCrossPageComponents(pages, stub as unknown as Parameters<typeof extractCrossPageComponents>[1], warn, { hintOf: (layerId) => (nav.has(layerId) ? 'nav' : undefined) });
  assert.equal(result.components, 1);
  assert.equal(result.instances, 2);
  assert.equal(stub.created[0].variants, undefined);
  assert.equal(warn.count('component_skipped'), 1);
});

test('navbar variants: the variant name comes from the extra Webflow classes', () => {
  assert.equal(variantNameFromClasses(['navbar'], ['navbar', 'black'], 2), 'Black');
  assert.equal(variantNameFromClasses(['navbar'], ['navbar', 'dark-mode'], 2), 'Dark Mode');
  assert.equal(variantNameFromClasses(['navbar'], ['navbar'], 2), 'Variant 2');
});

// ─── Flags ────────────────────────────────────────────────────────────────────

test('flags: every extra widget defaults to on and can be turned off individually', async () => {
  const flags = resolveWidgetFlags();
  for (const key of ['video', 'lottie', 'codeBlock', 'fileUpload', 'map', 'search', 'locales', 'pagination', 'conditionalVisibility', 'bgVideoControl', 'iconFont', 'navbarVariants', 'unsupportedWidgets', 'badge'] as const) {
    assert.equal(flags[key], true, key);
  }
  const { page, layerByNode } = await build(`${LOTTIE_HTML}${MAP_HTML}`, { ctx: { widgets: { lottie: false, map: false } } });
  const lottie = layerOf(page, layerByNode, (n) => n.wf.siteClasses.includes('lottie-animation'));
  assert.equal(lottie.name, 'div');
  assert.equal(lottie.settings?.htmlEmbed, undefined);
  const map = layerOf(page, layerByNode, (n) => n.wf.siteClasses.includes('map'));
  assert.equal(map.name, 'div');
  assert.equal(map.settings?.map, undefined);
});

test('all part-C widgets together leave no unmapped framework class', async () => {
  const { warn } = await build(`${VIDEO_HTML}${LOTTIE_HTML}${CODE_HTML}${UPLOAD_HTML}${MAP_HTML}${LIST_HTML}${BG_VIDEO_HTML}${USERS_HTML}`);
  assert.equal(warn.count('html_unmapped'), 0, messages(warn, 'html_unmapped').join('\n'));
});

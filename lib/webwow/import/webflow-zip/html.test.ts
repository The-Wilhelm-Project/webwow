import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { Warnings } from './warnings';
import { buildStyleModel, type WfStyleModel } from './css';
import type { WfZipBundle, WfZipFile } from './zip';
import type { WfNode, WfPage } from './types';
import { isTextual, loadSvgIcons, normaliseHref, parsePage, sanitizeSvg, textContent, type HtmlContext } from './html';
import { parse } from 'node-html-parser';
import { getAffectedProperties } from '@/lib/tailwind-class-mapper';

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

function fakeFile(p: string, content: string | Buffer = ''): WfZipFile {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return { path: p, size: buf.length, data: async () => buf, text: async () => buf.toString('utf8') };
}

function fakeZip(files: Record<string, string | Buffer>): WfZipBundle {
  return {
    root: '',
    pages: new Map(),
    errorPages: new Map(),
    css: { site: [] },
    js: [],
    files: new Map(Object.entries(files).map(([p, c]) => [p, fakeFile(p, c)])),
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
    pageNames: new Set(['index', 'work', 'exhibitions', 'artist', 'detail_werke']),
    assetKey: (p) => (zip.files.has(p) ? p : null),
    warn,
    ...overrides,
  };
}

function doc(body: string, head = ''): string {
  return `<!DOCTYPE html><html data-wf-page="abc" lang="de"><head><title>T</title>${head}</head><body class="body">${body}</body></html>`;
}

function walk(nodes: WfNode[], visit: (n: WfNode) => void): void {
  for (const n of nodes) {
    visit(n);
    if (n.children) walk(n.children, visit);
  }
}

function collect(page: WfPage, pred: (n: WfNode) => boolean): WfNode[] {
  const out: WfNode[] = [];
  walk(page.roots, (n) => {
    if (pred(n)) out.push(n);
  });
  return out;
}

// ─── Unit fixtures ────────────────────────────────────────────────────────────

test('bind-empty leaves are kept as slots, .w-dyn-empty is dropped, .w-dyn-item becomes a collection node', () => {
  const zip = fakeZip({});
  const ctx = ctxFor(zip);
  const page = parsePage(doc(`
    <div class="collection-list-wrapper w-dyn-list">
      <div class="collection-list w-dyn-items">
        <div class="collection-item w-dyn-item" id="w-node-x" data-w-id="8d505578">
          <div class="thin w-dyn-bind-empty"></div>
          <h1 class="title w-dyn-bind-empty"></h1>
          <img class="w-dyn-bind-empty" src="https://d3e54v103j8qbb.cloudfront.net/plugins/Basic/assets/placeholder.60f9b1840c.svg" alt="">
          <div class="rich-text-block w-dyn-bind-empty w-richtext"></div>
        </div>
      </div>
      <div class="w-dyn-empty"><div>No items found.</div></div>
    </div>`), ctx);

  const list = page.roots[0];
  assert.equal(list.wf.role, 'dyn-list');
  assert.deepEqual(list.wf.siteClasses, ['collection-list-wrapper']);
  const items = list.children![0];
  assert.equal(items.wf.role, 'dyn-items');
  assert.equal(list.children!.length, 1, '.w-dyn-empty dropped');
  const item = items.children![0];
  assert.equal(item.kind, 'collection');
  assert.equal(item.wf.role, 'dyn-item');
  assert.equal(item.wf.wId, '8d505578');
  assert.equal(item.wf.htmlId, 'w-node-x');
  const [text, heading, img, rich] = item.children!;
  assert.equal(text.kind, 'text');
  assert.equal(text.text, '');
  assert.equal(text.wf.bindEmpty, true);
  assert.deepEqual(text.wf.siteClasses, ['thin']);
  assert.equal(heading.kind, 'heading');
  assert.equal(heading.tag, 'h1');
  assert.equal(heading.wf.bindEmpty, true);
  assert.equal(img.kind, 'image');
  assert.equal(img.image?.src, undefined, 'placeholder never downloaded');
  assert.equal(img.image?.alt, '');
  assert.equal(rich.wf.role, 'rich-text');
  assert.equal(rich.wf.layerKind, 'richText');
  assert.equal(rich.wf.html, '');
  assert.equal(page.nodeIndex.size, 7);
  assert.equal(page.nodeIndex.get(item.wf.id), item);
});

test('images: srcset derivatives are ignored, svg files become icons, missing files keep the original src', () => {
  const zip = fakeZip({ 'images/photo.jpg': 'x', 'images/photo-p-500.jpg': 'x', 'images/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><path d="M0 0"/></svg>' });
  const ctx = ctxFor(zip, { svgFiles: new Map([['images/logo.svg', sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><path d="M0 0"/></svg>')]]) });
  const page = parsePage(doc(`
    <img src="images/photo-p-500.jpg" srcset="images/photo-p-500.jpg 500w, images/photo.jpg 800w" width="800" height="600" alt="A photo" class="image-4">
    <img src="images/logo.svg" class="signet" alt="">
    <img src="images/gone.png" alt="">
    <img src="https://example.com/remote.png" alt="">`), ctx);
  const [photo, logo, gone, remote] = page.roots;
  assert.equal(photo.kind, 'image');
  assert.equal(photo.image?.src, 'images/photo.jpg');
  assert.equal(photo.image?.alt, 'A photo');
  assert.equal(photo.image?.width, '800');
  assert.equal(logo.kind, 'icon');
  assert.ok(logo.svg?.includes('<path'));
  assert.ok(!logo.svg?.includes('<script'));
  assert.equal(gone.kind, 'image');
  assert.equal(gone.image?.src, 'images/gone.png');
  assert.equal(remote.image?.src, 'https://example.com/remote.png');
});

test('loadSvgIcons reads and sanitises every svg of the bundle', async () => {
  const zip = fakeZip({ 'images/a.svg': '<svg onload="x()"><path/></svg>', 'images/b.png': 'nope', 'images/c.svg': 'not svg' });
  const icons = await loadSvgIcons(zip);
  assert.deepEqual([...icons.keys()], ['images/a.svg']);
  assert.equal(icons.get('images/a.svg'), '<svg><path/></svg>');
});

test('embeds: style-only -> headStyles, svg-only -> icon, script embeds -> htmlEmbed with a warning', () => {
  const ctx = ctxFor(fakeZip({}));
  const page = parsePage(doc(`
    <div class="global-styles w-embed"><style>.x{color:red}</style></div>
    <div class="icon w-embed"><svg viewBox="0 0 10 10"><rect onclick="evil()" width="1" height="1"/></svg></div>
    <div class="code-embed w-embed w-script"><script src="https://elfsightcdn.com/platform.js" async></script><div class="elfsight-app-1"></div></div>`,
  '<style>html{font-size:1rem}</style><script type="text/javascript">!function(o,c){var n=c.documentElement,t=" w-mod-";n.className+=t+"js"}(window,document);</script><script src="https://example.com/analytics.js"></script>'), ctx);
  assert.deepEqual(page.headStyles, ['html{font-size:1rem}', '.x{color:red}']);
  assert.equal(page.roots.length, 2);
  const [icon, embed] = page.roots;
  assert.equal(icon.kind, 'icon');
  assert.ok(icon.svg?.startsWith('<svg'));
  assert.ok(!icon.svg?.includes('onclick'));
  assert.equal(embed.wf.role, 'embed-script');
  assert.equal(embed.wf.layerKind, 'htmlEmbed');
  assert.ok(embed.wf.html?.includes('elfsightcdn.com/platform.js'));
  assert.ok(embed.wf.html?.includes('elfsight-app-1'));
  assert.deepEqual(embed.children, []);
  assert.equal(ctx.warn.count('embed_script'), 2, 'embed + the non-Webflow head script');
  assert.deepEqual(page.headScripts, ['<script src="https://example.com/analytics.js"></script>']);
  assert.deepEqual(page.bodyScripts, []);
});

test('background video: mp4 preferred, only files in the ZIP kept, controls dropped once per page', () => {
  const zip = fakeZip({ 'videos/header_mp4.mp4': 'v', 'videos/header_webm.webm': 'v', 'videos/header_poster.0000000.jpg': 'p' });
  const ctx = ctxFor(zip);
  const page = parsePage(doc(`
    <div data-poster-url="videos/header_poster.0000000.jpg" data-video-urls="videos/header_webm.webm,videos/header_mp4.mp4,videos/header_mov.mov" data-autoplay="true" data-loop="true" data-wf-ignore="true" class="bg-video w-background-video w-background-video-atom" id="head">
      <video id="x-video" autoplay loop muted playsinline style="background-image:url(&quot;videos/header_poster.0000000.jpg&quot;)">
        <source src="videos/header_webm.webm"><source src="videos/header_mp4.mp4">
      </video>
      <noscript><style>.x{}</style><img src="videos/header_poster.0000000.jpg"></noscript>
      <div aria-live="polite"><button class="w-backgroundvideo-backgroundvideoplaypausebutton w-background-video--control"><span>Pause</span></button></div>
    </div>`), ctx);
  const video = page.roots[0];
  assert.equal(video.wf.role, 'bg-video');
  assert.equal(video.wf.layerKind, 'video');
  assert.deepEqual(video.children, []);
  assert.deepEqual(video.wf.video?.sources, ['videos/header_mp4.mp4', 'videos/header_webm.webm']);
  assert.equal(video.wf.video?.poster, 'videos/header_poster.0000000.jpg');
  assert.equal(video.wf.video?.autoplay, true);
  assert.equal(video.wf.video?.loop, true);
  assert.equal(video.wf.htmlId, 'head');
  assert.ok(video.frameworkClasses?.includes('overflow-hidden'));
  assert.equal(ctx.warn.count('video_missing_file'), 1);
  assert.equal(ctx.warn.count('embed_dropped'), 1);
  assert.equal(page.headStyles.length, 0, 'noscript style is not a page style');
});

test('navbar: data-collapse, menu/button roles, framework classes per collapse point', () => {
  const nav = (collapse: string) => `
    <div data-collapse="${collapse}" data-duration="400" id="nav" class="navbar w-nav" role="banner">
      <a href="index.html" class="brand w-nav-brand w--current" aria-current="page"><img src="images/logo.svg" alt=""></a>
      <nav role="navigation" class="nav-menu w-nav-menu"><a href="work.html" class="item w-inline-block"><div>Work</div></a></nav>
      <div class="menu-button w-nav-button"><img src="images/burger.svg" alt=""></div>
    </div>`;
  const ctx = ctxFor(fakeZip({}));
  const all = parsePage(doc(nav('all')), ctx).roots[0];
  assert.equal(all.wf.role, 'nav');
  assert.equal(all.wf.navCollapse, 'all');
  assert.equal(all.wf.htmlId, 'nav');
  assert.deepEqual(all.wf.siteClasses, ['navbar']);
  assert.deepEqual(all.frameworkClasses, ['relative', 'z-[1000]']);
  const [brand, menu, button] = all.children!;
  assert.equal(brand.kind, 'link');
  assert.equal(brand.wf.role, 'nav-brand');
  assert.equal(brand.link?.href, '/');
  assert.ok(!brand.wf.siteClasses.includes('w--current'));
  assert.equal(menu.wf.role, 'nav-menu');
  assert.equal(menu.tag, 'nav');
  assert.deepEqual(menu.frameworkClasses, ['relative', 'float-right']);
  assert.equal(button.wf.role, 'nav-button');
  assert.deepEqual(button.frameworkClasses ?? [], []);
  assert.equal(menu.children![0].link?.href, '/work');

  const medium = parsePage(doc(nav('medium')), ctx).roots[0];
  const [, mMenu, mButton] = medium.children!;
  assert.ok(!mMenu.frameworkClasses?.includes('max-lg:hidden'), 'interaction owns the menu visibility when a button exists');
  assert.deepEqual(mButton.frameworkClasses, ['hidden', 'max-lg:block']);

  const none = parsePage(doc(nav('none')), ctx).roots[0];
  assert.deepEqual(none.children![2].frameworkClasses, ['hidden']);
  const dflt = parsePage(doc(nav('').replace(' data-collapse=""', '')), ctx).roots[0];
  assert.equal(dflt.wf.navCollapse, 'medium');
});

test('dropdowns: roles, hover flag, chevron icon, list keeps its tag and loses the hidden shim', () => {
  const ctx = ctxFor(fakeZip({}));
  const page = parsePage(doc(`
    <div data-hover="true" data-delay="0" class="dropdown w-dropdown">
      <div class="dropdown-toggle w-dropdown-toggle"><div class="w-icon-dropdown-toggle"></div><div>Toggle</div></div>
      <nav class="dropdown-list w-dropdown-list"><p class="w-dyn-bind-empty"></p></nav>
    </div>`), ctx);
  const dd = page.roots[0];
  assert.equal(dd.wf.role, 'dropdown');
  assert.equal(dd.wf.dropdownHover, true);
  const [toggle, list] = dd.children!;
  assert.equal(toggle.wf.role, 'dropdown-toggle');
  assert.equal(toggle.children![0].wf.role, 'dropdown-icon');
  assert.ok(toggle.children![0].svg?.includes('<svg'));
  assert.equal(list.wf.role, 'dropdown-list');
  assert.equal(list.tag, 'nav');
  assert.ok(!list.frameworkClasses?.includes('hidden'));
  assert.ok(list.frameworkClasses?.includes('absolute'));
});

test('href normalisation table', () => {
  const names = new Set(['index', 'work', 'detail_werke']);
  assert.deepEqual(normaliseHref('index.html', names), { href: '/', kind: 'page' });
  assert.deepEqual(normaliseHref('work.html', names), { href: '/work', kind: 'page' });
  assert.deepEqual(normaliseHref('work.html#top', names), { href: '/work#top', kind: 'page' });
  assert.deepEqual(normaliseHref('detail_werke.html', names), { href: '/werke', kind: 'page' });
  assert.deepEqual(normaliseHref('missing.html', names), { href: 'missing.html', kind: 'broken' });
  assert.deepEqual(normaliseHref('#nav', names), { href: '#nav', kind: 'anchor' });
  assert.deepEqual(normaliseHref('#https://www.facebook.com/x', names), { href: '#https://www.facebook.com/x', kind: 'broken' });
  assert.deepEqual(normaliseHref('mailto:a@b.c', names), { href: 'mailto:a@b.c', kind: 'external' });
  assert.deepEqual(normaliseHref('tel:+49', names), { href: 'tel:+49', kind: 'external' });
  assert.deepEqual(normaliseHref('https://webflow.com/shais', names), { href: 'https://webflow.com/shais', kind: 'external' });
  assert.deepEqual(normaliseHref('', names), { href: '', kind: 'empty' });
  assert.deepEqual(normaliseHref('#', names), { href: '#', kind: 'empty' });
  assert.deepEqual(normaliseHref('/detail_werke/some-slug', names), { href: '/detail_werke/some-slug', kind: 'page' });
});

test('links: text, buttons, target/rel, broken anchors warn', () => {
  const ctx = ctxFor(fakeZip({}));
  const page = parsePage(doc(`
    <a href="work.html" class="heading-2 button w-button">Catalog</a>
    <a href="#https://www.facebook.com/x" class="arrow" target="_blank" rel="noopener">Facebook</a>
    <a href="#" class="div-block-2 w-inline-block"><div class="div-block"></div></a>`), ctx);
  const [button, broken, block] = page.roots;
  assert.equal(button.kind, 'link');
  assert.equal(button.button, true);
  assert.equal(button.text, 'Catalog');
  assert.equal(button.link?.href, '/work');
  assert.deepEqual(button.frameworkClasses, ['inline-block', 'cursor-pointer', 'no-underline']);
  assert.equal(broken.link?.target, '_blank');
  assert.equal(broken.link?.rel, 'noopener');
  assert.equal(ctx.warn.count('link_broken'), 1);
  assert.equal(block.link?.href, '#');
  assert.equal(block.children!.length, 1);
  assert.deepEqual(block.children![0].children, []);
});

test('mixed footer cell: loose text runs become text children in document order, <br> -> newline', () => {
  const ctx = ctxFor(fakeZip({}));
  const page = parsePage(doc(`
    <div class="footer-right_links">
      <a href="#nav" class="link-block-2 w-inline-block"></a>
      Valeska von Brase<br>Studio<br>
      <a href="https://x.y" class="arrow">Instagram</a>
      Tail text
    </div>
    <div class="text-size-regular small">Copyright <br>(c)2025 VvB</div>`), ctx);
  const cell = page.roots[0];
  assert.equal(cell.kind, 'box');
  assert.deepEqual(cell.children!.map((c) => c.kind), ['link', 'text', 'link', 'text']);
  assert.equal(cell.children![1].text, 'Valeska von Brase\nStudio');
  assert.equal(cell.children![3].text, 'Tail text');
  const copyright = page.roots[1];
  assert.equal(copyright.kind, 'text');
  assert.equal(copyright.text, 'Copyright\n(c)2025 VvB');
});

test('textual detection, headings, whitespace-only boxes and displayName carry the node id', () => {
  const ctx = ctxFor(fakeZip({}));
  const page = parsePage(doc(`
    <h1 class="heading-2">  Studio <strong>von</strong>   Brase </h1>
    <div class="div-block"> </div>
    <p></p>
    <section class="section"><div class="heading-xlarge">Home</div></section>
    <div class="x w-condition-invisible">hidden</div>`), ctx);
  const [h1, empty, p, section, invisible] = page.roots;
  assert.equal(h1.kind, 'heading');
  assert.equal(h1.text, 'Studio von Brase');
  assert.equal(h1.displayName, `heading-2 ${h1.wf.id}`);
  assert.equal(empty.kind, 'box');
  assert.deepEqual(empty.children, []);
  assert.equal(p.kind, 'text');
  assert.equal(p.text, '');
  assert.equal(section.kind, 'box');
  assert.equal(section.tag, 'section');
  assert.equal(section.children![0].kind, 'text');
  assert.equal(section.children![0].text, 'Home');
  assert.deepEqual(invisible.classes, ['hidden']);
  assert.deepEqual(invisible.wf.siteClasses, ['x']);
  assert.equal(section.displayName, `section ${section.wf.id}`);
  assert.equal(page.lang, 'de');
  assert.equal(page.wfPageId, 'abc');
  assert.deepEqual(page.bodyClassNames, ['body']);
  assert.equal(page.isEmpty, false);

  const el = parse('<div>a <b>b</b> <br> c</div>').querySelector('div')!;
  assert.equal(isTextual(el), true);
  assert.equal(textContent(el), 'a b\nc');
  assert.equal(isTextual(parse('<div><span><img></span></div>').querySelector('div')!), false);
  assert.equal(isTextual(parse('<div>  </div>').querySelector('div')!), false);
});

test('styling: base + combo refs, grid id one-offs, residual wf- classes, tag underlays, bound backgrounds', () => {
  const styles = emptyStyles();
  const base = { key: 'wf:section', name: 'section', classes: ['flex'] };
  const combo = { key: 'wf:section.small', name: 'section small', classes: ['p-[0]'], combo: true };
  const unordered = { key: 'wf:b.a', name: 'b a', classes: ['gap-[1px]'], combo: true };
  styles.classes.set('section', { ref: base, boundBackground: false });
  styles.classes.set('div-block', { ref: { key: 'wf:div-block', name: 'div-block', classes: ['w-full'] }, boundBackground: true });
  styles.boundBackgroundKeys.add('div-block');
  styles.combos.set('section.small', combo);
  styles.combos.set('b.a', unordered);
  styles.ids.set('w-node-1', ['grid-cols-[1fr_1fr]']);
  styles.residual.classNames.add('topheader');
  styles.tags.set('p', { key: 'wf-tag:p', name: 'Paragraph', classes: ['mb-[10px]'] });
  const ctx = ctxFor(fakeZip({}), { styles });
  const page = parsePage(doc(`
    <section class="section small topheader" id="w-node-1"><p class="para">Hi</p><div class="a b"></div><div class="div-block"></div><div class="div-block">x</div></section>`), ctx);
  const section = page.roots[0];
  assert.deepEqual(section.styles, [base, combo]);
  assert.deepEqual(section.classes, ['grid-cols-[1fr_1fr]', 'wf-topheader']);
  const [p, ab, bg, bgText] = section.children!;
  assert.deepEqual(p.underlayStyles, [styles.tags.get('p')]);
  assert.equal(p.styles, undefined);
  assert.deepEqual(ab.styles, [unordered], 'combo found regardless of class order');
  assert.equal(bg.wf.boundBackground, true);
  assert.equal(bgText.wf.boundBackground, true, 'the placeholder URL is definitive even when the element has content');
  assert.equal(ctx.warn.count('html_unmapped'), 0);
});

test('unknown w-* classes are reported once per class, meta and google fonts are extracted', () => {
  const ctx = ctxFor(fakeZip({ 'images/favicon.png': 'f', 'images/webclip.png': 'w', 'images/6973b0695bd4b92617308ffa_og.jpg': 'o', 'images/og.jpg': 'o' }));
  const page = parsePage(`<html><head><title> My  Site </title><meta content="Desc" name="description"><meta content="https://cdn.prod.website-files.com/x/6973b0695bd4b92617308ffa_og.jpg" property="og:image">
    <link href="https://fonts.googleapis.com/css?family=Open+Sans:300,400|Roboto" rel="stylesheet"><link href="images/favicon.png" rel="shortcut icon" type="image/x-icon"><link href="images/webclip.png" rel="apple-touch-icon"><link rel="canonical" href="https://example.com/">
    <script type="text/javascript">WebFont.load({ google: { families: ["Lato:400,700","Roboto"] } });</script></head>
    <body><div class="w-slider w-slider"><div class="w-form-done"></div></div><script src="https://d3e54v103j8qbb.cloudfront.net/js/jquery-3.5.1.min.js"></script><script src="js/site.js"></script></body></html>`, ctx);
  assert.equal(page.title, 'My Site');
  assert.equal(page.description, 'Desc');
  assert.equal(page.ogImage, 'images/og.jpg');
  assert.equal(page.favicon, 'images/favicon.png');
  assert.equal(page.webclip, 'images/webclip.png');
  assert.equal(page.canonical, 'https://example.com/');
  assert.deepEqual(page.googleFontFamilies, ['Open Sans', 'Roboto', 'Lato']);
  assert.deepEqual(page.bodyScripts, []);
  assert.equal(page.headScripts, undefined);
  assert.equal(ctx.warn.count('html_unmapped'), 2);
  assert.equal(ctx.warn.count('embed_script'), 0);
});

test('empty body -> isEmpty + page_empty warning', () => {
  const ctx = ctxFor(fakeZip({}), { page: 'detail_exhibitions' });
  const page = parsePage('<html><head></head><body><script src="js/site.js"></script></body></html>', ctx);
  assert.equal(page.isEmpty, true);
  assert.deepEqual(page.roots, []);
  assert.equal(ctx.warn.count('page_empty'), 1);
});

test('sanitizeSvg strips scripts, handlers, foreignObject and javascript hrefs', () => {
  const dirty = '<svg xmlns="http://www.w3.org/2000/svg" onload="a()"><script>b()</script><foreignObject><div>x</div></foreignObject><a xlink:href="javascript:c()" href="#ok"><path d="M0 0" onclick=\'d()\'/></a></svg>';
  const clean = sanitizeSvg(dirty);
  assert.ok(!/script|foreignObject|onload|onclick|javascript:/i.test(clean));
  assert.ok(clean.includes('href="#ok"'));
  assert.ok(clean.includes('<path d="M0 0"'));
});

// ─── Sample export ────────────────────────────────────────────────────────────

const SAMPLE_ROOT = path.join(process.cwd(), 'import/web/valeska-von-brase.webflow');
const SAMPLE_INDEX = path.join(SAMPLE_ROOT, 'index.html');

function sampleZip(): WfZipBundle {
  const files = new Map<string, WfZipFile>();
  const walkDir = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walkDir(full);
        continue;
      }
      const rel = path.relative(SAMPLE_ROOT, full).split(path.sep).join('/');
      files.set(rel, { path: rel, size: statSync(full).size, data: async () => readFileSync(full), text: async () => readFileSync(full, 'utf8') });
    }
  };
  walkDir(SAMPLE_ROOT);
  return { root: '', pages: new Map(), errorPages: new Map(), css: { site: [] }, js: [], files, missing: [], skipped: [] };
}

test('sample index.html: slots, video, embeds and class hygiene', { skip: !existsSync(SAMPLE_INDEX) }, async () => {
  const zip = sampleZip();
  const warn = new Warnings();
  const styles = buildStyleModel({ siteCss: [readFileSync(path.join(SAMPLE_ROOT, 'css/valeska-von-brase.css'), 'utf8')], assetUrl: () => null, warn });
  const pageNames = new Set([...zip.files.keys()].filter((f) => /^[^/]+\.html$/.test(f)).map((f) => f.slice(0, -5)));
  const ctx: HtmlContext = { page: 'index', styles, zip, pageNames, assetKey: (p) => (zip.files.has(p) ? p : null), warn: new Warnings(), svgFiles: await loadSvgIcons(zip) };
  const page = parsePage(readFileSync(SAMPLE_INDEX, 'utf8'), ctx);

  assert.equal(page.wfPageId, '696e3d590d900572c87f0671');
  assert.equal(page.title, 'Valeska von Brase');
  assert.equal(page.ogImage, 'images/02-Sudisland-I-OlTempera-Pigmente-auf-Leinwand-I-100-x120-I-2018-1-scaled-1.jpg');
  assert.equal(page.favicon, 'images/favicon.png');
  assert.equal(page.webclip, 'images/webclip.png');
  assert.deepEqual(page.bodyClassNames, ['body']);
  assert.equal(page.isEmpty, false);
  assert.equal(page.headStyles.length, 1, 'the .global-styles embed');
  assert.ok(page.headStyles[0].includes('font-size: calc('));

  assert.equal(collect(page, (n) => n.wf.bindEmpty).length, 17);
  assert.equal(collect(page, (n) => n.wf.role === 'bg-video').length, 1);
  assert.equal(collect(page, (n) => n.wf.role === 'embed-script').length, 1);
  assert.equal(ctx.warn.count('embed_script'), 1, 'one script embed on index.html');
  assert.equal(collect(page, (n) => n.wf.role === 'dyn-list').length, 5);
  assert.equal(collect(page, (n) => n.kind === 'collection').length, 5);
  assert.equal(collect(page, (n) => n.wf.role === 'nav').length, 1);
  assert.equal(collect(page, (n) => n.wf.role === 'nav-button').length, 1);
  const nav = collect(page, (n) => n.wf.role === 'nav')[0];
  assert.equal(nav.wf.navCollapse, 'all');
  assert.equal(nav.wf.htmlId, 'nav');
  assert.equal(collect(page, (n) => n.wf.classNames.includes('fixed-menu_item')).length, 5);
  const icons = collect(page, (n) => n.kind === 'icon');
  assert.equal(icons.length, 2, 'logo + hamburger svg files become icons');
  const bgVideo = collect(page, (n) => n.wf.role === 'bg-video')[0];
  assert.deepEqual(bgVideo.wf.video?.sources, ['videos/valeska-film-header_mp4.mp4', 'videos/valeska-film-header_webm.webm']);
  assert.equal(bgVideo.wf.video?.poster, 'videos/valeska-film-header_poster.0000000.jpg');
  const bound = collect(page, (n) => n.wf.boundBackground === true);
  assert.ok(bound.some((n) => n.wf.siteClasses[0] === 'div-block'), 'Werke card background slot');

  // D1: no emitted class may equal an original Webflow class name (`w-*` framework
  // classes included); Tailwind's own `w-full` / `w-[…]` width utilities are fine.
  const webflowClasses = new Set<string>();
  walk(page.roots, (n) => n.wf.classNames.forEach((c) => webflowClasses.add(c)));
  const isWebflowFramework = (c: string) => /^w-[a-z]/.test(c) && !/^w-(full|auto|screen|fit|min|max|px|\d)/.test(c) && !c.startsWith('w-[');
  const offenders: string[] = [];
  walk(page.roots, (n) => {
    const emitted = [...(n.styles ?? []).flatMap((r) => r.classes), ...(n.underlayStyles ?? []).flatMap((r) => r.classes), ...(n.classes ?? []), ...(n.frameworkClasses ?? [])];
    // A Webflow class NAME that coincides with a real Tailwind utility (`overflow-hidden`) is only
    // emitted by a rule with that declaration, so utilities the class mapper knows are fine.
    for (const c of emitted) if ((webflowClasses.has(c) && getAffectedProperties(c).length === 0) || isWebflowFramework(c) || c === 'wf-layout-layout') offenders.push(`${n.wf.id}:${c}`);
    for (const c of n.wf.siteClasses) if (c.startsWith('w-') || c === 'wf-layout-layout') offenders.push(`${n.wf.id}:site:${c}`);
  });
  assert.deepEqual(offenders, []);
  assert.equal(ctx.warn.count('html_unmapped'), 0);
  const links = collect(page, (n) => n.kind === 'link');
  assert.ok(links.some((l) => l.link?.href === '/work'));
  assert.ok(links.some((l) => l.link?.href === '/artist'));
  assert.equal(ctx.warn.count('link_broken'), 1, 'the #https://facebook link');
  const footerCells = collect(page, (n) => n.wf.siteClasses[0] === 'footer-right_links');
  assert.ok(footerCells.some((c) => (c.children ?? []).some((k) => k.kind === 'text' && (k.text ?? '').includes('\n'))), 'footer text runs keep line breaks');
});

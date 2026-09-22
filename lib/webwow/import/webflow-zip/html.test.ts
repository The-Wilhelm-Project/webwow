import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { Warnings } from './warnings';
import { collectClassLists } from './states';
import { buildStyleModel, type WfStyleModel } from './css';
import type { WfZipBundle, WfZipFile } from './zip';
import type { WfNode, WfPage } from './types';
import { explicitImageWidth, hasInlineDisplayNone, isTextual, loadSvgIcons, normaliseHref, parsePage, sanitizeSvg, textContent, type HtmlContext } from './html';
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
    states: new Map(),
    resting: new Map(),
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

test('an image without a width attribute keeps width:auto under its classes: ycode\'s asset width attribute must not stretch it', () => {
  // detail_werke's main image: `height:100%; max-height:70vh` and no CSS width. ycode renders the
  // bound asset's width="800" height="1026"; the attribute's presentational width would hold at
  // 800px while max-height caps the height, so the picture was squeezed (800x630 for 491x630).
  const css = '.image-7{min-width:350px;height:100%;max-height:70vh}.sized{width:50%}@media screen and (max-width:767px){.image-7{width:100%}}';
  const styles = buildStyleModel({ siteCss: [css], assetUrl: () => null, warn: new Warnings() });
  const page = parsePage(doc(`
    <img src="https://d3e54v103j8qbb.cloudfront.net/plugins/Basic/assets/placeholder.60f9b1840c.svg" loading="eager" alt="" class="image-7 w-dyn-bind-empty">
    <img src="images/photo.jpg" width="800" height="600" alt="" class="image-7">
    <img src="images/photo.jpg" width="auto" alt="" class="image-7 sized">
    <img src="images/photo.jpg" alt="">`), ctxFor(fakeZip({ 'images/photo.jpg': 'x' }), { styles }));
  const [bound, sized, auto, bare] = page.roots;
  assert.deepEqual(bound.frameworkClasses, ['w-auto'], 'the lowest layer: every chip class wins over it');
  assert.deepEqual(bound.styles!.map((r) => r.classes.join(' ')), ['min-w-[350px] h-full max-h-[70vh] max-md:w-full']);
  assert.equal(sized.frameworkClasses, undefined, 'an export width attribute sized the original too: kept as it was');
  assert.equal(sized.image?.width, '800');
  assert.deepEqual(auto.frameworkClasses, ['w-auto'], 'width="auto" is no width');
  assert.deepEqual(bare.frameworkClasses, ['w-auto']);
  assert.equal(explicitImageWidth('800'), true);
  assert.equal(explicitImageWidth('50%'), true);
  assert.equal(explicitImageWidth('auto'), false);
  assert.equal(explicitImageWidth('0'), false);
  assert.equal(explicitImageWidth(undefined), false);
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
  // Class selectors in a page's own <style> are namespaced like the site residual
  // CSS (see `namespacePageStyles`); tag selectors are left alone.
  assert.deepEqual(page.headStyles, ['html{font-size:1rem}', '.wf-x{color:red}']);
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

test('background video: mp4 preferred, only files in the ZIP kept, the control button is kept as a child', () => {
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
  // The `<video>` and `<noscript>` are dropped; the control button (widgets-extra.ts) survives inside its wrapper.
  assert.equal(video.children?.length, 1);
  assert.equal(video.children?.[0].children?.[0].wf.role, 'bg-video-control');
  assert.deepEqual(video.wf.video?.sources, ['videos/header_mp4.mp4', 'videos/header_webm.webm']);
  assert.equal(video.wf.video?.poster, 'videos/header_poster.0000000.jpg');
  assert.equal(video.wf.video?.autoplay, true);
  assert.equal(video.wf.video?.loop, true);
  assert.equal(video.wf.htmlId, 'head');
  assert.ok(video.frameworkClasses?.includes('overflow-hidden'));
  assert.equal(ctx.warn.count('video_missing_file'), 1);
  assert.equal(ctx.warn.count('embed_dropped'), 0, 'the controls are rebuilt, not dropped');
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
  // `collapse=all`: the opened menu is Webflow's panel below the bar at every width.
  const MENU_OPEN = ['absolute', 'top-full', 'left-0', 'right-0', 'min-w-[200px]', 'bg-[#c8c8c8]', 'text-center'];
  assert.deepEqual(menu.frameworkClasses, ['relative', 'float-right', ...MENU_OPEN]);
  assert.equal(button.wf.role, 'nav-button');
  // Webflow's `.w-nav-button` defaults (tap padding, 24px glyph) plus the collapse display.
  const NAV_BUTTON = ['relative', 'float-right', 'p-[18px]', 'text-[24px]', 'cursor-pointer', 'select-none'];
  assert.deepEqual(button.frameworkClasses ?? [], NAV_BUTTON);
  assert.equal(menu.children![0].link?.href, '/work');

  const medium = parsePage(doc(nav('medium')), ctx).roots[0];
  const [, mMenu, mButton] = medium.children!;
  assert.ok(!mMenu.frameworkClasses?.includes('max-lg:hidden'), 'interaction owns the menu visibility when a button exists');
  assert.deepEqual(mMenu.frameworkClasses, ['relative', 'float-right', ...MENU_OPEN.map((c) => `max-lg:${c}`)], 'opened-menu panel on tablet and phone');
  assert.deepEqual(mButton.frameworkClasses, [...NAV_BUTTON, 'hidden', 'max-lg:block']);
  const small = parsePage(doc(nav('small')), ctx).roots[0];
  assert.deepEqual(small.children![1].frameworkClasses, ['relative', 'float-right', ...MENU_OPEN.map((c) => `max-md:${c}`)]);

  const none = parsePage(doc(nav('none')), ctx).roots[0];
  assert.deepEqual(none.children![1].frameworkClasses, ['relative', 'float-right'], 'never collapsed: no panel layout');
  assert.deepEqual(none.children![2].frameworkClasses, [...NAV_BUTTON, 'hidden']);
  const dflt = parsePage(doc(nav('').replace(' data-collapse=""', '')), ctx).roots[0];
  assert.equal(dflt.wf.navCollapse, 'medium');

  // No hamburger: the menu is simply hidden on the collapsed breakpoints (nothing can open it).
  const noButton = parsePage(doc(nav('medium').replace(/<div class="menu-button w-nav-button">.*?<\/div>/, '')), ctx).roots[0];
  assert.deepEqual(noButton.children![1].frameworkClasses, ['relative', 'float-right', 'max-lg:hidden']);
});

test('collapsed navbar: a menu the site stylesheet positions (fixed slide-in) keeps its own layout instead of the panel', () => {
  const nav = `
    <div data-collapse="all" class="navbar w-nav" role="banner">
      <nav role="navigation" class="nav-menu w-nav-menu"><a href="work.html" class="nav-link w-nav-link">Work</a></nav>
      <div class="menu-button w-nav-button"><div class="w-icon-nav-menu"></div></div>
    </div>`;
  const styled = (css: string) => ctxFor(fakeZip({}), { styles: buildStyleModel({ siteCss: [css], assetUrl: () => null, warn: new Warnings() }) });
  const fixed = parsePage(doc(nav), styled('.nav-menu { position: fixed; inset: 0% 0% 0% auto; height: 100vh; display: flex }')).roots[0];
  assert.deepEqual(fixed.children![0].frameworkClasses, ['relative', 'float-right'], 'site position wins: no absolute/top/left/right/bg shims');
  const insetOnly = parsePage(doc(nav), styled('.nav-menu { top: 60px } @media screen and (max-width: 991px) { .nav-menu { left: 0 } }')).roots[0];
  assert.deepEqual(insetOnly.children![0].frameworkClasses, ['relative', 'float-right'], 'an inset alone counts as positioned');
  const colours = parsePage(doc(nav), styled('.nav-menu { background-color: #1a1a1a; display: flex } @media screen and (max-width: 991px) { .nav-menu { flex-direction: column } }')).roots[0];
  assert.deepEqual(colours.children![0].frameworkClasses, ['relative', 'float-right', 'absolute', 'top-full', 'left-0', 'right-0', 'min-w-[200px]', 'bg-[#c8c8c8]', 'text-center'], 'colours and flex do not position: the panel layout is added, the site class stacks on top');
});

test('dropdowns: roles, hover flag, chevron icon, list keeps its tag and loses the hidden shim', () => {
  const ctx = ctxFor(fakeZip({}));
  const page = parsePage(doc(`
    <div data-hover="true" data-delay="0" class="dropdown w-dropdown">
      <div class="dropdown-toggle w-dropdown-toggle"><div class="w-icon-dropdown-toggle"></div><div>Toggle</div></div>
      <nav class="dropdown-list w-dropdown-list"><a href="#video" class="w-dropdown-link">Video</a><p class="w-dyn-bind-empty"></p></nav>
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
  // Webflow's `components.css` defaults: dark-grey padded toggle, dark-grey padded block links,
  // so an opened list on a dark navbar does not show white links on a white list.
  assert.deepEqual(toggle.frameworkClasses, ['relative', 'inline-block', 'cursor-pointer', 'select-none', 'py-[20px]', 'pl-[20px]', 'pr-[40px]', 'text-[#222]', 'whitespace-nowrap', 'text-left']);
  const link = list.children![0];
  assert.equal(link.kind, 'link');
  assert.deepEqual(link.frameworkClasses, ['relative', 'block', 'no-underline', 'text-[#222]', 'py-[10px]', 'px-[20px]', 'text-left', 'whitespace-nowrap']);
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
  assert.deepEqual(button.frameworkClasses, ['inline-block', 'py-[9px]', 'px-[15px]', 'bg-[#3898ec]', 'text-[#fff]', 'border-0', 'leading-[inherit]', 'no-underline', 'cursor-pointer', 'rounded-none']);
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
    <body><div class="w-unknown-one w-unknown-one"><div class="w-unknown-two"></div></div><script src="https://d3e54v103j8qbb.cloudfront.net/js/jquery-3.5.1.min.js"></script><script src="js/site.js"></script></body></html>`, ctx);
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

test('a framework class styled by the site stylesheet keeps those values on top of the shim', () => {
  // Webflow writes the designer's Quick Stack values into the SITE sheet,
  // under the framework class name.
  const styles = buildStyleModel({
    siteCss: ['.w-layout-layout { grid-row-gap: 20px; grid-column-gap: 20px; justify-content: center; padding: 20px }'],
    assetUrl: () => null,
    warn: new Warnings(),
  });
  const zip = fakeZip({});
  const page = parsePage(
    doc('<div class="w-layout-layout wf-layout-layout"><div class="w-layout-cell">x</div></div>'),
    ctxFor(zip, { styles }),
  );
  const grid = page.roots[0];
  assert.ok(grid.frameworkClasses?.includes('grid'), 'the hand-written shim still applies');
  assert.ok(grid.frameworkClasses?.includes('p-[20px]'), `site padding applied: ${grid.frameworkClasses?.join(' ')}`);
  assert.ok(grid.frameworkClasses?.includes('gap-x-[20px]'));
});

test('a page-scoped <style> gets its class selectors namespaced and its layers hooked', () => {
  const page = parsePage(
    doc('<div class="pageLayout"><p class="pageLayout note">x</p></div>',
      '<style>@media print { .pageLayout { width: 19cm } } .pageLayout .note { color: red }</style>'),
    ctxFor(fakeZip({})),
  );
  const css = page.headStyles.join('\n');
  assert.match(css, /@media print \{ \.wf-pagelayout \{ width: 19cm \} \}/);
  assert.match(css, /\.wf-pagelayout \.wf-note/);
  assert.equal(css.includes('.pageLayout'), false, 'no raw Webflow class name is left in the block');

  const hooked = [...page.nodeIndex.values()].filter((n) => (n.classes ?? []).includes('wf-pagelayout'));
  assert.equal(hooked.length, 2, 'both elements carrying the class get the inert hook');
  assert.ok((hooked[1].classes ?? []).includes('wf-note'));
});

test('inline display:none becomes the hidden utility; other inline styles are left to the widget builders', () => {
  assert.ok(hasInlineDisplayNone('display:none'));
  assert.ok(hasInlineDisplayNone(' display : NONE !important; color: red'));
  assert.ok(!hasInlineDisplayNone('display:block'));
  assert.ok(!hasInlineDisplayNone('background-image:url(x.png)'));
  assert.ok(!hasInlineDisplayNone(undefined));
  const ctx = ctxFor(fakeZip({}));
  const page = parsePage(doc(`
    <div class="box"><div style="display:none" data-wf-user-form-error="true" class="state w-users-userformerrorstate"><div>Fehler</div></div></div>
    <div style="opacity:0" class="fade">x</div>`), ctx);
  const [box, fade] = page.roots;
  const state = box.children![0];
  assert.deepEqual(state.classes, ['hidden']);
  assert.equal(fade.classes, undefined, 'an inline opacity is not a visibility rule');
});

test('a shim-only element folds the tag underlay under its framework classes, so the reset cannot evict the shim', () => {
  const warn = new Warnings();
  const styles = buildStyleModel({
    frameworkCss: ['button { border: 0; color: inherit; font: inherit; margin: 0; }'],
    siteCss: ['.cta { padding: 0; }'],
    assetUrl: () => null,
    warn,
  });
  const ctx = ctxFor(fakeZip({}), { styles });
  const page = parsePage(doc('<button class="w-pagination-next">Weiter</button><button class="cta w-pagination-next">Weiter</button>'), ctx);
  const [bare, styled] = page.roots;
  assert.equal(bare.underlayStyles, undefined, 'no underlay chip: it is folded inline under the shims');
  for (const c of ['border', 'border-solid', 'border-[#ccc]', 'rounded-[2px]', 'text-[#333]', 'm-[0]']) assert.ok(bare.frameworkClasses!.includes(c), `${c} in ${bare.frameworkClasses!.join(' ')}`);
  for (const c of ['border-0', 'text-[inherit]']) assert.ok(!bare.frameworkClasses!.includes(c), `${c} evicted by the shim`);
  assert.equal(styled.underlayStyles?.[0].key, 'wf-tag:button', 'with a site class the underlay stays a chip under it');
  assert.ok(styled.frameworkClasses!.includes('border') && !styled.frameworkClasses!.includes('border-0'));
});

test('state combos per role: open styles merge into the list / menu / pane chip, become a tween on the toggle, are dropped elsewhere; the dropdown runtime line is added once', () => {
  const css = `
.dropdown-list{position:relative}
.dropdown-list.w--open{background-color:#fff;padding:20px}
.dropdown-toggle{background-color:#000;padding:30px 0}
.dropdown-toggle.w--open{background-color:#333;color:#fff;transform:rotate(180deg)}
.dropdown-toggle.big.w--open{opacity:.5}
.nav-menu[data-nav-menu-open]{background-color:#111}
.tab-pane.w--tab-active{opacity:1}
.card.w--open{color:red}
@media screen and (max-width:767px){.dropdown-toggle.w--open{background-color:#444}}
`;
  const ctx = ctxFor(fakeZip({}), { styles: buildStyleModel({ siteCss: [css], assetUrl: () => null, warn: new Warnings() }) });
  const page = parsePage(doc(`
    <div class="dropdown w-dropdown" data-hover="false">
      <div class="dropdown-toggle big w-dropdown-toggle"><div class="w-icon-dropdown-toggle"></div><div>Upcoming</div></div>
      <nav class="dropdown-list w-dropdown-list"><p>Text</p></nav>
    </div>
    <div class="dropdown w-dropdown" data-hover="true">
      <div class="dropdown-toggle w-dropdown-toggle">Archive</div>
      <nav class="dropdown-list w-dropdown-list"></nav>
    </div>
    <div class="navbar w-nav" data-collapse="medium"><nav class="nav-menu w-nav-menu"></nav><div class="w-nav-button"></div></div>
    <div class="w-tabs"><div class="w-tab-menu"><a class="w-tab-link w--current" data-w-tab="A" href="#">A</a></div><div class="w-tab-content"><div class="tab-pane w-tab-pane w--tab-active" data-w-tab="A">A</div></div></div>
    <div class="card">plain</div>
  `), ctx);
  const byClass = (c: string) => collect(page, (n) => n.wf.siteClasses[0] === c);
  const lists = byClass('dropdown-list');
  assert.equal(lists.length, 2);
  for (const list of lists) assert.deepEqual(list.styles![0].classes, ['relative', 'bg-[#fff]', 'p-[20px]'], 'the open styles joined the base chip');
  // The menu can only be opened on the collapsed breakpoints (`data-collapse="medium"` -> tablet and phone).
  assert.deepEqual(byClass('nav-menu')[0].styles![0].classes, ['max-lg:bg-[#111]']);
  assert.deepEqual(byClass('tab-pane')[0].styles![0].classes, ['opacity-[1]']);
  assert.equal(page.headStyles.length, 0);

  const [bigToggle, plainToggle] = byClass('dropdown-toggle');
  assert.deepEqual(bigToggle.wf.stateTween, {
    from: { backgroundColor: '#000000', rotation: '0deg', autoAlpha: '100' },
    to: { backgroundColor: '#333333', rotation: '180deg', autoAlpha: '50' },
  }, 'base + combo state rules add up; resting values come from the toggle\'s own rules, else ycode defaults');
  assert.deepEqual(plainToggle.wf.stateTween, { from: { backgroundColor: '#000000', rotation: '0deg' }, to: { backgroundColor: '#333333', rotation: '180deg' } });
  assert.equal(byClass('card')[0].wf.stateTween, undefined);
  assert.ok(!ctx.styles.combos.has('dropdown-toggle.w--open'));

  const dropped = ctx.warn.list.filter((w) => w.code === 'css_state_dropped').map((w) => w.message);
  assert.deepEqual(dropped, [
    '.dropdown-toggle.w--open: color: #fff cannot become an interaction tween (ycode tweens background colour, opacity, transform, size and display)',
    '.dropdown-toggle.w--open: the open state on a breakpoint cannot become an interaction tween',
    '.card.w--open: webflow.js sets .w--open on dropdown toggles, dropdown lists and the nav button, not on this div; the rule has no ycode counterpart',
  ]);
  assert.equal(ctx.warn.list.find((w) => w.code === 'css_state_dropped' && w.message.startsWith('.card'))?.count ?? 1, 1);

  assert.equal(page.bodyScripts.filter((s) => s.includes('data-webwow-import="dropdown"')).length, 1, 'one runtime line per page, however many dropdowns');
  const script = page.bodyScripts.find((s) => s.includes('data-webwow-import="dropdown"'))!;
  assert.ok(/^[\x20-\x7e]+$/.test(script), 'ASCII only');
  assert.equal(script.split('</script>').length, 2, 'one closing tag');
  assert.ok(script.includes('[data-webwow-dropdown]') && script.includes('aria-expanded') && script.includes('"Escape"'));
  // Touch: a hover dropdown opens on tap by dispatching the wrapper's `mouseenter` (webflow.js: `hover && !touch`).
  assert.ok(script.includes('"ontouchstart" in window') && script.includes('(hover: none)'));
  assert.ok(script.includes('mouse(w,"mouseenter")') && script.includes('mouse(w,"mouseleave")'));
  assert.ok(script.includes('addEventListener("mouseenter",block,true)') && script.includes('ev.isTrusted'));
});

test('nav-menu state rules are scoped to the collapsed breakpoints: max-md for small, none for all, dropped for none, a narrower rule keeps its prefix', () => {
  const build = (collapse: string, css: string) => {
    const ctx = ctxFor(fakeZip({}), { styles: buildStyleModel({ siteCss: [css], assetUrl: () => null, warn: new Warnings() }) });
    const page = parsePage(doc(`<div class="navbar w-nav" data-collapse="${collapse}"><nav class="nav-menu w-nav-menu"></nav><div class="w-nav-button"></div></div>`), ctx);
    return { menu: collect(page, (n) => n.wf.role === 'nav-menu')[0], warn: ctx.warn };
  };
  const css = '.nav-menu[data-nav-menu-open]{background-color:#111;display:flex}.nav-menu.w--open{padding:8px}@media screen and (max-width:767px){.nav-menu[data-nav-menu-open]{padding:4px}}';
  const small = build('small', css);
  assert.deepEqual(small.menu.styles![0].classes, ['max-md:bg-[#111]', 'max-md:flex', 'max-md:p-[4px]']);
  assert.equal(small.warn.count('css_state_dropped'), 0);

  const medium = build('medium', css);
  assert.deepEqual(medium.menu.styles![0].classes, ['max-lg:bg-[#111]', 'max-lg:flex', 'max-lg:p-[8px]', 'max-md:p-[4px]'], 'the small rule keeps its narrower prefix under a medium collapse');

  const all = build('all', css);
  assert.deepEqual(all.menu.styles![0].classes, ['bg-[#111]', 'flex', 'p-[8px]', 'max-md:p-[4px]'], 'collapse=all: the menu is toggled at every width');

  const none = build('none', css);
  assert.deepEqual(none.menu.styles![0].classes, [], 'never collapsed: no open state at all');
  assert.deepEqual(none.warn.list.filter((w) => w.code === 'css_state_dropped').map((w) => [w.message, w.count]), [
    ['.nav-menu[data-nav-menu-open]: the navbar never collapses (data-collapse="none"), so its menu is never opened and the open-menu state has no ycode counterpart', 2],
    ['.nav-menu.w--open: the navbar never collapses (data-collapse="none"), so its menu is never opened and the open state has no ycode counterpart', 1],
  ]);
});

test('`.tab-link.w--current` on a tab link becomes a tween for the tab interaction (current: variant elsewhere); what cannot tween is reported', () => {
  const css = `
.tab-link{padding:10px;background-color:#eee}
.tab-link.w--current{background-color:#000;color:#fff;opacity:.9}
.tab-link.big.w--current{transform:scale(1.1)}
.nav-link.w--current{color:#0082f3}
.pill.w--current{background-color:#0082f3}
@media screen and (max-width:767px){.tab-link.w--current{background-color:#333}}
`;
  const ctx = ctxFor(fakeZip({}), { styles: buildStyleModel({ siteCss: [css], assetUrl: () => null, warn: new Warnings() }) });
  const page = parsePage(doc(`
    <div class="w-tabs">
      <div class="w-tab-menu"><a class="tab-link big w-tab-link w--current" data-w-tab="A" href="#">A</a><a class="tab-link w-tab-link" data-w-tab="B" href="#">B</a><a class="pill w-tab-link" data-w-tab="C" href="#">C</a></div>
      <div class="w-tab-content"><div class="w-tab-pane w--tab-active" data-w-tab="A">A</div><div class="w-tab-pane" data-w-tab="B">B</div><div class="w-tab-pane" data-w-tab="C">C</div></div>
    </div>
    <a class="nav-link w--current" href="index.html">Home</a>
  `), ctx);
  const [a, b, pill] = collect(page, (n) => n.wf.role === 'tab-link');
  assert.deepEqual(a.wf.stateTween, {
    from: { backgroundColor: '#eeeeee', autoAlpha: '100', scale: '1' },
    to: { backgroundColor: '#000000', autoAlpha: '90', scale: '1.1' },
  }, 'base + combo state rules add up; resting values from the tab link\'s own rules, else ycode defaults');
  assert.deepEqual(b.wf.stateTween, { from: { backgroundColor: '#eeeeee', autoAlpha: '100' }, to: { backgroundColor: '#000000', autoAlpha: '90' } });
  // No class of the pill sets a background: the tab returns to transparent when another tab is clicked.
  assert.deepEqual(pill.wf.stateTween, { from: { backgroundColor: '#000000/0' }, to: { backgroundColor: '#0082f3' } });
  // The `current:` variant is still on the chip (ycode's aria-current="page" for links); it is inert on a tab link.
  assert.deepEqual(a.styles![0].classes, ['p-[10px]', 'bg-[#eee]', 'current:bg-[#000]', 'current:text-[#fff]', 'current:opacity-[.9]', 'max-md:current:bg-[#333]']);
  const home = collect(page, (n) => n.wf.siteClasses[0] === 'nav-link')[0];
  assert.equal(home.wf.stateTween, undefined, 'a link to the current page keeps the current: variant only');
  assert.deepEqual(home.styles![0].classes, ['current:text-[#0082f3]']);

  const dropped = ctx.warn.list.filter((w) => w.code === 'css_state_dropped').map((w) => w.message);
  assert.deepEqual(dropped, [
    '.tab-link.w--current: color: #fff cannot become an interaction tween on the tab link (ycode tweens background colour, opacity, transform, size and display)',
    '.tab-link.w--current: the active-tab state on a breakpoint cannot become an interaction tween',
  ]);
});

test('a standalone rule of a later class applies too: single-class chips in stylesheet order, then the combos', () => {
  const css = `
.button{border:1px solid #006450;border-radius:99vw;max-width:16rem;font-weight:600}
.heading-2{font-weight:300;margin-bottom:20px}
.heading-2.button{color:#000;max-width:20rem}
.lonely{padding:4px}
@media screen and (max-width:767px){.button{max-width:15rem}}
`;
  const styles = buildStyleModel({ siteCss: [css], assetUrl: () => null, warn: new Warnings() });
  const ctx = ctxFor(fakeZip({}), { styles });
  const page = parsePage(doc('<a href="#" class="heading-2 button w-button">Catalog</a><div class="unstyled lonely">x</div>'), ctx);
  const [button, box] = page.roots;
  // `.button` comes first in the sheet, so `.heading-2`'s font-weight (same specificity, later) wins.
  assert.deepEqual(button.styles!.map((r) => r.key), ['wf:button', 'wf:heading-2', 'wf:heading-2.button']);
  assert.ok(button.styles![2].classes.includes('max-md:max-w-[20rem]'), 'the combo keeps its max-width over .button on 767 px');
  assert.deepEqual(box.styles!.map((r) => r.key), ['wf:lonely'], 'a later class counts even when the first has no rule');
});

test('a combo beats a later standalone class of its element on every breakpoint (element `a b c`, only `a.b` is a combo)', () => {
  const css = '.a{padding:1px}.c{color:red}@media screen and (max-width:767px){.c{padding:50px}}@media screen and (max-width:479px){.c{margin:3px}}.a.b{padding:10px;margin:0}';
  const html = doc('<div class="a b c">x</div>');
  const lists = new Set<string>();
  collectClassLists(html, lists);
  const styles = buildStyleModel({ siteCss: [css], classLists: lists, assetUrl: () => null, warn: new Warnings() });
  const page = parsePage(html, ctxFor(fakeZip({}), { styles }));
  const [el] = page.roots;
  assert.deepEqual(el.styles!.map((r) => r.key), ['wf:a', 'wf:c', 'wf:a.b']);
  const stack = el.styles!.flatMap((r) => r.classes);
  // `.c`'s 767 px padding is one class against two: the combo re-states its own value there, later in the stack.
  assert.ok(stack.lastIndexOf('max-md:p-[10px]') > stack.indexOf('max-md:p-[50px]'), stack.join(' '));
  // Under 480 px `.c`'s tiny margin is residual CSS; the combo's margin is restated with two classes.
  assert.ok(styles.residualCss.includes('html .wf-a.wf-b{margin:0;}'), styles.residualCss);
  assert.deepEqual(el.classes, ['wf-a', 'wf-b', 'wf-c'], 'the element carries every hook the residual rules select');
});

test('a state rule on a framework class outranks the element\'s one-class rules: above the framework class\'s own rule and the site chips', () => {
  // `.w-dropdown-list.w--open` is two classes: it beats `.w-dropdown-list` and `.dropdown-list` on every breakpoint.
  const css = `
.w-dropdown-list{background-color:red}
.w-dropdown-list.w--open{background-color:#fff;padding:20px;color:#111}
.dropdown-list{background-color:transparent}
@media screen and (max-width:767px){.dropdown-list{background-color:#eee}}
.dropdown-list.w--open{color:#222}
`;
  const styles = buildStyleModel({ siteCss: [css], assetUrl: () => null, warn: new Warnings() });
  const ctx = ctxFor(fakeZip({}), { styles });
  const page = parsePage(doc(`
    <div class="w-dropdown" data-hover="false">
      <div class="w-dropdown-toggle"><div>Open</div></div>
      <nav class="dropdown-list w-dropdown-list"><a href="#" class="w-dropdown-link">A</a></nav>
    </div>
    <div class="w-dropdown" data-hover="false">
      <div class="w-dropdown-toggle"><div>Open</div></div>
      <nav class="w-dropdown-list"><a href="#" class="w-dropdown-link">B</a></nav>
    </div>`), ctx);
  const [withChip, bare] = collect(page, (n) => n.wf.role === 'dropdown-list');
  // With a site chip: the open-state classes are one-offs above the chips (re-stated on 767 px, where
  // the chip has its own background), without the colour `.dropdown-list.w--open` (later, as specific) sets.
  assert.deepEqual(withChip.styles!.map((r) => r.key), ['wf:dropdown-list']);
  assert.deepEqual(withChip.classes, ['max-md:bg-[#fff]', 'bg-[#fff]', 'p-[20px]']);
  assert.ok(withChip.styles![0].classes.includes('text-[#222]'), withChip.styles![0].classes.join(' '));
  assert.ok(!withChip.frameworkClasses!.includes('bg-[#fff]'), withChip.frameworkClasses!.join(' '));
  // Without one: on top of the framework layer, after the class's own site rule.
  const fw = bare.frameworkClasses!;
  assert.ok(fw.lastIndexOf('bg-[#fff]') > fw.indexOf('bg-[red]'), fw.join(' '));
  assert.ok(fw.includes('text-[#111]') && fw.includes('p-[20px]'), fw.join(' '));
  assert.equal(bare.classes, undefined);
});

test('a site state rule on a framework class reaches the element: merged into its framework classes, or a tween on the toggle', () => {
  const css = `
.w-dropdown-toggle{background-color:#000}
.w-dropdown-toggle.w--open{background-color:#333}
.w-dropdown-list.w--open{background-color:#fff;padding:20px}
`;
  const styles = buildStyleModel({ siteCss: [css], assetUrl: () => null, warn: new Warnings() });
  const ctx = ctxFor(fakeZip({}), { styles });
  const page = parsePage(doc(`
    <div class="w-dropdown" data-hover="false">
      <div class="w-dropdown-toggle"><div>Open</div></div>
      <nav class="w-dropdown-list"><a href="#" class="w-dropdown-link">A</a></nav>
    </div>`), ctx);
  const toggle = collect(page, (n) => n.wf.role === 'dropdown-toggle')[0];
  const list = collect(page, (n) => n.wf.role === 'dropdown-list')[0];
  assert.deepEqual(toggle.wf.stateTween, { from: { backgroundColor: '#000000' }, to: { backgroundColor: '#333333' } });
  assert.ok(list.frameworkClasses!.includes('bg-[#fff]') && list.frameworkClasses!.includes('p-[20px]'), list.frameworkClasses!.join(' '));
  assert.equal(list.styles, undefined, 'no chip for a framework class');
  assert.equal(ctx.warn.count('css_state_dropped'), 0);
});

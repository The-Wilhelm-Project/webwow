import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractCrossPageComponents, regionSignature, type PageLayers, type RegionHint } from './components';
import { Warnings } from './warnings';
import type { ServerMaterializer } from './server-materializer';

import type { Component, Layer } from '@/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

class StubMaterializer {
  readonly created: { name: string; layers: Layer[] }[] = [];
  async createComponent(name: string, layers: Layer[]): Promise<Component | null> {
    this.created.push({ name, layers });
    return { id: `cmp-${this.created.length}`, name, layers, is_published: false } as Component;
  }
}

function matOf(stub: StubMaterializer): ServerMaterializer {
  return stub as unknown as ServerMaterializer;
}

let counter = 0;
const id = (prefix: string) => `${prefix}-${++counter}`;

/** A footer with a brand line and two links; `currentOn` marks the active page link. */
function footer(opts: { currentOn?: boolean; contactHref?: string } = {}): Layer {
  return {
    id: id('lyr'),
    name: 'div',
    settings: { tag: 'footer' },
    classes: 'flex justify-between p-[40px]',
    children: [
      {
        id: id('lyr'),
        name: 'text',
        classes: 'text-[14px]',
        variables: { text: { type: 'dynamic_rich_text', data: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Valeska von Brase' }] }] } } } },
      },
      {
        id: id('lyr'),
        name: 'div',
        classes: opts.currentOn ? 'link wf-w--current' : 'link',
        variables: { link: { type: 'url', url: { type: 'dynamic_text', data: { content: '/work' } } } },
        children: [],
      },
      {
        id: id('lyr'),
        name: 'div',
        classes: 'link',
        variables: { link: { type: 'url', url: { type: 'dynamic_text', data: { content: opts.contactHref ?? '/contact' } } } },
        children: [],
      },
    ],
  };
}

function body(children: Layer[]): Layer {
  return { id: 'body', name: 'body', classes: '', children };
}

function hero(): Layer {
  return {
    id: id('lyr'),
    name: 'section',
    classes: 'hero',
    children: [{ id: id('lyr'), name: 'heading', settings: { tag: 'h1' }, classes: 'title', variables: { text: { type: 'dynamic_rich_text', data: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] } } } } }],
  };
}

// ─── Signature ────────────────────────────────────────────────────────────────

test('the signature ignores ids, customName, attributes and interactions', () => {
  const a = footer();
  const b = footer();
  b.customName = 'Footer (work)';
  b.attributes = { 'data-x': '1' };
  b.interactions = [{ id: 'int-1', trigger: 'hover', timeline: { breakpoints: ['desktop'], repeat: 0, yoyo: true }, tweens: [] }];
  assert.equal(regionSignature(a), regionSignature(b));
});

test('the signature ignores the w--current state class but not real class differences', () => {
  assert.equal(regionSignature(footer()), regionSignature(footer({ currentOn: true })));
  const restyled = footer();
  restyled.classes = 'flex justify-between p-[40px] black';
  assert.notEqual(regionSignature(footer()), regionSignature(restyled));
});

test('the signature reacts to link targets and text content', () => {
  assert.notEqual(regionSignature(footer()), regionSignature(footer({ contactHref: '#' })));
});

// ─── Extraction ───────────────────────────────────────────────────────────────

test('an identical footer on two pages becomes one component with two instances', async () => {
  const a = footer();
  const b = footer({ currentOn: true });
  const pages: PageLayers[] = [
    { page: 'index', body: body([hero(), a]) },
    { page: 'work', body: body([hero(), b]) },
  ];
  const stub = new StubMaterializer();
  const warn = new Warnings();

  const result = await extractCrossPageComponents(pages, matOf(stub), warn);

  assert.equal(result.components, 1);
  assert.equal(result.instances, 2);
  assert.equal(stub.created.length, 1);
  assert.equal(stub.created[0].name, 'Footer');

  // The instances keep the original layer ids so interactions/anchors still resolve.
  const instanceA = pages[0].body.children![1];
  const instanceB = pages[1].body.children![1];
  assert.equal(instanceA.id, a.id);
  assert.equal(instanceB.id, b.id);
  assert.equal(instanceA.componentId, 'cmp-1');
  assert.equal(instanceB.componentId, 'cmp-1');
  assert.deepEqual(instanceA.children, []);
  assert.equal(instanceA.classes, '');
});

test('a footer nested inside a body-level section is found and replaced too', async () => {
  const inline = footer();
  const wrapper: Layer = { id: id('lyr'), name: 'section', classes: 'section work', children: [inline] };
  const pages: PageLayers[] = [
    { page: 'index', body: body([footer()]) },
    { page: 'work', body: body([wrapper]) },
  ];
  const stub = new StubMaterializer();

  const result = await extractCrossPageComponents(pages, matOf(stub), new Warnings());

  assert.equal(result.components, 1);
  assert.equal(result.instances, 2);
  assert.equal(wrapper.children![0].componentId, 'cmp-1');
  assert.equal(wrapper.children![0].id, inline.id);
});

test('a third page whose footer differs by an href stays inline and is reported', async () => {
  const odd = footer({ contactHref: '#' });
  const pages: PageLayers[] = [
    { page: 'index', body: body([footer()]) },
    { page: 'work', body: body([footer()]) },
    { page: 'detail_werke', body: body([odd]) },
  ];
  const stub = new StubMaterializer();
  const warn = new Warnings();

  const result = await extractCrossPageComponents(pages, matOf(stub), warn);

  assert.equal(result.components, 1);
  assert.equal(result.instances, 2);
  assert.equal(pages[2].body.children![0].componentId, undefined, 'the odd footer stays inline');
  assert.equal(warn.count('component_skipped'), 1);
  const warning = warn.list.find((w) => w.code === 'component_skipped')!;
  assert.equal(warning.page, 'detail_werke');
  assert.match(warning.message, /link target/);
});

test('a region that appears on only one page is left alone', async () => {
  const pages: PageLayers[] = [
    { page: 'index', body: body([footer()]) },
    { page: 'work', body: body([hero()]) },
  ];
  const stub = new StubMaterializer();
  const result = await extractCrossPageComponents(pages, matOf(stub), new Warnings());
  assert.equal(result.components, 0);
  assert.equal(result.instances, 0);
  assert.equal(stub.created.length, 0);
});

test('a region holding a collection is never turned into a component', async () => {
  const withCollection = (): Layer => ({
    id: id('lyr'),
    name: 'div',
    settings: { tag: 'footer' },
    classes: 'flex',
    children: [{ id: id('lyr'), name: 'div', classes: 'item', variables: { collection: { id: 'col-1' } }, children: [{ id: id('lyr'), name: 'text', classes: '' }] }],
  });
  const pages: PageLayers[] = [
    { page: 'index', body: body([withCollection()]) },
    { page: 'work', body: body([withCollection()]) },
  ];
  const stub = new StubMaterializer();
  const result = await extractCrossPageComponents(pages, matOf(stub), new Warnings());
  assert.equal(result.components, 0);
});

test('a navbar and a footer on four pages give two components and eight instances', async () => {
  const navbar = (): Layer => ({
    id: id('lyr'),
    name: 'div',
    settings: { tag: 'nav' },
    classes: 'navbar relative z-[1000]',
    children: [
      { id: id('lyr'), name: 'div', classes: 'brand', variables: { link: { type: 'url', url: { type: 'dynamic_text', data: { content: '/' } } } }, children: [] },
      { id: id('lyr'), name: 'div', settings: { tag: 'nav' }, classes: 'menu', children: [{ id: id('lyr'), name: 'text', classes: 'item', variables: { text: { type: 'dynamic_rich_text', data: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Work' }] }] } } } } }] },
    ],
  });
  const pages: PageLayers[] = ['index', 'work', 'exhibitions', 'artist'].map((page) => ({
    page,
    body: body([navbar(), hero(), footer({ currentOn: page === 'work' })]),
  }));
  const stub = new StubMaterializer();

  const result = await extractCrossPageComponents(pages, matOf(stub), new Warnings());

  assert.equal(result.components, 2);
  assert.equal(result.instances, 8);
  assert.deepEqual(stub.created.map((c) => c.name).sort(), ['Footer', 'Navbar']);
});

// ─── Hint-driven extraction (Webflow's tagless navbar / footer) ───────────────

/** Webflow's real markup: a `div.navbar.w-nav`, no `<nav>` tag anywhere. */
function wfNavbar(): Layer {
  return {
    id: id('lyr'),
    name: 'div',
    classes: 'navbar relative z-[1000]',
    children: [
      { id: id('lyr'), name: 'div', classes: 'brand', variables: { link: { type: 'url', url: { type: 'dynamic_text', data: { content: '/' } } } }, children: [] },
      { id: id('lyr'), name: 'div', classes: 'menu', children: [{ id: id('lyr'), name: 'text', classes: 'item', variables: { text: { type: 'dynamic_rich_text', data: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Work' }] }] } } } } }] },
    ],
  };
}

/** Webflow's real markup: a `div.section-footer`, no `<footer>` tag. */
function wfFooter(): Layer {
  const f = footer();
  delete f.settings;
  f.classes = 'section-footer flex justify-between p-[40px]';
  return f;
}

test('a tagless navbar and footer are found at any depth via the hint map', async () => {
  const hints = new Map<string, RegionHint>();
  const mk = (page: string, nest: 'body' | 'wrapper' | 'deep') => {
    const nav = wfNavbar();
    const foot = wfFooter();
    hints.set(nav.id, 'nav');
    hints.set(foot.id, 'footer');
    if (nest === 'body') return { page, body: body([nav, hero(), foot]) };
    if (nest === 'wrapper') return { page, body: body([nav, { id: id('lyr'), name: 'section', classes: 'section', children: [hero(), foot] }]) };
    return { page, body: body([{ id: id('lyr'), name: 'div', classes: 'page-wrapper', children: [nav, hero(), foot] }]) };
  };
  const pages: PageLayers[] = [mk('index', 'deep'), mk('work', 'wrapper'), mk('artist', 'body'), mk('exhibitions', 'body')];
  const stub = new StubMaterializer();

  const result = await extractCrossPageComponents(pages, matOf(stub), new Warnings(), { hintOf: (lid) => hints.get(lid) });

  assert.equal(result.components, 2);
  assert.equal(result.instances, 8);
  assert.deepEqual(stub.created.map((c) => c.name).sort(), ['Footer', 'Navbar']);
});

test('a hinted region is never split: an inner `.footer-left` does not compete with its own wrapper', async () => {
  const hints = new Map<string, RegionHint>();
  const mk = (page: string) => {
    const foot = wfFooter();
    hints.set(foot.id, 'footer');
    // Webflow's class scan also flags children like `.footer-left`.
    for (const child of foot.children ?? []) hints.set(child.id, 'footer');
    return { page, body: body([hero(), foot]) };
  };
  const pages: PageLayers[] = [mk('index'), mk('work')];
  const stub = new StubMaterializer();

  const result = await extractCrossPageComponents(pages, matOf(stub), new Warnings(), { hintOf: (lid) => hints.get(lid) });

  assert.equal(result.components, 1, 'only the outermost hinted region becomes a component');
  assert.equal(result.instances, 2);
  assert.equal(stub.created[0].name, 'Footer');
});

test('a hinted navbar wins over the repeated page wrapper that contains it', async () => {
  const hints = new Map<string, RegionHint>();
  const mk = (page: string) => {
    const nav = wfNavbar();
    hints.set(nav.id, 'nav');
    return { page, body: body([{ id: id('lyr'), name: 'div', classes: 'page-wrapper', children: [nav, hero()] }]) };
  };
  const pages: PageLayers[] = [mk('index'), mk('work')];
  const stub = new StubMaterializer();

  const result = await extractCrossPageComponents(pages, matOf(stub), new Warnings(), { hintOf: (lid) => hints.get(lid) });

  // Both the wrapper and the navbar repeat; the navbar is extracted first and the
  // wrapper — now holding an instance — no longer matches its own old signature.
  assert.equal(stub.created[0].name, 'Navbar');
  assert.equal(result.components, 1);
  assert.equal(result.instances, 2);
});

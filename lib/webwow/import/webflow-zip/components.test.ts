import { test } from 'node:test';
import assert from 'node:assert/strict';

import { componentizeKeepingMedia, extractCrossPageComponents, regionSignature, type PageLayers, type RegionHint } from './components';
import { applyComponentOverrides } from '@/lib/resolve-components';
import { Warnings } from './warnings';
import type { ServerMaterializer } from './server-materializer';

import type { Component, ComponentVariable, Layer } from '@/types';

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

// ─── Repeated siblings with media ────────────────────────────────────────────

class VariableStub {
  readonly created: { name: string; layers: Layer[]; variables?: ComponentVariable[] }[] = [];
  async createComponent(name: string, layers: Layer[], variables?: ComponentVariable[]): Promise<Component | null> {
    this.created.push({ name, layers, variables });
    return { id: `cmp-${this.created.length}`, name, layers, variables, is_published: false } as Component;
  }
}

const asset = (asset_id: string) => ({ type: 'asset' as const, data: { asset_id } });

/** A `/artist` tile: box > background video + caption. */
function videoTile(video: string, poster: string, caption = 'Studio'): Layer {
  return {
    id: id('lyr'),
    name: 'div',
    classes: 'relative overflow-hidden',
    children: [
      { id: id('lyr'), name: 'video', classes: 'absolute inset-0', attributes: { autoplay: true, muted: true, loop: true, controls: false }, variables: { video: { src: asset(video), poster: asset(poster) } } },
      { id: id('lyr'), name: 'text', classes: 'text-[14px]', variables: { text: { type: 'dynamic_text', data: { content: caption } } } },
    ],
  } as Layer;
}

test('repeated siblings with different background videos: one component, the video (src + poster) is a per-instance variable', async () => {
  const stub = new VariableStub();
  const out = await componentizeKeepingMedia([videoTile('natur', 'natur-poster'), videoTile('studio', 'studio-poster')], stub);
  assert.equal(stub.created.length, 1);
  const [{ layers, variables }] = stub.created;
  assert.equal(variables?.length, 1);
  const variable = variables![0];
  assert.equal(variable.type, 'video');
  assert.equal(variable.name, 'Video 1');
  assert.deepEqual(variable.default_value, { src: asset('natur'), poster: asset('natur-poster'), autoplay: true, loop: true, muted: true, controls: false });
  const templateVideo = layers[0].children![0];
  assert.equal(templateVideo.variables?.image, undefined, 'no stand-in image left in the template');
  assert.deepEqual(templateVideo.variables?.video?.src, { ...asset('natur'), id: variable.id });
  assert.equal(out.length, 2);
  assert.ok(out.every((l) => l.componentId === 'cmp-1'));
  assert.equal(out[0].componentOverrides?.image, undefined);
  // What ycode renders for the second instance: its own video and poster.
  const rendered = applyComponentOverrides(layers, out[1].componentOverrides, variables);
  assert.deepEqual((rendered[0].children![0].variables?.video?.src as { data: unknown }).data, { asset_id: 'studio' });
  assert.deepEqual(rendered[0].children![0].variables?.video?.poster, asset('studio-poster'));
  const first = applyComponentOverrides(layers, out[0].componentOverrides, variables);
  assert.deepEqual((first[0].children![0].variables?.video?.src as { data: unknown }).data, { asset_id: 'natur' });
});

test('repeated siblings with the same video keep it as template content; a lone media layer is restored untouched', async () => {
  const stub = new VariableStub();
  const lone: Layer = { id: id('lyr'), name: 'icon', classes: '', variables: { icon: { src: { type: 'static_text', data: { content: '<svg/>' } } } } } as Layer;
  const out = await componentizeKeepingMedia([videoTile('natur', 'p', 'A'), videoTile('natur', 'p', 'B'), lone], stub);
  assert.equal(stub.created.length, 1);
  const { layers, variables } = stub.created[0];
  assert.deepEqual(variables?.map((v) => v.type), ['rich_text'], 'only the caption differs');
  assert.deepEqual(layers[0].children![0].variables?.video, { src: asset('natur'), poster: asset('p') });
  assert.deepEqual(out[2].variables, { icon: { src: { type: 'static_text', data: { content: '<svg/>' } } } });
  // Poster alone differs: still two different looks.
  const stub2 = new VariableStub();
  await componentizeKeepingMedia([videoTile('natur', 'p1'), videoTile('natur', 'p2')], stub2);
  assert.equal(stub2.created[0].variables?.[0]?.type, 'video');
});

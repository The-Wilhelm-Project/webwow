/**
 * Native widget builders — parse -> convert -> post-process, asserted against
 * the ycode layer shapes the element library itself produces.
 *
 * The markup fixtures are verbatim Webflow export output (class names checked
 * against `import/web/valeska-von-brase.webflow/css/components.css`, which lists
 * every framework class the exporter can emit).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ImportConverter } from '@/lib/import/convert';
import { getLayerFromTemplate } from '@/lib/templates/blocks';
import { DEFAULT_SLIDER_SETTINGS, SLIDER_LAYER_NAMES } from '@/lib/slider-constants';

import { applyNodeLayerPostProcessing, convertPage } from './convert-bridge';
import { parsePage, type HtmlContext } from './html';
import { generateWidgetInteractions } from './widgets';
import { Warnings } from './warnings';
import {
  columnFrameworkClasses,
  columnWidth,
  lightboxGroupId,
  parseLightboxPayload,
  planFormControl,
  resolveWidgetFlags,
  sliderChromeLayers,
  sliderSettingsFromAttrs,
} from './widgets-native';

import type { WfStyleModel } from './css';
import type { WfNode, WfPage } from './types';
import type { WfZipBundle, WfZipFile } from './zip';
import type { ImportMaterializer } from '@/lib/import/materializer';
import type { Component, Layer } from '@/types';

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

function ctxFor(zip: WfZipBundle, overrides: Partial<HtmlContext> = {}): HtmlContext & { warn: Warnings } {
  const warn = new Warnings();
  return {
    page: 'index',
    styles: emptyStyles(),
    zip,
    pageNames: new Set(['index']),
    assetKey: (p) => (zip.files.has(p) ? p : null),
    warn,
    ...overrides,
  };
}

function doc(body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><title>T</title></head><body class="body">${body}</body></html>`;
}

class StubMaterializer {
  async getOrCreateStyle(): Promise<null> {
    return null;
  }
  async prepareStyles(): Promise<void> {}
  async uploadAsset(): Promise<string | null> {
    return null;
  }
  async createComponent(name: string, layers: Layer[]): Promise<Component> {
    return { id: 'cmp-1', name, layers, is_published: false } as Component;
  }
}

function converter(): ImportConverter {
  return new ImportConverter(new StubMaterializer() as unknown as ImportMaterializer);
}

/** parse -> convert -> post-process, the same order `index.ts` runs them in. */
async function build(html: string, opts: { assets?: Record<string, string>; ctx?: Partial<HtmlContext> } = {}) {
  const ctx = ctxFor(fakeZip(Object.keys(opts.assets ?? {})), opts.ctx);
  const page = parsePage(doc(html), ctx);
  const { roots, layerByNode } = await convertPage(page, converter());
  const assets = { idOf: (key: string) => opts.assets?.[key] ?? null };
  applyNodeLayerPostProcessing(page, layerByNode, assets, ctx.warn, opts.ctx?.widgets);
  const { generated } = generateWidgetInteractions(page, layerByNode, ctx.warn);
  return { page, roots, layerByNode, warn: ctx.warn, generated };
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

function names(layers: Layer[] | undefined): string[] {
  return (layers ?? []).map((l) => l.name);
}

function findByName(layer: Layer, name: string): Layer | undefined {
  if (layer.name === name) return layer;
  for (const child of layer.children ?? []) {
    const hit = findByName(child, name);
    if (hit) return hit;
  }
  return undefined;
}

// ─── Slider ───────────────────────────────────────────────────────────────────

/** Webflow's exported slider, with two slides, both arrows and the bullet strip. */
const SLIDER_HTML = `
<div data-delay="4000" data-animation="cross" class="hero-slider w-slider" data-autoplay="1" data-easing="ease-in-out"
     data-hide-arrows="0" data-disable-swipe="0" data-autoplay-limit="0" data-nav-spacing="3" data-duration="750" data-infinite="1">
  <div class="w-slider-mask">
    <div class="slide-one w-slide"><h2 class="slide-title">One</h2></div>
    <div class="w-slide"><h2>Two</h2></div>
  </div>
  <div class="left-arrow w-slider-arrow-left"><div class="w-icon-slider-left"></div></div>
  <div class="right-arrow w-slider-arrow-right"><div class="w-icon-slider-right"></div></div>
  <div class="slide-nav w-slider-nav w-round"></div>
</div>`;

test('slider: data-* attributes map onto SliderSettings (data-infinite becomes loop, not "all")', () => {
  const { settings, unmapped } = sliderSettingsFromAttrs({
    'data-animation': 'cross',
    'data-autoplay': '1',
    'data-infinite': '1',
    'data-easing': 'ease-in-out',
    'data-duration': '750',
    'data-delay': '4000',
    'data-hide-arrows': '0',
    'data-disable-swipe': '1',
    'data-nav-spacing': '3',
  }, true);

  // `SliderLoopMode` is 'none' | 'loop' | 'rewind'; anything else never loops.
  assert.equal(settings.loop, 'loop');
  assert.equal(settings.animationEffect, 'fade', 'Webflow "cross" is a cross-fade');
  assert.equal(settings.autoplay, true);
  assert.equal(settings.navigation, true, 'data-hide-arrows="0" keeps the arrows');
  assert.equal(settings.touchEvents, false, 'data-disable-swipe="1" turns swiping off');
  assert.equal(settings.duration, '0.75', 'ms -> seconds');
  assert.equal(settings.delay, '4');
  assert.equal(settings.pagination, true, '.w-slider-nav present');
  assert.deepEqual(unmapped, ['data-nav-spacing="3"']);
});

test('slider: defaults survive when Webflow writes nothing', () => {
  const { settings, unmapped } = sliderSettingsFromAttrs({}, false);
  assert.equal(settings.loop, 'none');
  assert.equal(settings.autoplay, false);
  assert.equal(settings.touchEvents, true);
  assert.equal(settings.pagination, false, 'no .w-slider-nav -> no bullets');
  assert.equal(settings.duration, DEFAULT_SLIDER_SETTINGS.duration);
  assert.deepEqual(unmapped, []);
});

test('slider: .w-slider becomes slider > slides > slide with native navigation and pagination children', async () => {
  const { page, layerByNode, roots } = await build(SLIDER_HTML);
  const slider = layerOf(page, layerByNode, (n) => n.wf.role === 'slider');

  assert.equal(slider.name, 'slider');
  assert.equal(slider.settings?.slider?.loop, 'loop');
  assert.equal(slider.customName, 'Slider');

  // slides + the two chrome wrappers ycode's own slider template ships.
  assert.deepEqual(names(slider.children), ['slides', 'slideNavigationWrapper', 'slidePaginationWrapper']);

  const slides = slider.children![0];
  assert.deepEqual(names(slides.children), ['slide', 'slide']);
  assert.equal(slides.restrictions?.ancestor, 'slider');
  assert.equal(slides.children![0].restrictions?.ancestor, 'slides');
  assert.equal(slides.children![0].customName, 'Slide 1');

  // The slide keeps its content.
  assert.ok(findByName(slides.children![0], 'heading'), 'slide content survives');

  // Webflow's own arrows / bullet strip are gone — ycode regenerates them.
  const flat: Layer[] = [];
  const walk = (l: Layer) => { flat.push(l); (l.children ?? []).forEach(walk); };
  roots.forEach(walk);
  assert.equal(flat.some((l) => l.customName === 'left-arrow' || l.customName === 'slide-nav'), false);

  // Every produced sub-layer name is one ycode's slider family knows.
  for (const l of flat) {
    if (l.name.startsWith('slide')) {
      assert.ok((SLIDER_LAYER_NAMES as readonly string[]).includes(l.name), `${l.name} is not a slider layer name`);
    }
  }
});

test('slider: the generated chrome matches the element library template layer for layer', () => {
  // Drift guard: `widgets-native.ts` hand-writes the chrome so the importer does
  // not have to pull the 1.5 MB template tree into the API route. This asserts
  // the copy is still identical to what the builder inserts.
  const template = getLayerFromTemplate('slider');
  assert.ok(template);
  const expected = (template.children ?? []).filter((c) => c.name !== 'slides');
  const actual = sliderChromeLayers();

  const shape = (l: Layer): unknown => ({
    name: l.name,
    customName: l.customName,
    classes: Array.isArray(l.classes) ? l.classes.join(' ') : l.classes,
    design: l.design,
    restrictions: l.restrictions,
    settings: l.settings,
    variables: l.variables,
    children: (l.children ?? []).map(shape),
  });
  assert.deepEqual(actual.map(shape), expected.map(shape));
});

test('slider: an empty slider is reported, not silently produced', async () => {
  const { warn } = await build('<div class="w-slider"><div class="w-slider-mask"></div></div>');
  assert.equal(warn.count('widget_partial'), 1);
  assert.match(warn.list.find((w) => w.code === 'widget_partial')!.message, /no \.w-slide children/);
});

test('slider: the flag turns the builder off and the old generic-box path returns', async () => {
  const { page, layerByNode } = await build(SLIDER_HTML, { ctx: { widgets: { slider: false } } });
  const slider = layerOf(page, layerByNode, (n) => n.wf.classNames.includes('w-slider'));
  assert.equal(slider.name, 'div');
  assert.equal(slider.settings?.slider, undefined);
});

// ─── Lightbox ─────────────────────────────────────────────────────────────────

const LIGHTBOX_JSON = JSON.stringify({
  items: [
    { _id: '1', url: 'https://cdn.prod.website-files.com/x/a.jpg', type: 'image', fileName: 'a.jpg' },
    { _id: '2', url: 'https://cdn.prod.website-files.com/x/b.jpg', type: 'image', fileName: 'b.jpg' },
    { _id: '3', url: 'https://www.youtube.com/watch?v=1', type: 'video' },
  ],
  group: 'Werke Gallery',
});

const LIGHTBOX_HTML = `
<a href="#" class="gallery-link w-inline-block w-lightbox">
  <img src="images/a.jpg" alt="A" class="thumb">
  <script type="application/json" class="w-json">${LIGHTBOX_JSON}</script>
</a>`;

test('lightbox: the w-json payload is parsed, non-image items are counted', () => {
  const payload = parseLightboxPayload(LIGHTBOX_JSON);
  assert.deepEqual(payload.urls, ['https://cdn.prod.website-files.com/x/a.jpg', 'https://cdn.prod.website-files.com/x/b.jpg']);
  assert.equal(payload.group, 'Werke Gallery');
  assert.equal(payload.nonImage, 1);
  assert.deepEqual(parseLightboxPayload('not json'), { urls: [], group: '', nonImage: 0 });
});

test('lightbox: the Webflow gallery key is namespaced so it cannot collide with a user group', () => {
  assert.equal(lightboxGroupId('Werke Gallery'), 'wf-werke-gallery');
  assert.equal(lightboxGroupId(''), '');
});

test('lightbox: .w-lightbox becomes a lightbox layer with resolved asset ids and no link', async () => {
  const { page, layerByNode, warn } = await build(LIGHTBOX_HTML, {
    assets: {
      'https://cdn.prod.website-files.com/x/a.jpg': 'ast_a',
      'https://cdn.prod.website-files.com/x/b.jpg': 'ast_b',
      'images/a.jpg': 'ast_thumb',
    },
  });
  const lightbox = layerOf(page, layerByNode, (n) => n.wf.role === 'lightbox');

  assert.equal(lightbox.name, 'lightbox');
  assert.deepEqual(lightbox.settings?.lightbox?.files, ['ast_a', 'ast_b']);
  assert.equal(lightbox.settings?.lightbox?.filesSource, 'files');
  assert.equal(lightbox.settings?.lightbox?.groupId, 'wf-werke-gallery');
  assert.equal(lightbox.variables?.link, undefined, 'a lightbox opens an overlay, it must not navigate');
  assert.ok(findByName(lightbox, 'image'), 'the visible thumbnail survives');
  // The video item has no ycode equivalent and is reported.
  assert.equal(warn.count('widget_partial'), 1);
});

test('lightbox: a payload-less lightbox still becomes a lightbox and says so', async () => {
  const { page, layerByNode, warn } = await build('<a href="#" class="w-lightbox"><img src="images/a.jpg" alt=""></a>');
  const lightbox = layerOf(page, layerByNode, (n) => n.wf.role === 'lightbox');
  assert.equal(lightbox.name, 'lightbox');
  assert.deepEqual(lightbox.settings?.lightbox?.files, []);
  assert.match(warn.list.find((w) => w.code === 'widget_partial')!.message, /without a gallery payload/);
});

// ─── Form ─────────────────────────────────────────────────────────────────────

const FORM_HTML = `
<div class="form-block w-form">
  <form id="email-form" name="email-form" data-name="Email Form" method="get" class="form">
    <label for="name-2" class="field-label">Name</label>
    <input class="text-field w-input" maxlength="256" name="Name" data-name="Name" placeholder="Your name" type="text" id="name-2" required="">
    <label for="Message" class="field-label">Message</label>
    <textarea id="Message" name="Message" maxlength="5000" data-name="Message" placeholder="Hi" class="w-input" rows="4"></textarea>
    <select id="Topic" name="Topic" data-name="Topic" required="" class="w-select">
      <option value="">Select one...</option>
      <option value="press">Press</option>
    </select>
    <label class="w-checkbox checkbox-field">
      <input type="checkbox" id="Agree" name="Agree" data-name="Agree" class="w-checkbox-input">
      <span class="w-form-label" for="Agree">I agree</span>
    </label>
    <input type="submit" data-wait="Please wait..." class="submit-button w-button" value="Send">
  </form>
  <div class="success-message w-form-done"><div>Thank you! Your submission has been received!</div></div>
  <div class="error-message w-form-fail"><div>Oops! Something went wrong.</div></div>
</div>`;

test('form controls: the tag maps to the ycode layer name and keeps the attributes FormData needs', () => {
  const input = planFormControl('input', { type: 'email', name: 'Email', placeholder: 'you@x.com', required: '', maxlength: '256', 'data-name': 'Email' }, '');
  assert.deepEqual(input, {
    name: 'input',
    // `maxLength`, not `maxlength`: the renderer spreads these onto a React element.
    attributes: { type: 'email', name: 'Email', placeholder: 'you@x.com', required: true, maxLength: 256 },
  });

  // `<input type="submit">` is Webflow's submit button; ycode has a real button layer.
  assert.deepEqual(planFormControl('input', { type: 'submit', value: 'Send' }, ''), {
    name: 'button',
    attributes: { type: 'submit' },
    text: 'Send',
  });

  assert.deepEqual(planFormControl('option', { value: 'press' }, 'Press'), { name: 'option', attributes: { value: 'press' }, text: 'Press' });
  // Webflow's prompt option: the empty value is meaningful and marks the placeholder.
  assert.deepEqual(planFormControl('option', { value: '' }, 'Select one...'), { name: 'option', attributes: { value: '' }, text: 'Select one...', isPlaceholder: true });
  assert.equal(planFormControl('div', {}, ''), null);
});

test('form: every control becomes its native layer instead of an empty div', async () => {
  const { page, layerByNode } = await build(FORM_HTML);
  const form = layerOf(page, layerByNode, (n) => n.wf.role === 'form');

  assert.equal(form.name, 'form');
  assert.equal(form.settings?.id, 'email-form', 'form_id is reported from settings.id on submission');
  assert.equal(form.settings?.form?.success_action, 'message');

  const text = layerOf(page, layerByNode, (n) => n.wf.tag === 'input' && n.wf.htmlId === 'name-2');
  assert.equal(text.name, 'input');
  assert.equal(text.attributes?.name, 'Name', 'FormData keys on `name`; without it the payload is empty');
  assert.equal(text.attributes?.type, 'text');
  assert.equal(text.attributes?.placeholder, 'Your name');
  assert.equal(text.attributes?.required, true);
  assert.equal(text.attributes?.maxLength, 256);
  assert.equal(text.settings?.id, 'name-2');

  const area = layerOf(page, layerByNode, (n) => n.wf.tag === 'textarea');
  assert.equal(area.name, 'textarea');
  assert.equal(area.attributes?.rows, 4);
  assert.equal(area.attributes?.maxLength, 5000);

  const select = layerOf(page, layerByNode, (n) => n.wf.tag === 'select');
  assert.equal(select.name, 'select');
  assert.equal(select.attributes?.name, 'Topic');
  assert.deepEqual(names(select.children), ['option', 'option']);
  assert.equal(select.children![0].settings?.isPlaceholder, true, 'Webflow\'s prompt option drives the select placeholder');
  assert.equal(select.children![1].attributes?.value, 'press');
  assert.deepEqual(select.children![1].variables?.text, { type: 'dynamic_text', data: { content: 'Press' } });

  const checkbox = layerOf(page, layerByNode, (n) => n.wf.htmlId === 'Agree');
  assert.equal(checkbox.name, 'input');
  assert.equal(checkbox.attributes?.type, 'checkbox');
  assert.equal(checkbox.attributes?.name, 'Agree');

  const submit = layerOf(page, layerByNode, (n) => n.wf.formControl?.name === 'button');
  assert.equal(submit.name, 'button');
  assert.equal(submit.attributes?.type, 'submit');
});

test('form: the .w-form-done / .w-form-fail siblings move inside the form as alert children', async () => {
  const { page, layerByNode } = await build(FORM_HTML);
  const form = layerOf(page, layerByNode, (n) => n.wf.role === 'form');
  const wrapper = layerOf(page, layerByNode, (n) => n.wf.role === 'form-wrapper');

  // ycode's submit handler resolves them with form.querySelector('[data-alert-type]').
  const alerts = (form.children ?? []).filter((c) => c.alertType);
  assert.deepEqual(alerts.map((a) => a.alertType), ['success', 'error']);
  assert.ok(alerts.every((a) => a.hiddenGenerated));
  assert.equal((wrapper.children ?? []).some((c) => c.alertType), false, 'the alerts left the wrapper');
});

test('form: the flag turns the builder off', async () => {
  const { page, layerByNode } = await build(FORM_HTML, { ctx: { widgets: { form: false } } });
  const input = layerOf(page, layerByNode, (n) => n.wf.tag === 'input' && n.wf.htmlId === 'name-2');
  assert.equal(input.name, 'div', 'without the flag an input is the empty div it always was');
});

// ─── Tabs ─────────────────────────────────────────────────────────────────────

const TABS_HTML = `
<div data-current="Tab 1" data-easing="ease" data-duration-in="300" data-duration-out="100" class="tabs w-tabs">
  <div class="tabs-menu w-tab-menu">
    <a data-w-tab="Tab 1" class="tab-link w-inline-block w-tab-link w--current"><div>One</div></a>
    <a data-w-tab="Tab 2" class="tab-link w-inline-block w-tab-link"><div>Two</div></a>
  </div>
  <div class="tabs-content w-tab-content">
    <div data-w-tab="Tab 1" class="w-tab-pane w--tab-active"><p>First pane</p></div>
    <div data-w-tab="Tab 2" class="w-tab-pane"><p>Second pane</p></div>
  </div>
</div>`;

test('tabs: switching is rebuilt as one click interaction per tab link', async () => {
  const { page, layerByNode, generated } = await build(TABS_HTML);
  assert.equal(generated, 2);

  const links = [...page.nodeIndex.values()].filter((n) => n.wf.role === 'tab-link');
  const panes = [...page.nodeIndex.values()].filter((n) => n.wf.role === 'tab-pane');
  assert.equal(links.length, 2);
  assert.deepEqual(panes.map((p) => p.wf.tab?.active), [true, false]);

  const paneIds = panes.map((p) => layerByNode.get(p.wf.id)!.id);
  const firstLink = layerByNode.get(links[0].wf.id)!;
  const interaction = firstLink.interactions![0];

  assert.equal(interaction.trigger, 'click');
  assert.equal(interaction.timeline.yoyo, false, 'a tab is not a toggle');
  assert.equal(interaction.tweens.length, 2, 'one tween per pane: show mine, hide the others');

  const own = interaction.tweens.find((t) => t.layer_id === paneIds[0])!;
  assert.deepEqual([own.from.display, own.to.display], ['hidden', 'visible']);
  assert.equal(own.apply_styles.display, undefined, 'pane 1 starts active, so it is not hidden on load');

  const other = interaction.tweens.find((t) => t.layer_id === paneIds[1])!;
  assert.deepEqual([other.from.display, other.to.display], ['visible', 'hidden']);

  // Pane 2's own interaction is what hides it before the first click.
  const secondLink = layerByNode.get(links[1].wf.id)!;
  const ownSecond = secondLink.interactions![0].tweens.find((t) => t.layer_id === paneIds[1])!;
  assert.equal(ownSecond.apply_styles.display, 'on-load');

  // A tab link must not navigate to the fragment Webflow generated.
  assert.equal(firstLink.variables?.link, undefined);
});

test('tabs: a pane never carries a Tailwind `hidden` that would defeat the interaction', async () => {
  const { page, layerByNode } = await build(TABS_HTML);
  for (const pane of [...page.nodeIndex.values()].filter((n) => n.wf.role === 'tab-pane')) {
    assert.equal(classes(layerByNode.get(pane.wf.id)!).has('hidden'), false);
  }
});

test('tabs: a tab link without a pane is reported', async () => {
  const { warn } = await build(`
    <div class="w-tabs">
      <div class="w-tab-menu"><a data-w-tab="A" class="w-tab-link">A</a><a data-w-tab="B" class="w-tab-link">B</a></div>
      <div class="w-tab-content"><div data-w-tab="A" class="w-tab-pane w--tab-active">only one</div></div>
    </div>`);
  assert.equal(warn.count('widget_partial'), 1);
});

// ─── Columns ──────────────────────────────────────────────────────────────────

const ROW_HTML = `
<div class="w-container">
  <div class="columns w-row">
    <div class="w-col w-col-4 w-col-medium-6 w-col-small-12 w-col-tiny-6"><p>Left</p></div>
    <div class="w-col w-col-8"><p>Right</p></div>
  </div>
</div>`;

test('columns: .w-col-N widths follow Webflow\'s own arithmetic and breakpoint resets', () => {
  assert.equal(columnWidth(1), '8.333333%');
  assert.equal(columnWidth(6), '50%');
  assert.equal(columnWidth(12), '100%');

  const map = columnFrameworkClasses();
  assert.deepEqual(map['w-col-6'], ['w-[50%]', 'max-md:w-full'], 'Webflow stacks columns at <= 767px unless a small variant says otherwise');
  assert.deepEqual(map['w-col-medium-6'], ['max-lg:w-[50%]']);
  assert.deepEqual(map['w-col-small-12'], ['max-md:w-full']);
  assert.deepEqual(map['w-col-tiny-6'], [], 'tiny (<= 479px) has no ycode tier');
  assert.deepEqual(map['w-row'], ['flex', 'flex-wrap']);
});

test('columns: a .w-row grid gets real widths and readable names instead of anonymous divs', async () => {
  const { page, layerByNode, warn } = await build(ROW_HTML);
  const row = layerOf(page, layerByNode, (n) => n.wf.role === 'row');
  assert.equal(row.customName, 'Row');
  assert.ok(classes(row).has('flex'));

  const cols = [...page.nodeIndex.values()].filter((n) => n.wf.role === 'col');
  assert.equal(cols.length, 2);
  const left = layerByNode.get(cols[0].wf.id)!;
  assert.equal(left.customName, 'Column 4/12');
  const leftClasses = classes(left);
  assert.ok(leftClasses.has('w-[33.333333%]'), `desktop width missing: ${[...leftClasses].join(' ')}`);
  assert.ok(leftClasses.has('max-lg:w-[50%]'), 'medium variant');
  assert.ok(leftClasses.has('max-md:w-full'), 'small variant');

  // tiny is honestly reported rather than silently dropped.
  assert.equal(warn.count('widget_partial'), 1);
  assert.match(warn.list.find((w) => w.code === 'widget_partial')!.message, /w-col-tiny/);
});

// ─── Flags / warnings ─────────────────────────────────────────────────────────

test('flags: every widget defaults to on and can be turned off individually', () => {
  const all = resolveWidgetFlags();
  assert.deepEqual(all, { slider: true, tabs: true, lightbox: true, form: true, columns: true, richText: true });
  assert.equal(resolveWidgetFlags({ slider: false }).slider, false);
  assert.equal(resolveWidgetFlags({ slider: false }).form, true);
});

test('widgets no longer fall through to the unmapped-class warning', async () => {
  const { warn } = await build(`${SLIDER_HTML}${TABS_HTML}${FORM_HTML}${ROW_HTML}${LIGHTBOX_HTML}`);
  assert.equal(warn.count('html_unmapped'), 0, warn.list.map((w) => w.message).join('\n'));
});

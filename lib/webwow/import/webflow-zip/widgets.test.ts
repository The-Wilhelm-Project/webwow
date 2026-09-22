import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Layer } from '@/types';
import { Warnings } from './warnings';
import type { WfNode, WfPage } from './types';
import { generateWidgetInteractions, stripDisplayShims } from './widgets';

let counter = 0;
function node(role: WfNode['wf']['role'] | undefined, children: WfNode[] = [], extra: Partial<WfNode['wf']> = {}): WfNode {
  const id = `p#${counter++}`;
  return { kind: 'box', tag: 'div', children, wf: { id, page: 'p', tag: 'div', classNames: [], siteClasses: [], attrs: {}, bindEmpty: false, role, ...extra } };
}

function page(roots: WfNode[]): { page: WfPage; layers: Map<string, Layer> } {
  const nodeIndex = new Map<string, WfNode>();
  const layers = new Map<string, Layer>();
  const walk = (list: WfNode[]) => {
    for (const n of list) {
      nodeIndex.set(n.wf.id, n);
      layers.set(n.wf.id, { id: `lyr-${n.wf.id}`, name: 'div', classes: `relative ${n.wf.role === 'dropdown-list' ? 'hidden absolute' : ''} ${n.wf.role === 'nav-menu' ? 'max-lg:hidden' : ''}`.trim() });
      if (n.children) walk(n.children);
    }
  };
  walk(roots);
  return { page: { name: 'index', title: '', description: '', lang: 'en', bodyClassNames: [], roots, nodeIndex, headStyles: [], bodyScripts: [], isEmpty: false }, layers };
}

test('navbar collapse=all -> click/yoyo display toggle on the button for every breakpoint', () => {
  const button = node('nav-button');
  const menu = node('nav-menu');
  const nav = node('nav', [node('nav-brand'), menu, button], { navCollapse: 'all', attrs: { 'data-duration': '400' } });
  const { page: p, layers } = page([nav]);
  const warn = new Warnings();
  assert.deepEqual(generateWidgetInteractions(p, layers, warn), { generated: 1 });
  const buttonLayer = layers.get(button.wf.id)!;
  assert.equal(buttonLayer.interactions?.length, 1);
  const int = buttonLayer.interactions![0];
  assert.equal(int.trigger, 'click');
  assert.deepEqual(int.timeline, { breakpoints: ['desktop', 'tablet', 'mobile'], repeat: 0, yoyo: true });
  assert.equal(int.tweens.length, 1);
  const tween = int.tweens[0];
  assert.equal(tween.layer_id, layers.get(menu.wf.id)!.id);
  assert.deepEqual({ position: tween.position, duration: tween.duration, ease: tween.ease, from: tween.from, to: tween.to, apply_styles: tween.apply_styles }, {
    position: 0, duration: 0.4, ease: 'none', from: { display: 'hidden' }, to: { display: 'visible' }, apply_styles: { display: 'on-load' },
  });
  assert.ok(int.id.startsWith('int-') && tween.id.startsWith('twn-'));
  assert.equal(layers.get(menu.wf.id)!.classes, 'relative', 'display shims removed from the menu');
  assert.equal(layers.get(menu.wf.id)!.interactions, undefined);
  assert.equal(warn.list.length, 0);
});

test('navbar collapse=medium -> tablet+mobile, small -> mobile, none -> nothing, custom duration honoured', () => {
  const build = (collapse: WfNode['wf']['navCollapse'], duration?: string) => {
    const button = node('nav-button');
    const menu = node('nav-menu');
    const nav = node('nav', [menu, button], { navCollapse: collapse, attrs: duration ? { 'data-duration': duration } : {} });
    const { page: p, layers } = page([nav]);
    const result = generateWidgetInteractions(p, layers, new Warnings());
    return { result, interaction: layers.get(button.wf.id)!.interactions?.[0] };
  };
  const medium = build('medium', '250');
  assert.deepEqual(medium.interaction!.timeline.breakpoints, ['tablet', 'mobile']);
  assert.equal(medium.interaction!.tweens[0].duration, 0.25);
  assert.deepEqual(build('small').interaction!.timeline.breakpoints, ['mobile']);
  assert.deepEqual(build('tiny').interaction!.timeline.breakpoints, ['mobile']);
  assert.deepEqual(build(undefined).interaction!.timeline.breakpoints, ['tablet', 'mobile'], 'Webflow default is medium');
  const none = build('none');
  assert.deepEqual(none.result, { generated: 0 });
  assert.equal(none.interaction, undefined);
});

test('dropdown: hover vs click trigger, tween on the sibling list, framework hidden removed from the list', () => {
  const toggle1 = node('dropdown-toggle', [node('dropdown-icon')]);
  const list1 = node('dropdown-list');
  const dd1 = node('dropdown', [toggle1, list1], { dropdownHover: false });
  const toggle2 = node('dropdown-toggle');
  const list2 = node('dropdown-list');
  const dd2 = node('dropdown', [toggle2, list2], { dropdownHover: true });
  const item = node('dyn-item', [dd1, dd2]);
  const { page: p, layers } = page([node('dyn-list', [node('dyn-items', [item])])]);
  const warn = new Warnings();
  assert.deepEqual(generateWidgetInteractions(p, layers, warn), { generated: 2 });
  const click = layers.get(toggle1.wf.id)!.interactions![0];
  assert.equal(click.trigger, 'click');
  assert.equal(click.timeline.yoyo, true);
  assert.equal(click.tweens[0].layer_id, layers.get(list1.wf.id)!.id);
  assert.equal(click.tweens[0].duration, 0.2);
  assert.deepEqual(click.tweens[0].apply_styles, { display: 'on-load' });
  // webflow.js listens for mouseenter / mouseleave on the `.w-dropdown` wrapper, so
  // the hover interaction sits there and the list stays open while the pointer is in it.
  const hover = layers.get(dd2.wf.id)!.interactions![0];
  assert.equal(hover.trigger, 'hover');
  assert.equal(hover.tweens[0].layer_id, layers.get(list2.wf.id)!.id);
  assert.equal(layers.get(toggle2.wf.id)!.interactions, undefined);
  assert.equal(layers.get(list1.wf.id)!.classes, 'relative absolute');
  assert.equal(layers.get(list2.wf.id)!.classes, 'relative absolute');
  assert.equal(layers.get(dd1.wf.id)!.interactions, undefined);
  // Hooks for the constant runtime line (outside click / Escape, aria-expanded).
  assert.deepEqual(layers.get(dd1.wf.id)!.attributes, { 'data-webwow-dropdown': 'click' });
  assert.deepEqual(layers.get(dd2.wf.id)!.attributes, { 'data-webwow-dropdown': 'hover' });
  assert.deepEqual(layers.get(toggle1.wf.id)!.attributes, { 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
  assert.deepEqual(layers.get(toggle2.wf.id)!.attributes, { 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
});

test('a toggle with `w--open` styles (wf.stateTween) gets a second tween on the same interaction; nav button likewise', () => {
  const stateTween = { from: { backgroundColor: '#000000', rotation: '0deg' }, to: { backgroundColor: '#333333', rotation: '180deg' } };
  const toggle = node('dropdown-toggle', [], { stateTween });
  const list = node('dropdown-list');
  const dd = node('dropdown', [toggle, list], { dropdownHover: true });
  const button = node('nav-button', [], { stateTween: { from: {}, to: { backgroundColor: '#444444' } } });
  const menu = node('nav-menu');
  const nav = node('nav', [menu, button], { navCollapse: 'all', attrs: {} });
  const { page: p, layers } = page([dd, nav]);
  const warn = new Warnings();
  assert.deepEqual(generateWidgetInteractions(p, layers, warn), { generated: 2 });

  const hover = layers.get(dd.wf.id)!.interactions![0];
  assert.equal(hover.tweens.length, 2);
  assert.deepEqual(hover.tweens.map((t) => [t.layer_id, t.position, t.duration, t.ease]), [[layers.get(list.wf.id)!.id, 0, 0.2, 'none'], [layers.get(toggle.wf.id)!.id, 0, 0.2, 'none']]);
  assert.deepEqual({ from: hover.tweens[1].from, to: hover.tweens[1].to, apply: hover.tweens[1].apply_styles }, { from: stateTween.from, to: stateTween.to, apply: {} });
  assert.equal(hover.timeline.yoyo, true, 'the open state reverses with the list');

  const click = layers.get(button.wf.id)!.interactions![0];
  assert.deepEqual(click.tweens.map((t) => t.layer_id), [layers.get(menu.wf.id)!.id, layers.get(button.wf.id)!.id]);
  assert.deepEqual(click.tweens[1].to, { backgroundColor: '#444444' });
  assert.equal(click.tweens[1].duration, 0.4);
  assert.equal(warn.list.length, 0);
});

test('incomplete widgets warn and generate nothing; stripDisplayShims handles arrays and chip overrides', () => {
  const nav = node('nav', [node('nav-menu')], { navCollapse: 'all' });
  const dd = node('dropdown', [node('dropdown-toggle')]);
  const { page: p, layers } = page([nav, dd]);
  const warn = new Warnings();
  assert.deepEqual(generateWidgetInteractions(p, layers, warn), { generated: 0 });
  assert.equal(warn.count('html_unmapped'), 2);

  const layer: Layer = { id: 'x', name: 'div', classes: ['hidden', 'flex', 'max-md:hidden'], styleOverridesByStyle: { s1: { classes: 'max-lg:hidden p-[2px]' } } };
  stripDisplayShims(layer);
  assert.deepEqual(layer.classes, ['flex']);
  assert.equal(layer.styleOverridesByStyle!.s1.classes, 'p-[2px]');
});

test('tabs: a tab link with `w--current` styles (wf.stateTween) gets its active look on its own click and its resting look on the others; the current tab starts active', () => {
  const active = { from: { backgroundColor: '#eeeeee' }, to: { backgroundColor: '#000000' } };
  const linkA = node('tab-link', [], { tab: { id: 'A', active: true }, stateTween: active });
  const linkB = node('tab-link', [], { tab: { id: 'B', active: false }, stateTween: active });
  const linkC = node('tab-link', [], { tab: { id: 'C', active: false } });
  const paneA = node('tab-pane', [], { tab: { id: 'A', active: true } });
  const paneB = node('tab-pane', [], { tab: { id: 'B', active: false } });
  const paneC = node('tab-pane', [], { tab: { id: 'C', active: false } });
  const tabs = node('tabs', [node('tab-menu', [linkA, linkB, linkC]), node('tab-content', [paneA, paneB, paneC])]);
  const { page: p, layers } = page([tabs]);
  const warn = new Warnings();
  assert.deepEqual(generateWidgetInteractions(p, layers, warn), { generated: 3 });
  const id = (n: WfNode) => layers.get(n.wf.id)!.id;
  const linkTweens = (n: WfNode) => layers.get(n.wf.id)!.interactions![0].tweens.filter((t) => [id(linkA), id(linkB)].includes(t.layer_id)).map((t) => [t.layer_id, t.from, t.to, t.duration, t.apply_styles]);
  // Click A: A active, B resting. `from` is each link's on-load look (A starts active), which the runtime pre-paints.
  assert.deepEqual(linkTweens(linkA), [
    [id(linkA), { backgroundColor: '#000000' }, { backgroundColor: '#000000' }, 0, {}],
    [id(linkB), { backgroundColor: '#eeeeee' }, { backgroundColor: '#eeeeee' }, 0, {}],
  ]);
  assert.deepEqual(linkTweens(linkB), [
    [id(linkA), { backgroundColor: '#000000' }, { backgroundColor: '#eeeeee' }, 0, {}],
    [id(linkB), { backgroundColor: '#eeeeee' }, { backgroundColor: '#000000' }, 0, {}],
  ]);
  // A tab without an active look (C) still resets the styled ones when clicked.
  assert.deepEqual(linkTweens(linkC).map((t) => t[2]), [{ backgroundColor: '#eeeeee' }, { backgroundColor: '#eeeeee' }]);
  assert.equal(layers.get(linkC.wf.id)!.interactions![0].tweens.length, 5, 'three panes + two styled links');
  assert.ok(layers.get(linkA.wf.id)!.interactions![0].tweens.every((t) => t.position === 0));
  assert.equal(warn.list.length, 0);
});

test('tabs: when no tab link is marked current the first styled one starts active', () => {
  const active = { from: { autoAlpha: '50' }, to: { autoAlpha: '100' } };
  const linkA = node('tab-link', [], { tab: { id: 'A', active: false }, stateTween: active });
  const linkB = node('tab-link', [], { tab: { id: 'B', active: false }, stateTween: active });
  const tabs = node('tabs', [node('tab-menu', [linkA, linkB]), node('tab-content', [node('tab-pane', [], { tab: { id: 'A', active: false } }), node('tab-pane', [], { tab: { id: 'B', active: false } })])]);
  const { page: p, layers } = page([tabs]);
  generateWidgetInteractions(p, layers, new Warnings());
  const own = layers.get(linkB.wf.id)!.interactions![0].tweens.filter((t) => t.layer_id === layers.get(linkA.wf.id)!.id || t.layer_id === layers.get(linkB.wf.id)!.id);
  assert.deepEqual(own.map((t) => t.from), [{ autoAlpha: '100' }, { autoAlpha: '50' }]);
});

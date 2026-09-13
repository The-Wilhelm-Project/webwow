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
  const hover = layers.get(toggle2.wf.id)!.interactions![0];
  assert.equal(hover.trigger, 'hover');
  assert.equal(hover.tweens[0].layer_id, layers.get(list2.wf.id)!.id);
  assert.equal(layers.get(list1.wf.id)!.classes, 'relative absolute');
  assert.equal(layers.get(list2.wf.id)!.classes, 'relative absolute');
  assert.equal(layers.get(dd1.wf.id)!.interactions, undefined);
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

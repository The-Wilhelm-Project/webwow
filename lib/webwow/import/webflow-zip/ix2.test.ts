import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Layer } from '@/types';
import { Warnings } from './warnings';
import type { WfNode, WfPage } from './types';
import type { Ix2ActionItem, Ix2Data, Ix2Event } from './ix2-parse';
import { parseIx2FromJs } from './ix2-parse';
import { actionItemToTween, mapEase, mapInteractions, matchSelector } from './ix2';
import { buildStyleModel } from './css';
import { loadSvgIcons, parsePage } from './html';
import type { WfZipBundle, WfZipFile } from './zip';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let counter = 0;
function node(classNames: string[], children: WfNode[] = [], extra: Partial<WfNode['wf']> = {}): WfNode {
  const id = `p#${counter++}`;
  return {
    kind: 'box',
    tag: 'div',
    children,
    wf: { id, page: 'p', tag: 'div', classNames, siteClasses: classNames.filter((c) => !c.startsWith('w-')), attrs: {}, bindEmpty: false, ...extra },
  };
}

function page(name: string, roots: WfNode[], wfPageId?: string): WfPage {
  const nodeIndex = new Map<string, WfNode>();
  const walk = (list: WfNode[]) => {
    for (const n of list) {
      n.wf.page = name;
      nodeIndex.set(n.wf.id, n);
      if (n.children) walk(n.children);
    }
  };
  walk(roots);
  return { name, wfPageId, title: name, description: '', lang: 'en', bodyClassNames: [], roots, nodeIndex, headStyles: [], bodyScripts: [], isEmpty: false };
}

function layersFor(pages: WfPage[]): Map<string, Layer> {
  const map = new Map<string, Layer>();
  for (const p of pages) for (const [id] of p.nodeIndex) map.set(id, { id: `lyr-${id}`, name: 'div', classes: '' });
  return map;
}

function event(id: string, eventTypeId: string, target: Ix2Event['target'], actionListId: string, extra: Partial<Ix2Event> = {}): Ix2Event {
  const { action: extraAction, ...rest } = extra;
  return {
    id,
    eventTypeId,
    animationType: 'custom',
    mediaQueries: ['main', 'medium', 'small', 'tiny'],
    target,
    config: { loop: false, playInReverse: false, scrollOffsetValue: null, scrollOffsetUnit: null, delay: null, direction: null, effectIn: null },
    ...rest,
    action: {
      actionTypeId: extraAction?.actionTypeId ?? 'GENERAL_START_ACTION',
      config: { delay: 0, easing: '', duration: 0, actionListId, affectedElements: {}, playInReverse: false, ...(extraAction?.config ?? {}) },
    },
  };
}

const CHILD = (selector: string) => ({ useEventTarget: 'CHILDREN' as const, selector });
const SELF = { id: 'N/A', appliesTo: 'TRIGGER_ELEMENT', useEventTarget: true as const };

function item(actionTypeId: string, config: Ix2ActionItem['config']): Ix2ActionItem {
  return { actionTypeId, config };
}

// ─── mapEase ──────────────────────────────────────────────────────────────────

test('mapEase: Webflow names -> GSAP eases, arrays approximated', () => {
  const table: Record<string, string> = {
    '': 'none', linear: 'none', ease: 'power1.inOut', easeIn: 'power1.in', easeOut: 'power1.out', easeInOut: 'power1.inOut',
    inQuad: 'power1.in', outQuad: 'power1.out', inOutQuad: 'power1.inOut', inCubic: 'power2.in', outCubic: 'power2.out',
    inQuart: 'power3.in', outQuart: 'power3.out', inOutQuart: 'power3.inOut', outQuint: 'power4.out', inSine: 'sine.in',
    outExpo: 'expo.out', inOutCirc: 'circ.inOut', inBack: 'back.in', outBack: 'back.out', inOutBack: 'back.inOut',
    swingFrom: 'back.in', swingTo: 'back.out', swingFromTo: 'back.inOut', outElastic: 'elastic.out', bounce: 'bounce.out',
    outBounce: 'bounce.out', bouncePast: 'bounce.out',
  };
  for (const [wf, gsap] of Object.entries(table)) assert.deepEqual(mapEase(wf), { ease: gsap, approximated: false }, wf);
  assert.deepEqual(mapEase(undefined), { ease: 'none', approximated: false });
  assert.equal(mapEase('whatever').approximated, true);
  const linear = mapEase([0, 0, 1, 1]);
  assert.equal(linear.ease, 'none');
  assert.equal(linear.approximated, true);
  const easeOut = mapEase([0, 0, 0.58, 1]);
  assert.ok(easeOut.ease.endsWith('.out'), easeOut.ease);
  const easeIn = mapEase([0.42, 0, 1, 1]);
  assert.ok(easeIn.ease.endsWith('.in'), easeIn.ease);
  assert.equal(mapEase([0.165, 0.84, 0.44, 1]).ease, 'power3.out');
  assert.equal(mapEase([1, 2]).approximated, true);
});

// ─── actionItemToTween ────────────────────────────────────────────────────────

test('actionItemToTween per action type', () => {
  const warn = new Warnings();
  assert.deepEqual(actionItemToTween(item('TRANSFORM_MOVE', { xValue: 0.07, yValue: -0.07, xUnit: 'rem', yUnit: 'rem' }), warn), { x: '0.07rem', y: '-0.07rem' });
  assert.deepEqual(actionItemToTween(item('TRANSFORM_MOVE', { yValue: 102, xUnit: 'PX', yUnit: '%' }), warn), { y: '102%' });
  assert.deepEqual(actionItemToTween(item('TRANSFORM_MOVE', { xValue: 10, zValue: 5, xUnit: 'PX' }), warn), { x: '10px' });
  assert.equal(warn.count('ix2_unsupported_action'), 1, 'z axis warning');
  assert.deepEqual(actionItemToTween(item('TRANSFORM_SCALE', { xValue: 1.3, yValue: 1.3 })), { scale: '1.3' });
  assert.deepEqual(actionItemToTween(item('TRANSFORM_ROTATE', { zValue: -10, zUnit: 'deg' })), { rotation: '-10deg' });
  assert.deepEqual(actionItemToTween(item('TRANSFORM_SKEW', { xValue: 5, yValue: 0 })), { skewX: '5deg', skewY: '0deg' });
  assert.deepEqual(actionItemToTween(item('STYLE_OPACITY', { value: 0.5 })), { autoAlpha: '50' });
  assert.deepEqual(actionItemToTween(item('STYLE_SIZE', { widthValue: 100, heightValue: 0, widthUnit: '%', heightUnit: '%' })), { width: '100%', height: '0%' });
  const sizeWarn = new Warnings();
  assert.deepEqual(actionItemToTween(item('STYLE_SIZE', { widthValue: 100, heightValue: 50, widthUnit: 'AUTO', heightUnit: 'PX' }), sizeWarn), { height: '50px' });
  assert.equal(sizeWarn.count('ix2_unsupported_action'), 1);
  assert.deepEqual(actionItemToTween(item('STYLE_BACKGROUND_COLOR', { rValue: 0, gValue: 100, bValue: 80, aValue: 1 })), { backgroundColor: '#006450' });
  assert.deepEqual(actionItemToTween(item('STYLE_BACKGROUND_COLOR', { rValue: 255, gValue: 255, bValue: 255, aValue: 0.5 })), { backgroundColor: '#ffffff/50' });
  assert.deepEqual(actionItemToTween(item('STYLE_FILTER', { filters: [{ type: 'blur', value: 5, unit: 'px' }, { type: 'brightness', value: 120, unit: '%' }, { type: 'grayscale', value: 100, unit: '%' }] })), { filterBlur: '5', filterBrightness: '1.2', filterGrayscale: '100' });
  assert.deepEqual(actionItemToTween(item('GENERAL_DISPLAY', { value: 'none' })), { display: 'hidden' });
  assert.deepEqual(actionItemToTween(item('GENERAL_DISPLAY', { value: 'flex' })), { display: 'visible' });
  const unsupported = new Warnings();
  for (const type of ['STYLE_TEXT_COLOR', 'STYLE_BORDER', 'STYLE_FONT_VARIATION', 'OBJECT_VALUE', 'PLUGIN_LOTTIE', 'GENERAL_COMBO_CLASS', 'GENERAL_LOOP']) {
    assert.equal(actionItemToTween(item(type, { target: CHILD('.x') }), unsupported), null, type);
  }
  assert.equal(unsupported.count('ix2_unsupported_action'), 7);
  assert.ok(unsupported.list.some((w) => w.message.includes('STYLE_TEXT_COLOR') && w.message.includes('.x')));
});

test('matchSelector matches compound class selectors', () => {
  const a = node(['a', 'b']);
  const b = node(['a']);
  const c = node(['b', 'a', 'c']);
  assert.deepEqual(matchSelector('.a.b', [a, b, c]), [a, c]);
  assert.deepEqual(matchSelector('.a', [a, b, c]), [a, b, c]);
  assert.deepEqual(matchSelector('.nav .a.b', [a, b, c]), [a, c]);
  assert.deepEqual(matchSelector('', [a]), []);
});

// ─── mapping ──────────────────────────────────────────────────────────────────

test('MOUSE_OVER + MOUSE_OUT pair -> one hover interaction (yoyo) with CHILDREN targets and initial-state from values', () => {
  const bg = node(['fixed-menu-item_bg']);
  const label = node(['heading-xlarge']);
  const trigger = node(['fixed-menu_item', 'w-inline-block'], [label, bg]);
  const stray = node(['fixed-menu-item_bg']);
  const p = page('index', [node(['nav'], [trigger]), stray], 'pg1');
  const layerByNode = layersFor([p]);
  const data: Ix2Data = {
    events: {
      'e-2': event('e-2', 'MOUSE_OUT', { selector: '.fixed-menu_item', appliesTo: 'CLASS' }, 'a-4', { action: { config: { autoStopEventId: 'e-22' } } }),
      'e-22': event('e-22', 'MOUSE_OVER', { selector: '.fixed-menu_item', appliesTo: 'CLASS' }, 'a-7', { action: { config: { autoStopEventId: 'e-2' } } }),
    },
    actionLists: {
      'a-7': {
        id: 'a-7',
        useFirstGroupAsInitialState: true,
        actionItemGroups: [
          { actionItems: [item('STYLE_SIZE', { delay: 0, easing: '', duration: 500, target: CHILD('.fixed-menu-item_bg'), widthValue: 100, heightValue: 0, widthUnit: '%', heightUnit: '%' }), item('STYLE_TEXT_COLOR', { delay: 0, duration: 500, target: CHILD('.heading-xlarge'), rValue: 0, gValue: 100, bValue: 80, aValue: 1 })] },
          { actionItems: [item('STYLE_SIZE', { delay: 0, easing: 'outQuint', duration: 700, target: CHILD('.fixed-menu-item_bg'), widthValue: 100, heightValue: 100, widthUnit: '%', heightUnit: '%' }), item('STYLE_TEXT_COLOR', { delay: 0, easing: 'outQuint', duration: 700, target: CHILD('.heading-xlarge'), rValue: 255, gValue: 255, bValue: 255, aValue: 1 })] },
        ],
      },
      'a-4': { id: 'a-4', actionItemGroups: [{ actionItems: [item('STYLE_SIZE', { delay: 0, easing: 'outQuint', duration: 700, target: CHILD('.fixed-menu-item_bg'), widthValue: 100, heightValue: 0, widthUnit: '%', heightUnit: '%' })] }] },
    },
  };
  const warn = new Warnings();
  const result = mapInteractions({ data, pages: [p], layerByNode, warn });
  assert.equal(result.definitions, 1);
  assert.equal(result.instances, 1);
  const { interaction, triggerLayerId, page: pageName } = result.items[0];
  assert.equal(pageName, 'index');
  assert.equal(triggerLayerId, `lyr-${trigger.wf.id}`);
  assert.equal(interaction.trigger, 'hover');
  assert.deepEqual(interaction.timeline, { breakpoints: ['desktop', 'tablet', 'mobile'], repeat: 0, yoyo: true });
  assert.equal(interaction.tweens.length, 1);
  const tween = interaction.tweens[0];
  assert.equal(tween.layer_id, `lyr-${bg.wf.id}`, 'CHILDREN resolves inside the trigger subtree only');
  assert.deepEqual({ from: tween.from, to: tween.to, duration: tween.duration, ease: tween.ease, position: tween.position }, {
    from: { width: '100%', height: '0%' }, to: { width: '100%', height: '100%' }, duration: 0.7, ease: 'power4.out', position: 0,
  });
  assert.deepEqual(tween.apply_styles, { width: 'on-trigger', height: 'on-trigger' });
  assert.ok(tween.id.startsWith('twn-'));
  assert.ok(interaction.id.startsWith('int-'));
  assert.deepEqual(layerByNode.get(trigger.wf.id)!.interactions, [interaction], 'pushed onto the trigger layer');
  assert.equal(warn.count('ix2_unsupported_action'), 2, 'two text colour items');
  assert.equal(warn.count('ix2_unsupported_event'), 0);
});

test('SCROLL_INTO_VIEW + OUT pair -> scroll-into-view with reverse toggle actions, group timing, merged keys', () => {
  const card = node(['collection-item', 'w-dyn-item'], [], { wId: '8d505578-aaaa' });
  const other = node(['collection-item', 'w-dyn-item'], [], { wId: '8d505578-aaaa_instance-1' });
  const p1 = page('index', [node(['list'], [card])], 'pg1');
  const p2 = page('work', [other], 'pg2');
  const layerByNode = layersFor([p1, p2]);
  const data: Ix2Data = {
    events: {
      'e-31': { ...event('e-31', 'SCROLL_INTO_VIEW', { id: '8d505578-aaaa', appliesTo: 'ELEMENT' }, 'growBigIn', { action: { config: { autoStopEventId: 'e-32' } } }), animationType: 'preset', config: { loop: false, playInReverse: false, scrollOffsetValue: 0, scrollOffsetUnit: '%', delay: 0, direction: null, effectIn: true } },
      'e-32': { ...event('e-32', 'SCROLL_OUT_OF_VIEW', { id: '8d505578-aaaa', appliesTo: 'ELEMENT' }, 'shrinkBigOut', { action: { config: { autoStopEventId: 'e-31' } } }), animationType: 'preset' },
    },
    actionLists: {
      growBigIn: {
        id: 'growBigIn',
        useFirstGroupAsInitialState: true,
        actionItemGroups: [
          { actionItems: [item('STYLE_OPACITY', { delay: 0, duration: 0, target: SELF, value: 0 })] },
          { actionItems: [item('TRANSFORM_SCALE', { delay: 0, duration: 0, target: SELF, xValue: 0, yValue: 0 })] },
          { actionItems: [item('TRANSFORM_SCALE', { delay: 0, easing: 'outQuart', duration: 1000, target: SELF, xValue: 1, yValue: 1 }), item('STYLE_OPACITY', { delay: 0, easing: 'outQuart', duration: 1000, target: SELF, value: 1 })] },
          { actionItems: [item('TRANSFORM_MOVE', { delay: 200, easing: 'outQuad', duration: 300, target: SELF, yValue: 10, yUnit: 'PX' })] },
        ],
      },
      shrinkBigOut: { id: 'shrinkBigOut', actionItemGroups: [{ actionItems: [item('TRANSFORM_SCALE', { delay: 0, easing: 'inQuart', duration: 1000, target: SELF, xValue: 0, yValue: 0 })] }] },
    },
  };
  const warn = new Warnings();
  const result = mapInteractions({ data, pages: [p1, p2], layerByNode, warn });
  assert.equal(result.definitions, 1);
  assert.equal(result.instances, 2, 'exact id and _instance ids on every page');
  const int = result.items[0].interaction;
  assert.equal(int.trigger, 'scroll-into-view');
  assert.deepEqual(int.timeline, { breakpoints: ['desktop', 'tablet', 'mobile'], repeat: 0, yoyo: false, scrollStart: 'top bottom', toggleActions: 'play reverse play reverse' });
  assert.equal(int.tweens.length, 2);
  const [grow, move] = int.tweens;
  assert.equal(grow.layer_id, `lyr-${card.wf.id}`);
  assert.deepEqual({ from: grow.from, to: grow.to, ease: grow.ease, position: grow.position, duration: grow.duration }, {
    from: { autoAlpha: '0', scale: '0' }, to: { autoAlpha: '100', scale: '1' }, ease: 'power3.out', position: 0, duration: 1,
  });
  assert.deepEqual(grow.apply_styles, { scale: 'on-load', autoAlpha: 'on-load' });
  assert.deepEqual({ from: move.from, to: move.to, position: move.position, duration: move.duration, ease: move.ease }, { from: { y: '0px' }, to: { y: '10px' }, position: 1.2, duration: 0.3, ease: 'power1.out' });
  assert.equal(warn.list.length, 0);
});

test('page-scoped element ids, scroll offsets, load events, loop and breakpoints', () => {
  const a = node(['x'], [], { wId: 'el-1' });
  const b = node(['x'], [], { wId: 'el-1' });
  const p1 = page('index', [a], 'page-a');
  const p2 = page('work', [b], 'page-b');
  const layerByNode = layersFor([p1, p2]);
  const data: Ix2Data = {
    events: {
      scoped: { ...event('scoped', 'SCROLL_INTO_VIEW', { id: 'page-a|el-1', appliesTo: 'ELEMENT' }, 'fade'), mediaQueries: ['main', 'medium'], config: { loop: true, playInReverse: false, scrollOffsetValue: 20, scrollOffsetUnit: '%', delay: 0, direction: null, effectIn: true } },
      load: { ...event('load', 'PAGE_START', { selector: '.x', appliesTo: 'CLASS' }, 'fade'), mediaQueries: ['small', 'tiny'] },
      px: { ...event('px', 'SCROLL_INTO_VIEW', { selector: '.x', appliesTo: 'CLASS' }, 'fade'), config: { loop: false, playInReverse: false, scrollOffsetValue: 50, scrollOffsetUnit: 'PX', delay: 0, direction: null, effectIn: true } },
    },
    actionLists: { fade: { id: 'fade', actionItemGroups: [{ actionItems: [item('STYLE_OPACITY', { delay: 100, easing: 'ease', duration: 400, target: SELF, value: 1 })] }] } },
  };
  const result = mapInteractions({ data, pages: [p1, p2], layerByNode, warn: new Warnings() });
  assert.equal(result.definitions, 3);
  const scoped = result.items.filter((i) => i.interaction.timeline.repeat === -1);
  assert.equal(scoped.length, 1, 'pageId|id only matches the page with that data-wf-page');
  assert.equal(scoped[0].page, 'index');
  assert.deepEqual(scoped[0].interaction.timeline.breakpoints, ['desktop', 'tablet']);
  assert.equal(scoped[0].interaction.timeline.scrollStart, 'top 80%');
  assert.equal(scoped[0].interaction.timeline.toggleActions, 'play none none none');
  assert.deepEqual({ position: scoped[0].interaction.tweens[0].position, duration: scoped[0].interaction.tweens[0].duration, ease: scoped[0].interaction.tweens[0].ease, from: scoped[0].interaction.tweens[0].from }, { position: 0.1, duration: 0.4, ease: 'power1.inOut', from: { autoAlpha: '100' } });
  const loads = result.items.filter((i) => i.interaction.trigger === 'load');
  assert.equal(loads.length, 2);
  assert.deepEqual(loads[0].interaction.timeline.breakpoints, ['mobile']);
  assert.deepEqual(loads[0].interaction.tweens[0].apply_styles, { autoAlpha: 'on-load' });
  const px = result.items.filter((i) => i.interaction.timeline.scrollStart === 'top bottom-=50px');
  assert.equal(px.length, 2);
});

test('zero targets: missing trigger and missing item targets are dropped with warnings; unsupported events warn', () => {
  const trigger = node(['button', 'w-button']);
  const p = page('index', [trigger], 'pg');
  const layerByNode = layersFor([p]);
  const data: Ix2Data = {
    events: {
      'e-10': event('e-10', 'MOUSE_OVER', { selector: '.nav-link', appliesTo: 'CLASS' }, 'a-8', { action: { config: { autoStopEventId: 'e-3' } } }),
      'e-3': event('e-3', 'MOUSE_OUT', { selector: '.nav-link', appliesTo: 'CLASS' }, 'a-12', { action: { config: { autoStopEventId: 'e-10' } } }),
      'e-12': event('e-12', 'MOUSE_OVER', { selector: '.button', appliesTo: 'CLASS' }, 'a-6'),
      lonely: event('lonely', 'MOUSE_OUT', { selector: '.button', appliesTo: 'CLASS' }, 'a-6'),
      tab: event('tab', 'TAB_CHANGE', { selector: '.button', appliesTo: 'CLASS' }, 'a-6'),
      missing: event('missing', 'MOUSE_CLICK', { selector: '.button', appliesTo: 'CLASS' }, 'nope'),
    },
    actionLists: {
      'a-8': { id: 'a-8', actionItemGroups: [{ actionItems: [item('TRANSFORM_SCALE', { duration: 300, target: CHILD('.link-arrow'), xValue: 1.3, yValue: 1.3 })] }] },
      'a-12': { id: 'a-12', actionItemGroups: [] },
      'a-6': { id: 'a-6', actionItemGroups: [{ actionItems: [item('TRANSFORM_ROTATE', { duration: 700, easing: 'outQuart', target: CHILD('.button-outline-two.no-cursor'), zValue: 0 }), item('STYLE_TEXT_COLOR', { duration: 500, target: CHILD('.button-text'), rValue: 255, gValue: 255, bValue: 255, aValue: 1 })] }] },
    },
  };
  const warn = new Warnings();
  const result = mapInteractions({ data, pages: [p], layerByNode, warn });
  assert.equal(result.definitions, 0);
  assert.equal(result.instances, 0);
  assert.equal(layerByNode.get(trigger.wf.id)!.interactions, undefined);
  assert.ok(warn.list.some((w) => w.code === 'ix2_no_targets' && w.message.includes('.nav-link')));
  assert.ok(warn.list.some((w) => w.code === 'ix2_no_targets' && w.message.includes('.button-outline-two.no-cursor')));
  assert.ok(warn.list.some((w) => w.code === 'ix2_unsupported_action' && w.message.includes('STYLE_TEXT_COLOR')));
  assert.equal(warn.list.filter((w) => w.code === 'ix2_unsupported_event').length, 3, 'unpaired MOUSE_OUT, TAB_CHANGE, missing action list');
});

test('click pairs, sibling/parent targets, boundary mode and continuous keyframes', () => {
  const panel = node(['panel']);
  const toggle = node(['toggle']);
  const wrapper = node(['wrapper'], [toggle, panel]);
  const outsideItem = node(['panel']);
  const itemNode = node(['w-dyn-item'], [wrapper], { role: 'dyn-item' });
  const p = page('index', [node(['list'], [itemNode]), outsideItem], 'pg');
  const layerByNode = layersFor([p]);
  const data: Ix2Data = {
    events: {
      open: event('open', 'MOUSE_CLICK', { selector: '.toggle', appliesTo: 'CLASS' }, 'show', { action: { config: { autoStopEventId: 'close' } } }),
      close: event('close', 'MOUSE_CLICK', { selector: '.toggle', appliesTo: 'CLASS' }, 'show', { action: { config: { autoStopEventId: 'open', playInReverse: true } } }),
      bounded: event('bounded', 'MOUSE_CLICK', { selector: '.toggle', appliesTo: 'CLASS' }, 'bounded'),
      scrub: { ...event('scrub', 'SCROLLING_IN_VIEW', { selector: '.wrapper', appliesTo: 'CLASS' }, 'para'), action: { actionTypeId: 'GENERAL_CONTINUOUS_ACTION', config: { actionListId: 'para' } } },
    },
    actionLists: {
      show: { id: 'show', actionItemGroups: [{ actionItems: [item('GENERAL_DISPLAY', { duration: 0, target: { useEventTarget: 'SIBLINGS', selector: '.panel' }, value: 'block' }), item('TRANSFORM_MOVE', { duration: 200, target: { useEventTarget: 'PARENT', selector: '.wrapper' }, xValue: 5, xUnit: 'PX' })] }] },
      bounded: { id: 'bounded', actionItemGroups: [{ actionItems: [item('STYLE_OPACITY', { duration: 200, target: { selector: '.panel', boundaryMode: true }, value: 0.5 })] }] },
      para: { id: 'para', continuousParameterGroups: [{ id: 'g', type: 'SCROLL_PROGRESS', continuousActionGroups: [{ keyframe: 0, actionItems: [item('TRANSFORM_MOVE', { target: SELF, yValue: 0, yUnit: 'PX' })] }, { keyframe: 50, actionItems: [item('TRANSFORM_MOVE', { target: SELF, yValue: -100, yUnit: 'PX' })] }, { keyframe: 100, actionItems: [item('TRANSFORM_MOVE', { target: SELF, yValue: -200, yUnit: 'PX' })] }] }] },
    },
  };
  const warn = new Warnings();
  const result = mapInteractions({ data, pages: [p], layerByNode, warn });
  assert.equal(result.definitions, 3);
  const open = result.items.find((i) => i.interaction.timeline.yoyo && i.interaction.trigger === 'click')!.interaction;
  assert.equal(open.tweens.length, 2);
  const display = open.tweens.find((t) => t.to.display)!;
  assert.equal(display.layer_id, `lyr-${panel.wf.id}`, 'SIBLINGS');
  assert.deepEqual({ from: display.from, to: display.to, duration: display.duration }, { from: { display: 'visible' }, to: { display: 'visible' }, duration: 0.001 });
  const move = open.tweens.find((t) => t.to.x)!;
  assert.equal(move.layer_id, `lyr-${wrapper.wf.id}`, 'PARENT');
  const bounded = result.items.find((i) => i.interaction.trigger === 'click' && !i.interaction.timeline.yoyo)!.interaction;
  assert.equal(bounded.tweens.length, 1);
  assert.equal(bounded.tweens[0].layer_id, `lyr-${panel.wf.id}`, 'boundaryMode keeps matches inside the enclosing dyn-item');
  const scrub = result.items.find((i) => i.interaction.trigger === 'while-scrolling')!.interaction;
  assert.deepEqual(scrub.timeline, { breakpoints: ['desktop', 'tablet', 'mobile'], repeat: 0, yoyo: false, scrub: true, scrollStart: 'top bottom', scrollEnd: 'bottom top' });
  assert.deepEqual(scrub.tweens.map((t) => [t.position, t.duration, t.from.y, t.to.y]), [[0, 0.5, '0px', '0px'], [0.5, 0.5, '0px', '-100px'], [1, 0.001, '-100px', '-200px']]);
});

test('ix2-parse never evaluates code', () => {
  const src = readFileSync(path.join(__dirname, 'ix2-parse.ts'), 'utf8');
  for (const needle of ['eval(', 'new Function', "require('vm')", 'from \'vm\'', 'from "vm"']) assert.ok(!src.includes(needle), needle);
});

// ─── Sample export ────────────────────────────────────────────────────────────

const SAMPLE_ROOT = path.join(process.cwd(), 'import/web/valeska-von-brase.webflow');
const SAMPLE_JS = path.join(SAMPLE_ROOT, 'js/valeska-von-brase.js');

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

test('sample export: 2 definitions, hover and scroll tween shapes', { skip: !existsSync(SAMPLE_JS) }, async () => {
  const zip = sampleZip();
  const styles = buildStyleModel({ siteCss: [readFileSync(path.join(SAMPLE_ROOT, 'css/valeska-von-brase.css'), 'utf8')], assetUrl: () => null, warn: new Warnings() });
  const pageNames = new Set([...zip.files.keys()].filter((f) => /^[^/]+\.html$/.test(f)).map((f) => f.slice(0, -5)));
  const svgFiles = await loadSvgIcons(zip);
  const pages = [...pageNames].sort().map((name) => parsePage(readFileSync(path.join(SAMPLE_ROOT, `${name}.html`), 'utf8'), { page: name, styles, zip, pageNames, assetKey: (p) => (zip.files.has(p) ? p : null), warn: new Warnings(), svgFiles }));
  const layerByNode = layersFor(pages);
  const data = parseIx2FromJs(readFileSync(SAMPLE_JS, 'utf8'))!;
  const warn = new Warnings();
  const result = mapInteractions({ data, pages, layerByNode, warn });

  assert.equal(result.definitions, 2);
  const hovers = result.items.filter((i) => i.interaction.trigger === 'hover');
  const scrolls = result.items.filter((i) => i.interaction.trigger === 'scroll-into-view');
  assert.equal(hovers.length, 25, '5 .fixed-menu_item on each of the 5 navbar pages (before component extraction)');
  assert.equal(scrolls.length, 4, '.collection-item on index x2, work, detail_werke');
  assert.equal(result.instances, 29);

  const hover = hovers[0].interaction;
  assert.deepEqual(hover.timeline, { breakpoints: ['desktop', 'tablet', 'mobile'], repeat: 0, yoyo: true });
  assert.equal(hover.tweens.length, 1);
  const h = hover.tweens[0];
  assert.deepEqual({ from: h.from, to: h.to, duration: h.duration, ease: h.ease }, { from: { width: '100%', height: '0%' }, to: { width: '100%', height: '100%' }, duration: 0.7, ease: 'power4.out' });
  const triggerNode = [...pages.flatMap((p) => [...p.nodeIndex.values()])].find((n) => layerByNode.get(n.wf.id)?.id === hovers[0].triggerLayerId)!;
  assert.ok(triggerNode.wf.classNames.includes('fixed-menu_item'));
  const bgNode = triggerNode.children!.find((c) => c.wf.classNames.includes('fixed-menu-item_bg'))!;
  assert.equal(h.layer_id, layerByNode.get(bgNode.wf.id)!.id);

  const scroll = scrolls[0].interaction;
  assert.deepEqual(scroll.timeline, { breakpoints: ['desktop', 'tablet', 'mobile'], repeat: 0, yoyo: false, scrollStart: 'top bottom', toggleActions: 'play reverse play reverse' });
  assert.equal(scroll.tweens.length, 1);
  const s = scroll.tweens[0];
  assert.deepEqual({ from: s.from, to: s.to, ease: s.ease, duration: s.duration, position: s.position }, { from: { autoAlpha: '0', scale: '0' }, to: { autoAlpha: '100', scale: '1' }, ease: 'power3.out', duration: 1, position: 0 });
  assert.deepEqual(s.apply_styles, { scale: 'on-load', autoAlpha: 'on-load' });
  assert.equal(s.layer_id, scrolls[0].triggerLayerId);
  assert.deepEqual(scrolls.map((i) => i.page).sort(), ['detail_werke', 'index', 'index', 'work']);

  assert.ok(warn.count('ix2_unsupported_action') >= 6, `STYLE_TEXT_COLOR items: ${warn.count('ix2_unsupported_action')}`);
  assert.ok(warn.count('ix2_no_targets') >= 3);
  assert.ok(warn.list.some((w) => w.code === 'ix2_no_targets' && w.message.includes('.nav-link')));
  assert.ok(warn.list.some((w) => w.code === 'ix2_no_targets' && w.message.includes('.footer-link')));
  assert.ok(warn.list.some((w) => w.code === 'ix2_no_targets' && w.message.includes('.button-bg')));
  assert.equal(warn.count('ix2_unsupported_event'), 0);
  assert.equal(warn.count('ix2_ease_approximated'), 0);
});

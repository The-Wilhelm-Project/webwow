import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPEN_POPUP_SELECTOR,
  detectPlatform,
  metaKeyLabel,
  RAIL_ITEMS,
  TYPING_TARGET_SELECTOR,
  activeRouteItem,
  ariaKeyShortcuts,
  isRouteEnabled,
  isTypingTarget,
  parseRailStorage,
  resolveRailShortcut,
  routeKindFor,
  safeGet,
  safeSet,
  serializeRailStorage,
  shortcutLabel,
  visibleRailItems,
  type ShortcutContext,
} from './rail-items';

const ctx = (overrides: Partial<ShortcutContext> = {}): ShortcutContext => ({
  typing: false,
  dialogOpen: false,
  flyoutOpen: false,
  role: 'designer',
  routeKind: 'design',
  ...overrides,
});

test('RAIL_ITEMS order and groups', () => {
  assert.deepEqual(
    RAIL_ITEMS.map((i) => i.id),
    ['add', 'pages', 'navigator', 'components', 'assets', 'cms', 'forms', 'localization', 'apps', 'settings', 'find', 'help', 'theme', 'profile'],
  );
  assert.deepEqual(RAIL_ITEMS.filter((i) => i.group === 'bottom').map((i) => i.id), ['find', 'help', 'theme', 'profile']);
  assert.deepEqual(RAIL_ITEMS.filter((i) => i.kind === 'menu').map((i) => i.id), ['theme', 'profile']);
  assert.equal(RAIL_ITEMS.filter((i) => i.group === 'top').length, 10);
});

test('visibleRailItems per role', () => {
  assert.deepEqual(visibleRailItems('editor').map((i) => i.id), ['pages', 'navigator', 'assets', 'cms', 'help', 'theme', 'profile']);
  for (const role of ['designer', 'admin', 'owner'] as const) {
    assert.equal(visibleRailItems(role).length, RAIL_ITEMS.length, role);
  }
});

test('isRouteEnabled', () => {
  for (const id of ['add', 'navigator'] as const) {
    assert.equal(isRouteEnabled(id, 'design'), true);
    assert.equal(isRouteEnabled(id, 'cms'), false);
    assert.equal(isRouteEnabled(id, 'other'), false);
  }
  for (const id of ['pages', 'components', 'assets', 'cms', 'forms', 'settings', 'help'] as const) {
    assert.equal(isRouteEnabled(id, 'cms'), true, id);
    assert.equal(isRouteEnabled(id, 'other'), true, id);
  }
});

test('activeRouteItem and routeKindFor', () => {
  assert.equal(activeRouteItem('collection'), 'cms');
  assert.equal(activeRouteItem('collections-base'), 'cms');
  assert.equal(activeRouteItem('forms'), 'forms');
  assert.equal(activeRouteItem('localization'), 'localization');
  assert.equal(activeRouteItem('integrations'), 'apps');
  assert.equal(activeRouteItem('settings'), 'settings');
  assert.equal(activeRouteItem('layers'), null);
  assert.equal(activeRouteItem(null), null);

  assert.equal(routeKindFor('layers'), 'design');
  assert.equal(routeKindFor('page'), 'design');
  assert.equal(routeKindFor('component'), 'design');
  assert.equal(routeKindFor(null), 'design');
  assert.equal(routeKindFor('collection'), 'cms');
  assert.equal(routeKindFor('layers', 'cms'), 'cms');
  assert.equal(routeKindFor('settings'), 'other');
  assert.equal(routeKindFor('forms'), 'other');
});

test('resolveRailShortcut letters', () => {
  assert.equal(resolveRailShortcut({ code: 'KeyA' }, ctx()), 'add');
  assert.equal(resolveRailShortcut({ code: 'KeyA', shiftKey: true }, ctx()), 'components');
  assert.equal(resolveRailShortcut({ code: 'KeyA', metaKey: true }, ctx()), null);
  assert.equal(resolveRailShortcut({ code: 'KeyA', altKey: true }, ctx()), null);
  assert.equal(resolveRailShortcut({ code: 'KeyA' }, ctx({ typing: true })), null);
  assert.equal(resolveRailShortcut({ code: 'KeyA' }, ctx({ dialogOpen: true })), null);
  assert.equal(resolveRailShortcut({ code: 'KeyA', repeat: true }, ctx()), null);
  assert.equal(resolveRailShortcut({ code: 'KeyP' }, ctx()), 'pages');
  assert.equal(resolveRailShortcut({ code: 'KeyP', shiftKey: true }, ctx()), null);
  assert.equal(resolveRailShortcut({ code: 'KeyZ' }, ctx()), 'navigator');
  assert.equal(resolveRailShortcut({ code: 'KeyZ', ctrlKey: true }, ctx()), null);
  assert.equal(resolveRailShortcut({ code: 'KeyJ' }, ctx()), 'assets');
  assert.equal(resolveRailShortcut({ code: 'KeyX' }, ctx()), null);
});

test('resolveRailShortcut route and role gating', () => {
  assert.equal(resolveRailShortcut({ code: 'KeyA' }, ctx({ routeKind: 'cms' })), null);
  assert.equal(resolveRailShortcut({ code: 'KeyZ' }, ctx({ routeKind: 'other' })), null);
  assert.equal(resolveRailShortcut({ code: 'KeyP' }, ctx({ routeKind: 'cms' })), 'pages');
  assert.equal(resolveRailShortcut({ code: 'KeyA' }, ctx({ role: 'editor' })), null);
  assert.equal(resolveRailShortcut({ code: 'KeyA', shiftKey: true }, ctx({ role: 'editor' })), null);
  assert.equal(resolveRailShortcut({ code: 'KeyJ' }, ctx({ role: 'editor' })), 'assets');
});

test('resolveRailShortcut find and escape', () => {
  assert.equal(resolveRailShortcut({ code: 'KeyK', metaKey: true }, ctx({ typing: true })), 'find');
  assert.equal(resolveRailShortcut({ code: 'KeyK', ctrlKey: true }, ctx()), 'find');
  assert.equal(resolveRailShortcut({ code: 'KeyK', metaKey: true, altKey: true }, ctx()), null);
  assert.equal(resolveRailShortcut({ code: 'KeyK', metaKey: true }, ctx({ role: 'editor' })), null);
  assert.equal(resolveRailShortcut({ code: 'KeyK', metaKey: true }, ctx({ dialogOpen: true })), null);
  assert.equal(resolveRailShortcut({ key: 'Escape', code: 'Escape' }, ctx({ flyoutOpen: true })), 'escape');
  assert.equal(resolveRailShortcut({ key: 'Escape', code: 'Escape' }, ctx({ flyoutOpen: false })), null);
  assert.equal(resolveRailShortcut({ key: 'Escape', code: 'Escape' }, ctx({ flyoutOpen: true, typing: true })), null);
  assert.equal(resolveRailShortcut({ key: 'Escape', code: 'Escape' }, ctx({ flyoutOpen: true, dialogOpen: true })), null);
});

test('isTypingTarget', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, isContentEditable: false, closest: () => null, ...extra });
  assert.equal(isTypingTarget(el('INPUT')), true);
  assert.equal(isTypingTarget(el('textarea')), true);
  assert.equal(isTypingTarget(el('SELECT')), true);
  assert.equal(isTypingTarget(el('DIV', { isContentEditable: true })), true);
  assert.equal(isTypingTarget(el('SPAN', { closest: (sel: string) => (sel.includes('textbox') ? {} : null) })), true);
  // Focus inside an open Radix Select (role=option / listbox) or a popover owns the keyboard.
  const inside = (selector: string) => el('DIV', { closest: (sel: string) => (sel.includes(selector) ? {} : null) });
  assert.equal(isTypingTarget(inside('[role="option"]')), true);
  assert.equal(isTypingTarget(inside('[role="listbox"]')), true);
  assert.equal(isTypingTarget(inside('[role="combobox"]')), true);
  assert.equal(isTypingTarget(inside('[data-slot="select-content"]')), true);
  assert.equal(isTypingTarget(inside('[data-radix-popper-content-wrapper]')), true);
  assert.equal(isTypingTarget(el('DIV', { closest: () => { throw new Error('bad selector'); } })), false);
  assert.equal(isTypingTarget(el('BODY')), false);
  assert.equal(isTypingTarget(el('BUTTON')), false);
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget(undefined), false);
  assert.equal(isTypingTarget({}), false);
});

test('shortcut guard selectors cover Select, listbox and popover content', () => {
  for (const part of ['[role="option"]', '[role="listbox"]', '[data-slot="select-content"]', '[data-radix-popper-content-wrapper]']) {
    assert.ok(TYPING_TARGET_SELECTOR.includes(part), part);
  }
  for (const part of ['[role="dialog"][data-state="open"]', '[role="menu"][data-state="open"]', '[role="listbox"][data-state="open"]', '[data-slot="select-content"][data-state="open"]', '[data-slot="popover-content"][data-state="open"]']) {
    assert.ok(OPEN_POPUP_SELECTOR.includes(part), part);
  }
});

test('parseRailStorage', () => {
  const defaults = { pinned: 'navigator', width: 300 };
  assert.deepEqual(parseRailStorage(null), defaults);
  assert.deepEqual(parseRailStorage(''), defaults);
  assert.deepEqual(parseRailStorage('garbage{'), defaults);
  assert.deepEqual(parseRailStorage('{}'), defaults);
  assert.deepEqual(parseRailStorage('[1]'), { pinned: 'navigator', width: 300 });
  assert.deepEqual(parseRailStorage('{"pinned":"pages","width":900}'), { pinned: 'pages', width: 480 });
  assert.deepEqual(parseRailStorage('{"pinned":"x"}'), defaults);
  assert.deepEqual(parseRailStorage('{"pinned":null,"width":250}'), { pinned: null, width: 250 });
  assert.deepEqual(parseRailStorage('{"pinned":"pages","width":"abc"}'), { pinned: 'pages', width: 300 });
  assert.deepEqual(parseRailStorage('{"pinned":"pages","width":10}'), { pinned: 'pages', width: 240 });
});

test('serializeRailStorage round-trips', () => {
  const state = { pinned: 'pages' as const, width: 320 };
  assert.deepEqual(parseRailStorage(serializeRailStorage(state)), state);
  assert.deepEqual(parseRailStorage(serializeRailStorage({ pinned: null, width: 9999 })), { pinned: null, width: 480 });
});

test('safeGet / safeSet swallow storage errors', () => {
  const throwing = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('quota'); },
  };
  assert.equal(safeGet(throwing, 'k'), null);
  assert.equal(safeSet(throwing, 'k', 'v'), false);
  assert.equal(safeGet(null, 'k'), null);
  assert.equal(safeSet(undefined, 'k', 'v'), false);

  const store = new Map<string, string>();
  const ok = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  assert.equal(safeSet(ok, 'k', 'v'), true);
  assert.equal(safeGet(ok, 'k'), 'v');
});

test('shortcutLabel and ariaKeyShortcuts', () => {
  assert.equal(shortcutLabel('find', true), '⌘K');
  assert.equal(shortcutLabel('find', false), 'Ctrl K');
  assert.equal(shortcutLabel('components', true), '⇧A');
  assert.equal(shortcutLabel('add', false), 'A');
  assert.equal(shortcutLabel('help', true), null);
  assert.equal(ariaKeyShortcuts('find', true), 'Meta+k');
  assert.equal(ariaKeyShortcuts('find', false), 'Control+k');
  assert.equal(ariaKeyShortcuts('components', true), 'Shift+a');
  assert.equal(ariaKeyShortcuts('help', true), undefined);
});

test('detectPlatform and metaKeyLabel', () => {
  assert.equal(detectPlatform('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X)'), 'mac');
  assert.equal(detectPlatform('iPhone', ''), 'mac');
  assert.equal(detectPlatform('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows');
  assert.equal(detectPlatform('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)'), 'other');
  assert.equal(detectPlatform(null, null), 'other');
  assert.equal(detectPlatform('', 'Mozilla/5.0 (Windows NT 10.0)'), 'windows');
  // Meta-only upstream shortcuts never render as Ctrl.
  assert.equal(metaKeyLabel('mac'), '⌘');
  assert.equal(metaKeyLabel('windows'), 'Win');
  assert.equal(metaKeyLabel('other'), 'Meta');
  for (const platform of ['mac', 'windows', 'other'] as const) assert.notEqual(metaKeyLabel(platform), 'Ctrl');
});

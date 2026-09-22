/**
 * Webwow builder rail: pure data and logic for the left icon bar.
 *
 * No React, no stores - only types from `lib/roles`, so this module is unit-testable
 * with node:test. The React side lives in `app/(builder)/ycode/components/webwow/`.
 */

import type { UserRole } from '@/lib/roles';

export type RailItemId =
  | 'add'
  | 'pages'
  | 'navigator'
  | 'components'
  | 'assets'
  | 'cms'
  | 'forms'
  | 'localization'
  | 'apps'
  | 'settings'
  | 'find'
  | 'help'
  | 'theme'
  | 'profile';

export type RailItemKind = 'flyout' | 'pinnable' | 'action' | 'menu';
export type RailGroup = 'top' | 'bottom';
export type RouteKind = 'design' | 'cms' | 'other';
export type PinnedId = 'navigator' | 'pages' | null;

export interface RailShortcut {
  /** Physical key (`KeyboardEvent.code`). */
  code: string;
  shift?: boolean;
  /** Cmd on Mac, Ctrl elsewhere. */
  mod?: boolean;
}

export interface RailItem {
  id: RailItemId;
  label: string;
  /** Icon name: an `Icon` name from `components/ui/icon.tsx` or a `RailIcon` name. */
  icon: string;
  kind: RailItemKind;
  group: RailGroup;
  roles: readonly UserRole[];
  shortcut?: RailShortcut;
  /** `EditorRouteType` values for which this item counts as the current route. */
  routeTypes?: readonly string[];
  /** Only usable on design routes (layers / page / component). */
  designOnly?: boolean;
}

const ALL: readonly UserRole[] = ['owner', 'admin', 'designer', 'editor'];
const STRUCTURE: readonly UserRole[] = ['owner', 'admin', 'designer'];

export const RAIL_WIDTH = 48;
export const RAIL_FLYOUT_WIDTH = 300;
export const RAIL_PANEL_DEFAULT_WIDTH = 300;
export const RAIL_PANEL_MIN_WIDTH = 240;
export const RAIL_PANEL_MAX_WIDTH = 480;
export const RAIL_STORAGE_KEY = 'webwow.rail.v1';

export const RAIL_ITEMS: readonly RailItem[] = [
  { id: 'add', label: 'Add', icon: 'plus', kind: 'flyout', group: 'top', roles: STRUCTURE, shortcut: { code: 'KeyA' }, designOnly: true },
  { id: 'pages', label: 'Pages', icon: 'page', kind: 'pinnable', group: 'top', roles: ALL, shortcut: { code: 'KeyP' } },
  { id: 'navigator', label: 'Navigator', icon: 'layers', kind: 'pinnable', group: 'top', roles: ALL, shortcut: { code: 'KeyZ' }, designOnly: true },
  { id: 'components', label: 'Components', icon: 'component', kind: 'flyout', group: 'top', roles: STRUCTURE, shortcut: { code: 'KeyA', shift: true } },
  { id: 'assets', label: 'Assets', icon: 'image', kind: 'flyout', group: 'top', roles: ALL, shortcut: { code: 'KeyJ' } },
  { id: 'cms', label: 'CMS', icon: 'database', kind: 'flyout', group: 'top', roles: ALL, routeTypes: ['collection', 'collections-base'] },
  { id: 'forms', label: 'Forms', icon: 'form', kind: 'flyout', group: 'top', roles: STRUCTURE, routeTypes: ['forms'] },
  { id: 'localization', label: 'Localization', icon: 'globe', kind: 'flyout', group: 'top', roles: STRUCTURE, routeTypes: ['localization'] },
  { id: 'apps', label: 'Apps', icon: 'apps', kind: 'flyout', group: 'top', roles: STRUCTURE, routeTypes: ['integrations'] },
  { id: 'settings', label: 'Settings', icon: 'settings', kind: 'flyout', group: 'top', roles: STRUCTURE, routeTypes: ['settings'] },
  { id: 'find', label: 'Find', icon: 'search', kind: 'action', group: 'bottom', roles: STRUCTURE, shortcut: { code: 'KeyK', mod: true } },
  { id: 'help', label: 'Help', icon: 'help-circle', kind: 'flyout', group: 'bottom', roles: ALL },
  { id: 'theme', label: 'Theme', icon: 'theme', kind: 'menu', group: 'bottom', roles: ALL },
  { id: 'profile', label: 'Profile', icon: 'profile', kind: 'menu', group: 'bottom', roles: ALL },
];

const ITEMS_BY_ID: Record<string, RailItem> = Object.fromEntries(RAIL_ITEMS.map((item) => [item.id, item]));

export function getRailItem(id: RailItemId): RailItem {
  return ITEMS_BY_ID[id];
}

export function isRailItemId(value: unknown): value is RailItemId {
  return typeof value === 'string' && value in ITEMS_BY_ID;
}

export function isPinnableId(value: unknown): value is Exclude<PinnedId, null> {
  return value === 'navigator' || value === 'pages';
}

/** Items visible for a role, in `RAIL_ITEMS` order. */
export function visibleRailItems(role: UserRole): RailItem[] {
  return RAIL_ITEMS.filter((item) => item.roles.includes(role));
}

export function isRailItemVisible(id: RailItemId, role: UserRole): boolean {
  return ITEMS_BY_ID[id].roles.includes(role);
}

/** Whether an item can be used on the given route kind. */
export function isRouteEnabled(id: RailItemId, routeKind: RouteKind): boolean {
  const item = ITEMS_BY_ID[id];
  if (!item.designOnly) return true;
  return routeKind === 'design';
}

/** The rail item whose route is currently shown, or null on design routes. */
export function activeRouteItem(routeType: string | null | undefined): RailItemId | null {
  if (!routeType) return null;
  const item = RAIL_ITEMS.find((candidate) => candidate.routeTypes?.includes(routeType));
  return item ? item.id : null;
}

/** Classifies `EditorRouteType` (+ the store tab) into the three rail route kinds. */
export function routeKindFor(routeType: string | null | undefined, activeTab?: string | null): RouteKind {
  if (activeTab === 'cms') return 'cms';
  if (!routeType) return 'design';
  if (routeType === 'layers' || routeType === 'page' || routeType === 'component') return 'design';
  if (routeType === 'collection' || routeType === 'collections-base') return 'cms';
  return 'other';
}

export interface KeyboardEventLike {
  code?: string;
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
}

export interface ShortcutContext {
  typing: boolean;
  dialogOpen: boolean;
  flyoutOpen: boolean;
  role: UserRole;
  routeKind: RouteKind;
}

export type RailShortcutResult = RailItemId | 'escape' | null;

/**
 * Maps a keydown to a rail action.
 *
 * - Cmd/Ctrl+K -> `find` (also while typing, never for editors or with a dialog open)
 * - Escape -> `escape` only while a flyout is open (so the layer tree keeps its parent-select)
 * - plain letters only when nothing is focused, no modifier, no repeat, no dialog
 */
export function resolveRailShortcut(e: KeyboardEventLike, ctx: ShortcutContext): RailShortcutResult {
  const mod = Boolean(e.metaKey || e.ctrlKey);

  if (ctx.dialogOpen) return null;

  if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyK') {
    return isRailItemVisible('find', ctx.role) ? 'find' : null;
  }

  if (e.key === 'Escape' && !mod && !e.altKey && !e.shiftKey) {
    return ctx.flyoutOpen && !ctx.typing ? 'escape' : null;
  }

  if (ctx.typing || mod || e.altKey || e.repeat) return null;

  let id: RailItemId | null = null;
  if (e.shiftKey) {
    if (e.code === 'KeyA') id = 'components';
  } else {
    switch (e.code) {
      case 'KeyA': id = 'add'; break;
      case 'KeyP': id = 'pages'; break;
      case 'KeyZ': id = 'navigator'; break;
      case 'KeyJ': id = 'assets'; break;
      default: id = null;
    }
  }
  if (!id) return null;
  if (!isRailItemVisible(id, ctx.role)) return null;
  if (!isRouteEnabled(id, ctx.routeKind)) return null;
  return id;
}

export interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/**
 * Focus inside one of these swallows the letter shortcuts: text entry, rich text editors and
 * open pickers that own the keyboard (Radix Select / listbox typeahead, popover content).
 */
export const TYPING_TARGET_SELECTOR = [
  '[role="textbox"]',
  '.cm-editor',
  '[contenteditable="true"]',
  '[role="option"]',
  '[role="listbox"]',
  '[role="combobox"]',
  '[data-slot="select-content"]',
  '[data-radix-popper-content-wrapper]',
].join(', ');

/**
 * Open floating content that must keep the keyboard even when nothing inside it is focused:
 * dialogs, menus, Radix Select lists and popovers (`data-state="open"` is set by Radix).
 */
export const OPEN_POPUP_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
  '[data-slot="select-content"][data-state="open"]',
  '[data-slot="popover-content"][data-state="open"]',
].join(', ');

/**
 * True when a keydown target is a text-entry element (inputs, editors, rich text) or sits
 * inside an open picker that handles keys itself (Select options, listboxes, popovers).
 */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as ElementLike;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  if (typeof el.closest === 'function') {
    try {
      if (el.closest(TYPING_TARGET_SELECTOR)) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export type Platform = 'mac' | 'windows' | 'other';

/** Classifies `navigator.platform` / `navigator.userAgent` for shortcut labels. */
export function detectPlatform(platform?: string | null, userAgent?: string | null): Platform {
  const source = `${platform ?? ''} ${userAgent ?? ''}`;
  if (/Mac|iPhone|iPad|iPod/i.test(source)) return 'mac';
  if (/Win/i.test(source)) return 'windows';
  return 'other';
}

/**
 * Label of the Meta key for the upstream shortcuts whose handlers require `e.metaKey` and have
 * no Ctrl fallback (copy/paste style, create component, detach instance, show/hide element).
 * Showing "Ctrl" for them on Windows/Linux would describe a combo that does nothing.
 */
export function metaKeyLabel(platform: Platform): string {
  if (platform === 'mac') return '⌘';
  if (platform === 'windows') return 'Win';
  return 'Meta';
}

/** Human readable shortcut ("A", "⇧A", "⌘K" / "Ctrl K"). */
export function shortcutLabel(id: RailItemId, isMac: boolean): string | null {
  const shortcut = ITEMS_BY_ID[id].shortcut;
  if (!shortcut) return null;
  const key = shortcut.code.replace(/^Key/, '').toUpperCase();
  let label = '';
  if (shortcut.mod) label += isMac ? '⌘' : 'Ctrl ';
  if (shortcut.shift) label += '⇧';
  return `${label}${key}`;
}

/** `aria-keyshortcuts` value for an item (W3C syntax). */
export function ariaKeyShortcuts(id: RailItemId, isMac: boolean): string | undefined {
  const shortcut = ITEMS_BY_ID[id].shortcut;
  if (!shortcut) return undefined;
  const parts: string[] = [];
  if (shortcut.mod) parts.push(isMac ? 'Meta' : 'Control');
  if (shortcut.shift) parts.push('Shift');
  parts.push(shortcut.code.replace(/^Key/, '').toLowerCase());
  return parts.join('+');
}

export interface RailStorage {
  pinned: PinnedId;
  width: number;
}

export const DEFAULT_RAIL_STORAGE: RailStorage = { pinned: 'navigator', width: RAIL_PANEL_DEFAULT_WIDTH };

export function clampPanelWidth(width: unknown): number {
  const n = typeof width === 'number' ? width : Number(width);
  if (!Number.isFinite(n)) return RAIL_PANEL_DEFAULT_WIDTH;
  return Math.min(RAIL_PANEL_MAX_WIDTH, Math.max(RAIL_PANEL_MIN_WIDTH, Math.round(n)));
}

/** Parses `localStorage["webwow.rail.v1"]`; anything invalid falls back to the defaults. */
export function parseRailStorage(json: string | null | undefined): RailStorage {
  if (!json) return { ...DEFAULT_RAIL_STORAGE };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ...DEFAULT_RAIL_STORAGE };
  }
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_RAIL_STORAGE };
  const obj = raw as Record<string, unknown>;
  const pinned: PinnedId = obj.pinned === null ? null : isPinnableId(obj.pinned) ? obj.pinned : DEFAULT_RAIL_STORAGE.pinned;
  const width = 'width' in obj ? clampPanelWidth(obj.width) : DEFAULT_RAIL_STORAGE.width;
  return { pinned, width };
}

export function serializeRailStorage(state: RailStorage): string {
  return JSON.stringify({ pinned: state.pinned, width: clampPanelWidth(state.width) });
}

export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** `storage.getItem` that never throws (private mode, blocked storage, quota). */
export function safeGet(storage: StorageLike | null | undefined, key: string): string | null {
  try {
    if (!storage) return null;
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** `storage.setItem` that never throws; returns whether the write happened. */
export function safeSet(storage: StorageLike | null | undefined, key: string, value: string): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

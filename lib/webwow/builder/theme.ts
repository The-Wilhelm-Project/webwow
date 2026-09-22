/**
 * Builder theme (System / Light / Dark) shared by the HeaderBar logo menu and the rail's Theme
 * item. Both read and write the same `localStorage["theme"]` key and the `dark` class on
 * `<html>`; the rail announces its changes through the `webwow:theme` window event so the
 * HeaderBar's local state follows. Pure helpers only - no DOM, no React (node:test covered).
 */

import { safeGet, safeSet, type StorageLike } from './rail-items';

export type BuilderTheme = 'system' | 'light' | 'dark';

/** Same key the HeaderBar uses. */
export const THEME_STORAGE_KEY = 'theme';
/** `CustomEvent<BuilderTheme>` dispatched on `window` after the rail changed the theme. */
export const THEME_CHANGE_EVENT = 'webwow:theme';
/** HeaderBar default when nothing is stored. */
export const DEFAULT_THEME: BuilderTheme = 'dark';

export const BUILDER_THEMES: readonly { id: BuilderTheme; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

export function isBuilderTheme(value: unknown): value is BuilderTheme {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** Anything invalid falls back to the HeaderBar default. */
export function parseTheme(value: unknown): BuilderTheme {
  return isBuilderTheme(value) ? value : DEFAULT_THEME;
}

/** Whether the `dark` class belongs on `<html>` for a theme. */
export function isDarkTheme(theme: BuilderTheme, systemPrefersDark: boolean): boolean {
  if (theme === 'system') return systemPrefersDark;
  return theme === 'dark';
}

export function readTheme(storage: StorageLike | null | undefined): BuilderTheme {
  return parseTheme(safeGet(storage, THEME_STORAGE_KEY));
}

export function persistTheme(storage: StorageLike | null | undefined, theme: BuilderTheme): boolean {
  return safeSet(storage, THEME_STORAGE_KEY, theme);
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILDER_THEMES,
  DEFAULT_THEME,
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
  isBuilderTheme,
  isDarkTheme,
  parseTheme,
  persistTheme,
  readTheme,
} from './theme';

test('theme constants match the HeaderBar', () => {
  assert.equal(THEME_STORAGE_KEY, 'theme');
  assert.equal(DEFAULT_THEME, 'dark');
  assert.equal(THEME_CHANGE_EVENT, 'webwow:theme');
  assert.deepEqual(BUILDER_THEMES.map((t) => t.id), ['system', 'light', 'dark']);
});

test('parseTheme / isBuilderTheme', () => {
  assert.equal(parseTheme('light'), 'light');
  assert.equal(parseTheme('dark'), 'dark');
  assert.equal(parseTheme('system'), 'system');
  assert.equal(parseTheme(null), 'dark');
  assert.equal(parseTheme('blue'), 'dark');
  assert.equal(parseTheme(1), 'dark');
  assert.equal(isBuilderTheme('light'), true);
  assert.equal(isBuilderTheme('LIGHT'), false);
});

test('isDarkTheme', () => {
  assert.equal(isDarkTheme('dark', false), true);
  assert.equal(isDarkTheme('light', true), false);
  assert.equal(isDarkTheme('system', true), true);
  assert.equal(isDarkTheme('system', false), false);
});

test('readTheme / persistTheme never throw', () => {
  const store = new Map<string, string>();
  const ok = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  assert.equal(readTheme(ok), 'dark');
  assert.equal(persistTheme(ok, 'light'), true);
  assert.equal(store.get('theme'), 'light');
  assert.equal(readTheme(ok), 'light');
  const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } };
  assert.equal(readTheme(throwing), 'dark');
  assert.equal(persistTheme(throwing, 'dark'), false);
  assert.equal(readTheme(null), 'dark');
});

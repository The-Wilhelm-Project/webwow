import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlDirFromLang, htmlLangFromLocales } from '@/lib/html-lang';

const locales = [
  { code: 'en', is_default: true },
  { code: 'fr', is_default: false },
  { code: 'pt-BR', is_default: false },
];

test('homepage uses the default locale', () => {
  assert.equal(htmlLangFromLocales('', locales), 'en');
});

test('default-locale page paths use the default locale', () => {
  assert.equal(htmlLangFromLocales('about/team', locales), 'en');
});

test('prefixed paths use the matching locale code', () => {
  assert.equal(htmlLangFromLocales('fr', locales), 'fr');
  assert.equal(htmlLangFromLocales('fr/about', locales), 'fr');
});

test('preserves canonical casing from the locale record', () => {
  assert.equal(htmlLangFromLocales('pt-br/contato', locales), 'pt-BR');
});

test('falls back to en when no locales are configured', () => {
  assert.equal(htmlLangFromLocales('fr/about', []), 'en');
});

test('rtl language subtags set dir to rtl', () => {
  assert.equal(htmlDirFromLang('ar'), 'rtl');
  assert.equal(htmlDirFromLang('he'), 'rtl');
  assert.equal(htmlDirFromLang('fa'), 'rtl');
  assert.equal(htmlDirFromLang('ur'), 'rtl');
});

test('rtl direction follows the language, not the region', () => {
  assert.equal(htmlDirFromLang('ar-SA'), 'rtl');
  assert.equal(htmlDirFromLang('he-IL'), 'rtl');
});

test('ltr languages and unknown codes set dir to ltr', () => {
  assert.equal(htmlDirFromLang('en'), 'ltr');
  assert.equal(htmlDirFromLang('fr'), 'ltr');
  assert.equal(htmlDirFromLang('pt-BR'), 'ltr');
  assert.equal(htmlDirFromLang('xyz'), 'ltr');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SITE_ID, RESERVED_SLUGS, SITE_ID_RE, SITE_SLUG_RE, isSiteId, newSiteId, slugToDatabaseName, slugify } from './ids';

test('newSiteId matches SITE_ID_RE and is random', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const id = newSiteId();
    assert.match(id, SITE_ID_RE);
    assert.equal(id.length, 12);
    ids.add(id);
  }
  assert.equal(ids.size, 200);
});

test('isSiteId accepts default and s_ ids only', () => {
  assert.equal(isSiteId(DEFAULT_SITE_ID), true);
  assert.equal(isSiteId('s_abcdefghij'), true);
  assert.equal(isSiteId('s_ABCDEFGHIJ'), false);
  assert.equal(isSiteId('s_abcdefghi'), false);
  assert.equal(isSiteId('sites'), false);
  assert.equal(isSiteId(''), false);
  assert.equal(isSiteId(null), false);
  assert.equal(isSiteId('s_abcdefghij/../x'), false);
});

test('slugify folds names to lower-case ascii slugs', () => {
  assert.equal(slugify('Valeska von Brase'), 'valeska-von-brase');
  assert.equal(slugify('  Café Über — Straße!  '), 'cafe-uber-strasse');
  assert.equal(slugify('!!!'), 'site');
  assert.equal(slugify(''), 'site');
  const long = slugify('a'.repeat(80));
  assert.equal(long.length, 50);
  assert.match(slugify('x'.repeat(49) + '-y'), SITE_SLUG_RE);
  for (const name of ['My Site', 'Valeska von Brase', 'a-b-c', '123']) {
    assert.match(slugify(name), SITE_SLUG_RE, name);
  }
});

test('reserved slugs and slug pattern', () => {
  for (const s of ['default', 'www', 'api', 'mail', 'localhost', 'ycode', 'webwow', 'admin', 'static', 'storage', 'a']) {
    assert.equal(RESERVED_SLUGS.has(s), true, s);
  }
  assert.equal(RESERVED_SLUGS.has('valeska'), false);
  assert.match('valeska', SITE_SLUG_RE);
  assert.match('a', SITE_SLUG_RE);
  assert.doesNotMatch('-a', SITE_SLUG_RE);
  assert.doesNotMatch('a-', SITE_SLUG_RE);
  assert.doesNotMatch('A', SITE_SLUG_RE);
  assert.doesNotMatch('a'.repeat(51), SITE_SLUG_RE);
  assert.match('a'.repeat(50), SITE_SLUG_RE);
});

test('slugToDatabaseName maps hyphens to underscores and stays under the identifier limit', () => {
  assert.equal(slugToDatabaseName('my-site'), 'webwow_site_my_site');
  assert.equal(slugToDatabaseName('valeska'), 'webwow_site_valeska');
  assert.ok(Buffer.byteLength(slugToDatabaseName('a'.repeat(50))) <= 62);
});

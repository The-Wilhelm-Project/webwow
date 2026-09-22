import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_COLLECTION_FIELDS, autoItemValues, describeUnresolvedKeys, resolveValueKeys } from './collection-items';
import type { CollectionFieldType } from '@/types';

const f = (id: string, name: string, key: string | null, type: CollectionFieldType) => ({ id, name, key, type });
const FIELDS = [
  f('f-id', 'ID', 'id', 'number'),
  f('f-status', 'Status', 'status', 'status'),
  f('f-name', 'Name', 'name', 'text'),
  f('f-slug', 'Slug', 'slug', 'text'),
  f('f-sub', 'Untertitel', null, 'text'),
  f('f-created', 'Created Date', 'created_at', 'date'),
  f('f-updated', 'Updated Date', 'updated_at', 'date'),
  f('f-dup1', 'Bild', null, 'image'),
  f('f-dup2', 'bild', null, 'image'),
];

test('built-in fields match the builder (stores/useCollectionsStore.ts createCollection)', () => {
  assert.deepEqual(BUILT_IN_COLLECTION_FIELDS.map((x) => [x.key, x.type, x.order, x.fillable]), [
    ['id', 'number', 0, false], ['status', 'status', 1, false], ['name', 'text', 2, true],
    ['slug', 'text', 3, true], ['created_at', 'date', 4, false], ['updated_at', 'date', 5, false],
  ]);
  assert.equal(BUILT_IN_COLLECTION_FIELDS.find((x) => x.key === 'status')?.is_computed, true);
});

test('resolveValueKeys: id, key, name (case-insensitive), unknown, ambiguous', () => {
  const r = resolveValueKeys({ 'f-name': 'A', slug: 'a', untertitel: 'x', nope: 1, Bild: 'b' }, FIELDS);
  assert.deepEqual(r.values, { 'f-name': 'A', 'f-slug': 'a', 'f-sub': 'x' });
  assert.deepEqual(r.unknown, ['nope']);
  assert.deepEqual(r.ambiguous, ['Bild']);
  const msg = describeUnresolvedKeys(r, FIELDS) ?? '';
  assert.match(msg, /unknown field\(s\): nope/);
  assert.match(msg, /ambiguous field name\(s\), use the field id: Bild/);
  assert.match(msg, /f-slug \(Slug, key slug, text\)/);
  assert.equal(describeUnresolvedKeys(resolveValueKeys({ 'f-sub': 'ok' }, FIELDS), FIELDS), null);
  assert.equal(describeUnresolvedKeys(resolveValueKeys({}, FIELDS), FIELDS), null);
});

test('autoItemValues: ID = max + 1, timestamps, explicit values win, missing fields skipped', () => {
  const now = '2026-09-22T12:00:00.000Z';
  assert.deepEqual(autoItemValues(FIELDS, 41, now, {}), { 'f-id': '42', 'f-created': now, 'f-updated': now });
  assert.deepEqual(autoItemValues(FIELDS, 0, now, { 'f-id': '7' }), { 'f-created': now, 'f-updated': now });
  assert.deepEqual(autoItemValues([f('x', 'Titel', null, 'text')], 3, now, {}), {});
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findLayerById,
  flattenLayers,
  folderPath,
  formatBytes,
  layerLabel,
  matchScore,
  rankEntries,
  uniqueName,
} from './panel-utils';

const tree = [
  {
    id: 'body',
    name: 'body',
    children: [
      { id: 's1', name: 'section', customName: 'Hero', children: [
        { id: 'img1', name: 'image' },
        { id: 't1', name: 'text', customName: '  ' },
      ] },
      { id: 'c1', name: 'div', componentId: 'cmp-1', customName: 'Nav' },
    ],
  },
];

test('layerLabel prefers custom name, then block name, then Body / raw name', () => {
  assert.equal(layerLabel({ id: 'x', name: 'div', customName: 'Card' }, 'Block'), 'Card');
  assert.equal(layerLabel({ id: 'x', name: 'div', customName: '   ' }, 'Block'), 'Block');
  assert.equal(layerLabel({ id: 'body', name: 'body' }), 'Body');
  assert.equal(layerLabel({ id: 'x', name: 'image' }), 'image');
});

test('flattenLayers walks depth-first with paths', () => {
  const flat = flattenLayers(tree, (name) => (name === 'image' ? 'Image' : name === 'text' ? 'Text' : null));
  assert.deepEqual(flat.map((l) => l.id), ['body', 's1', 'img1', 't1', 'c1']);
  assert.equal(flat[2].label, 'Image');
  assert.equal(flat[2].path, 'Body › Hero');
  assert.equal(flat[2].depth, 2);
  assert.equal(flat[3].label, 'Text');
  assert.equal(flat[4].path, 'Body');
  assert.equal(flattenLayers(tree, undefined, 2).length, 2);
});

test('findLayerById searches nested children', () => {
  assert.equal(findLayerById(tree, 'img1')?.name, 'image');
  assert.equal(findLayerById(tree, 'nope'), null);
});

test('matchScore ranks prefix > word prefix > substring', () => {
  assert.equal(matchScore('Homepage', 'home'), 3);
  assert.equal(matchScore('About us', 'us'), 2);
  assert.equal(matchScore('my-blog-post', 'post'), 2);
  assert.equal(matchScore('Contact', 'tac'), 1);
  assert.equal(matchScore('Contact', 'zzz'), 0);
  assert.equal(matchScore('Contact', '   '), 0);
});

test('rankEntries sorts by score then group order, caps per group and keeps groups together', () => {
  const groups = ['Pages', 'Layers', 'Actions'];
  const entries = [
    { label: 'Publish', group: 'Actions' },
    { label: 'Hero image', group: 'Layers' },
    { label: 'Home', group: 'Pages' },
    { label: 'Heading', group: 'Layers' },
    { label: 'Help center', group: 'Pages' },
  ];
  const ranked = rankEntries(entries, 'he', groups);
  assert.deepEqual(ranked.map((e) => e.label), ['Help center', 'Hero image', 'Heading']);
  assert.deepEqual(rankEntries(entries, '', groups), []);
  const many = Array.from({ length: 12 }, (_, i) => ({ label: `Page ${i}`, group: 'Pages' }));
  assert.equal(rankEntries(many, 'page', groups, 8).length, 8);
  assert.equal(rankEntries(many, 'page', groups, 8, 3).length, 3);
});

test('uniqueName follows the CMS naming rule', () => {
  assert.equal(uniqueName('Collection', []), 'Collection');
  assert.equal(uniqueName('Collection', ['Collection']), 'Collection 1');
  assert.equal(uniqueName('Collection', ['Collection', 'Collection 1', 'Collection 2']), 'Collection 3');
  assert.equal(uniqueName('Collection', ['Collection 1']), 'Collection');
});

test('folderPath returns the parent chain root first and survives cycles', () => {
  const folders = [
    { id: 'a', asset_folder_id: null, name: 'A' },
    { id: 'b', asset_folder_id: 'a', name: 'B' },
    { id: 'c', asset_folder_id: 'b', name: 'C' },
    { id: 'x', asset_folder_id: 'y', name: 'X' },
    { id: 'y', asset_folder_id: 'x', name: 'Y' },
  ];
  assert.deepEqual(folderPath(folders, 'c').map((f) => f.name), ['A', 'B', 'C']);
  assert.deepEqual(folderPath(folders, null), []);
  assert.deepEqual(folderPath(folders, 'missing'), []);
  assert.deepEqual(folderPath(folders, 'x').map((f) => f.name), ['Y', 'X']);
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(20 * 1024), '20 KB');
  assert.equal(formatBytes(1.5 * 1024 * 1024), '1.5 MB');
});

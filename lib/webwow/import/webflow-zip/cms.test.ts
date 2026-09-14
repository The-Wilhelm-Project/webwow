import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// cms.ts imports the repositories (-> `@/lib/supabase-server` -> `server-only`) and
// safe-fetch (-> `@/lib/webwow/storage` -> `server-only`). Stub `server-only` and
// the five repositories before the module graph loads, so the persistence path
// runs against in-memory tables.
type Row = Record<string, unknown>;
const db = { collections: [] as Row[], fields: [] as Row[], items: [] as Row[], values: [] as Row[], existingCollections: [] as Row[], assetsByFilename: {} as Record<string, { id: string; public_url: string }> };
let ids = 0;
const nextId = (prefix: string) => `${prefix}-${++ids}`;
function stub(request: string, exports: Record<string, unknown>): void {
  const filename = require.resolve(request);
  const mod = new Module(filename) as Module & { loaded: boolean };
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}
stub('server-only', {});
stub('@/lib/repositories/collectionRepository', {
  getAllCollections: async () => db.existingCollections,
  createCollection: async (data: Row) => {
    const row = { id: nextId('col'), ...data };
    db.collections.push(row);
    return row;
  },
});
stub('@/lib/repositories/collectionFieldRepository', {
  createField: async (data: Row) => {
    const row = { id: nextId('fld'), ...data };
    db.fields.push(row);
    return row;
  },
});
stub('@/lib/repositories/collectionItemRepository', {
  createItemsBulk: async (items: Row[]) => {
    db.items.push(...items);
    return items;
  },
});
stub('@/lib/repositories/collectionItemValueRepository', {
  insertValuesBulk: async (values: Row[]) => {
    assert.ok(values.length <= 500);
    db.values.push(...values);
  },
});
stub('@/lib/repositories/assetRepository', { findAssetsByFilenames: async () => db.assetsByFilename });

import { Warnings } from './warnings';
import type { WfMaterializerLike } from './types';
import {
  CSV_META_COLUMNS,
  convertScalar,
  dateFormatFor,
  importCms,
  inferSchema,
  isPublishableRow,
  isYearOnlyDate,
  parseCollectionFilename,
  parseCsvFiles,
  resolveReferenceToken,
  splitTokens,
  type WfCollectionInfo,
} from './cms';

function resetDb(): void {
  db.collections = [];
  db.fields = [];
  db.items = [];
  db.values = [];
  db.existingCollections = [];
  db.assetsByFilename = {};
}

function fakeMat(behaviour: 'ok' | 'fail' = 'ok'): WfMaterializerLike & { uploaded: string[] } {
  const uploaded: string[] = [];
  return {
    uploaded,
    uploadAsset: async (key) => {
      uploaded.push(key);
      return behaviour === 'ok' ? `asset-${uploaded.length}` : null;
    },
    assetUrl: (key) => (uploaded.includes(key) ? `/storage/${encodeURIComponent(key)}` : null),
    uploadRaw: async () => null,
    installFont: async () => null,
  };
}

const WERKE_CSV = 'valeska von brase - Werke - 696e3e261a55566a62dc5508 (1).csv';
const EXHIBITIONS_CSV = 'valeska von brase - Exhibitions - 697275d29b50275b1e811754.csv';

// ─── Filenames / parsing ──────────────────────────────────────────────────────

test('collection filename parsing', () => {
  assert.deepEqual(parseCollectionFilename(WERKE_CSV), { name: 'Werke', webflowId: '696e3e261a55566a62dc5508' });
  assert.deepEqual(parseCollectionFilename(`/tmp/x/${EXHIBITIONS_CSV}`), { name: 'Exhibitions', webflowId: '697275d29b50275b1e811754' });
  assert.deepEqual(parseCollectionFilename('Team.csv'), { name: 'Team', webflowId: null });
  assert.deepEqual(parseCollectionFilename('site - Blog Posts - abc.csv'), { name: 'Blog Posts', webflowId: null });
  const parsed = parseCsvFiles([{ filename: 'site - Team - 0123456789abcdef01234567.csv', content: 'Name,Slug,Role\r\n"Doe, Jane",jane,"Lead\nDesigner"\r\n' }, { filename: 'empty.csv', content: '' }]);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].headers, ['Name', 'Slug', 'Role']);
  assert.deepEqual(parsed[0].rows, [{ Name: 'Doe, Jane', Slug: 'jane', Role: 'Lead\nDesigner' }]);
  assert.equal(parsed[0].webflowId, '0123456789abcdef01234567');
  assert.equal(parsed[0].order, 0);
  assert.equal(CSV_META_COLUMNS.length, 8);
});

// ─── Inference on inline fixtures ─────────────────────────────────────────────

test('inferSchema: value-based rules and name heuristics', () => {
  const posts = { name: 'Posts', webflowId: 'a'.repeat(24), filename: 'x - Posts - a.csv', order: 0, headers: ['Name', 'Slug', 'Item ID', 'Author', 'Tags', 'Hero', 'Gallery', 'Price', 'Live', 'When', 'Body', 'Tint', 'Mail', 'Tel', 'Site', 'Bild', 'Beschreibung', 'Video', 'Datum', 'Whatever', 'Doc'], rows: [
    { Name: 'One', Slug: 'one', 'Item ID': '1'.repeat(24), Author: 'jane', Tags: 'red; blue', Hero: 'https://cdn.x/a.jpg', Gallery: 'https://cdn.x/a.jpg; https://cdn.x/b.png', Price: '12.5', Live: 'true', When: 'Thu Jan 22 2026 19:21:05 GMT+0000 (Coordinated Universal Time)', Body: '<p>Hi</p>', Tint: '#ff0000', Mail: 'a@b.co', Tel: '+49 30 123456', Site: 'https://example.com/page', Bild: '', Beschreibung: '', Video: '', Datum: '', Whatever: '', Doc: 'https://cdn.x/file.pdf' },
    { Name: 'Two', Slug: 'two', 'Item ID': '2'.repeat(24), Author: 'john', Tags: 'blue', Hero: 'https://cdn.x/c.jpeg', Gallery: '', Price: '3', Live: 'false', When: '2026-01-01', Body: '<h1>x</h1>', Tint: '#00ff00', Mail: 'c@d.co', Tel: '030 987654', Site: 'http://example.org', Bild: '', Beschreibung: '', Video: '', Datum: '', Whatever: '', Doc: '' },
  ] };
  const people = { name: 'People', webflowId: 'b'.repeat(24), filename: 'x - People - b.csv', order: 1, headers: ['Name', 'Slug', 'Item ID', 'Posts'], rows: [{ Name: 'Jane', Slug: 'jane', 'Item ID': '3'.repeat(24), Posts: '' }, { Name: 'John', Slug: 'john', 'Item ID': '4'.repeat(24), Posts: '' }] };
  const tags = { name: 'Tags', webflowId: null, filename: 'Tags.csv', order: 2, headers: ['Name', 'Slug'], rows: [{ Name: 'Red', Slug: 'red' }, { Name: 'Blue', Slug: 'blue' }] };
  const warn = new Warnings();
  const [postsPlan, peoplePlan] = inferSchema([posts, people, tags], warn);
  const type = (h: string) => postsPlan.fields.find((f) => f.header === h)!;
  assert.deepEqual(postsPlan.fields.filter((f) => f.system).map((f) => [f.header, f.key]), [['Name', 'name'], ['Slug', 'slug']]);
  assert.ok(!postsPlan.fields.some((f) => f.header === 'Item ID'));
  assert.equal(type('Author').type, 'reference');
  assert.equal(type('Author').referenceTargetWebflowId, 'b'.repeat(24));
  assert.equal(type('Tags').type, 'multi_reference');
  assert.equal(type('Tags').referenceTargetName, 'Tags');
  assert.equal(type('Hero').type, 'image');
  assert.equal(type('Hero').multiple, undefined);
  assert.equal(type('Gallery').type, 'image');
  assert.equal(type('Gallery').multiple, true);
  assert.equal(type('Price').type, 'number');
  assert.equal(type('Live').type, 'boolean');
  assert.equal(type('When').type, 'date');
  assert.equal(type('Body').type, 'rich_text');
  assert.equal(type('Tint').type, 'color');
  assert.equal(type('Mail').type, 'email');
  assert.equal(type('Tel').type, 'phone');
  assert.equal(type('Site').type, 'link');
  assert.equal(type('Doc').type, 'document');
  assert.equal(type('Bild').type, 'image');
  assert.equal(type('Bild').guessed, true);
  assert.equal(type('Beschreibung').type, 'rich_text');
  assert.equal(type('Video').type, 'text');
  assert.equal(type('Datum').type, 'date');
  assert.equal(type('Whatever').type, 'text');
  assert.equal(type('Whatever').guessed, true);
  const postsRef = peoplePlan.fields.find((f) => f.header === 'Posts')!;
  assert.equal(postsRef.type, 'multi_reference');
  assert.equal(postsRef.referenceTargetWebflowId, 'a'.repeat(24));
  assert.equal(warn.count('csv_type_guess'), 6);
});

// ─── Value helpers ────────────────────────────────────────────────────────────

test('value conversion: dates to ISO, booleans, numbers, rich text, tokens, publishable rule', () => {
  assert.equal(convertScalar('Thu Jan 22 2026 19:21:05 GMT+0000 (Coordinated Universal Time)', 'date'), '2026-01-22T19:21:05.000Z');
  assert.equal(convertScalar('Fri Dec 31 2010 23:00:00 GMT+0000 (Coordinated Universal Time)', 'date'), '2010-12-31T23:00:00.000Z');
  assert.equal(convertScalar('not a date', 'date'), null);
  assert.equal(convertScalar('true', 'boolean'), 'true');
  assert.equal(convertScalar('False', 'boolean'), 'false');
  assert.equal(convertScalar('on', 'boolean'), 'true');
  assert.equal(convertScalar('61', 'number'), '61');
  assert.equal(convertScalar('12.50', 'number'), '12.5');
  assert.equal(convertScalar('abc', 'number'), null);
  assert.equal(convertScalar('  ', 'text'), null);
  assert.equal(convertScalar(' München, DE ', 'text'), 'München, DE');
  const rich = JSON.parse(convertScalar('<p>Hi <strong>there</strong></p>', 'rich_text')!);
  assert.equal(rich.type, 'doc');
  assert.equal(rich.content[0].type, 'paragraph');
  const plain = JSON.parse(convertScalar('Plain <text>', 'rich_text')!);
  assert.equal(plain.content[0].content[0].text, 'Plain <text>');
  assert.deepEqual(splitTokens(' a ; b;;c '), ['a', 'b', 'c']);
  assert.equal(isPublishableRow({ Draft: 'false', Archived: 'false', 'Published On': 'x' }), true);
  assert.equal(isPublishableRow({ Draft: 'true', Archived: 'false', 'Published On': 'x' }), false);
  assert.equal(isPublishableRow({ Draft: 'false', Archived: 'true', 'Published On': 'x' }), false);
  assert.equal(isPublishableRow({ Draft: 'false', Archived: 'false', 'Published On': '' }), false);
  assert.equal(isYearOnlyDate('Fri Dec 31 2010 23:00:00 GMT+0000 (Coordinated Universal Time)'), true);
  assert.equal(isYearOnlyDate('Mon Jan 01 2024 00:00:00 GMT+0000 (Coordinated Universal Time)'), true);
  assert.equal(isYearOnlyDate('Sat Feb 28 2026 00:00:00 GMT+0000 (Coordinated Universal Time)'), false);
  assert.equal(dateFormatFor(['Fri Dec 31 2010 23:00:00 GMT+0000', 'Mon Jan 01 2024 00:00:00 GMT+0000', '', 'Sat Dec 31 2022 23:00:00 GMT+0000']), 'part-year');
  assert.equal(dateFormatFor(['Sat Feb 28 2026 00:00:00 GMT+0000', 'Fri Dec 31 2010 23:00:00 GMT+0000']), 'date-eu-dot');
  assert.equal(dateFormatFor([]), 'date-eu-dot');
});

test('reference tokens resolve slug -> Webflow item id -> name', () => {
  const info: WfCollectionInfo = {
    id: 'c', name: 'Werke', webflowId: null, fields: [], slugFieldId: 's', nameFieldId: 'n', rowCount: 2, publishableCount: 2, dateFormatByField: {}, fillCountByField: {},
    itemIdBySlug: new Map([['affinitat', 'item-slug'], ['x', 'item-x']]),
    itemIdByWebflowId: new Map([['6972638bad3db59708fe979b', 'item-wf'], ['affinitat', 'wrong']]),
    itemIdByName: new Map([['Affinität', 'item-name'], ['affinität', 'item-name'], ['x', 'wrong'], ['6972638bad3db59708fe979b', 'wrong']]),
  };
  assert.equal(resolveReferenceToken('affinitat', info), 'item-slug');
  assert.equal(resolveReferenceToken('6972638bad3db59708fe979b', info), 'item-wf');
  assert.equal(resolveReferenceToken('Affinität', info), 'item-name');
  assert.equal(resolveReferenceToken('AFFINITÄT', info), 'item-name');
  assert.equal(resolveReferenceToken('nope', info), null);
  assert.equal(resolveReferenceToken('  ', info), null);
});

// ─── Persistence path on inline fixtures ──────────────────────────────────────

test('importCms: built-ins, references resolved before insert, assets deduped / skipped / failed, slug fallbacks', async () => {
  resetDb();
  db.existingCollections = [{ id: 'old', name: 'Posts', order: 4 }];
  db.assetsByFilename = { reused: { id: 'asset-reused', public_url: '/storage/reused.webp' } };
  const csvs = parseCsvFiles([
    { filename: 'site - Posts - aaaaaaaaaaaaaaaaaaaaaaaa.csv', content: [
      'Name,Slug,Item ID,Draft,Archived,Created On,Updated On,Published On,Author,Cover,Gallery,Body,Score',
      'First,first,111111111111111111111111,false,false,Thu Jan 22 2026 19:21:05 GMT+0000,Thu Jan 23 2026 19:21:05 GMT+0000,Thu Jan 24 2026 19:21:05 GMT+0000,jane,https://cdn.prod.website-files.com/x/0123456789abcdef01234567_reused.jpg,https://cdn.x/a.jpg; https://cdn.x/b.jpg,"<p>Hi <img src=""https://cdn.x/inline.png""></p>",7',
      'Second,,222222222222222222222222,true,false,Thu Jan 22 2026 19:21:05 GMT+0000,,,Nobody,https://d3e54v103j8qbb.cloudfront.net/plugins/Basic/assets/placeholder.60f9b1840c.svg,,,',
      'Fourth,fourth,666666666666666666666666,false,false,,,Thu Jan 24 2026 19:21:05 GMT+0000,jane,,,,',
      'Third,first,333333333333333333333333,false,false,,,Thu Jan 24 2026 19:21:05 GMT+0000,John Doe,,,,3.5',
    ].join('\n') },
    { filename: 'site - People - bbbbbbbbbbbbbbbbbbbbbbbb.csv', content: ['Name,Slug,Item ID,Published On,Posts', 'Jane,jane,444444444444444444444444,x,first; 333333333333333333333333; Third; nope', 'John Doe,john,555555555555555555555555,x,'].join('\n') },
  ]);
  const plans = inferSchema(csvs);
  const warn = new Warnings();
  const mat = fakeMat('ok');
  const progress: number[][] = [];
  const result = await importCms(plans, { mat, remoteAssets: 'download', warn, onProgress: (d, t) => progress.push([d, t]), concurrency: 2 });

  assert.deepEqual(result.counts, { collections: 2, fields: 6 + 5 + 6 + 1, items: 6, itemsPublishable: 5, cmsImages: 3, failed: 0, skipped: 0 });
  assert.deepEqual(progress, [[4, 6], [6, 6]]);
  const posts = result.collections[0];
  const people = result.collections[1];
  assert.equal(posts.name, 'Posts 2', 'existing name de-duplicated');
  assert.equal(people.name, 'People');
  assert.deepEqual(db.collections.map((c) => c.order), [5, 6]);
  assert.deepEqual(posts.fields.map((f) => [f.name, f.key, f.type]), [
    ['ID', 'id', 'number'], ['Status', 'status', 'status'], ['Name', 'name', 'text'], ['Slug', 'slug', 'text'],
    ['Author', null, 'reference'], ['Cover', null, 'image'], ['Gallery', null, 'image'], ['Body', null, 'rich_text'], ['Score', null, 'number'],
    ['Created Date', 'created_at', 'date'], ['Updated Date', 'updated_at', 'date'],
  ]);
  const authorField = db.fields.find((f) => f.name === 'Author' && f.collection_id === posts.id)!;
  assert.equal(authorField.reference_collection_id, people.id);
  assert.equal(authorField.key, null);
  assert.equal(db.fields.find((f) => f.name === 'Status')!.is_computed, true);
  assert.equal(db.fields.find((f) => f.name === 'ID')!.fillable, false);
  assert.deepEqual(db.fields.find((f) => f.name === 'Gallery')!.data, { multiple: true });
  assert.deepEqual(db.fields.filter((f) => f.collection_id === posts.id).map((f) => f.order), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(posts.slugFieldId, db.fields.find((f) => f.name === 'Slug' && f.collection_id === posts.id)!.id);
  assert.equal(posts.dateFormatByField[db.fields.find((f) => f.name === 'Score')!.id as string], undefined);
  assert.equal(posts.fillCountByField[db.fields.find((f) => f.name === 'Score')!.id as string], 2);

  const items = db.items.filter((i) => i.collection_id === posts.id);
  assert.deepEqual(items.map((i) => [i.manual_order, i.is_publishable, i.is_published]), [[0, true, false], [1, false, false], [2, true, false], [3, true, false]]);
  const SLUGS = ['first', 'second', 'fourth', 'third'];
  assert.ok(items.every((i) => typeof i.content_hash === 'string' && (i.content_hash as string).length === 64));
  assert.deepEqual([...posts.itemIdBySlug.keys()], SLUGS, 'duplicate slug "first" falls back to the slugified name');
  assert.equal(warn.count('slug_suffixed'), 2);
  const valueOf = (itemIndex: number, fieldName: string) => {
    const fieldId = db.fields.find((f) => f.name === fieldName && f.collection_id === posts.id)!.id;
    return db.values.find((v) => v.item_id === posts.itemIdBySlug.get(SLUGS[itemIndex]) && v.field_id === fieldId)?.value;
  };
  assert.equal(valueOf(0, 'ID'), '1');
  assert.equal(valueOf(0, 'Name'), 'First');
  assert.equal(valueOf(0, 'Slug'), 'first');
  assert.equal(valueOf(0, 'Created Date'), '2026-01-22T19:21:05.000Z');
  assert.equal(valueOf(0, 'Author'), people.itemIdBySlug.get('jane'));
  assert.equal(valueOf(0, 'Cover'), 'asset-reused', 'existing asset reused by display name');
  assert.deepEqual(JSON.parse(valueOf(0, 'Gallery') as string).length, 2);
  assert.ok((valueOf(0, 'Body') as string).includes('"assetId":"asset-'), 'rich-text image re-hosted');
  assert.equal(valueOf(0, 'Score'), '7');
  assert.equal(valueOf(1, 'Cover'), undefined, 'placeholder never downloaded, no value row');
  assert.equal(valueOf(1, 'Author'), undefined, 'unresolved reference -> no value');
  assert.equal(valueOf(3, 'Author'), people.itemIdBySlug.get('john'), 'resolved by name');
  assert.equal(valueOf(3, 'Score'), '3.5');
  assert.equal(valueOf(3, 'Slug'), 'third');
  assert.ok(typeof valueOf(3, 'Created Date') === 'string', 'missing Created On falls back to now');
  assert.equal(valueOf(2, 'Author'), people.itemIdBySlug.get('jane'));
  assert.equal(warn.count('reference_unresolved'), 2, 'Nobody + nope');
  const postsRef = db.values.find((v) => v.item_id === people.itemIdBySlug.get('jane') && v.field_id === db.fields.find((f) => f.name === 'Posts')!.id)!;
  assert.deepEqual(JSON.parse(postsRef.value as string), [posts.itemIdBySlug.get('first'), posts.itemIdBySlug.get('third'), posts.itemIdBySlug.get('third')]);
  assert.deepEqual(mat.uploaded.sort(), ['https://cdn.x/a.jpg', 'https://cdn.x/b.jpg', 'https://cdn.x/inline.png']);
  assert.ok(!db.values.some((v) => v.value === null));

  // skip mode: nothing uploaded, values absent, counted as skipped
  resetDb();
  const skipWarn = new Warnings();
  const skipMat = fakeMat('ok');
  const skipped = await importCms(inferSchema(csvs), { mat: skipMat, remoteAssets: 'skip', warn: skipWarn });
  assert.equal(skipped.counts.skipped, 4, 'the reused asset is not in the table after resetDb');
  assert.equal(skipped.counts.cmsImages, 0);
  assert.deepEqual(skipMat.uploaded, []);
  assert.equal(skipWarn.count('asset_skipped'), 4);

  // failures: counted per URL, first five verbatim
  resetDb();
  const failWarn = new Warnings();
  const failed = await importCms(inferSchema(csvs), { mat: fakeMat('fail'), remoteAssets: 'download', warn: failWarn });
  assert.equal(failed.counts.failed, 4);
  assert.equal(failed.counts.cmsImages, 0);
  assert.equal(failWarn.count('asset_download_failed'), 4);
  assert.ok(failWarn.list.every((w) => w.code !== 'asset_download_failed' || w.message.startsWith('download failed: https://')));
});

// ─── Sample CSVs ──────────────────────────────────────────────────────────────

const SAMPLE_DB = path.join(process.cwd(), 'import/db');
const HAS_SAMPLE = existsSync(SAMPLE_DB) && existsSync(path.join(SAMPLE_DB, WERKE_CSV)) && existsSync(path.join(SAMPLE_DB, EXHIBITIONS_CSV));

function sampleCsvs() {
  return readdirSync(SAMPLE_DB).filter((f) => f.endsWith('.csv')).sort().map((f) => ({ filename: f, content: readFileSync(path.join(SAMPLE_DB, f), 'utf8') }));
}

test('sample CSVs: schema inference and publishable counts', { skip: !HAS_SAMPLE }, () => {
  const csvs = parseCsvFiles(sampleCsvs());
  assert.deepEqual(csvs.map((c) => [c.name, c.webflowId, c.rows.length]), [['Exhibitions', '697275d29b50275b1e811754', 24], ['Werke', '696e3e261a55566a62dc5508', 97]]);
  const warn = new Warnings();
  const plans = inferSchema(csvs, warn);
  const werke = plans.find((p) => p.csv.name === 'Werke')!;
  const exhibitions = plans.find((p) => p.csv.name === 'Exhibitions')!;
  const custom = (p: typeof werke) => p.fields.filter((f) => !f.system).map((f) => [f.header, f.type, f.multiple ?? false]);
  assert.deepEqual(custom(werke), [
    ['feature', 'boolean', false], ['highlight', 'boolean', false], ['Werk', 'image', false], ['Order', 'number', false], ['Video', 'text', false],
    ['Details', 'text', false], ['Beschreibung', 'rich_text', false], ['Datum', 'date', false], ['masse', 'text', false], ['technik', 'text', false], ['Ohne Titel', 'boolean', false],
  ]);
  assert.deepEqual(custom(exhibitions), [
    ['images', 'image', true], ['description', 'text', false], ['datum', 'date', false], ['location', 'text', false], ['werke', 'multi_reference', false], ['feature', 'boolean', false], ['article', 'rich_text', false],
  ]);
  const werkeRef = exhibitions.fields.find((f) => f.header === 'werke')!;
  assert.equal(werkeRef.referenceTargetWebflowId, '696e3e261a55566a62dc5508');
  assert.equal(werkeRef.guessed, true);
  assert.equal(werke.fields.filter((f) => !f.system).length, 11);
  assert.equal(exhibitions.fields.filter((f) => !f.system).length, 7);
  assert.equal(werke.csv.rows.filter((r) => !isPublishableRow(r)).length, 12);
  assert.equal(exhibitions.csv.rows.filter((r) => !isPublishableRow(r)).length, 1);
  assert.equal(dateFormatFor(werke.csv.rows.map((r) => r['Datum'])), 'part-year');
  assert.equal(dateFormatFor(exhibitions.csv.rows.map((r) => r['datum'])), 'part-year');
});

test('sample CSVs: import against the in-memory repositories (remoteAssets = skip)', { skip: !HAS_SAMPLE }, async () => {
  resetDb();
  const warn = new Warnings();
  const mat = fakeMat('ok');
  const result = await importCms(inferSchema(parseCsvFiles(sampleCsvs())), { mat, remoteAssets: 'skip', warn });
  assert.deepEqual(result.counts, { collections: 2, fields: 30, items: 121, itemsPublishable: 108, cmsImages: 0, failed: 0, skipped: 134 }, '97 Werk + 37 exhibition image URLs');
  assert.deepEqual(mat.uploaded, []);
  const werke = result.collections.find((c) => c.name === 'Werke')!;
  const exhibitions = result.collections.find((c) => c.name === 'Exhibitions')!;
  assert.equal(werke.rowCount, 97);
  assert.equal(werke.publishableCount, 85);
  assert.equal(exhibitions.publishableCount, 23);
  assert.equal(werke.itemIdBySlug.size, 97);
  assert.ok(werke.itemIdBySlug.has('affinitat'), 'CSV slug kept verbatim');
  assert.ok(werke.itemIdBySlug.has('ohne-titel') && werke.itemIdBySlug.has('ohne-titel-129e9'));
  assert.equal(warn.count('slug_suffixed'), 0);
  assert.equal(warn.count('reference_unresolved'), 0);
  const datum = werke.fields.find((f) => f.name === 'Datum')!;
  assert.equal(werke.dateFormatByField[datum.id], 'part-year');
  assert.equal(werke.fillCountByField[datum.id], 95);
  assert.equal(werke.fillCountByField[werke.fields.find((f) => f.name === 'Video')!.id], 0);
  assert.equal(db.items.length, 121);
  assert.equal(db.items.filter((i) => i.is_publishable).length, 108);
  const werkField = werke.fields.find((f) => f.name === 'Werk')!;
  assert.equal(db.values.filter((v) => v.field_id === werkField.id).length, 0, 'skipped images leave no value rows');
  const orderField = werke.fields.find((f) => f.name === 'Order')!;
  assert.equal(db.values.filter((v) => v.field_id === orderField.id).length, 80);
  assert.ok(db.values.filter((v) => v.field_id === datum.id).every((v) => /^\d{4}-\d{2}-\d{2}T/.test(v.value as string)));
  const werkeRef = exhibitions.fields.find((f) => f.name === 'werke')!;
  assert.equal(werkeRef.type, 'multi_reference');
  assert.equal(werkeRef.referenceCollectionId, werke.id);
});

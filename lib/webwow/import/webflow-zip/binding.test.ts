import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// cms.ts (schema inference is reused below) imports the repositories, whose module
// graph carries `import 'server-only'`; make it a no-op outside a server bundle.
{
  const filename = require.resolve('server-only');
  const mod = new Module(filename) as Module & { loaded: boolean };
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = {};
  require.cache[filename] = mod;
}

import { Warnings } from './warnings';
import { buildStyleModel, type WfStyleModel } from './css';
import { loadSvgIcons, parsePage, type HtmlContext } from './html';
import type { WfZipBundle, WfZipFile } from './zip';
import type { WfNode, WfPage } from './types';
import type { WfCmsResult, WfCollectionInfo, WfCollectionInfoField, WfCollectionPlan } from './cms';
import { inferSchema, parseCsvFiles } from './cms';
import { NAME_SYNONYMS, bindPages, chooseCollection, nameSimilarity, objectIdSeconds, similarity, templateSignature } from './binding';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let fieldCounter = 0;
type FieldSpec = { name: string; type: WfCollectionInfoField['type']; key?: string | null; multiple?: boolean; fill?: number; yearOnly?: boolean };

/** Build a WfCollectionInfo the way importCms would (built-ins first, custom fields, then dates). */
function collection(id: string, name: string, webflowId: string | null, custom: FieldSpec[], rowCount: number, slugs: string[] = []): WfCollectionInfo {
  const mk = (spec: FieldSpec): WfCollectionInfoField => ({ id: `f-${id}-${++fieldCounter}-${spec.name.toLowerCase().replace(/\W+/g, '')}`, key: spec.key ?? null, name: spec.name, header: spec.key ? null : spec.name, type: spec.type, multiple: !!spec.multiple, referenceCollectionId: null });
  const fields = [
    mk({ name: 'ID', type: 'number', key: 'id' }), mk({ name: 'Status', type: 'status', key: 'status' }), mk({ name: 'Name', type: 'text', key: 'name' }), mk({ name: 'Slug', type: 'text', key: 'slug' }),
    ...custom.map(mk),
    mk({ name: 'Created Date', type: 'date', key: 'created_at' }), mk({ name: 'Updated Date', type: 'date', key: 'updated_at' }),
  ];
  const dateFormatByField: Record<string, string> = {};
  const fillCountByField: Record<string, number> = {};
  custom.forEach((spec, i) => {
    const f = fields[4 + i];
    fillCountByField[f.id] = spec.fill ?? rowCount;
    if (spec.type === 'date') dateFormatByField[f.id] = spec.yearOnly === false ? 'date-eu-dot' : 'part-year';
  });
  return {
    id, name, webflowId, fields, slugFieldId: fields[3].id, nameFieldId: fields[2].id,
    itemIdBySlug: new Map(slugs.map((s) => [s, `item-${s}`])), itemIdByWebflowId: new Map(), itemIdByName: new Map(),
    rowCount, publishableCount: rowCount, dateFormatByField, fillCountByField,
  };
}

function werke(): WfCollectionInfo {
  return collection('werke', 'Werke', '696e3e261a55566a62dc5508', [
    { name: 'feature', type: 'boolean' }, { name: 'highlight', type: 'boolean' }, { name: 'Werk', type: 'image' }, { name: 'Order', type: 'number', fill: 80 },
    { name: 'Video', type: 'text', fill: 0 }, { name: 'Details', type: 'text', fill: 0 }, { name: 'Beschreibung', type: 'rich_text', fill: 0 }, { name: 'Datum', type: 'date', fill: 95 },
    { name: 'masse', type: 'text', fill: 93 }, { name: 'technik', type: 'text', fill: 92 }, { name: 'Ohne Titel', type: 'boolean' },
  ], 97, ['affinitat', 'ohne-titel']);
}

function exhibitions(): WfCollectionInfo {
  return collection('exhibitions', 'Exhibitions', '697275d29b50275b1e811754', [
    { name: 'images', type: 'image', multiple: true, fill: 12 }, { name: 'description', type: 'text', fill: 1 }, { name: 'datum', type: 'date', fill: 24 },
    { name: 'location', type: 'text', fill: 23 }, { name: 'werke', type: 'multi_reference', fill: 0 }, { name: 'feature', type: 'boolean' }, { name: 'article', type: 'rich_text', fill: 2 },
  ], 24);
}

function cmsWith(...collections: WfCollectionInfo[]): WfCmsResult {
  return { collections, counts: { collections: collections.length, fields: 0, items: 0, itemsPublishable: 0, cmsImages: 0, failed: 0, skipped: 0 } };
}

function fakeZip(): WfZipBundle {
  return { root: '', pages: new Map(), errorPages: new Map(), css: { site: [] }, js: [], files: new Map(), missing: [], skipped: [] };
}

function stylesWithBoundBg(...keys: string[]): WfStyleModel {
  const m: WfStyleModel = { classes: new Map(), combos: new Map(), ids: new Map(), tags: new Map(), residual: { rules: [], classNames: new Set(), ids: new Set() }, residualCss: '', fontFaces: [], fontFamilies: [], boundBackgroundKeys: new Set(keys) };
  for (const k of keys) if (!k.includes('.')) m.classes.set(k, { ref: { key: `wf:${k}`, name: k, classes: ['bg-cover'] }, boundBackground: true });
  return m;
}

function pageFrom(name: string, body: string, wfPageId = '', styles = stylesWithBoundBg('div-block')): WfPage {
  const ctx: HtmlContext = { page: name, styles, zip: fakeZip(), pageNames: new Set([name, 'index', 'work', 'detail_werke', 'detail_exhibitions']), assetKey: () => null, warn: new Warnings() };
  return parsePage(`<html data-wf-page="${wfPageId}"><head><title>${name}</title></head><body>${body}</body></html>`, ctx);
}

function find(page: WfPage, pred: (n: WfNode) => boolean): WfNode[] {
  return [...page.nodeIndex.values()].filter(pred);
}

const WERKE_CARD = `
  <div class="collection-list-wrapper w-dyn-list"><div class="collection-list w-dyn-items">
    <div class="collection-item w-dyn-item" data-w-id="8d505578">
      <a href="#" class="div-block-2 w-inline-block"><div class="div-block"></div></a>
      <div class="div-block-4"><div class="rotatetext"><div class="div-block-6"><div class="w-dyn-bind-empty"></div>
        <div class="sidebar"><div class="thin w-dyn-bind-empty"></div><div class="thin w-dyn-bind-empty"></div><div class="thin">|</div><div class="thin w-dyn-bind-empty"></div></div>
      </div></div></div>
    </div>
  </div><div class="w-dyn-empty"><div>No items found.</div></div></div>`;

const EXHIBITIONS_CARD = `
  <div class="collection-list-wrapper-2 w-dyn-list"><div class="w-dyn-items">
    <div class="collection-item-2 _2 w-dyn-item"><div class="div-block-14">
      <div class="div-block-8"><div class="text-block w-dyn-bind-empty"></div><div class="div-block-9"><div class="w-dyn-bind-empty"></div><div class="text-block-2 w-dyn-bind-empty"></div></div></div>
      <p class="w-dyn-bind-empty"></p>
      <div class="rich-text-block w-dyn-bind-empty w-richtext"></div></div>
      <div class="w-dyn-list"><div class="collection-list-2 w-dyn-items"><div class="w-dyn-item"><img src="https://d3e54v103j8qbb.cloudfront.net/plugins/Basic/assets/placeholder.60f9b1840c.svg" class="image-6 w-dyn-bind-empty"></div></div></div>
    </div>
  </div></div>`;

// ─── Similarity / ids ─────────────────────────────────────────────────────────

test('similarity, synonyms and ObjectId timestamps', () => {
  assert.equal(similarity('Datum', 'datum'), 1);
  assert.equal(similarity('Affinität', 'affinitat'), 1);
  assert.ok(similarity('technik', 'technik-2') > 0.7);
  assert.ok(similarity('location', 'Werke') < 0.4);
  assert.equal(similarity('', 'x'), 0);
  assert.equal(nameSimilarity('work', 'Werke'), 1);
  assert.equal(nameSimilarity('Werke', 'works'), 1);
  assert.equal(nameSimilarity('exhibitions', 'Ausstellungen'), 1);
  assert.equal(nameSimilarity('Exhibitions', 'exhibitions'), 1);
  assert.ok(nameSimilarity('artist', 'Werke') < 0.5);
  assert.deepEqual(NAME_SYNONYMS.work, ['werke', 'works', 'arbeiten']);
  assert.equal(objectIdSeconds('696e3e261a55566a62dc5508'), 0x696e3e26);
  assert.equal(objectIdSeconds('nope'), null);
  assert.equal(objectIdSeconds(undefined), null);
});

test('chooseCollection(page): ObjectId proximity (equal / 1 s), 20 s apart falls back to the name, otherwise null', () => {
  const cms = cmsWith(werke(), exhibitions());
  const equal = chooseCollection('page', { page: pageFrom('detail_werke', '', '696e3e261a55566a62dc550e') }, cms)!;
  assert.equal(equal.collection.name, 'Werke');
  assert.equal(equal.confidence, 0.95);
  const oneSecond = chooseCollection('page', { page: pageFrom('detail_exhibitions', '', '697275d39b50275b1e81177c') }, cms)!;
  assert.equal(oneSecond.collection.name, 'Exhibitions');
  assert.equal(oneSecond.confidence, 0.95);
  const far = chooseCollection('page', { page: pageFrom('detail_work', '', '696e3e3a1a55566a62dc550e') }, cms)!;
  assert.equal(far.collection.name, 'Werke', 'synonym work ~ Werke');
  assert.equal(far.confidence, 0.7);
  assert.equal(chooseCollection('page', { page: pageFrom('detail_team', '', '000000001a55566a62dc550e') }, cms), null);
  assert.equal(chooseCollection('page', { page: pageFrom('work', '', '696e3e261a55566a62dc550e') }, cms), null, 'not a detail page');
});

test('chooseCollection(list): template shape, names, headings, field names and the largest-collection fallback', () => {
  const cms = cmsWith(werke(), exhibitions());
  const exPage = pageFrom('index', `<h1 class="heading-2">Current</h1>${EXHIBITIONS_CARD}`);
  const exList = find(exPage, (n) => n.wf.role === 'dyn-list' && n.wf.siteClasses[0] === 'collection-list-wrapper-2')[0];
  const nested = chooseCollection('list', { page: exPage, list: exList, heading: 'Current', wrapperClasses: exList.wf.siteClasses }, cms)!;
  assert.equal(nested.collection.name, 'Exhibitions');
  assert.equal(nested.confidence, 0.8);

  const workPage = pageFrom('work', WERKE_CARD);
  const workList = find(workPage, (n) => n.wf.role === 'dyn-list')[0];
  const byPage = chooseCollection('list', { page: workPage, list: workList, wrapperClasses: workList.wf.siteClasses }, cms)!;
  assert.equal(byPage.collection.name, 'Werke');
  assert.equal(byPage.confidence, 0.7);

  const indexPage = pageFrom('index', WERKE_CARD);
  const indexList = find(indexPage, (n) => n.wf.role === 'dyn-list')[0];
  const fallback = chooseCollection('list', { page: indexPage, list: indexList, wrapperClasses: ['collection-list-wrapper', 'feature-block'] }, cms)!;
  assert.equal(fallback.collection.name, 'Werke');
  assert.equal(fallback.confidence, 0.5);
  assert.ok(fallback.reason.includes('fallback'));

  const byHeading = chooseCollection('list', { page: indexPage, list: indexList, heading: 'Weitere Werke', wrapperClasses: [] }, cms)!;
  assert.equal(byHeading.collection.name, 'Werke');
  assert.equal(byHeading.confidence, 0.7);

  const single = cmsWith(collection('c', 'Team', null, [{ name: 'Portrait', type: 'image' }, { name: 'Role', type: 'text' }], 3));
  const onlyOne = chooseCollection('list', { page: indexPage, list: indexList, heading: 'Our roles', wrapperClasses: [] }, single)!;
  assert.equal(onlyOne.collection.name, 'Team');
  assert.equal(chooseCollection('list', { page: indexPage }, cmsWith()), null);
});

// ─── Slot binding ─────────────────────────────────────────────────────────────

test('Werke template: background -> Werk, first text -> Name, thin x3 -> Datum/masse/technik (best filled first), link -> current item', () => {
  const w = werke();
  const cms = cmsWith(w, exhibitions());
  const page = pageFrom('work', `<section class="section work">${WERKE_CARD}</section>`);
  const warn = new Warnings();
  bindPages({ cms, pages: [page], dynamicPageByCollection: new Map([[w.id, { pageId: 'pg-werke', folderId: 'fld', slug: 'werke' }]]), warn });

  const item = find(page, (n) => n.wf.role === 'dyn-item')[0];
  const field = (name: string) => w.fields.find((f) => f.name === name)!;
  assert.equal(item.wf.collection?.collectionId, w.id);
  assert.equal(item.wf.collection?.sortBy, field('Order').id);
  assert.equal(item.wf.collection?.sortOrder, 'asc');
  assert.equal(item.wf.collection?.filters, undefined);
  assert.equal(item.wf.collection?.limit, undefined);
  assert.equal(item.wf.collection?.confidence, 0.7);

  const bg = find(page, (n) => n.wf.siteClasses[0] === 'div-block')[0];
  assert.equal(bg.wf.boundBackground, true);
  assert.deepEqual({ kind: bg.wf.binding?.kind, field: bg.wf.binding?.fieldName, source: bg.wf.binding?.source, node: bg.wf.binding?.collectionNodeId }, { kind: 'background', field: 'Werk', source: 'collection', node: item.wf.id });
  const nameSlot = find(page, (n) => n.wf.bindEmpty && n.wf.siteClasses.length === 0 && n.kind === 'text')[0];
  assert.equal(nameSlot.wf.binding?.fieldName, 'Name');
  assert.equal(nameSlot.wf.binding?.fieldType, 'text');
  const thins = find(page, (n) => n.wf.bindEmpty && n.wf.siteClasses[0] === 'thin');
  assert.deepEqual(thins.map((t) => t.wf.binding?.fieldName), ['Datum', 'masse', 'technik']);
  assert.equal(thins[0].wf.binding?.format, 'part-year');
  assert.equal(thins[0].wf.binding?.fieldType, 'date');
  assert.equal(thins[1].wf.binding?.format, undefined);
  const link = find(page, (n) => n.kind === 'link')[0];
  assert.deepEqual(link.wf.binding?.link, { pageId: 'pg-werke', collectionItemId: 'current-collection' });
  assert.equal(link.wf.binding?.kind, 'link');
  assert.equal(find(page, (n) => n.wf.siteClasses[0] === 'thin' && !n.wf.bindEmpty)[0].wf.binding, undefined, 'static separator untouched');
  assert.equal(warn.count('collection_guess'), 1);
  assert.ok(warn.count('binding_guess') >= 6);
  assert.equal(warn.count('binding_unbound'), 0);
});

test('Exhibitions template: name/datum/location/description, rich text -> article, nested list -> multi-asset images + __asset_url', () => {
  const e = exhibitions();
  const cms = cmsWith(werke(), e);
  const page = pageFrom('index', `<section class="section small"><h1 class="heading-2">Current</h1>${EXHIBITIONS_CARD}</section>`);
  const warn = new Warnings();
  bindPages({ cms, pages: [page], dynamicPageByCollection: new Map(), warn });
  const field = (name: string) => e.fields.find((f) => f.name === name)!;
  const items = find(page, (n) => n.wf.role === 'dyn-item');
  const outer = items.find((n) => n.wf.siteClasses[0] === 'collection-item-2')!;
  const inner = items.find((n) => n !== outer)!;
  assert.equal(outer.wf.collection?.collectionId, e.id);
  assert.equal(outer.wf.collection?.sortBy, field('datum').id);
  assert.equal(outer.wf.collection?.sortOrder, 'desc');
  assert.equal(find(page, (n) => n.wf.siteClasses[0] === 'text-block')[0].wf.binding?.fieldName, 'Name');
  const dateSlot = find(page, (n) => n.wf.bindEmpty && n.wf.siteClasses.length === 0 && n.wf.tag === 'div')[0];
  assert.equal(dateSlot.wf.binding?.fieldName, 'datum');
  assert.equal(dateSlot.wf.binding?.format, 'part-year');
  assert.equal(find(page, (n) => n.wf.siteClasses[0] === 'text-block-2')[0].wf.binding?.fieldName, 'location');
  assert.equal(find(page, (n) => n.wf.tag === 'p' && n.wf.bindEmpty)[0].wf.binding?.fieldName, 'description');
  const rich = find(page, (n) => n.wf.role === 'rich-text')[0];
  assert.deepEqual({ kind: rich.wf.binding?.kind, field: rich.wf.binding?.fieldName, type: rich.wf.binding?.fieldType }, { kind: 'richText', field: 'article', type: 'rich_text' });
  assert.deepEqual(inner.wf.collection, { collectionId: '__multi_asset__', multiAsset: { fieldId: field('images').id, source: 'collection', parentCollectionNodeId: outer.wf.id }, confidence: 0.8, reason: 'nested list -> multi-image field images' });
  const img = find(page, (n) => n.kind === 'image')[0];
  assert.deepEqual({ field: img.wf.binding?.fieldId, type: img.wf.binding?.fieldType, node: img.wf.binding?.collectionNodeId, source: img.wf.binding?.source }, { field: '__asset_url', type: 'image', node: inner.wf.id, source: 'collection' });
  assert.equal(warn.count('binding_unbound'), 0);
});

test('feature list: filter on the boolean field, limit 1, headings -> Name, class similarity, unbound leftovers', () => {
  const w = werke();
  const cms = cmsWith(w, exhibitions());
  const page = pageFrom('index', `
    <div class="feature w-dyn-list"><div class="w-dyn-items"><div class="section feature w-dyn-item"><div class="section shadow">
      <h2 class="logoanimation white subhead">Featured painting</h2>
      <h1 class="logoanimation white w-dyn-bind-empty"></h1>
      <div class="div-block-7"><p class="paragraph technik w-dyn-bind-empty"></p><p class="paragraph w-dyn-bind-empty"></p><div class="w-dyn-bind-empty"></div><div class="w-dyn-bind-empty"></div><div class="w-dyn-bind-empty"></div><div class="w-dyn-bind-empty"></div></div>
      <h1 class="other w-dyn-bind-empty"></h1>
    </div></div></div></div>`, '', stylesWithBoundBg('section.feature'));
  const warn = new Warnings();
  bindPages({ cms, pages: [page], dynamicPageByCollection: new Map(), warn });
  const item = find(page, (n) => n.wf.role === 'dyn-item')[0];
  const field = (name: string) => w.fields.find((f) => f.name === name)!;
  assert.deepEqual(item.wf.collection?.filters, [{ fieldId: field('feature').id, fieldType: 'boolean', value: 'true' }]);
  assert.equal(item.wf.collection?.limit, 1);
  assert.equal(item.wf.collection?.sortBy, field('Order').id);
  assert.equal(item.wf.boundBackground, true, 'combo chain flagged as bound background');
  assert.equal(item.wf.binding?.kind, 'background');
  const headings = find(page, (n) => n.kind === 'heading' && n.wf.bindEmpty);
  assert.equal(headings[0].wf.binding?.fieldName, 'Name');
  assert.equal(headings[1].wf.binding, undefined);
  const paragraphs = find(page, (n) => n.wf.tag === 'p' && n.wf.bindEmpty);
  assert.equal(paragraphs[0].wf.binding?.fieldName, 'technik', 'class technik ~ field technik');
  assert.equal(paragraphs[1].wf.binding?.fieldName, 'Datum');
  const divs = find(page, (n) => n.wf.tag === 'div' && n.wf.bindEmpty);
  assert.deepEqual(divs.map((d) => d.wf.binding?.fieldName), ['masse', 'Video', 'Details', undefined], 'empty columns after filled ones, then nothing left');
  assert.equal(warn.count('binding_unbound'), 2);
  assert.ok(warn.list.some((x) => x.code === 'binding_unbound' && /previous\/next/.test(x.message)));
});

test('detail page: page-source bindings, h1 -> Name, image -> Werk, extra headings unbound, href safety net, template twins', () => {
  const w = werke();
  const cms = cmsWith(w, exhibitions());
  const detail = pageFrom('detail_werke', `
    <section class="section-3">
      <img src="https://d3e54v103j8qbb.cloudfront.net/plugins/Basic/assets/placeholder.60f9b1840c.svg" class="image-7 w-dyn-bind-empty">
      <div class="title"><h1 class="logoanimation white l auto mobile black subtitle w-dyn-bind-empty"></h1>
        <div class="footerheading"><div class="thin _2 w-dyn-bind-empty"></div><div class="thin _2">|</div><div class="thin _2 w-dyn-bind-empty"></div><div class="thin _2 w-dyn-bind-empty"></div></div></div>
      <div class="cell-3"><h1 class="logoanimation white l auto small w-dyn-bind-empty"></h1></div>
      <div class="cell-4"><h1 class="logoanimation white l auto small w-dyn-bind-empty"></h1></div>
      <a href="/detail_werke/affinitat" class="static">See</a>
      <a href="/detail_werke/missing" class="static">Gone</a>
    </section>
    <section class="section-3-copy"><h1 class="heading-2">Weitere Werke</h1>${WERKE_CARD.replace('href="#"', 'href="/detail_werke/ohne-titel"')}</section>`, '696e3e261a55566a62dc550e');
  const index = pageFrom('index', `<div class="feature-block">${WERKE_CARD}</div>`, '696e3d590d900572c87f0671');
  const warn = new Warnings();
  bindPages({ cms, pages: [index, detail], dynamicPageByCollection: new Map([[w.id, { pageId: 'pg-werke', folderId: 'fld', slug: 'werke' }]]), warn });

  const img = find(detail, (n) => n.kind === 'image')[0];
  assert.deepEqual({ kind: img.wf.binding?.kind, field: img.wf.binding?.fieldName, source: img.wf.binding?.source, node: img.wf.binding?.collectionNodeId }, { kind: 'image', field: 'Werk', source: 'page', node: undefined });
  const headings = find(detail, (n) => n.kind === 'heading' && n.wf.bindEmpty);
  assert.equal(headings[0].wf.binding?.fieldName, 'Name');
  assert.equal(headings[0].wf.binding?.source, 'page');
  assert.equal(headings[1].wf.binding, undefined);
  assert.equal(headings[2].wf.binding, undefined);
  const thins = find(detail, (n) => n.wf.bindEmpty && n.wf.siteClasses[0] === 'thin' && n.wf.siteClasses[1] === '_2');
  assert.deepEqual(thins.map((t) => t.wf.binding?.fieldName), ['Datum', 'masse', 'technik']);
  assert.ok(thins.every((t) => t.wf.binding?.source === 'page'));

  const links = find(detail, (n) => n.kind === 'link' && n.wf.siteClasses[0] === 'static');
  assert.deepEqual(links[0].wf.binding?.link, { pageId: 'pg-werke', collectionItemId: 'item-affinitat' });
  assert.equal(links[0].wf.binding?.source, 'page');
  assert.deepEqual(links[1].wf.binding?.link, { pageId: 'pg-werke', collectionItemId: 'current-collection' });
  assert.ok(warn.list.some((x) => x.code === 'link_broken' && x.message.includes('missing')));
  const cardLink = find(detail, (n) => n.kind === 'link' && n.wf.siteClasses[0] === 'div-block-2')[0];
  assert.deepEqual(cardLink.wf.binding?.link, { pageId: 'pg-werke', collectionItemId: 'current-collection' }, 'inside a list -> current-collection');

  const guesses = warn.list.filter((x) => x.code === 'collection_guess').map((x) => x.message);
  assert.ok(guesses.some((m) => m.includes('page detail_werke') && m.includes('0.95')));
  assert.ok(guesses.some((m) => m.includes('on detail_werke') && m.includes('0.70')), 'heading "Weitere Werke"');
  assert.ok(guesses.some((m) => m.includes('on index') && m.includes('0.90') && m.includes('same item template')), 'index list bound through the template twin');
  const indexItem = find(index, (n) => n.wf.role === 'dyn-item')[0];
  assert.equal(indexItem.wf.collection?.collectionId, w.id);
  assert.equal(indexItem.wf.collection?.confidence, 0.9);
  assert.equal(templateSignature(indexItem), templateSignature(find(detail, (n) => n.wf.role === 'dyn-item')[0]));
});

test('no collections -> nothing bound, no warnings', () => {
  const page = pageFrom('work', WERKE_CARD);
  const warn = new Warnings();
  bindPages({ cms: cmsWith(), pages: [page], dynamicPageByCollection: new Map(), warn });
  assert.equal(find(page, (n) => n.wf.binding !== undefined || n.wf.collection !== undefined).length, 0);
  assert.equal(warn.list.length, 0);
});

// ─── Sample export ────────────────────────────────────────────────────────────

const SAMPLE_ROOT = path.join(process.cwd(), 'import/web/valeska-von-brase.webflow');
const SAMPLE_DB = path.join(process.cwd(), 'import/db');
const HAS_SAMPLE = existsSync(path.join(SAMPLE_ROOT, 'index.html')) && existsSync(SAMPLE_DB);

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

/** WfCollectionInfo from an inferred plan (no database): mirrors importCms' field layout and fill counts. */
function infoFromPlan(plan: WfCollectionPlan, id: string): WfCollectionInfo {
  const custom: FieldSpec[] = plan.fields.filter((f) => !f.system).map((f) => {
    const values = plan.csv.rows.map((r) => (r[f.header] ?? '').trim()).filter(Boolean);
    const yearOnly = values.length > 0 && values.filter((v) => /(Dec 31 \d{4} 2[23]:00:00|Jan 01 \d{4} 00:00:00)/.test(v)).length / values.length >= 0.8;
    return { name: f.name, type: f.type, multiple: f.multiple, fill: values.length, yearOnly };
  });
  return collection(id, plan.csv.name, plan.csv.webflowId, custom, plan.csv.rows.length, plan.csv.rows.map((r) => r['Slug']));
}

test('sample export: every list and detail page binds to the expected collection with the expected slots', { skip: !HAS_SAMPLE }, async () => {
  const zip = sampleZip();
  const styles = buildStyleModel({ siteCss: [readFileSync(path.join(SAMPLE_ROOT, 'css/valeska-von-brase.css'), 'utf8')], assetUrl: () => null, warn: new Warnings() });
  const pageNames = new Set([...zip.files.keys()].filter((f) => /^[^/]+\.html$/.test(f)).map((f) => f.slice(0, -5)));
  const svgFiles = await loadSvgIcons(zip);
  const pages = [...pageNames].sort().map((name) => parsePage(readFileSync(path.join(SAMPLE_ROOT, `${name}.html`), 'utf8'), { page: name, styles, zip, pageNames, assetKey: (p) => (zip.files.has(p) ? p : null), warn: new Warnings(), svgFiles }));
  const csvs = parseCsvFiles(readdirSync(SAMPLE_DB).filter((f) => f.endsWith('.csv')).sort().map((f) => ({ filename: f, content: readFileSync(path.join(SAMPLE_DB, f), 'utf8') })));
  const plans = inferSchema(csvs);
  const infos = plans.map((p) => infoFromPlan(p, p.csv.name.toLowerCase()));
  const cms = cmsWith(...infos);
  const w = infos.find((c) => c.name === 'Werke')!;
  const e = infos.find((c) => c.name === 'Exhibitions')!;
  const warn = new Warnings();
  bindPages({ cms, pages, dynamicPageByCollection: new Map([[w.id, { pageId: 'pg-werke', folderId: 'f1', slug: 'werke' }], [e.id, { pageId: 'pg-ex', folderId: 'f2', slug: 'exhibitions' }]]), warn });

  const byPage = (name: string) => pages.find((p) => p.name === name)!;
  const topItems = (page: WfPage) => find(page, (n) => n.wf.role === 'dyn-item' && n.wf.collection?.collectionId !== '__multi_asset__');

  // Detail pages: 0.95 through ObjectId proximity.
  const guesses = warn.list.filter((x) => x.code === 'collection_guess').map((x) => x.message);
  assert.ok(guesses.some((m) => m.startsWith('bound page detail_werke to collection Werke (confidence 0.95')));
  assert.ok(guesses.some((m) => m.startsWith('bound page detail_exhibitions to collection Exhibitions (confidence 0.95')));
  assert.equal(warn.count('collection_guess'), 2 + 9, '2 pages + 9 top-level lists (index 4, work 1, exhibitions 2, catalog 1, detail_werke 1)');

  // Lists.
  const werkeLists = ['index', 'work', 'detail_werke', 'catalog'].flatMap((n) => topItems(byPage(n)).filter((i) => i.wf.collection?.collectionId === w.id));
  assert.equal(werkeLists.length, 6, 'index x3 (two cards + feature), work, detail_werke, catalog');
  const exLists = ['index', 'exhibitions'].flatMap((n) => topItems(byPage(n)).filter((i) => i.wf.collection?.collectionId === e.id));
  assert.equal(exLists.length, 3, 'index x1, exhibitions x2');
  assert.ok(topItems(byPage('index')).every((i) => i.wf.collection && i.wf.collection.confidence >= 0.5));

  const field = (c: WfCollectionInfo, name: string) => c.fields.find((f) => f.name === name)!;
  const feature = topItems(byPage('index')).find((i) => i.wf.classNames.includes('feature'))!;
  assert.deepEqual(feature.wf.collection?.filters, [{ fieldId: field(w, 'feature').id, fieldType: 'boolean', value: 'true' }]);
  assert.equal(feature.wf.collection?.limit, 1);
  assert.equal(feature.wf.binding?.kind, 'background', '.section.feature carries the bound-background placeholder');

  const workItem = topItems(byPage('work'))[0];
  assert.equal(workItem.wf.collection?.sortBy, field(w, 'Order').id);
  const workBindings = find(byPage('work'), (n) => n.wf.binding !== undefined).map((n) => [n.wf.binding!.kind, n.wf.binding!.fieldName]);
  assert.deepEqual(workBindings, [['link', 'Slug'], ['background', 'Werk'], ['text', 'Name'], ['text', 'Datum'], ['text', 'masse'], ['text', 'technik']]);
  assert.equal(find(byPage('work'), (n) => n.wf.binding?.fieldName === 'Datum')[0].wf.binding?.format, 'part-year');

  const exItems = topItems(byPage('exhibitions'));
  assert.ok(exItems.every((i) => i.wf.collection?.sortBy === field(e, 'datum').id && i.wf.collection?.sortOrder === 'desc'));
  const exBindings = find(byPage('exhibitions'), (n) => n.wf.binding !== undefined).map((n) => `${n.wf.binding!.kind}:${n.wf.binding!.fieldName}`);
  assert.deepEqual(exBindings, ['text:Name', 'text:datum', 'text:location', 'text:description', 'text:Name', 'text:datum', 'text:location', 'text:description', 'image:images']);
  const nestedItems = find(byPage('exhibitions'), (n) => n.wf.collection?.collectionId === '__multi_asset__');
  assert.equal(nestedItems.length, 2);
  assert.ok(nestedItems.every((n) => n.wf.collection?.multiAsset?.fieldId === field(e, 'images').id));

  const indexEx = find(byPage('index'), (n) => n.wf.role === 'rich-text')[0];
  assert.equal(indexEx.wf.binding?.fieldName, 'article');
  assert.equal(find(byPage('index'), (n) => n.wf.binding?.fieldId === '__asset_url').length, 1);

  const detail = byPage('detail_werke');
  const pageBindings = find(detail, (n) => n.wf.binding?.source === 'page').map((n) => `${n.wf.binding!.kind}:${n.wf.binding!.fieldName}`);
  assert.deepEqual(pageBindings, ['image:Werk', 'text:Name', 'text:Datum', 'text:masse', 'text:technik', 'background:Werk', 'background:Werk', 'background:Werk', 'background:Werk'], 'cells 5/3/4 and div-block-16 carry the bound-background placeholder');
  const unbound = warn.list.filter((x) => x.code === 'binding_unbound' && x.page === 'detail_werke');
  assert.equal(unbound.reduce((n, x) => n + (x.count ?? 1), 0), 2, 'the two small h1s (identical messages merge into one entry with count 2)');
  assert.equal(warn.count('binding_unbound'), 2, 'nothing else is left unbound on the sample');
  assert.ok(unbound.every((x) => /previous\/next/.test(x.message)));
  assert.ok(find(detail, (n) => n.kind === 'link' && n.wf.binding?.link?.collectionItemId === 'current-collection').length >= 1);
  assert.ok(warn.count('binding_guess') >= 10);
});

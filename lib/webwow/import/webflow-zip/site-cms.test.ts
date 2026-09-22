import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

// cms.ts imports the repositories, whose module graph carries `import 'server-only'`.
{
  const filename = require.resolve('server-only');
  const mod = new Module(filename) as Module & { loaded: boolean };
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = {};
  require.cache[filename] = mod;
}

import { Warnings } from './warnings';
import { parsePage, type HtmlContext } from './html';
import { inferSchema, parseCsvFiles } from './cms';
import { bindPages } from './binding';
import { parseSitePage, type SiteItem, type SitePage, type SiteSlotValue, type WfSiteCrawl } from './site-crawl';
import { OTHER_ZONE_MATCH, applySiteSeo, assignRows, compareValue, createSiteOracle, currentItemEvidence, dateRenderings, decideSlot, decideTimeZone, exportLists, exportSlotKeys, imageIdentity, listFilterFor, mergeSitePlans, rowEvidence, seoTextTemplate } from './site-cms';
import type { PagePlan } from './pages';
import { inferTimeZoneFromDates } from './cms';
import type { WfStyleModel } from './css';
import type { WfCmsResult, WfCollectionInfo, WfCollectionInfoField, WfCollectionPlan } from './cms';
import type { WfZipBundle } from './zip';
import type { WfNode, WfPage } from './types';

// ─── Export-side fixtures (the ZIP's template markup) ─────────────────────────

function fakeZip(): WfZipBundle {
  return { root: '', pages: new Map(), errorPages: new Map(), css: { site: [] }, js: [], files: new Map(), missing: [], skipped: [] };
}

function stylesWithBoundBg(...keys: string[]): WfStyleModel {
  const m: WfStyleModel = { classes: new Map(), combos: new Map(), ids: new Map(), tags: new Map(), residual: { rules: [], classNames: new Set(), ids: new Set() }, residualCss: '', fontFaces: [], fontFamilies: [], boundBackgroundKeys: new Set(keys), states: new Map(), resting: new Map() };
  for (const k of keys) m.classes.set(k, { ref: { key: `wf:${k}`, name: k, classes: ['bg-cover'] }, boundBackground: true });
  return m;
}

function exportPage(name: string, body: string): WfPage {
  const ctx: HtmlContext = { page: name, styles: stylesWithBoundBg('div-block'), zip: fakeZip(), pageNames: new Set([name, 'index', 'work', 'detail_werke']), assetKey: () => null, warn: new Warnings() };
  return parsePage(`<html data-wf-page="696e3e261a55566a62dc550e"><head><title>${name}</title></head><body>${body}</body></html>`, ctx);
}

const WERKE_TEMPLATE = `
  <h1 class="logoanimation">WORKS</h1>
  <div class="collection-list-wrapper w-dyn-list"><div role="list" class="collection-list w-dyn-items">
    <div class="collection-item w-dyn-item" data-w-id="8d505578">
      <a href="#" class="div-block-2 w-inline-block"><div class="div-block"></div></a>
      <div class="div-block-4"><div class="rotatetext"><div class="div-block-6"><div class="w-dyn-bind-empty"></div>
        <div class="sidebar"><div class="thin w-dyn-bind-empty"></div><div class="thin w-dyn-bind-empty"></div><div class="thin">|</div><div class="thin w-dyn-bind-empty"></div></div>
      </div></div></div>
    </div>
  </div><div class="w-dyn-empty"><div>No items found.</div></div></div>`;

const DETAIL_TEMPLATE = `
  <section class="section-3"><img src="https://d3e54v103j8qbb.cloudfront.net/plugins/Basic/assets/placeholder.svg" alt="" class="image-7 w-dyn-bind-empty">
    <div class="title"><h1 class="logoanimation white subtitle w-dyn-bind-empty"></h1>
      <div class="footerheading"><div class="thin _2 w-dyn-bind-empty"></div><div class="thin _2">|</div><div class="thin _2 w-dyn-bind-empty"></div><div class="thin _2 w-dyn-bind-empty"></div></div>
    </div>
  </section>
  <section class="section-3-copy"><h1 class="heading-2">Weitere Werke</h1>${WERKE_TEMPLATE}</section>`;

// ─── Live-side fixtures (what the published site renders) ─────────────────────

const ORIGIN = 'http://localhost:8090';
const CDN = 'https://cdn.prod.website-files.com/696e3e2685bc773db82e3fca';

interface Werk { slug: string; name: string; year: string; masse: string; technik: string; file: string }
const AFFINITAT: Werk = { slug: 'affinitat', name: 'Affinität', year: '2023', masse: '150x180 cm', technik: 'Öl, Pigmente, Acryl auf Leinwand', file: '69726347adba29a83e587f60_03-Affinitat.jpeg' };
const BRANDMALE: Werk = { slug: 'brandmale-der-erde', name: 'Brandmale der Erde', year: '2024', masse: '160x 140', technik: 'Pigmente, Öl, Acryl', file: '699227c04227ec41906ebccc_03-Brandmale.jpg' };
const LEER: Werk = { slug: 'leer', name: 'Leer', year: '2024', masse: '90x90 cm', technik: 'Acryl', file: '6aaa27c04227ec41906ebccc_leer.jpg' };
const LIVE_ONLY: Werk = { slug: 'nur-auf-der-website', name: 'Nur auf der Website', year: '2025', masse: '50x50 cm', technik: 'Tusche', file: '6bbb27c04227ec41906ebccc_nur.jpg' };

function liveCard(w: Werk, masseEmpty = false): string {
  return `<div class="collection-item w-dyn-item" data-w-id="8d505578">
    <a href="/werke/${w.slug}" class="div-block-2 w-inline-block"><div class="div-block" style="background-image:url(&quot;${ORIGIN}/cdn/${w.file}&quot;)"></div></a>
    <div class="div-block-4"><div class="rotatetext"><div class="div-block-6"><div>${w.name}</div>
      <div class="sidebar"><div class="thin">${w.year}</div><div class="thin${masseEmpty ? ' w-dyn-bind-empty' : ''}">${masseEmpty ? '' : w.masse}</div><div class="thin">|</div><div class="thin">${w.technik}</div></div>
    </div></div></div>
  </div>`;
}

function liveWorkPage(items: Werk[]): SitePage {
  const html = `<html><head><title>Works</title></head><body><h1 class="logoanimation">WORKS</h1>
    <div class="collection-list-wrapper w-dyn-list"><div role="list" class="collection-list w-dyn-items">${items.map((w) => liveCard(w, w === LEER)).join('')}</div></div></body></html>`;
  return parseSitePage(html, `${ORIGIN}/work`);
}

function liveDetailPage(w: Werk, others: Werk[]): SitePage {
  const html = `<html><head><title>${w.name} | Valeska von Brase</title></head><body>
    <section class="section-3"><img src="${ORIGIN}/cdn/${w.file}" alt="${w.name}" class="image-7">
      <div class="title"><h1 class="logoanimation white subtitle">${w.name}</h1>
        <div class="footerheading"><div class="thin _2">${w.year}</div><div class="thin _2">|</div><div class="thin _2">${w.masse}</div><div class="thin _2">${w.technik}</div></div>
      </div>
    </section>
    <section class="section-3-copy"><h1 class="heading-2">Weitere Werke</h1>
      <div class="collection-list-wrapper w-dyn-list"><div role="list" class="collection-list w-dyn-items">${others.map((o) => liveCard(o)).join('')}</div></div>
    </section></body></html>`;
  return parseSitePage(html, `${ORIGIN}/werke/${w.slug}`);
}

test('mergeSitePlans: images of a nested gallery list become download fallbacks for the multi-image cell', () => {
  const template = `<div class="collection-list-wrapper-2 w-dyn-list"><div class="w-dyn-items"><div class="collection-item-2 w-dyn-item">
    <div class="text-block w-dyn-bind-empty"></div>
    <div class="w-dyn-list"><div class="collection-list-2 w-dyn-items"><div class="w-dyn-item"><img src="https://d3e54v103j8qbb.cloudfront.net/placeholder.svg" class="image-6 w-dyn-bind-empty"></div></div></div>
  </div></div></div>`;
  const pages = [exportPage('exhibitions', template)];
  const live = parseSitePage(`<html><body><div class="collection-list-wrapper-2 w-dyn-list"><div class="w-dyn-items"><div class="collection-item-2 w-dyn-item">
    <div class="text-block">Art Cologne</div>
    <div class="w-dyn-list"><div class="collection-list-2 w-dyn-items"><div class="w-dyn-item"><img src="${ORIGIN}/cdn/aaaaaaaaaaaaaaaaaaaaaaaa_one.jpg" class="image-6"></div><div class="w-dyn-item"><img src="${ORIGIN}/cdn/bbbbbbbbbbbbbbbbbbbbbbbb_two.jpg" class="image-6"></div></div></div>
  </div></div></div></body></html>`, `${ORIGIN}/exhibitions`);
  const content = ['Name,Slug,Published On,images', `Art Cologne,art-cologne,Mon Feb 09 2026 15:07:10 GMT+0000,${CDN}/aaaaaaaaaaaaaaaaaaaaaaaa_one.jpg;${CDN}/bbbbbbbbbbbbbbbbbbbbbbbb_two.jpg`].join('\n');
  const plans = inferSchema(parseCsvFiles([{ filename: 'x - Exhibitions - 697275d29b50275b1e811754.csv', content }]));
  const merge = mergeSitePlans({ plans, site: crawlOf([live], {}), pages, detailPages: new Map(), warn: new Warnings() });
  assert.equal(merge.mappings.get('exhibitions#list0')?.slots.get('div.text-block#0')?.header, 'Name');
  assert.equal(merge.alternateUrls.get(`${CDN}/aaaaaaaaaaaaaaaaaaaaaaaa_one.jpg`), `${ORIGIN}/cdn/aaaaaaaaaaaaaaaaaaaaaaaa_one.jpg`);
  assert.equal(merge.alternateUrls.get(`${CDN}/bbbbbbbbbbbbbbbbbbbbbbbb_two.jpg`), `${ORIGIN}/cdn/bbbbbbbbbbbbbbbbbbbbbbbb_two.jpg`);
});

function crawlOf(pages: SitePage[], details: Record<string, SitePage[]>): WfSiteCrawl {
  const crawl: WfSiteCrawl = { baseUrl: ORIGIN, origin: ORIGIN, host: 'localhost', reachable: true, pages: new Map(), detail: new Map(), locales: [], stats: { fetched: pages.length, failed: 0, skipped: 0, bytes: 0 } };
  for (const p of pages) crawl.pages.set(p.path, p);
  for (const [folder, list] of Object.entries(details)) {
    const m = new Map<string, SitePage>();
    for (const p of list) m.set(p.path.split('/').pop()!, p);
    crawl.detail.set(folder, m);
  }
  return crawl;
}

// ─── CSV plan ─────────────────────────────────────────────────────────────────

const CSV_HEADERS = 'Name,Slug,Collection ID,Locale ID,Item ID,Archived,Draft,Created On,Updated On,Published On,feature,Werk,Order,Beschreibung,Datum,masse,technik';
function csvRow(w: Werk, opts: { masse?: string; datum: string; order: string }): string {
  return [w.name, w.slug, '696e3e261a55566a62dc5508', '696e3e2685bc773db82e3fc9', '6972638bad3db59708fe979b', 'false', 'false', 'Thu Jan 22 2026 17:51:07 GMT+0000', 'Thu Feb 05 2026 21:52:52 GMT+0000', 'Mon Feb 09 2026 15:07:10 GMT+0000', 'false', `${CDN}/${w.file}`, opts.order, '', opts.datum, opts.masse ?? w.masse, `"${w.technik}"`].join(',');
}

function werkePlans(): WfCollectionPlan[] {
  const content = [
    CSV_HEADERS,
    csvRow(AFFINITAT, { datum: 'Sat Dec 31 2022 23:00:00 GMT+0000 (Coordinated Universal Time)', order: '67' }),
    csvRow(BRANDMALE, { datum: 'Sun Dec 31 2023 23:00:00 GMT+0000 (Coordinated Universal Time)', order: '3' }),
    csvRow(LEER, { datum: 'Sun Dec 31 2023 23:00:00 GMT+0000 (Coordinated Universal Time)', order: '5', masse: '' }),
  ].join('\n');
  return inferSchema(parseCsvFiles([{ filename: 'valeska von brase - Werke - 696e3e261a55566a62dc5508.csv', content }]));
}

/** WfCollectionInfo the way importCms builds it from a plan (built-ins keyed, custom fields keep their header). */
function infoFromPlan(plan: WfCollectionPlan, id: string): WfCollectionInfo {
  let n = 0;
  const mk = (name: string, key: string | null, header: string | null, type: WfCollectionInfoField['type'], multiple = false): WfCollectionInfoField => ({ id: `${id}-f${++n}-${name.toLowerCase().replace(/\W+/g, '')}`, key, name, header, type, multiple, referenceCollectionId: null });
  const fields = [mk('ID', 'id', null, 'number'), mk('Status', 'status', null, 'status'), mk('Name', 'name', 'Name', 'text'), mk('Slug', 'slug', 'Slug', 'text')];
  for (const f of plan.fields) if (!f.system) fields.push(mk(f.name, null, f.header, f.type, !!f.multiple));
  fields.push(mk('Created Date', 'created_at', null, 'date'), mk('Updated Date', 'updated_at', null, 'date'));
  const dateFormatByField: Record<string, string> = {};
  const fillCountByField: Record<string, number> = {};
  for (const f of fields) {
    if (f.header && f.key === null) fillCountByField[f.id] = plan.csv.rows.filter((r) => (r[f.header!] ?? '').trim()).length;
    if (f.type === 'date' && f.key === null) dateFormatByField[f.id] = 'part-year';
  }
  return {
    id, name: plan.csv.name, webflowId: plan.csv.webflowId, fields, slugFieldId: fields[3].id, nameFieldId: fields[2].id,
    itemIdBySlug: new Map(plan.csv.rows.map((r) => [r['Slug'], `item-${r['Slug']}`])), itemIdByWebflowId: new Map(), itemIdByName: new Map(),
    rowCount: plan.csv.rows.length, publishableCount: plan.csv.rows.length, dateFormatByField, fillCountByField,
  };
}

function cmsOf(plans: WfCollectionPlan[]): WfCmsResult {
  const collections = plans.map((p, i) => infoFromPlan(p, `c${i}`));
  return { collections, counts: { collections: collections.length, fields: 0, items: 0, itemsPublishable: 0, cmsImages: 0, failed: 0, skipped: 0 } };
}

function nodesOf(page: WfPage, pred: (n: WfNode) => boolean): WfNode[] {
  return [...page.nodeIndex.values()].filter(pred);
}

// ─── Value comparison ─────────────────────────────────────────────────────────

test('dateRenderings: a Webflow year-only date renders as the year in European time zones, and names them', () => {
  const r = dateRenderings('Sat Dec 31 2022 23:00:00 GMT+0000 (Coordinated Universal Time)');
  assert.equal(r.get('2023')?.format, 'part-year');
  assert.deepEqual(r.get('2023')?.zones, ['Europe/Berlin', 'Europe/Helsinki'], 'only zones east of London are past midnight');
  assert.equal(r.get('2022')?.format, 'part-year', 'UTC still shows 2022');
  assert.deepEqual(r.get('2022')?.zones, ['UTC', 'Europe/London', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles']);
  assert.equal(r.get('01.01.2023')?.format, 'date-eu-dot');
  assert.equal(r.has('january 1, 2023'), true);
  assert.equal(r.has('1. januar 2023'), true);
  // A summer date: Berlin is UTC+2 then, the zone (not a fixed offset) renders it right.
  assert.deepEqual(dateRenderings('Sat Jul 15 2023 22:30:00 GMT+0000').get('16.07.2023')?.zones, ['Europe/Berlin', 'Europe/Helsinki']);
  assert.equal(dateRenderings('not a date').size, 0);
});

test('compareValue by kind and field type', () => {
  assert.equal(compareValue('text', 'Öl, Pigmente, Acryl auf Leinwand ', '"Öl, Pigmente, Acryl auf Leinwand"'.replace(/"/g, ''), 'text').match, true);
  assert.equal(compareValue('text', 'Affinitat', 'Affinität', 'text').match, true, 'diacritics are folded');
  assert.deepEqual(compareValue('text', '2024', 'Sun Dec 31 2023 23:00:00 GMT+0000', 'date'), { match: true, format: 'part-year', zones: ['Europe/Berlin', 'Europe/Helsinki'] });
  assert.equal(compareValue('text', '61', '61', 'number').match, true);
  assert.equal(compareValue('text', '2024', 'true', 'boolean').match, false);
  assert.equal(compareValue('text', 'x', '', 'text').match, false, 'an empty cell never matches');
  assert.equal(compareValue('background', `${ORIGIN}/cdn/${AFFINITAT.file}`, `${CDN}/${AFFINITAT.file}`, 'image').match, true, 'same file on another host');
  assert.equal(compareValue('image', `${ORIGIN}/cdn/x-p-800.jpg`, `${CDN}/aaaaaaaaaaaaaaaaaaaaaaaa_x.jpg`, 'image').match, true, 'derivative and id prefix stripped');
  assert.equal(compareValue('image', `${ORIGIN}/cdn/other.jpg`, `${CDN}/x.jpg;${CDN}/other.jpg`, 'image').match, true, 'any token of a multi-image cell');
  assert.equal(compareValue('image', `${ORIGIN}/cdn/x.jpg`, `${CDN}/x.jpg`, 'text').match, false, 'images only bind image fields');
  assert.equal(compareValue('richText', '<p>Hello <strong>there</strong></p>', '<p>Hello there</p>', 'rich_text').match, true);
  assert.equal(imageIdentity(`${CDN}/69726347adba29a83e587f60_03-Affinitat-p-500.jpeg`), '03-affinitat.jpeg');
});

test('decideSlot: exactly one consistent field wins, ambiguity and contradictions fall through', () => {
  const [plan] = werkePlans();
  const rows = plan.csv.rows;
  const v = (text: string, empty = false) => ({ key: 'div.thin#1', tag: 'div', classes: ['thin'], text, empty });
  assert.equal(decideSlot('text', [{ value: v('150x180 cm'), row: rows[0] }, { value: v('160x 140'), row: rows[1] }], plan)?.header, 'masse');
  assert.deepEqual(decideSlot('text', [{ value: v('2023'), row: rows[0] }, { value: v('2024'), row: rows[1] }], plan), { header: 'Datum', kind: 'text', format: 'part-year', timeZones: ['Europe/Berlin', 'Europe/Helsinki'], reason: 'live value matches Werke.Datum on 2 item(s)' });
  assert.equal(decideSlot('text', [{ value: v('2022'), row: rows[0] }], plan)?.timeZones, undefined, 'a rendering UTC produces is no zone evidence');
  assert.equal(decideSlot('text', [{ value: v('150x180 cm'), row: rows[0] }, { value: v('nope'), row: rows[1] }], plan), null, 'one contradiction disqualifies');
  assert.equal(decideSlot('text', [{ value: v('150x180 cm'), row: rows[0] }, { value: v('90x90 cm'), row: rows[2] }], plan)?.header, 'masse', 'a live value over an empty cell is neutral (the gap the site fills)');
  assert.equal(decideSlot('text', [{ value: v(''), row: rows[0] }], plan), null, 'no evidence');
  assert.equal(decideSlot('text', [{ value: v('', true), row: rows[2] }, { value: v('150x180 cm'), row: rows[0] }], plan)?.header, 'masse', 'an empty live slot on an item whose cell is empty is consistent');
  assert.equal(decideSlot('text', [{ value: v('', true), row: rows[0] }, { value: v('160x 140'), row: rows[1] }], plan), null, 'an empty live slot on an item whose cell is filled contradicts');
  // Two fields with the same value on every sampled item: ambiguous.
  const twin = { ...plan, fields: [...plan.fields, { ...plan.fields.find((f) => f.header === 'masse')!, header: 'masse2', name: 'masse2' }] };
  const twinRows = rows.map((r) => ({ ...r, masse2: r['masse'] }));
  assert.equal(decideSlot('text', [{ value: v('150x180 cm'), row: twinRows[0] }], twin), null);
});

// ─── exportSlotKeys ───────────────────────────────────────────────────────────

test('exportSlotKeys mirrors the live walk: same keys on the template as on the rendered clone', () => {
  const page = exportPage('work', WERKE_TEMPLATE);
  const [entry] = exportLists(page);
  const keys = exportSlotKeys(entry.item, true);
  const byKey = new Map([...keys].map(([id, key]) => [key, page.nodeIndex.get(id)!]));
  assert.equal(byKey.get('div.collection-item#0')?.wf.role, 'dyn-item');
  assert.equal(byKey.get('div.div-block#0')?.wf.boundBackground, true);
  assert.equal(byKey.get('div.#0')?.wf.bindEmpty, true);
  assert.equal(byKey.get('div.thin#2')?.text, '|');
  assert.equal(byKey.get('div.thin#3')?.wf.bindEmpty, true);
  const live = liveWorkPage([AFFINITAT]);
  const liveKeys = new Set(live.lists[0].items[0].values.keys());
  for (const key of ['a.div-block-2#0', 'div.div-block#0', 'div.#0', 'div.thin#0', 'div.thin#1', 'div.thin#3']) assert.ok(liveKeys.has(key), key);
});

// ─── mergeSitePlans ───────────────────────────────────────────────────────────

function scenario() {
  const pages = [exportPage('work', WERKE_TEMPLATE), exportPage('detail_werke', DETAIL_TEMPLATE)];
  const site = crawlOf(
    [liveWorkPage([AFFINITAT, BRANDMALE, LEER, LIVE_ONLY])],
    { werke: [liveDetailPage(AFFINITAT, [BRANDMALE]), liveDetailPage(LIVE_ONLY, [AFFINITAT])] },
  );
  const plans = werkePlans();
  const warn = new Warnings();
  const merge = mergeSitePlans({ plans, site, pages, detailPages: new Map([['detail_werke', { folder: 'werke', planIndex: 0 }]]), warn });
  return { pages, site, plans, warn, merge };
}

test('mergeSitePlans: slot mapping, filled cells, live-only item, image alternates; CSV rows are not mutated', () => {
  const { plans, warn, merge } = scenario();
  const list = merge.mappings.get('work#list0')!;
  assert.equal(list.planIndex, 0);
  assert.equal(list.identified, 3);
  const slot = (k: string) => list.slots.get(k);
  assert.equal(slot('div.div-block#0')?.header, 'Werk');
  assert.equal(slot('div.div-block#0')?.kind, 'background');
  assert.equal(slot('div.#0')?.header, 'Name');
  assert.deepEqual([slot('div.thin#0')?.header, slot('div.thin#0')?.format], ['Datum', 'part-year']);
  assert.equal(slot('div.thin#1')?.header, 'masse');
  assert.equal(slot('div.thin#3')?.header, 'technik');
  assert.equal(slot('div.thin#2'), undefined, 'the static separator is no slot');

  const detail = merge.mappings.get('detail_werke#page')!;
  assert.equal(detail.slots.get('img.image-7#0')?.header, 'Werk');
  assert.equal(detail.slots.get('img.image-7#0')?.kind, 'image');
  assert.equal(detail.slots.get('h1.logoanimation.white.subtitle#0')?.header, 'Name');
  assert.equal(detail.slots.get('div.thin._2#0')?.header, 'Datum');
  assert.equal(detail.slots.get('div.thin._2#2')?.header, 'masse');
  assert.equal(detail.slots.get('div.thin._2#3')?.header, 'technik');

  const rows = merge.plans[0].csv.rows;
  assert.equal(rows.length, 4, 'the live-only item was added');
  assert.equal(plans[0].csv.rows.length, 3, 'the input plans are untouched');
  assert.equal(rows.find((r) => r['Slug'] === 'leer')?.['masse'], '', 'the live slot is empty too (w-dyn-bind-empty): nothing to fill');
  const added = rows.find((r) => r['Slug'] === 'nur-auf-der-website')!;
  assert.equal(added['Name'], 'Nur auf der Website');
  assert.equal(added['masse'], '50x50 cm');
  assert.equal(added['technik'], 'Tusche');
  assert.equal(added['Werk'], `${ORIGIN}/cdn/${LIVE_ONLY.file}`);
  assert.equal(added['Datum'], '2025', 'new rows take every mapped slot, dates included');
  assert.ok(added['Published On'], 'live items are published');
  assert.equal(merge.stats.itemsAdded, 1);
  assert.equal(warn.count('cms_site_item_added'), 1);
  assert.equal(merge.alternateUrls.get(`${CDN}/${AFFINITAT.file}`), `${ORIGIN}/cdn/${AFFINITAT.file}`, 'the CDN URL keeps precedence, the live URL is the fallback');
  assert.equal(merge.alternateUrls.get(`${CDN}/${BRANDMALE.file}`), `${ORIGIN}/cdn/${BRANDMALE.file}`);
  assert.equal(merge.siteOnly, false);
});

test('mergeSitePlans: a live-only item takes its cells from every list that shows it, also one that never links it (catalog Order)', () => {
  const catalogTemplate = `<div class="collection-list-wrapper-3 w-dyn-list"><div role="list" class="w-dyn-items"><div role="listitem" class="w-dyn-item">
    <div class="catalog-name w-dyn-bind-empty"></div><div class="div-block-13"><div>Order: </div><div class="text-block-4 w-dyn-bind-empty"></div></div>
  </div></div></div>`;
  const orders: [Werk, string][] = [[AFFINITAT, '67'], [BRANDMALE, '3'], [LEER, '5'], [LIVE_ONLY, '999']];
  const liveCatalog = parseSitePage(`<html><body><div class="collection-list-wrapper-3 w-dyn-list"><div role="list" class="w-dyn-items">${orders
    .map(([w, o]) => `<div role="listitem" class="w-dyn-item"><div class="catalog-name">${w.name}</div><div class="div-block-13"><div>Order: </div><div class="text-block-4">${o}</div></div></div>`)
    .join('')}</div></div></body></html>`, `${ORIGIN}/catalog`);
  const pages = [exportPage('work', WERKE_TEMPLATE), exportPage('catalog', catalogTemplate), exportPage('detail_werke', DETAIL_TEMPLATE)];
  const site = crawlOf(
    [liveWorkPage([AFFINITAT, BRANDMALE, LEER, LIVE_ONLY]), liveCatalog],
    { werke: [liveDetailPage(AFFINITAT, [BRANDMALE]), liveDetailPage(LIVE_ONLY, [AFFINITAT])] },
  );
  const merge = mergeSitePlans({ plans: werkePlans(), site, pages, detailPages: new Map([['detail_werke', { folder: 'werke', planIndex: 0 }]]), warn: new Warnings() });
  const catalog = merge.mappings.get('catalog#list0')!;
  assert.equal(catalog.slots.get('div.text-block-4#0')?.header, 'Order');
  const added = merge.plans[0].csv.rows.find((r) => r['Slug'] === 'nur-auf-der-website')!;
  assert.equal(added['Order'], '999', 'the catalog list names it only by its Name slot');
  assert.equal(added['masse'], '50x50 cm', 'cells from the linking list stay');
  assert.equal(merge.stats.itemsAdded, 1, 'the catalog item is the same live-only item, not a second one');
});

test('finaliseMerge: constant live counts below the collection size become a limit; the date slots decide the site time zone', () => {
  const { merge } = scenario();
  const work = merge.mappings.get('work#list0')!;
  assert.deepEqual(work.liveCounts, [4]);
  assert.equal(work.limit, undefined, '/work shows every item (3 CSV rows + the live-only one)');
  assert.equal(work.filter, undefined);
  const more = merge.mappings.get('detail_werke#list0')!;
  assert.deepEqual(more.liveCounts, [1, 1], 'one entry per crawled collection page');
  assert.equal(more.limit, 1, '"Weitere Werke" shows one of four on every page');
  assert.equal(more.shownSlugs, undefined, 'pooled lists have no single shown set');
  assert.equal(merge.mappings.get('detail_werke#page')?.limit, undefined, 'a collection page is no list');
  assert.equal(merge.timeZone, 'Europe/Berlin', 'the years on the live site are the Central European ones');
  assert.match(merge.timeZoneReason ?? '', /date slot/);
  assert.equal(decideTimeZone({ ...merge, mappings: new Map() }), null, 'no date slot, no zone');
});

test('finaliseMerge: differing counts per page, pagination and full lists give no limit', () => {
  const pages = [exportPage('work', WERKE_TEMPLATE), exportPage('detail_werke', DETAIL_TEMPLATE)];
  const site = crawlOf(
    [liveWorkPage([AFFINITAT, BRANDMALE])],
    { werke: [liveDetailPage(AFFINITAT, [BRANDMALE, LEER]), liveDetailPage(BRANDMALE, [AFFINITAT])] },
  );
  const merge = mergeSitePlans({ plans: werkePlans(), site, pages, detailPages: new Map([['detail_werke', { folder: 'werke', planIndex: 0 }]]), warn: new Warnings() });
  assert.deepEqual(merge.mappings.get('detail_werke#list0')?.liveCounts, [2, 1]);
  assert.equal(merge.mappings.get('detail_werke#list0')?.limit, undefined, 'two pages, two counts: not a limit');
  assert.equal(merge.mappings.get('work#list0')?.limit, 2, '/work shows 2 of 3');

  const paginated = parseSitePage(`<html><body><h1 class="logoanimation">WORKS</h1><div class="collection-list-wrapper w-dyn-list"><div class="collection-list w-dyn-items">${liveCard(AFFINITAT)}${liveCard(BRANDMALE)}</div>
    <div role="navigation" class="w-pagination-wrapper"><a href="?7c3d1e2f_page=2" class="w-pagination-next">Next</a><div class="w-page-count">1 / 2</div></div></div></body></html>`, `${ORIGIN}/work`);
  const paged = mergeSitePlans({ plans: werkePlans(), site: crawlOf([paginated], {}), pages: [pages[0]], detailPages: new Map(), warn: new Warnings() });
  assert.equal(paged.mappings.get('work#list0')?.paginated, true);
  assert.equal(paged.mappings.get('work#list0')?.limit, undefined, 'a page size is no limit');
});

test('listFilterFor: the shown rows are exactly one condition\'s rows', () => {
  const [plan] = werkePlans();
  const rows = plan.csv.rows;
  rows[1]['feature'] = 'true';
  const zone = 'Europe/Berlin';
  const mid2023 = new Date('2023-06-01T12:00:00Z');
  assert.deepEqual(listFilterFor(plan, rows, ['brandmale-der-erde'], zone, mid2023), { header: 'feature', operator: 'is', value: 'true' });
  assert.deepEqual(listFilterFor(plan, rows, ['brandmale-der-erde', 'leer'], zone, mid2023), { header: 'Datum', operator: 'is_after', value: '$today' }, 'both 2024 works are after mid-2023');
  assert.deepEqual(listFilterFor(plan, rows, ['affinitat'], zone, mid2023), { header: 'Datum', operator: 'is_before', value: '$today' });
  assert.equal(listFilterFor(plan, rows, ['affinitat', 'brandmale-der-erde'], zone, mid2023), null, 'no single condition explains this pair');
  assert.equal(listFilterFor(plan, rows, ['affinitat', 'brandmale-der-erde', 'leer'], zone, mid2023), null, 'the whole collection is no filter');
  // Calendar days in the site zone: Jan 1 2024 00:00 Berlin is Dec 31 2023 23:00 UTC, still "after" a Dec 31 2023 "today" in Berlin.
  assert.deepEqual(listFilterFor(plan, rows, ['brandmale-der-erde', 'leer'], zone, new Date('2023-12-31T10:00:00Z')), { header: 'Datum', operator: 'is_after', value: '$today' });
  assert.equal(listFilterFor(plan, rows, ['brandmale-der-erde', 'leer'], 'UTC', new Date('2023-12-31T10:00:00Z')), null, 'in UTC the same instants fall on Dec 31: not after today');
});

test('binding oracle: list limits and proven filters reach the list settings', () => {
  const upcoming = `<div class="collection-list-wrapper-2 w-dyn-list"><div class="w-dyn-items"><h2>Upcoming</h2>${WERKE_TEMPLATE.replace(/collection-list-wrapper w-dyn-list/, 'inner')}</div></div>`;
  const pages = [exportPage('index', upcoming), exportPage('work', WERKE_TEMPLATE), exportPage('detail_werke', DETAIL_TEMPLATE)];
  const liveIndex = parseSitePage(`<html><body><div class="collection-list-wrapper-2 w-dyn-list"><div class="w-dyn-items"><h2>Upcoming</h2><div class="inner"><div class="collection-list w-dyn-items">${liveCard(BRANDMALE)}${liveCard(LEER)}</div></div></div></div></body></html>`, `${ORIGIN}/`);
  const site = crawlOf([liveIndex, liveWorkPage([AFFINITAT, BRANDMALE, LEER])], { werke: [liveDetailPage(AFFINITAT, [BRANDMALE]), liveDetailPage(BRANDMALE, [LEER])] });
  const plans = werkePlans();
  const merge = mergeSitePlans({ plans, site, pages, detailPages: new Map([['detail_werke', { folder: 'werke', planIndex: 0 }]]), warn: new Warnings(), now: new Date('2023-06-01T12:00:00Z') });
  assert.deepEqual(merge.mappings.get('index#list0')?.filter, { header: 'Datum', operator: 'is_after', value: '$today' });
  assert.equal(merge.mappings.get('index#list0')?.limit, undefined, 'a proven filter needs no limit');
  assert.equal(merge.mappings.get('detail_werke#list0')?.limit, 1);

  const cms = cmsOf(merge.plans);
  const warn = new Warnings();
  const oracle = createSiteOracle(merge, cms, pages);
  bindPages({ cms, pages, dynamicPageByCollection: new Map([[cms.collections[0].id, { pageId: 'p', folderId: 'f', slug: 'werke' }]]), warn, oracle });
  const datum = cms.collections[0].fields.find((f) => f.name === 'Datum')!;
  const indexItem = nodesOf(pages[0], (n) => n.wf.role === 'dyn-item')[0];
  assert.deepEqual(indexItem.wf.collection?.filters, [{ fieldId: datum.id, fieldType: 'date', operator: 'is_after', value: '$today' }]);
  assert.equal(indexItem.wf.collection?.limit, undefined);
  assert.deepEqual([indexItem.wf.collection?.sortBy, indexItem.wf.collection?.sortOrder], [cms.collections[0].fields.find((f) => f.name === 'Order')?.id, 'asc'], 'an explicit order field keeps the sort');
  const detailItem = nodesOf(pages[2], (n) => n.wf.role === 'dyn-item')[0];
  assert.equal(detailItem.wf.collection?.limit, 1, '"Weitere Werke" is limited like the live site');
  assert.equal(detailItem.wf.collection?.sortBy, cms.collections[0].fields.find((f) => f.name === 'Order')?.id, 'the sort still comes from the heuristics');
  const workItem = nodesOf(pages[1], (n) => n.wf.role === 'dyn-item')[0];
  assert.equal(workItem.wf.collection?.limit, undefined, '/work shows the whole collection');
  const notes = warn.list.filter((w) => w.code === 'collection_guess').map((w) => w.message);
  assert.ok(notes.some((m) => /detail_werke: limit 1 \(live site: each of 2 pages shows 1 of 3 Werke items\)/.test(m)), notes.join('\n'));
  assert.ok(notes.some((m) => /index: filter Datum is_after \$today \(live site: the 2 item\(s\) shown of 3 are exactly the ones with Datum after today\)/.test(m)), notes.join('\n'));
  // Neither collection page lists its own work, and Brandmale (a crawled page) shows up on Affinität's.
  assert.equal(detailItem.wf.collection?.excludeCurrentItem, true, '"Weitere Werke" leaves the current work out');
  assert.equal(workItem.wf.collection?.excludeCurrentItem, undefined, 'a list on a static page never does');
  assert.ok(notes.some((m) => /detail_werke: leaves out the current Werke item \(live site: none of 2 collection pages lists its own item\)/.test(m)), notes.join('\n'));
});

test('currentItemEvidence: own item left out, shown, the items that follow it, or too little to tell', () => {
  const pages = (entries: [string, (string | null)[]][]) => new Map(entries);
  // A ring of five works, each page showing the next two: excluded, and "follows".
  const ring = ['a', 'b', 'c', 'd', 'e'];
  const next = (i: number, n: number) => Array.from({ length: n }, (_, k) => ring[(i + k + 1) % ring.length]);
  assert.deepEqual(currentItemEvidence(pages(ring.map((s, i) => [s, next(i, 2)]))), { mode: 'excluded', follows: true });
  // The first two other works everywhere: excluded, not "follows" (page b would have to start with d).
  assert.deepEqual(currentItemEvidence(pages([['a', ['b', 'c']], ['b', ['a', 'c']], ['c', ['a', 'b']]])), { mode: 'excluded' });
  // One page lists itself.
  assert.deepEqual(currentItemEvidence(pages([['a', ['a', 'b']], ['b', ['c', 'd']]])), { mode: 'shown' });
  // No listed item has a crawled page: leaving the own item out cannot be told apart from never listing it.
  assert.equal(currentItemEvidence(pages([['a', ['x', 'y']], ['b', ['x', 'y']]])), undefined);
  // An item without a link into the folder, or a single crawled page.
  assert.equal(currentItemEvidence(pages([['a', ['b', null]], ['b', ['a', 'c']]])), undefined);
  assert.equal(currentItemEvidence(pages([['a', ['b', 'c']]])), undefined);
});

test('binding oracle: collection pages that list their own item keep it (no self filter, no warning about it)', () => {
  const pages = [exportPage('work', WERKE_TEMPLATE), exportPage('detail_werke', DETAIL_TEMPLATE)];
  const site = crawlOf([liveWorkPage([AFFINITAT, BRANDMALE, LEER])], { werke: [liveDetailPage(AFFINITAT, [AFFINITAT]), liveDetailPage(BRANDMALE, [AFFINITAT])] });
  const merge = mergeSitePlans({ plans: werkePlans(), site, pages, detailPages: new Map([['detail_werke', { folder: 'werke', planIndex: 0 }]]), warn: new Warnings(), now: new Date('2023-06-01T12:00:00Z') });
  assert.deepEqual(merge.mappings.get('detail_werke#list0')?.currentItem, { mode: 'shown' });
  const cms = cmsOf(merge.plans);
  const warn = new Warnings();
  bindPages({ cms, pages, dynamicPageByCollection: new Map([[cms.collections[0].id, { pageId: 'p', folderId: 'f', slug: 'werke' }]]), warn, oracle: createSiteOracle(merge, cms, pages) });
  const detailItem = nodesOf(pages[1], (n) => n.wf.role === 'dyn-item')[0];
  assert.equal(detailItem.wf.collection?.excludeCurrentItem, undefined);
  assert.equal(detailItem.wf.collection?.limit, 1);
  assert.equal(warn.list.filter((w) => /current item|own collection/.test(w.message)).length, 0, warn.list.map((w) => w.message).join('\n'));
});

test('two lists that split one collection in one sort: the second skips the first one\'s rows (offset), both share the sort', () => {
  const second = WERKE_TEMPLATE.replace('collection-list-wrapper w-dyn-list', 'collection-list-wrapper-2 w-dyn-list');
  const pages = [exportPage('exhibitions', `<h2>Upcoming</h2>${WERKE_TEMPLATE}<h2>Archive</h2>${second}`), exportPage('detail_werke', DETAIL_TEMPLATE)];
  const list = (cls: string, items: Werk[]) => `<div class="${cls} w-dyn-list"><div role="list" class="collection-list w-dyn-items">${items.map((w) => liveCard(w)).join('')}</div></div>`;
  // Order: Brandmale 3, Leer 5, Affinität 67. The years tie (2024, 2024), so only Order splits the lists strictly.
  const live = parseSitePage(`<html><body><h1 class="logoanimation">WORKS</h1><h2>Upcoming</h2>${list('collection-list-wrapper', [BRANDMALE])}<h2>Archive</h2>${list('collection-list-wrapper-2', [LEER, AFFINITAT])}</body></html>`, `${ORIGIN}/exhibitions`);
  const site = crawlOf([live], { werke: [liveDetailPage(AFFINITAT, [BRANDMALE]), liveDetailPage(BRANDMALE, [LEER])] });
  const merge = mergeSitePlans({ plans: werkePlans(), site, pages, detailPages: new Map([['detail_werke', { folder: 'werke', planIndex: 0 }]]), warn: new Warnings(), now: new Date('2025-06-01T12:00:00Z') });
  const upcoming = merge.mappings.get('exhibitions#list0')!;
  const archive = merge.mappings.get('exhibitions#list1')!;
  assert.equal(upcoming.limit, 1);
  assert.deepEqual(upcoming.sort, { header: 'Order', order: 'asc' });
  assert.equal(archive.offset, 1);
  assert.equal(archive.limit, undefined, 'the rest of the collection, not the first two');
  assert.deepEqual(archive.sort, { header: 'Order', order: 'asc' });

  const cms = cmsOf(merge.plans);
  const warn = new Warnings();
  bindPages({ cms, pages, dynamicPageByCollection: new Map([[cms.collections[0].id, { pageId: 'p', folderId: 'f', slug: 'werke' }]]), warn, oracle: createSiteOracle(merge, cms, pages) });
  const order = cms.collections[0].fields.find((f) => f.name === 'Order')!;
  const [a, b] = nodesOf(pages[0], (n) => n.wf.role === 'dyn-item');
  assert.deepEqual([a.wf.collection?.limit, a.wf.collection?.offset, a.wf.collection?.sortBy, a.wf.collection?.sortOrder], [1, undefined, order.id, 'asc']);
  assert.deepEqual([b.wf.collection?.limit, b.wf.collection?.offset, b.wf.collection?.sortBy, b.wf.collection?.sortOrder], [undefined, 1, order.id, 'asc']);
  assert.ok(warn.list.some((w) => /exhibitions: offset 1 \(live site: shows the 2 Werke item\(s\) an earlier list of the page leaves out, sorted by Order asc\)/.test(w.message)), warn.list.map((w) => w.message).join('\n'));

  // Overlapping lists (the newest item in both) or lists that leave rows out are no split.
  const overlap = parseSitePage(`<html><body><h1 class="logoanimation">WORKS</h1><h2>Upcoming</h2>${list('collection-list-wrapper', [BRANDMALE])}<h2>Archive</h2>${list('collection-list-wrapper-2', [BRANDMALE, LEER])}</body></html>`, `${ORIGIN}/exhibitions`);
  const merge2 = mergeSitePlans({ plans: werkePlans(), site: crawlOf([overlap], {}), pages, detailPages: new Map(), warn: new Warnings(), now: new Date('2025-06-01T12:00:00Z') });
  assert.equal(merge2.mappings.get('exhibitions#list1')?.offset, undefined);
  assert.equal(merge2.mappings.get('exhibitions#list1')?.limit, 2);
});

test('binding oracle: a limit with a known shown set clears a heuristic filter the live page contradicts', () => {
  const pages = [exportPage('index', `<div class="feature">${WERKE_TEMPLATE}</div>`)];
  const liveIndex = parseSitePage(`<html><body><div class="feature"><div class="collection-list-wrapper w-dyn-list"><div class="collection-list w-dyn-items">${liveCard(AFFINITAT)}${liveCard(LEER)}</div></div></div></body></html>`, `${ORIGIN}/`);
  const plans = werkePlans();
  plans[0].csv.rows[1]['feature'] = 'true';
  const item = nodesOf(pages[0], (n) => n.wf.role === 'dyn-item')[0];
  // Heuristics alone: the `feature` wrapper means "filter on the feature switch, one item".
  const alone = exportPage('index', `<div class="feature">${WERKE_TEMPLATE}</div>`);
  bindPages({ cms: cmsOf(plans), pages: [alone], dynamicPageByCollection: new Map(), warn: new Warnings() });
  const aloneItem = nodesOf(alone, (n) => n.wf.role === 'dyn-item')[0];
  assert.equal(aloneItem.wf.collection?.filters?.length, 1);
  assert.equal(aloneItem.wf.collection?.limit, 1);
  const merge = mergeSitePlans({ plans, site: crawlOf([liveIndex], {}), pages, detailPages: new Map([['detail_werke', { folder: 'werke', planIndex: 0 }]]), warn: new Warnings() });
  assert.equal(merge.mappings.get('index#list0')?.limit, 2);
  assert.deepEqual(merge.mappings.get('index#list0')?.shownSlugs, ['affinitat', 'leer']);
  const cms = cmsOf(merge.plans);
  const warn = new Warnings();
  bindPages({ cms, pages, dynamicPageByCollection: new Map(), warn, oracle: createSiteOracle(merge, cms, pages) });
  assert.equal(item.wf.collection?.limit, 2, 'the live count replaces the heuristic limit 1');
  assert.equal(item.wf.collection?.filters, undefined, 'the shown items are not the feature ones: no filter');
  assert.ok(warn.list.some((w) => w.code === 'collection_guess' && /limit 2 \(live site: shows 2 of 3 Werke items, no field selects exactly those\)/.test(w.message)));
});

test('binding oracle: a date filter sorts by its field when no order field exists', () => {
  const pages = [exportPage('index', WERKE_TEMPLATE)];
  const liveIndex = parseSitePage(`<html><body><div class="collection-list-wrapper w-dyn-list"><div class="collection-list w-dyn-items">${liveCard(AFFINITAT)}</div></div></body></html>`, `${ORIGIN}/`);
  const content = ['Name,Slug,Published On,Datum', ...[AFFINITAT, BRANDMALE, LEER].map((w) => `${w.name},${w.slug},Mon Feb 09 2026 15:07:10 GMT+0000,${w.year === '2023' ? 'Sat Dec 31 2022 23:00:00 GMT+0000' : 'Sun Dec 31 2023 23:00:00 GMT+0000'}`)].join('\n');
  const plans = inferSchema(parseCsvFiles([{ filename: 'x - Werke - 696e3e261a55566a62dc5508.csv', content }]));
  const merge = mergeSitePlans({ plans, site: crawlOf([liveIndex], {}), pages, detailPages: new Map([['detail_werke', { folder: 'werke', planIndex: 0 }]]), warn: new Warnings(), now: new Date('2023-06-01T12:00:00Z') });
  assert.deepEqual(merge.mappings.get('index#list0')?.filter, { header: 'Datum', operator: 'is_before', value: '$today' });
  const cms = cmsOf(merge.plans);
  bindPages({ cms, pages, dynamicPageByCollection: new Map(), warn: new Warnings(), oracle: createSiteOracle(merge, cms, pages) });
  const item = nodesOf(pages[0], (n) => n.wf.role === 'dyn-item')[0];
  const datum = cms.collections[0].fields.find((f) => f.name === 'Datum')!;
  assert.deepEqual(item.wf.collection?.filters, [{ fieldId: datum.id, fieldType: 'date', operator: 'is_before', value: '$today' }]);
  assert.deepEqual([item.wf.collection?.sortBy, item.wf.collection?.sortOrder], [datum.id, 'desc'], 'past items: newest first');
});

test('inferTimeZoneFromDates: Webflow year-only cells name the zone, plain dates do not', () => {
  assert.deepEqual(inferTimeZoneFromDates(werkePlans())?.zone, 'Europe/Berlin');
  const content = [CSV_HEADERS, csvRow(AFFINITAT, { datum: 'Sun Jan 01 2023 00:00:00 GMT+0000', order: '1' }), csvRow(BRANDMALE, { datum: 'Wed Mar 15 2023 10:00:00 GMT+0000', order: '2' })].join('\n');
  assert.equal(inferTimeZoneFromDates(inferSchema(parseCsvFiles([{ filename: 'x - Werke - 696e3e261a55566a62dc5508.csv', content }]))), null);
  const eet = [CSV_HEADERS, csvRow(AFFINITAT, { datum: 'Sat Dec 31 2022 22:00:00 GMT+0000', order: '1' })].join('\n');
  assert.equal(inferTimeZoneFromDates(inferSchema(parseCsvFiles([{ filename: 'x - Werke - 696e3e261a55566a62dc5508.csv', content: eet }])))?.zone, 'Europe/Helsinki');
});

test('mergeSitePlans: an empty CSV cell is filled from the live value', () => {
  const pages = [exportPage('work', WERKE_TEMPLATE)];
  const live = parseSitePage(`<html><body><h1 class="logoanimation">WORKS</h1><div class="collection-list-wrapper w-dyn-list"><div class="collection-list w-dyn-items">${liveCard(AFFINITAT)}${liveCard(LEER)}</div></div></body></html>`, `${ORIGIN}/work`);
  const warn = new Warnings();
  const merge = mergeSitePlans({ plans: werkePlans(), site: crawlOf([live], {}), pages, detailPages: new Map([['detail_werke', { folder: 'werke', planIndex: 0 }]]), warn });
  assert.equal(merge.plans[0].csv.rows.find((r) => r['Slug'] === 'leer')?.['masse'], '90x90 cm');
  assert.equal(merge.stats.valuesFilled, 1);
  assert.equal(warn.count('cms_site_value_filled'), 1);
});

test('mergeSitePlans: unreachable site changes nothing', () => {
  const pages = [exportPage('work', WERKE_TEMPLATE)];
  const site = crawlOf([], {});
  site.reachable = false;
  const merge = mergeSitePlans({ plans: werkePlans(), site, pages, detailPages: new Map(), warn: new Warnings() });
  assert.equal(merge.mappings.size, 0);
  assert.equal(merge.plans[0].csv.rows.length, 3);
});

test('mergeSitePlans: no CSV and no API -> collections are built from the live site', () => {
  const pages = [exportPage('work', WERKE_TEMPLATE), exportPage('detail_werke', DETAIL_TEMPLATE)];
  const site = crawlOf([liveWorkPage([AFFINITAT, BRANDMALE])], { werke: [liveDetailPage(AFFINITAT, [BRANDMALE]), liveDetailPage(BRANDMALE, [AFFINITAT])] });
  const warn = new Warnings();
  const merge = mergeSitePlans({ plans: [], site, pages, detailPages: new Map([['detail_werke', { folder: 'werke', planIndex: -1 }]]), warn });
  assert.equal(merge.siteOnly, true);
  assert.equal(merge.stats.collectionsBuilt, 1);
  assert.equal(warn.count('cms_site_only'), 1);
  const [plan] = merge.plans;
  assert.equal(plan.csv.name, 'Werke');
  assert.equal(plan.csv.rows.length, 2);
  const row = plan.csv.rows.find((r) => r['Slug'] === 'affinitat')!;
  assert.equal(row['Name'], 'Affinität');
  assert.equal(row['Image'], `${ORIGIN}/cdn/${AFFINITAT.file}`);
  const headers = plan.fields.map((f) => f.header);
  assert.ok(headers.includes('Image') && headers.includes('Thin') && headers.includes('Thin 2'), headers.join(','));
  assert.equal(plan.fields.find((f) => f.header === 'Image')?.type, 'image');
  // The card's name slot and the detail page's heading show the same values -> one field, not two.
  const list = merge.mappings.get('work#list0')!;
  const detail = merge.mappings.get('detail_werke#page')!;
  assert.equal(list.slots.get('div.#0')?.header, detail.slots.get('h1.logoanimation.white.subtitle#0')?.header);
  assert.equal(list.slots.get('div.thin#1')?.header, detail.slots.get('div.thin._2#2')?.header);
});

// ─── Binding oracle ───────────────────────────────────────────────────────────

test('binding oracle: slots with live values bind deterministically and emit no binding_guess', () => {
  // Before: structural heuristics only.
  const before = (() => {
    const pages = [exportPage('work', WERKE_TEMPLATE), exportPage('detail_werke', DETAIL_TEMPLATE)];
    const cms = cmsOf(werkePlans());
    const warn = new Warnings();
    bindPages({ cms, pages, dynamicPageByCollection: new Map([[cms.collections[0].id, { pageId: 'p', folderId: 'f', slug: 'werke' }]]), warn });
    return { pages, warn };
  })();
  const guessesBefore = before.warn.count('binding_guess');
  assert.ok(guessesBefore >= 8, `heuristics guess every slot (${guessesBefore})`);

  // After: the live site decides.
  const { pages, merge } = scenario();
  const cms = cmsOf(merge.plans);
  const warn = new Warnings();
  const oracle = createSiteOracle(merge, cms, pages);
  bindPages({ cms, pages, dynamicPageByCollection: new Map([[cms.collections[0].id, { pageId: 'p', folderId: 'f', slug: 'werke' }]]), warn, oracle });
  const guessesAfter = warn.count('binding_guess');

  const work = pages[0];
  const thin = nodesOf(work, (n) => n.wf.siteClasses.includes('thin') && n.wf.bindEmpty);
  assert.equal(thin.length, 3);
  assert.deepEqual(thin.map((n) => [n.wf.binding?.fieldName, n.wf.binding?.confidence, n.wf.binding?.format]), [['Datum', 1, 'part-year'], ['masse', 1, undefined], ['technik', 1, undefined]]);
  const bg = nodesOf(work, (n) => !!n.wf.boundBackground)[0];
  assert.deepEqual([bg.wf.binding?.kind, bg.wf.binding?.fieldName, bg.wf.binding?.confidence], ['background', 'Werk', 1]);
  const name = nodesOf(work, (n) => n.wf.bindEmpty && n.wf.siteClasses.length === 0 && n.kind === 'text')[0];
  assert.deepEqual([name.wf.binding?.fieldName, name.wf.binding?.confidence], ['Name', 1]);
  const item = nodesOf(work, (n) => n.wf.role === 'dyn-item')[0];
  assert.equal(item.wf.collection?.confidence, 1, 'the list collection comes from the live items');
  assert.match(item.wf.collection?.reason ?? '', /live site/);
  assert.equal(item.wf.collection?.sortBy, cms.collections[0].fields.find((f) => f.name === 'Order')?.id, 'list settings still come from the heuristics');

  const detail = pages[1];
  const img = nodesOf(detail, (n) => n.kind === 'image' && n.wf.bindEmpty)[0];
  assert.deepEqual([img.wf.binding?.kind, img.wf.binding?.fieldName, img.wf.binding?.source, img.wf.binding?.confidence], ['image', 'Werk', 'page', 1]);
  const h1 = nodesOf(detail, (n) => n.kind === 'heading' && n.wf.bindEmpty)[0];
  assert.deepEqual([h1.wf.binding?.fieldName, h1.wf.binding?.confidence], ['Name', 1]);
  const detailThin = nodesOf(detail, (n) => n.wf.siteClasses.includes('_2') && n.wf.bindEmpty);
  assert.deepEqual(detailThin.map((n) => n.wf.binding?.fieldName), ['Datum', 'masse', 'technik']);
  // The "Weitere Werke" list on the detail page is a second list of the same template: bound by the oracle too.
  const detailItem = nodesOf(detail, (n) => n.wf.role === 'dyn-item')[0];
  const detailCard = nodesOf(detail, (n) => n.wf.siteClasses.includes('thin') && !n.wf.siteClasses.includes('_2') && n.wf.bindEmpty);
  assert.equal(detailItem.wf.collection?.collectionId, cms.collections[0].id);
  assert.deepEqual(detailCard.map((n) => n.wf.binding?.confidence), [1, 1, 1]);

  const oracleBound = [...pages.flatMap((p) => [...p.nodeIndex.values()])].filter((n) => n.wf.binding?.confidence === 1 && !n.wf.binding.link).length;
  assert.equal(oracle.hits, oracleBound);
  assert.equal(oracle.hits, 15, '5 card slots on /work, 5 page slots and 5 card slots on the collection page');
  assert.equal(guessesAfter, guessesBefore - oracleBound + 0, 'every oracle hit removes one guess');
  assert.equal(warn.list.filter((w) => w.code === 'binding_guess' && /thin|div-block|Werk|Name/.test(w.message) && w.page === 'work').length, 0, 'no structural guess is left on /work (the item link href="#" is deterministic and reports none)');
});

test('site-only: a list whose items carry no link is keyed by the item names, gets fields, and binds to its own collection', () => {
  // Export: the index shows exhibitions (no link to the collection page) and a
  // "quotes" list that belongs to no folder; the exhibitions page of the export
  // is an empty shell (Webflow reality). Live: names come from the collection
  // page titles, the index shows the items with values.
  const EXHIBITIONS_LIST = `
    <div class="collection-list-wrapper-2 w-dyn-list"><div role="list" class="collection-list-2 w-dyn-items">
      <div class="collection-item-2 w-dyn-item">
        <div class="text-block w-dyn-bind-empty"></div>
        <div class="div-block-9"><div class="w-dyn-bind-empty"></div></div>
        <div class="text-block-2 w-dyn-bind-empty"></div>
        <p class="w-dyn-bind-empty"></p>
      </div>
    </div></div>`;
  const QUOTES_LIST = `
    <div class="quotes w-dyn-list"><div role="list" class="w-dyn-items">
      <div class="quote w-dyn-item"><h3 class="w-dyn-bind-empty"></h3><p class="w-dyn-bind-empty"></p></div>
    </div></div>`;
  const EMPTY_LIST = `
    <div class="upcoming w-dyn-list"><div role="list" class="w-dyn-items">
      <div class="upcoming-item w-dyn-item"><div class="text-block w-dyn-bind-empty"></div></div>
    </div><div class="w-dyn-empty"><div>No items found.</div></div></div>`;
  const pages = [
    exportPage('index', `<h1>Home</h1>${EMPTY_LIST}${WERKE_TEMPLATE}${EXHIBITIONS_LIST}${QUOTES_LIST}`),
    exportPage('detail_werke', DETAIL_TEMPLATE),
    exportPage('detail_exhibitions', ''),
  ];
  const exhibition = (name: string, year: string, location: string, description: string) => `
    <div class="collection-item-2 w-dyn-item">
      <div class="text-block">${name}</div>
      <div class="div-block-9"><div>${year}</div></div>
      <div class="text-block-2">${location}</div>
      <p>${description}</p>
    </div>`;
  const quote = (title: string, text: string) => `<div class="quote w-dyn-item"><h3>${title}</h3><p>${text}</p></div>`;
  const liveIndex = parseSitePage(
    `<html><head><title>Home</title></head><body><h1>Home</h1>
      <div class="upcoming w-dyn-list"><div class="w-dyn-empty"><div>No items found.</div></div></div>
      <div class="collection-list-wrapper w-dyn-list"><div role="list" class="collection-list w-dyn-items">${liveCard(AFFINITAT)}${liveCard(BRANDMALE)}</div></div>
      <div class="collection-list-wrapper-2 w-dyn-list"><div role="list" class="collection-list-2 w-dyn-items">
        ${exhibition('Art Cologne', '2024', 'Köln', 'Messe')}${exhibition('KunstSalon Köln', '2026', 'Köln', 'Salon')}
      </div></div>
      <div class="quotes w-dyn-list"><div role="list" class="w-dyn-items">${quote('Über die Farbe', 'Farbe ist Klang.')}${quote('Über das Licht', 'Licht ist Form.')}</div></div>
    </body></html>`,
    `${ORIGIN}/`,
  );
  const liveExhibition = (slug: string, name: string) => parseSitePage(`<html><head><title>${name} | Valeska von Brase</title></head><body></body></html>`, `${ORIGIN}/exhibitions/${slug}`);
  const site = crawlOf([liveIndex], {
    werke: [liveDetailPage(AFFINITAT, [BRANDMALE]), liveDetailPage(BRANDMALE, [AFFINITAT])],
    exhibitions: [liveExhibition('art-cologne', 'Art Cologne'), liveExhibition('kunstsalon-koln', 'KunstSalon Köln'), liveExhibition('lucca', 'Lucca Art Fair')],
  });
  const warn = new Warnings();
  const detailPages = new Map([
    ['detail_werke', { folder: 'werke', planIndex: -1 }],
    ['detail_exhibitions', { folder: 'exhibitions', planIndex: -1 }],
  ]);
  const merge = mergeSitePlans({ plans: [], site, pages, detailPages, warn });
  assert.equal(merge.siteOnly, true);
  assert.deepEqual(merge.plans.map((p) => p.csv.name), ['Werke', 'Exhibitions', 'Quotes']);
  assert.equal(merge.stats.collectionsBuilt, 3);
  assert.equal(warn.count('cms_site_only'), 3);

  // Exhibitions: items from the collection pages (3), fields from the index list (matched by name).
  const exhibitions = merge.plans[1];
  assert.equal(exhibitions.csv.rows.length, 3);
  const custom = exhibitions.fields.filter((f) => !f.system).map((f) => f.header);
  assert.deepEqual(custom, ['Field 1', 'Text Block', 'Field 3'], 'year, location, description — the name slot is the built-in Name, not a duplicate field');
  const cologne = exhibitions.csv.rows.find((r) => r['Slug'] === 'art-cologne')!;
  assert.equal(cologne['Name'], 'Art Cologne');
  assert.equal(cologne['Field 1'], '2024');
  assert.equal(cologne['Text Block'], 'Köln');
  assert.equal(cologne['Field 3'], 'Messe');
  assert.equal(exhibitions.csv.rows.find((r) => r['Slug'] === 'lucca')!['Name'], 'Lucca Art Fair', 'a collection page without a list appearance still is an item');
  const mapping = merge.mappings.get('index#list2')!;
  assert.equal(mapping.planIndex, 1);
  assert.equal(mapping.identified, 2);
  assert.equal(mapping.slots.get('div.text-block#0')?.header, 'Name');
  assert.equal(mapping.slots.get('div.text-block-2#0')?.header, 'Text Block');

  // Quotes: no folder, no link, no known name -> a collection of its own keyed by the heading slot.
  const quotes = merge.plans[2];
  assert.deepEqual(quotes.csv.rows.map((r) => [r['Slug'], r['Name'], r['Field 1']]), [['uber-die-farbe', 'Über die Farbe', 'Farbe ist Klang.'], ['uber-das-licht', 'Über das Licht', 'Licht ist Form.']]);
  assert.equal(merge.mappings.get('index#list3')?.planIndex, 2);

  // The empty live list is known and vetoes the largest-collection fallback.
  assert.equal(merge.unresolvedLists.get('index#list0'), 'the live site shows this list without items');

  // Binding: Exhibitions list -> Exhibitions (not Werke, the largest), Quotes -> Quotes, empty list unbound.
  const cms = cmsOf(merge.plans);
  const bindWarn = new Warnings();
  const oracle = createSiteOracle(merge, cms, pages);
  bindPages({ cms, pages, dynamicPageByCollection: new Map(), warn: bindWarn, oracle });
  const items = nodesOf(pages[0], (n) => n.wf.role === 'dyn-item');
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((n) => n.wf.collection?.collectionId), [undefined, cms.collections[0].id, cms.collections[1].id, cms.collections[2].id], JSON.stringify(bindWarn.list.filter((w) => w.code === 'collection_guess').map((w) => w.message)));
  const nameSlot = nodesOf(pages[0], (n) => n.wf.siteClasses[0] === 'text-block' && n.wf.bindEmpty)[1];
  assert.equal(nameSlot.wf.binding?.fieldName, 'Name');
  assert.equal(nameSlot.wf.binding?.confidence, 1);
  const veto = bindWarn.list.find((w) => w.code === 'collection_guess' && /left unbound/.test(w.message));
  assert.ok(veto && /div\.upcoming/.test(veto.message), veto?.message);
  assert.ok(!bindWarn.list.some((w) => w.code === 'collection_guess' && /^bound list .*fallback: largest/.test(w.message)), 'no list fell back to the largest collection');
});

// ─── Rows sharing a Name ──────────────────────────────────────────────────────

const EXHIBITIONS_TEMPLATE = `
  <div class="collection-list-wrapper-2 w-dyn-list"><div role="list" class="collection-list-2 w-dyn-items">
    <div class="collection-item-2 w-dyn-item">
      <div class="text-block w-dyn-bind-empty"></div>
      <div class="div-block-9"><div class="w-dyn-bind-empty"></div></div>
      <div class="text-block-2 w-dyn-bind-empty"></div>
      <div class="w-dyn-list"><div class="collection-list-3 w-dyn-items"><div class="w-dyn-item"><img src="https://d3e54v103j8qbb.cloudfront.net/placeholder.svg" class="image-6 w-dyn-bind-empty"></div></div></div>
    </div>
  </div></div>`;

function liveExhibitionItem(name: string, year: string, location: string, files: string[]): string {
  const images = files.map((f) => `<div class="w-dyn-item"><img src="${ORIGIN}/cdn/${f}" class="image-6"></div>`).join('');
  return `<div class="collection-item-2 w-dyn-item">
    <div class="text-block">${name}</div>
    <div class="div-block-9"><div>${year}</div></div>
    <div class="text-block-2">${location}</div>
    <div class="w-dyn-list">${images ? `<div class="collection-list-3 w-dyn-items">${images}</div>` : '<div class="w-dyn-empty"><div>No items found.</div></div>'}</div>
  </div>`;
}

test('mergeSitePlans: rows sharing a Name are told apart by their values, then by exclusion; a draft is no candidate; stray images fall back by identity', () => {
  const pages = [exportPage('exhibitions', EXHIBITIONS_TEMPLATE)];
  const dec31 = (y: number) => `Sun Dec 31 ${y} 23:00:00 GMT+0000 (Coordinated Universal Time)`;
  const img = (n: string) => `${'a'.repeat(24)}_${n}.jpg`;
  const content = [
    'Name,Slug,Draft,Published On,images,datum,location',
    `Orangerie im Englischen Garten,orangerie,false,${dec31(2023)},${CDN}/${img('o1')};${CDN}/${img('o2')},${dec31(2023)},"München, DE"`,
    `Orangerie im Englischen Garten,orangerie-2,false,${dec31(2023)},,${dec31(2023)},"München, DE"`,
    `Art Muc,art-muc,false,${dec31(2015)},,${dec31(2015)},"München, DE"`,
    `Art Muc,art-muc-2,false,${dec31(2014)},,${dec31(2014)},"München, DE"`,
    `Lucca Art Fair,lucca,false,${dec31(2023)},${CDN}/${img('l1')},${dec31(2023)},"Lucca, IT"`,
    `Lucca Art Fair,lucca-draft,true,${dec31(2023)},${CDN}/${img('l2')};${CDN}/${img('l3')},${dec31(2023)},"Lucca, IT"`,
    `Palazzo Fiuggi,palazzo,false,${dec31(2022)},${CDN}/${img('p1')},${dec31(2022)},"Fiuggi, IT"`,
  ].join('\n');
  const plans = inferSchema(parseCsvFiles([{ filename: 'x - Exhibitions - 697275d29b50275b1e811754.csv', content }]));
  // Live (Europe/Berlin: Dec 31 23:00 UTC is the next year): the two Orangerie
  // items differ only in the gallery, the two Art Muc items in the year, the
  // Lucca item has one picture, and one item names nothing the CSV knows.
  const live = parseSitePage(`<html><body><div class="collection-list-wrapper-2 w-dyn-list"><div role="list" class="collection-list-2 w-dyn-items">
    ${liveExhibitionItem('Orangerie im Englischen Garten', '2024', 'München, DE', [])}
    ${liveExhibitionItem('Orangerie im Englischen Garten', '2024', 'München, DE', [img('o1'), img('o2')])}
    ${liveExhibitionItem('Art Muc', '2015', 'München, DE', [])}
    ${liveExhibitionItem('Art Muc', '2016', 'München, DE', [])}
    ${liveExhibitionItem('Lucca Art Fair', '2024', 'Lucca, IT', [img('l1')])}
    ${liveExhibitionItem('Palazzo Fiuggi 2023', '2023', 'Fiuggi, IT', [img('p1')])}
  </div></div></body></html>`, `${ORIGIN}/exhibitions`);
  const warn = new Warnings();
  const merge = mergeSitePlans({ plans, site: crawlOf([live], {}), pages, detailPages: new Map(), warn });
  const mapping = merge.mappings.get('exhibitions#list0')!;
  assert.equal(mapping.identified, 5, 'every item with a known name has its row');
  assert.equal(mapping.shownSlugs, undefined, 'one item stayed unknown: no exact shown set');
  assert.equal(mapping.slots.get('div.text-block#0')?.header, 'Name');
  assert.deepEqual([mapping.slots.get('div.#0')?.header, mapping.slots.get('div.#0')?.format], ['datum', 'part-year']);
  assert.equal(mapping.slots.get('div.text-block-2#0')?.header, 'location');
  assert.deepEqual(mapping.slots.get('div.#0')?.timeZones, ['Europe/Berlin', 'Europe/Helsinki'], 'London is UTC in winter');
  for (const n of ['o1', 'o2', 'l1']) assert.equal(merge.alternateUrls.get(`${CDN}/${img(n)}`), `${ORIGIN}/cdn/${img(n)}`, `${n}: the picture of an identified row is a fallback`);
  assert.equal(merge.alternateUrls.get(`${CDN}/${img('p1')}`), `${ORIGIN}/cdn/${img('p1')}`, 'the picture of an unidentified item falls back by its identity (one row carries it)');
  assert.equal(merge.alternateUrls.has(`${CDN}/${img('l2')}`), false, 'the draft row is not on the live site');
  // Nothing was filled into the wrong row: every cell of every row is still the CSV cell.
  for (const row of merge.plans[0].csv.rows) {
    const original = plans[0].csv.rows.find((r) => r['Slug'] === row['Slug'])!;
    assert.deepEqual(row, original, row['Slug']);
  }
});

test('mergeSitePlans: two rows nothing tells apart both land, in list order, and complete the shown set', () => {
  const pages = [exportPage('exhibitions', EXHIBITIONS_TEMPLATE)];
  const dec31 = (y: number) => `Sun Dec 31 ${y} 23:00:00 GMT+0000 (Coordinated Universal Time)`;
  const content = [
    'Name,Slug,Published On,images,datum,location,feature',
    `Art Muc,art-muc,${dec31(2015)},,${dec31(2015)},"München, DE",true`,
    `Art Muc,art-muc-2,${dec31(2015)},,${dec31(2015)},"München, DE",true`,
    `Red Dot,red-dot,${dec31(2015)},,${dec31(2015)},"Miami, US",false`,
  ].join('\n');
  const plans = inferSchema(parseCsvFiles([{ filename: 'x - Exhibitions - 697275d29b50275b1e811754.csv', content }]));
  const live = parseSitePage(`<html><body><div class="collection-list-wrapper-2 w-dyn-list"><div role="list" class="collection-list-2 w-dyn-items">
    ${liveExhibitionItem('Art Muc', '2016', 'München, DE', [])}
    ${liveExhibitionItem('Art Muc', '2016', 'München, DE', [])}
  </div></div></body></html>`, `${ORIGIN}/exhibitions`);
  const merge = mergeSitePlans({ plans, site: crawlOf([live], {}), pages, detailPages: new Map(), warn: new Warnings() });
  const mapping = merge.mappings.get('exhibitions#list0')!;
  assert.equal(mapping.identified, 2);
  assert.deepEqual(mapping.shownSlugs, ['art-muc', 'art-muc-2']);
  assert.deepEqual(mapping.filter, { header: 'feature', operator: 'is', value: 'true' }, 'the exact shown set proves the filter');
});

test('site-only: two collection pages with the same title both take a list item', () => {
  const pages = [exportPage('index', EXHIBITIONS_TEMPLATE), exportPage('detail_exhibitions', '')];
  const liveIndex = parseSitePage(`<html><head><title>Home</title></head><body><div class="collection-list-wrapper-2 w-dyn-list"><div role="list" class="collection-list-2 w-dyn-items">
    ${liveExhibitionItem('Lucca Art Fair', '2024', 'Lucca, IT', ['bbbbbbbbbbbbbbbbbbbbbbbb_l1.jpg'])}
    ${liveExhibitionItem('Lucca Art Fair', '2023', 'Lucca, IT', [])}
    ${liveExhibitionItem('Art Cologne', '2024', 'Köln, DE', [])}
  </div></div></body></html>`, `${ORIGIN}/`);
  const liveExhibition = (slug: string, name: string) => parseSitePage(`<html><head><title>${name} | Valeska von Brase</title></head><body></body></html>`, `${ORIGIN}/exhibitions/${slug}`);
  const site = crawlOf([liveIndex], { exhibitions: [liveExhibition('lucca-art-fair', 'Lucca Art Fair'), liveExhibition('lucca-art-fair-2', 'Lucca Art Fair'), liveExhibition('art-cologne', 'Art Cologne')] });
  const merge = mergeSitePlans({ plans: [], site, pages, detailPages: new Map([['detail_exhibitions', { folder: 'exhibitions', planIndex: -1 }]]), warn: new Warnings() });
  const [plan] = merge.plans;
  assert.equal(plan.csv.rows.length, 3);
  const years = plan.csv.rows.map((r) => [r['Slug'], r['Name'], r['Field 1']]);
  assert.deepEqual(years, [['lucca-art-fair', 'Lucca Art Fair', '2024'], ['lucca-art-fair-2', 'Lucca Art Fair', '2023'], ['art-cologne', 'Art Cologne', '2024']]);
  const mapping = merge.mappings.get('index#list0')!;
  assert.equal(mapping.identified, 3);
  assert.deepEqual(mapping.shownSlugs, ['lucca-art-fair', 'lucca-art-fair-2', 'art-cologne']);
  assert.deepEqual(merge.seo.get('exhibitions'), { pages: 3, title: { header: 'Name', prefix: '', suffix: ' | Valeska von Brase' } });
});

test('site-only: two rows with the same title and identical live values each take one item of a later list', () => {
  // Review finding (rev-final): an earlier list filled the first row, so in the
  // next list *both* identical items score that row as the unique best and the
  // exclusion rule never runs; the second row keeps only its title.
  const pages = [exportPage('index', EXHIBITIONS_TEMPLATE), exportPage('exhibitions', EXHIBITIONS_TEMPLATE), exportPage('detail_exhibitions', '')];
  const liveIndex = parseSitePage(`<html><head><title>Home</title></head><body><div class="collection-list-wrapper-2 w-dyn-list"><div role="list" class="collection-list-2 w-dyn-items">
    ${liveExhibitionItem('Artbunker Grünwald', '2025', 'Grünwald, DE', [])}
  </div></div></body></html>`, `${ORIGIN}/`);
  const liveExhibitions = parseSitePage(`<html><head><title>Exhibitions</title></head><body><div class="collection-list-wrapper-2 w-dyn-list"><div role="list" class="collection-list-2 w-dyn-items">
    ${liveExhibitionItem('Artbunker Grünwald', '2025', 'Grünwald, DE', [])}
    ${liveExhibitionItem('Artbunker Grünwald', '2025', 'Grünwald, DE', [])}
    ${liveExhibitionItem('Art Cologne', '2017', 'Köln, DE', [])}
  </div></div></body></html>`, `${ORIGIN}/exhibitions`);
  const detail = (slug: string, name: string) => parseSitePage(`<html><head><title>${name} | Valeska von Brase</title></head><body></body></html>`, `${ORIGIN}/exhibitions/${slug}`);
  const site = crawlOf([liveIndex, liveExhibitions], { exhibitions: [detail('artbunker-grunwald', 'Artbunker Grünwald'), detail('artbunker-grunwald-2', 'Artbunker Grünwald'), detail('art-cologne', 'Art Cologne')] });
  const merge = mergeSitePlans({ plans: [], site, pages, detailPages: new Map([['detail_exhibitions', { folder: 'exhibitions', planIndex: -1 }]]), warn: new Warnings() });
  const [plan] = merge.plans;
  const cells = plan.csv.rows.map((r) => [r['Slug'], r['Field 1'], r['Text Block']]);
  assert.deepEqual(cells, [['artbunker-grunwald', '2025', 'Grünwald, DE'], ['artbunker-grunwald-2', '2025', 'Grünwald, DE'], ['art-cologne', '2017', 'Köln, DE']], 'both rows carry the values the live items show');
  const mapping = merge.mappings.get('exhibitions#list0')!;
  assert.deepEqual(mapping.shownSlugs, ['artbunker-grunwald', 'artbunker-grunwald-2', 'art-cologne'], 'a static list shows every row at most once');
});

test('same-name rows with consecutive Webflow years: a list showing one of them takes the row that renders the year in the site zone', () => {
  // Review finding (rev-final): `rowEvidence` matches a year in every zone, so
  // `2016` fits both `Dec 31 2015 23:00 UTC` (2016 in Europe/Berlin) and
  // `Dec 31 2016 23:00 UTC` (2016 in UTC); the tie falls to CSV order, the
  // wrong row is "shown" and the switch filter it would prove is lost.
  const pages = [exportPage('index', EXHIBITIONS_TEMPLATE)];
  const dec31 = (y: number) => `Sun Dec 31 ${y} 23:00:00 GMT+0000 (Coordinated Universal Time)`;
  const content = [
    'Name,Slug,Published On,datum,location,feature',
    `Art Muc,art-muc-2017,${dec31(2016)},${dec31(2016)},"München, DE",false`,
    `Art Muc,art-muc-2016,${dec31(2015)},${dec31(2015)},"München, DE",true`,
  ].join('\n');
  const plans = inferSchema(parseCsvFiles([{ filename: 'x - Exhibitions - 697275d29b50275b1e811754.csv', content }]));
  const live = parseSitePage(`<html><body><div class="collection-list-wrapper-2 w-dyn-list"><div role="list" class="collection-list-2 w-dyn-items">
    ${liveExhibitionItem('Art Muc', '2016', 'München, DE', [])}
  </div></div></body></html>`, `${ORIGIN}/`);
  const merge = mergeSitePlans({ plans, site: crawlOf([live], {}), pages, detailPages: new Map(), warn: new Warnings() });
  const mapping = merge.mappings.get('index#list0')!;
  assert.deepEqual(mapping.shownSlugs, ['art-muc-2016'], 'the only row that renders 2016 on a European site');
  assert.deepEqual(mapping.filter, { header: 'feature', operator: 'is', value: 'true' }, 'the shown row is exactly the feature row');
});

test('assignRows: on a static page a row is taken once — the surest item first, the other falls to its best free row', () => {
  const item = (): SiteItem => ({ values: new Map(), links: [], images: [] });
  const items = [item(), item(), item()];
  const scores = (table: number[][]) => (it: SiteItem, row: string) => table[items.indexOf(it)]['AB'.indexOf(row)];
  // Both items fit A best; the second fits it more (a gallery picture more): it gets A, the first its best free row.
  assert.deepEqual(assignRows(items.slice(0, 2), () => ['A', 'B'], scores([[3, 1], [5, 1]]), true), ['B', 'A']);
  // Equal evidence: list order, then exclusion — never the same row twice (the review finding).
  assert.deepEqual(assignRows(items.slice(0, 2), () => ['A', 'B'], scores([[3, 1], [3, 1]]), true), ['A', 'B']);
  // A tie waits for the decided item; the tie is then settled by exclusion.
  assert.deepEqual(assignRows(items.slice(0, 2), () => ['A', 'B'], scores([[3, 3], [3, 2]]), true), ['B', 'A']);
  // A linked item (one candidate) is certain and takes its row before anything else.
  assert.deepEqual(assignRows(items.slice(0, 2), (_it, i) => (i === 0 ? ['A'] : ['A', 'B']), scores([[0, 0], [3, 1]]), true), ['A', 'B']);
  // A third item nothing is left for stays unknown.
  assert.deepEqual(assignRows(items, () => ['A', 'B'], scores([[3, 1], [3, 1], [3, 1]]), true), ['A', 'B', null]);
  // The pool of a collection page's lists shows a row on many pages: no exclusion, ties stay open.
  assert.deepEqual(assignRows(items.slice(0, 2), () => ['A', 'B'], scores([[3, 1], [5, 1]]), false), ['A', 'A']);
  assert.deepEqual(assignRows(items.slice(0, 2), () => ['A', 'B'], scores([[3, 3], [3, 2]]), false), [null, 'A']);
});

test('rowEvidence: a year that only other zones render counts less than one the site zone renders', () => {
  const fields: { header: string; type: 'text' | 'date' }[] = [{ header: 'Name', type: 'text' }, { header: 'datum', type: 'date' }];
  const slot = (key: string, text: string): [string, SiteSlotValue] => [key, { key, tag: 'div', classes: [], empty: false, text }];
  const item: SiteItem = { values: new Map([slot('div.text-block#0', 'Art Muc'), slot('div.#0', '2016')]), links: [], images: [] };
  const berlin = { Name: 'Art Muc', datum: 'Sun Dec 31 2015 23:00:00 GMT+0000' };
  const utc = { Name: 'Art Muc', datum: 'Sat Dec 31 2016 23:00:00 GMT+0000' };
  assert.equal(rowEvidence(item, berlin, fields), 2, 'without a zone every rendering counts');
  assert.equal(rowEvidence(item, utc, fields), 2);
  assert.equal(rowEvidence(item, berlin, fields, 'Europe/Berlin'), 2);
  assert.equal(rowEvidence(item, utc, fields, 'Europe/Berlin'), 1 + OTHER_ZONE_MATCH);
  assert.equal(rowEvidence(item, berlin, fields, 'UTC'), 1 + OTHER_ZONE_MATCH);
  assert.equal(rowEvidence(item, utc, fields, 'UTC'), 2);
});

test('site-only: the list on a collection page is read from every crawled page, pooled, and gets the limit and bindings the CSV path gives it', () => {
  // Review finding (rev-final): "Weitere Werke" on /werke/<slug> was skipped in
  // the site-only build, so the published page showed all works instead of the
  // few the live pages show, with heuristic slot bindings only.
  const pages = [exportPage('work', WERKE_TEMPLATE), exportPage('detail_werke', DETAIL_TEMPLATE)];
  const site = crawlOf([liveWorkPage([AFFINITAT, BRANDMALE, LEER])], { werke: [liveDetailPage(AFFINITAT, [BRANDMALE]), liveDetailPage(BRANDMALE, [LEER]), liveDetailPage(LEER, [AFFINITAT])] });
  const warn = new Warnings();
  const merge = mergeSitePlans({ plans: [], site, pages, detailPages: new Map([['detail_werke', { folder: 'werke', planIndex: -1 }]]), warn });
  assert.equal(merge.plans.length, 1);
  assert.equal(merge.plans[0].csv.rows.length, 3);
  const more = merge.mappings.get('detail_werke#list0')!;
  assert.ok(more, 'the list on the collection page has a mapping');
  assert.equal(more.planIndex, 0);
  assert.equal(more.identified, 3, 'one item per crawled page, pooled');
  assert.deepEqual(more.liveCounts, [1, 1, 1]);
  assert.equal(more.shownSlugs, undefined, 'pooled over the pages: no exact shown set');
  assert.equal(more.limit, 1, 'every page shows one of three');
  const work = merge.mappings.get('work#list0')!;
  assert.equal(work.limit, undefined);
  assert.ok(work.slots.size >= 5, `${work.slots.size} slots on /work`);
  for (const [key, m] of work.slots) assert.equal(more.slots.get(key)?.header, m.header, `${key}: the same field as the same slot on /work`);

  const cms = cmsOf(merge.plans);
  const bindWarn = new Warnings();
  const oracle = createSiteOracle(merge, cms, pages);
  bindPages({ cms, pages, dynamicPageByCollection: new Map([[cms.collections[0].id, { pageId: 'p', folderId: 'f', slug: 'werke' }]]), warn: bindWarn, oracle });
  const detailItem = nodesOf(pages[1], (n) => n.wf.role === 'dyn-item')[0];
  assert.equal(detailItem.wf.collection?.collectionId, cms.collections[0].id);
  assert.equal(detailItem.wf.collection?.confidence, 1, detailItem.wf.collection?.reason);
  assert.equal(detailItem.wf.collection?.limit, 1);
  const card = nodesOf(pages[1], (n) => n.wf.siteClasses.includes('thin') && !n.wf.siteClasses.includes('_2') && n.wf.bindEmpty);
  assert.deepEqual(card.map((n) => n.wf.binding?.confidence), [1, 1, 1], 'the card slots on the collection page are decided by the live site');
  assert.equal(bindWarn.list.filter((w) => w.code === 'binding_guess' && w.page === 'detail_werke' && /thin|div-block/.test(w.message)).length, 0);
  assert.ok(bindWarn.list.some((w) => w.code === 'collection_guess' && /detail_werke.*limit 1 \(live site: each of 3 pages shows 1 of 3/.test(w.message)), JSON.stringify(bindWarn.list.filter((w) => w.code === 'collection_guess').map((w) => w.message)));
});

// ─── Collection page SEO ──────────────────────────────────────────────────────

test('seoTextTemplate: constant around one field, the same text everywhere, or nothing', () => {
  const rows = [{ Name: 'Affinität', Slug: 'affinitat', Beschreibung: '<p>Öl auf Leinwand</p>' }, { Name: 'Leer', Slug: 'leer', Beschreibung: '<p>Acryl</p>' }];
  const fields: { header: string; type: 'text' | 'rich_text' | 'date' }[] = [{ header: 'Name', type: 'text' }, { header: 'Beschreibung', type: 'rich_text' }, { header: 'Datum', type: 'date' }];
  assert.deepEqual(seoTextTemplate([{ text: 'Affinität | Valeska von Brase', row: rows[0] }, { text: 'Leer  |  Valeska von Brase', row: rows[1] }], fields), { header: 'Name', prefix: '', suffix: ' | Valeska von Brase' });
  assert.deepEqual(seoTextTemplate([{ text: 'Valeska von Brase – Affinität', row: rows[0] }, { text: 'Valeska von Brase – Leer', row: rows[1] }], fields), { header: 'Name', prefix: 'Valeska von Brase – ', suffix: '' });
  assert.deepEqual(seoTextTemplate([{ text: 'Öl auf Leinwand', row: rows[0] }, { text: 'Acryl', row: rows[1] }], fields), { header: 'Beschreibung', prefix: '', suffix: '' }, 'a rich text cell matches by its text');
  assert.deepEqual(seoTextTemplate([{ text: 'Werke', row: rows[0] }, { text: 'Werke', row: rows[1] }], fields), { text: 'Werke' });
  assert.equal(seoTextTemplate([{ text: 'Affinität | Valeska von Brase', row: rows[0] }, { text: 'Leer – Valeska von Brase', row: rows[1] }], fields), null, 'the pages disagree');
  assert.equal(seoTextTemplate([{ text: 'Affinität | Valeska von Brase', row: rows[0] }, { text: '', row: rows[1] }], fields), null, 'a page without the text');
  assert.equal(seoTextTemplate([], fields), null);
});

test('parseSitePage reads the meta description', () => {
  const page = parseSitePage(`<html><head><title>Affinität | Valeska von Brase</title><meta name="Description" content=" Werk: Affinität "><meta name="description" content="second"></head><body></body></html>`, `${ORIGIN}/werke/affinitat`);
  assert.equal(page.description, 'Werk: Affinität');
  assert.equal(parseSitePage('<html><head><title>x</title></head><body></body></html>', `${ORIGIN}/werke/x`).description, undefined);
});

test('applySiteSeo: the dynamic page gets the live title as an inline Name variable plus the suffix, the description from the pages', () => {
  const pages = [exportPage('detail_werke', DETAIL_TEMPLATE)];
  const detail = (w: Werk) => parseSitePage(`<html><head><title>${w.name} | Valeska von Brase</title><meta name="description" content="Werk von Valeska von Brase: ${w.name}"></head><body>
    <section class="section-3"><img src="${ORIGIN}/cdn/${w.file}" class="image-7"><div class="title"><h1 class="logoanimation white subtitle">${w.name}</h1></div></section></body></html>`, `${ORIGIN}/werke/${w.slug}`);
  const plans = werkePlans();
  const warn = new Warnings();
  const merge = mergeSitePlans({ plans, site: crawlOf([], { werke: [detail(AFFINITAT), detail(BRANDMALE), detail(LIVE_ONLY)] }), pages, detailPages: new Map([['detail_werke', { folder: 'werke', planIndex: 0 }]]), warn });
  assert.deepEqual(merge.seo.get('werke'), { pages: 3, title: { header: 'Name', prefix: '', suffix: ' | Valeska von Brase' }, description: { header: 'Name', prefix: 'Werk von Valeska von Brase: ', suffix: '' } }, 'the live-only page counts once its row exists');

  const cms = cmsOf(merge.plans);
  const nameField = cms.collections[0].fields.find((f) => f.id === cms.collections[0].nameFieldId)!;
  const plan: PagePlan = { page: pages[0], kind: 'dynamic', name: 'Werke', slug: '', folder: { name: 'Werke', slug: 'werke' }, cms: { collectionId: cms.collections[0].id, slugFieldId: cms.collections[0].slugFieldId }, seo: { title: 'valeska von brase', description: 'Werke', image: null, noindex: false }, customHead: '', customBody: '' };
  const untouched: PagePlan = { ...plan, kind: 'static', folder: undefined, cms: undefined, seo: { ...plan.seo } };
  const seoWarn = new Warnings();
  assert.equal(applySiteSeo([plan, untouched], cms, merge, seoWarn), 1);
  const variable = `<ycode-inline-variable>{"type":"field","data":{"field_id":"${nameField.id}","field_type":"text","relationships":[],"source":"page"}}</ycode-inline-variable>`;
  assert.equal(plan.seo.title, `${variable} | Valeska von Brase`);
  assert.equal(plan.seo.description, `Werk von Valeska von Brase: ${variable}`);
  assert.equal(untouched.seo.title, 'valeska von brase');
  assert.equal(seoWarn.count('seo_from_site'), 1);
  assert.match(seoWarn.list[0].message, /title "<Name> \| Valeska von Brase", description "Werk von Valeska von Brase: <Name>" as on the 3 live \/werke\/ page\(s\)/);
  // The same title on every page is kept as it is; no template without pages.
  const constant = mergeSitePlans({ plans: werkePlans(), site: crawlOf([], { werke: [liveDetailPage(AFFINITAT, []), liveDetailPage(BRANDMALE, [])].map((p) => ({ ...p, title: 'valeska von brase' })) }), pages, detailPages: new Map([['detail_werke', { folder: 'werke', planIndex: 0 }]]), warn: new Warnings() });
  assert.deepEqual(constant.seo.get('werke'), { pages: 2, title: { text: 'valeska von brase' } });
  assert.equal(applySiteSeo([{ ...plan, seo: { ...plan.seo, title: 'valeska von brase' } }], cms, constant, new Warnings()), 0, 'nothing changes: the export title already is the live title');
});

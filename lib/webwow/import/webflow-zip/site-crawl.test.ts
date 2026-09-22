import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

// safe-fetch.ts imports `@/lib/webwow/storage` (guessMimeType), which carries `import 'server-only'`.
{
  const filename = require.resolve('server-only');
  const mod = new Module(filename) as Module & { loaded: boolean };
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = {};
  require.cache[filename] = mod;
}

import { BUDGET_EXHAUSTED_ERROR } from './safe-fetch';
import { Warnings } from './warnings';
import {
  DEFAULT_SITE_LIMITS,
  MIN_PAGE_BYTES,
  SlotKeyCounter,
  checkSiteUrl,
  crawlSite,
  normalisePath,
  pagePathOf,
  parseSitemap,
  parseSitePage,
  textOf,
  type SiteFetch,
} from './site-crawl';
import { parse } from 'node-html-parser';

// ─── Fixtures (strings only — no network anywhere in this file) ───────────────

const ORIGIN = 'http://localhost:8090';

function card(slug: string, name: string, year: string, masse: string, technik: string, image: string): string {
  return `
    <div id="w-node-x" role="listitem" class="collection-item w-dyn-item">
      <a href="/werke/${slug}" class="div-block-2 w-inline-block">
        <div class="div-block" style="background-image:url(&quot;${image}&quot;)"></div>
      </a>
      <div class="div-block-4"><div class="rotatetext"><div class="div-block-6">
        <div>${name}</div>
        <div class="sidebar">
          <div class="thin">${year}</div>
          <div class="thin ${masse ? '' : 'w-dyn-bind-empty'}">${masse}</div>
          <div class="thin">|</div>
          <div class="thin">${technik}</div>
        </div>
      </div></div></div>
    </div>`;
}

function workPage(items: string[]): string {
  return `<!DOCTYPE html><html lang="de"><head><title>Works | Valeska</title>
    <link rel="canonical" href="${ORIGIN}/work">
    <link rel="alternate" hreflang="de" href="${ORIGIN}/work">
    <link rel="alternate" hreflang="en" href="${ORIGIN}/en/work">
    <link rel="alternate" hreflang="x-default" href="${ORIGIN}/work">
    <script>window.x = 1;</script></head>
    <body class="body">
      <div class="navbar w-nav"><a href="/" class="brand w-nav-brand"><img src="images/logo.svg" alt=""></a></div>
      <h1 class="logoanimation">WORKS</h1>
      <section class="section work">
        <div class="collection-list-wrapper w-dyn-list">
          <div role="list" class="collection-list w-dyn-items">${items.join('')}</div>
          <div class="w-dyn-empty"><div>No items found.</div></div>
          <div role="navigation" class="w-pagination-wrapper">
            <a href="?8d505578_page=1" class="w-pagination-previous">Previous</a>
            <a href="?8d505578_page=3" class="w-pagination-next">Next</a>
            <div class="w-page-count">Seite 2 von 3</div>
          </div>
        </div>
      </section>
      <section class="section small">
        <div class="collection-list-wrapper-2 w-dyn-list"><div class="w-dyn-items">
          <div class="collection-item-2 w-dyn-item"><div class="text-block">Artbunker</div>
            <div class="rich-text-block w-richtext"><p>Hello <strong>there</strong></p></div>
            <div class="w-dyn-list"><div class="collection-list-2 w-dyn-items">
              <div class="w-dyn-item"><img src="${ORIGIN}/cdn/a.png" class="image-6"></div>
              <div class="w-dyn-item"><img src="${ORIGIN}/cdn/b.png" class="image-6"></div>
            </div></div>
          </div>
        </div></div>
      </section>
      <div class="footer">Copyright <br>2025 <a href="https://instagram.com/x" class="arrow">Instagram</a></div>
    </body></html>`;
}

const DETAIL_HTML = `<!DOCTYPE html><html><head><title>Affinität | Valeska von Brase</title>
  <link href="${ORIGIN}/werke/affinitat" rel="canonical"></head>
  <body>
    <section class="section-3"><img src="${ORIGIN}/cdn/696e3e2685bc773db82e3fca/69726347adba29a83e587f60_03-Affinitat.jpeg" alt="Affinität" class="image-7">
      <div class="title">
        <h1 class="logoanimation white subtitle">Affinität</h1>
        <div class="footerheading">
          <div class="thin _2">2023</div>
          <div class="thin _2">|</div>
          <div class="thin _2">150x180 cm</div>
          <div class="thin _2">Öl, Pigmente, Acryl auf Leinwand</div>
        </div>
      </div>
    </section>
    <section class="section-3-copy"><h1 class="heading-2">Weitere Werke</h1>
      <div class="collection-list-wrapper w-dyn-list"><div role="list" class="collection-list w-dyn-items">
        ${card('grendill', 'Grendill', '2024', '10x10', 'Öl', `${ORIGIN}/cdn/x/1_g.jpg`)}
        ${card('sonnendreher', 'Sonnendreher', '2021', '20x20', 'Acryl', `${ORIGIN}/cdn/x/2_s.jpg`)}
      </div></div>
    </section>
  </body></html>`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

test('textOf collapses whitespace and turns <br> into newlines', () => {
  const el = parse('<div>  Copyright <br> ©2025   <b>VvB</b>\n</div>').querySelector('div')!;
  assert.equal(textOf(el), 'Copyright\n©2025 VvB');
});

test('normalisePath / pagePathOf', () => {
  assert.equal(normalisePath('/work/', ORIGIN), '/work');
  assert.equal(normalisePath('/work.html', ORIGIN), '/work');
  assert.equal(normalisePath('/index.html', ORIGIN), '/');
  assert.equal(normalisePath('/', ORIGIN), '/');
  assert.equal(normalisePath('/werke/affinitat?x=1#top', ORIGIN), '/werke/affinitat');
  assert.equal(normalisePath(`${ORIGIN}/exhibitions/`, ORIGIN), '/exhibitions');
  assert.equal(normalisePath('https://other.example.com/work', ORIGIN), null);
  assert.equal(normalisePath('mailto:x@y.z', ORIGIN), null);
  assert.equal(pagePathOf('index'), '/');
  assert.equal(pagePathOf('work'), '/work');
});

test('SlotKeyCounter numbers equal keys in walk order', () => {
  const c = new SlotKeyCounter();
  assert.equal(c.next('div', ['thin']), 'div.thin#0');
  assert.equal(c.next('div', ['thin']), 'div.thin#1');
  assert.equal(c.next('div', []), 'div.#0');
  assert.equal(c.next('div', ['thin', '_2']), 'div.thin._2#0');
});

// ─── parseSitePage ────────────────────────────────────────────────────────────

test('parseSitePage: head, top-level lists, item values, links, pagination', () => {
  const page = parseSitePage(workPage([
    card('affinitat', 'Affinität', '2023', '150x180 cm', 'Öl, Pigmente, Acryl auf Leinwand', `${ORIGIN}/cdn/x/1_a.jpg`),
    card('leer', 'Leer', '2024', '', 'Acryl', 'cdn/x/2_l.jpg'),
  ]), `${ORIGIN}/work`);

  assert.equal(page.path, '/work');
  assert.equal(page.title, 'Works | Valeska');
  assert.equal(page.lang, 'de');
  assert.equal(page.canonical, `${ORIGIN}/work`);
  assert.deepEqual(page.alternates.map((a) => a.lang), ['de', 'en', 'x-default']);

  assert.equal(page.lists.length, 2, 'the nested image list is not a top-level list');
  const [works, exhibitions] = page.lists;
  assert.equal(works.key, 'div.collection-list-wrapper');
  assert.equal(works.items.length, 2);
  assert.deepEqual(works.pagination, { previous: '?8d505578_page=1', next: '?8d505578_page=3', count: 'Seite 2 von 3', param: '8d505578_page' });

  const first = works.items[0];
  assert.deepEqual(first.links, ['/werke/affinitat']);
  // The item root is key #0 of its own class; the slots follow the template's walk order.
  assert.equal(first.values.get('a.div-block-2#0')?.href, `${ORIGIN}/werke/affinitat`);
  assert.equal(first.values.get('div.div-block#0')?.bg, `${ORIGIN}/cdn/x/1_a.jpg`);
  assert.equal(first.values.get('div.#0')?.text, 'Affinität');
  assert.equal(first.values.get('div.thin#0')?.text, '2023');
  assert.equal(first.values.get('div.thin#1')?.text, '150x180 cm');
  assert.equal(first.values.get('div.thin#2')?.text, '|');
  assert.equal(first.values.get('div.thin#3')?.text, 'Öl, Pigmente, Acryl auf Leinwand');
  assert.equal(first.values.get('div.collection-item#0'), undefined, 'the root carries no value');

  const second = works.items[1];
  assert.equal(second.values.get('div.div-block#0')?.bg, `${ORIGIN}/cdn/x/2_l.jpg`, 'relative image URLs are resolved against the page');
  const empty = second.values.get('div.thin#1');
  assert.equal(empty?.text, '');
  assert.equal(empty?.empty, true, 'w-dyn-bind-empty is remembered');

  assert.equal(exhibitions.items.length, 1);
  const ex = exhibitions.items[0];
  assert.equal(ex.values.get('div.text-block#0')?.text, 'Artbunker');
  assert.equal(ex.values.get('div.rich-text-block#0')?.html, '<p>Hello <strong>there</strong></p>');
  assert.equal([...ex.values.keys()].some((k) => k.startsWith('img.')), false, 'nested list images are no slots');
  assert.deepEqual(ex.images, [`${ORIGIN}/cdn/a.png`, `${ORIGIN}/cdn/b.png`], 'but they are the item\'s images (gallery fallback)');
  assert.deepEqual(first.images, [`${ORIGIN}/cdn/x/1_a.jpg`]);

  // Page-level values skip the lists entirely; loose text runs count like html.ts text nodes.
  assert.equal(page.values.get('h1.logoanimation#0')?.text, 'WORKS');
  assert.equal(page.values.has('div.#0'), false);
  assert.equal(page.values.get('a.arrow#0')?.href, 'https://instagram.com/x');
  assert.ok(page.links.includes('/werke/affinitat') && page.links.includes('/') && !page.links.includes('https://instagram.com/x'));
});

test('parseSitePage: a collection page keeps its page-level slots and skips the list below', () => {
  const page = parseSitePage(DETAIL_HTML, `${ORIGIN}/werke/affinitat`);
  assert.equal(page.path, '/werke/affinitat');
  assert.equal(page.title, 'Affinität | Valeska von Brase');
  assert.equal(page.values.get('img.image-7#0')?.src, `${ORIGIN}/cdn/696e3e2685bc773db82e3fca/69726347adba29a83e587f60_03-Affinitat.jpeg`);
  assert.equal(page.values.get('h1.logoanimation.white.subtitle#0')?.text, 'Affinität');
  assert.equal(page.values.get('div.thin._2#0')?.text, '2023');
  assert.equal(page.values.get('div.thin._2#1')?.text, '|');
  assert.equal(page.values.get('div.thin._2#2')?.text, '150x180 cm');
  assert.equal(page.values.get('div.thin._2#3')?.text, 'Öl, Pigmente, Acryl auf Leinwand');
  assert.equal(page.values.get('h1.heading-2#0')?.text, 'Weitere Werke');
  assert.equal(page.lists.length, 1);
  assert.equal(page.lists[0].items.length, 2);
});

test('parseSitemap: urlset and index, same origin only', () => {
  const urlset = `<?xml version="1.0"?><urlset><url><loc>${ORIGIN}/</loc></url><url><loc>${ORIGIN}/work</loc></url>
    <url><loc>${ORIGIN}/werke/affinitat</loc></url><url><loc>https://evil.example.com/x</loc></url><url><loc>${ORIGIN}/sub.xml</loc></url></urlset>`;
  assert.deepEqual(parseSitemap(urlset, ORIGIN), { pages: ['/', '/work', '/werke/affinitat'], sitemaps: [`${ORIGIN}/sub.xml`] });
  const index = `<sitemapindex><sitemap><loc>${ORIGIN}/a.xml</loc></sitemap><sitemap><loc>https://evil.example.com/b.xml</loc></sitemap></sitemapindex>`;
  assert.deepEqual(parseSitemap(index, ORIGIN), { pages: [], sitemaps: [`${ORIGIN}/a.xml`] });
});

// ─── checkSiteUrl ─────────────────────────────────────────────────────────────

const publicLookup = async () => [{ address: '93.184.216.34' }];
const privateLookup = async () => [{ address: '10.0.0.5' }];

test('checkSiteUrl: http(s) only, no credentials, bounded length, public host', async () => {
  assert.deepEqual(await checkSiteUrl('https://www.example.com/', { lookupImpl: publicLookup, relaxedHosts: [] }), { ok: true, origin: 'https://www.example.com', host: 'www.example.com' });
  assert.deepEqual(await checkSiteUrl('www.example.com', { lookupImpl: publicLookup, relaxedHosts: [] }), { ok: true, origin: 'https://www.example.com', host: 'www.example.com' });
  assert.equal((await checkSiteUrl('http://www.example.com/', { lookupImpl: publicLookup, relaxedHosts: [] })).ok, true, 'plain http on a public host is allowed');
  assert.match((await checkSiteUrl('ftp://www.example.com/', { lookupImpl: publicLookup, relaxedHosts: [] }) as { error: string }).error, /only http/);
  assert.match((await checkSiteUrl('https://user:pw@www.example.com/', { lookupImpl: publicLookup, relaxedHosts: [] }) as { error: string }).error, /credentials/);
  assert.match((await checkSiteUrl(`https://www.example.com/${'a'.repeat(2100)}`, { lookupImpl: publicLookup, relaxedHosts: [] }) as { error: string }).error, /longer than/);
  assert.match((await checkSiteUrl('   ', { lookupImpl: publicLookup, relaxedHosts: [] }) as { error: string }).error, /empty/);
  assert.match((await checkSiteUrl('https://intranet.local/', { lookupImpl: privateLookup, relaxedHosts: [] }) as { error: string }).error, /non-public/);
  assert.match((await checkSiteUrl('http://127.0.0.1:8090/', { lookupImpl: publicLookup, relaxedHosts: [] }) as { error: string }).error, /not public/);
  assert.match((await checkSiteUrl('http://localhost:8090/', { lookupImpl: privateLookup, relaxedHosts: [] }) as { error: string }).error, /non-public/);
  // The operator's development allow-list (never the default) may point at a private host.
  assert.deepEqual(await checkSiteUrl('http://localhost:8090/', { lookupImpl: privateLookup, relaxedHosts: [/^localhost$/i] }), { ok: true, origin: 'http://localhost:8090', host: 'localhost' });
});

// ─── crawlSite ────────────────────────────────────────────────────────────────

function stubSite(files: Record<string, string | { status: number } | { type: string; body: string }>, delayMs = 0): { fetch: SiteFetch; calls: string[]; timeouts: number[] } {
  const calls: string[] = [];
  const timeouts: number[] = [];
  const fetch: SiteFetch = async (url, opts) => {
    calls.push(url);
    timeouts.push(opts.timeoutMs);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const path = url.slice(ORIGIN.length) || '/';
    const entry = files[path];
    if (entry === undefined) return { ok: false, error: 'HTTP 404' };
    if (typeof entry !== 'string' && 'status' in entry) return { ok: false, error: `HTTP ${entry.status}` };
    const buffer = Buffer.from(typeof entry === 'string' ? entry : entry.body, 'utf8');
    // Like safeFetch: the body is charged against the budget while it streams.
    if (!opts.budget.take(buffer.length)) return { ok: false, error: BUDGET_EXHAUSTED_ERROR };
    if (typeof entry === 'string') return { ok: true, buffer, contentType: 'text/html', filename: 'page.html' };
    return { ok: true, buffer, contentType: (entry as { type: string }).type, filename: 'file' };
  };
  return { fetch, calls, timeouts };
}

const RELAXED = { relaxedHosts: [/^localhost$/i] };

test('crawlSite: static pages, sitemap, item pages, discovery, pagination merge, budgets', async () => {
  const work1 = workPage([card('affinitat', 'Affinität', '2023', '150x180 cm', 'Öl', `${ORIGIN}/cdn/x/1_a.jpg`)]);
  const work3 = workPage([card('grendill', 'Grendill', '2024', '10x10', 'Öl', `${ORIGIN}/cdn/x/1_g.jpg`)]).replace('?8d505578_page=3', '');
  const site = stubSite({
    '/': `<html><head><title>Home</title></head><body><a href="/work">Work</a><a href="/werke/sonnendreher">S</a></body></html>`,
    '/work': work1,
    '/work?8d505578_page=3': work3,
    '/sitemap.xml': { type: 'application/xml', body: `<urlset><url><loc>${ORIGIN}/</loc></url><url><loc>${ORIGIN}/catalog</loc></url><url><loc>${ORIGIN}/werke/affinitat</loc></url></urlset>` },
    '/catalog': `<html><head><title>Catalog</title></head><body><h1>Catalog</h1></body></html>`,
    '/artist': { type: 'application/pdf', body: '%PDF-1.4' },
    '/werke/affinitat': DETAIL_HTML,
    '/werke/sonnendreher': { status: 500 },
    '/werke/grendill': DETAIL_HTML.replace('Affinität | Valeska von Brase', 'Grendill | Valeska von Brase'),
    '/exhibitions': { status: 404 },
  });
  const warn = new Warnings();
  // `checkSiteUrl` inside crawlSite resolves the host through DNS; localhost is loopback, so it
  // only passes as an operator-listed host — exactly the verification setup of the spec.
  process.env.WEBWOW_IMPORT_ALLOWED_HOSTS = 'localhost';
  const crawl = await crawlSite({
    baseUrl: `${ORIGIN}/`,
    pagePaths: ['/', '/work', '/catalog', '/artist', '/exhibitions'],
    collections: [{ name: 'Werke', folder: 'werke', slugs: ['affinitat', 'leer'] }, { name: 'Exhibitions', folder: 'exhibitions', slugs: [] }],
    warn,
    fetch: site.fetch,
    limits: { concurrency: 2 },
  });
  delete process.env.WEBWOW_IMPORT_ALLOWED_HOSTS;

  assert.equal(crawl.reachable, true);
  assert.equal(crawl.host, 'localhost');
  assert.deepEqual([...crawl.pages.keys()].sort(), ['/', '/catalog', '/werke/affinitat', '/werke/grendill', '/work']);
  assert.equal(crawl.pages.get('/work')?.lists[0].items.length, 2, 'the pagination page was merged into the base list');
  assert.deepEqual([...crawl.detail.get('werke')!.keys()].sort(), ['affinitat', 'grendill']);
  assert.equal(crawl.detail.get('werke')!.get('grendill')?.title, 'Grendill | Valeska von Brase');
  assert.ok(site.calls.includes(`${ORIGIN}/sitemap.xml`));
  assert.ok(site.calls.includes(`${ORIGIN}/werke/leer`), 'CSV slugs are tried');
  assert.ok(site.calls.includes(`${ORIGIN}/werke/sonnendreher`), 'links found on pages are followed');
  assert.ok(site.calls.includes(`${ORIGIN}/work?8d505578_page=3`), 'pagination is followed');
  assert.equal(site.calls.filter((u) => u === `${ORIGIN}/work`).length, 1, 'no page is fetched twice');
  assert.ok(site.calls.every((u) => u.startsWith(ORIGIN)), 'only the site host is contacted');

  assert.equal(crawl.stats.fetched, 6);
  assert.equal(crawl.stats.skipped, 1, 'the PDF');
  assert.equal(crawl.stats.failed, 3, '404 exhibitions, 500 sonnendreher, 404 leer');
  assert.equal(warn.count('site_page_skipped'), 1);
  assert.equal(warn.count('site_page_failed'), 3);
  assert.equal(warn.count('site_unreachable'), 0);
  assert.deepEqual(crawl.locales, ['de', 'en']);
  assert.equal(warn.count('locales_collapsed'), 1);
});

test('crawlSite: the byte budget ends the crawl with one aggregated warning and no further requests', async () => {
  const files: Record<string, string> = { '/': '<html><body>home</body></html>' };
  const big = `<html><head><title>Item</title></head><body>${'x'.repeat(3000)}</body></html>`;
  for (let i = 0; i < 10; i++) files[`/werke/item-${i}`] = big;
  const site = stubSite(files);
  const warn = new Warnings();
  process.env.WEBWOW_IMPORT_ALLOWED_HOSTS = 'localhost';
  const crawl = await crawlSite({
    baseUrl: ORIGIN,
    pagePaths: ['/'],
    collections: [{ name: 'Werke', folder: 'werke', slugs: Array.from({ length: 10 }, (_, i) => `item-${i}`) }],
    warn,
    fetch: site.fetch,
    limits: { totalBytes: 7000, concurrency: 2 },
  });
  delete process.env.WEBWOW_IMPORT_ALLOWED_HOSTS;
  // home (~30 B) + two items (~3 KB each) fit; the third item is cut off by the budget and
  // nothing else is requested — one `site_page_skipped`, no `site_page_failed` per page.
  assert.equal(crawl.stats.fetched, 3);
  assert.equal(crawl.stats.failed, 0);
  assert.equal(warn.count('site_page_failed'), 0);
  assert.equal(warn.count('site_page_skipped'), 8, 'every unread item page is counted once');
  assert.equal(warn.list.filter((w) => w.code === 'site_page_skipped').length, 1, 'one aggregated warning');
  assert.match(warn.list.find((w) => w.code === 'site_page_skipped')!.message, /download budget of 0 MB exhausted; 8 page/);
  assert.equal(crawl.stats.fetched + crawl.stats.skipped, 11, 'every page is either read or counted as skipped, none twice');
  assert.equal(crawl.stats.skipped, 8);
  const itemCalls = site.calls.filter((u) => u.includes('/werke/')).length;
  assert.ok(itemCalls <= 4, `requests stop once the budget is gone (${itemCalls} item requests)`);
  assert.equal(crawl.stats.bytes < 7000, true);
  assert.equal(MIN_PAGE_BYTES, 2048);
});

test('crawlSite: the time budget ends the crawl and caps every page timeout', async () => {
  const files: Record<string, string> = { '/': '<html><body>home</body></html>' };
  for (let i = 0; i < 30; i++) files[`/werke/item-${i}`] = `<html><head><title>Item ${i}</title></head><body>x</body></html>`;
  const site = stubSite(files, 25);
  const warn = new Warnings();
  const started = Date.now();
  process.env.WEBWOW_IMPORT_ALLOWED_HOSTS = 'localhost';
  const crawl = await crawlSite({
    baseUrl: ORIGIN,
    pagePaths: ['/'],
    collections: [{ name: 'Werke', folder: 'werke', slugs: Array.from({ length: 30 }, (_, i) => `item-${i}`) }],
    warn,
    fetch: site.fetch,
    limits: { totalMs: 150, concurrency: 1, timeoutMs: 20_000 },
  });
  delete process.env.WEBWOW_IMPORT_ALLOWED_HOSTS;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `the crawl stopped at the deadline (${elapsed} ms)`);
  assert.ok(crawl.stats.fetched < 30 && crawl.stats.fetched >= 2, `some pages read (${crawl.stats.fetched})`);
  assert.equal(warn.count('site_page_failed'), 0);
  assert.equal(warn.list.filter((w) => w.code === 'site_page_skipped').length, 1, 'one aggregated warning');
  assert.match(warn.list.find((w) => w.code === 'site_page_skipped')!.message, /time budget of 0 s exhausted; \d+ page/);
  assert.equal(crawl.stats.fetched + crawl.stats.skipped, 31, 'every page is either read or counted as skipped');
  assert.ok(site.timeouts.every((t) => t <= 150), 'no page timeout exceeds the time budget');
  assert.ok(site.timeouts[site.timeouts.length - 1] < site.timeouts[0], 'later pages get only the time that is left');
  assert.equal(DEFAULT_SITE_LIMITS.totalMs, 120_000);
});

test('checkSiteUrl: an explicit port is a port probe and is refused, except for an operator-listed host', async () => {
  const publicLookup = async () => [{ address: '93.184.216.34' }];
  const probe = await checkSiteUrl('https://example.com:22/', { lookupImpl: publicLookup, relaxedHosts: [] });
  assert.deepEqual(probe, { ok: false, error: 'only the default port is allowed (got :22)' });
  const http8080 = await checkSiteUrl('http://example.com:8080/', { lookupImpl: publicLookup, relaxedHosts: [] });
  assert.equal(http8080.ok, false);
  const dflt = await checkSiteUrl('https://example.com:443/', { lookupImpl: publicLookup, relaxedHosts: [] });
  assert.deepEqual(dflt, { ok: true, origin: 'https://example.com', host: 'example.com' });
  const fixture = await checkSiteUrl('http://localhost:8090', { lookupImpl: async () => [{ address: '127.0.0.1' }], ...RELAXED });
  assert.deepEqual(fixture, { ok: true, origin: 'http://localhost:8090', host: 'localhost' });
});

test('crawlSite: unreachable base -> one warning, nothing else fetched', async () => {
  const site = stubSite({});
  const warn = new Warnings();
  process.env.WEBWOW_IMPORT_ALLOWED_HOSTS = 'localhost';
  const crawl = await crawlSite({ baseUrl: ORIGIN, pagePaths: ['/', '/work'], collections: [], warn, fetch: site.fetch });
  delete process.env.WEBWOW_IMPORT_ALLOWED_HOSTS;
  assert.equal(crawl.reachable, false);
  assert.equal(crawl.pages.size, 0);
  assert.equal(site.calls.length, 1);
  assert.equal(warn.count('site_unreachable'), 1);
});

test('crawlSite: a refused URL never touches the network', async () => {
  const site = stubSite({ '/': '<html></html>' });
  const warn = new Warnings();
  const crawl = await crawlSite({ baseUrl: 'ftp://localhost:8090/', pagePaths: ['/'], collections: [], warn, fetch: site.fetch });
  assert.equal(crawl.reachable, false);
  assert.equal(site.calls.length, 0);
  assert.match(warn.list[0].message, /only http/);
});

test('crawlSite: page limit and per-page byte limit are honoured', async () => {
  const files: Record<string, string> = { '/': '<html><body>home</body></html>' };
  for (let i = 0; i < 10; i++) files[`/werke/item-${i}`] = `<html><head><title>Item ${i}</title></head><body>x</body></html>`;
  const site = stubSite(files);
  const warn = new Warnings();
  process.env.WEBWOW_IMPORT_ALLOWED_HOSTS = 'localhost';
  const crawl = await crawlSite({
    baseUrl: ORIGIN,
    pagePaths: ['/'],
    collections: [{ name: 'Werke', folder: 'werke', slugs: Array.from({ length: 10 }, (_, i) => `item-${i}`) }],
    warn,
    fetch: site.fetch,
    limits: { maxPages: 4, concurrency: 4 },
  });
  delete process.env.WEBWOW_IMPORT_ALLOWED_HOSTS;
  assert.equal(crawl.stats.fetched, 4);
  assert.equal(crawl.detail.get('werke')!.size, 3);
  assert.equal(warn.count('site_page_skipped'), 7);
  assert.equal(DEFAULT_SITE_LIMITS.maxPages, 300);
  assert.equal(DEFAULT_SITE_LIMITS.concurrency, 4);
  assert.equal(DEFAULT_SITE_LIMITS.timeoutMs, 20_000);
  assert.equal(DEFAULT_SITE_LIMITS.maxPageBytes, 20 * 2 ** 20);
  assert.equal(DEFAULT_SITE_LIMITS.totalBytes, 200 * 2 ** 20);
  void RELAXED;
});

test('crawlSite: a canonical-host redirect (apex -> www) re-bases the crawl once; any other host is refused', async () => {
  // The stub plays safeFetch: the apex host answers the probe with a refused redirect
  // to www., the www. host serves the site. `www.localhost` is operator-listed so
  // checkSiteUrl accepts the target like the fixture host.
  const apex = 'http://localhost:8090';
  const www = 'http://www.localhost:8090';
  const calls: string[] = [];
  const fetch: SiteFetch = async (url) => {
    calls.push(url);
    if (url.startsWith(apex)) return { ok: false, error: 'host www.localhost is not in the allowlist', redirect: `${www}${url.slice(apex.length)}` };
    const path = url.slice(www.length) || '/';
    if (path === '/') return { ok: true, buffer: Buffer.from(workPage([card('a', 'A', '2020', '1x1', 'Öl', `${www}/cdn/a.jpg`)])), contentType: 'text/html', filename: 'index.html' };
    if (path === '/werke/a') return { ok: true, buffer: Buffer.from(DETAIL_HTML), contentType: 'text/html', filename: 'a.html' };
    return { ok: false, error: 'HTTP 404' };
  };
  const lookupImpl = async () => [{ address: '127.0.0.1' }];
  const warn = new Warnings();
  process.env.WEBWOW_IMPORT_ALLOWED_HOSTS = 'localhost,www.localhost';
  const crawl = await crawlSite({ baseUrl: apex, pagePaths: ['/'], collections: [{ name: 'Werke', folder: 'werke', slugs: ['a'] }], warn, fetch, lookupImpl });
  delete process.env.WEBWOW_IMPORT_ALLOWED_HOSTS;
  assert.equal(crawl.reachable, true, JSON.stringify({ calls, warns: warn.list }));
  assert.equal(crawl.origin, www);
  assert.equal(crawl.host, 'www.localhost');
  assert.equal(crawl.baseUrl, apex, 'the user input is kept');
  assert.equal(warn.count('site_unreachable'), 0);
  assert.equal(calls[0], `${apex}/`, 'the probe went to the given host first');
  assert.ok(calls.slice(1).every((u) => u.startsWith(www)), `after the re-base every request stays on the new origin: ${calls.join(' ')}`);
  assert.equal(crawl.pages.get('/')?.lists[0]?.items.length, 1);
  assert.equal(crawl.detail.get('werke')?.size, 1);

  // A redirect to an unrelated host is not followed: unreachable, one warning, no second probe.
  const foreign: SiteFetch = async (url) => ({ ok: false, error: 'host cdn.example.net is not in the allowlist', redirect: `https://cdn.example.net${url.slice(apex.length)}` });
  const warn2 = new Warnings();
  process.env.WEBWOW_IMPORT_ALLOWED_HOSTS = 'localhost,www.localhost';
  const refused = await crawlSite({ baseUrl: apex, pagePaths: ['/'], collections: [], warn: warn2, fetch: foreign, lookupImpl });
  delete process.env.WEBWOW_IMPORT_ALLOWED_HOSTS;
  assert.equal(refused.reachable, false);
  assert.equal(refused.origin, apex);
  assert.equal(warn2.count('site_unreachable'), 1);
  assert.match(warn2.list[0].message, /not in the allowlist/);

  // www -> apex works the other way round too.
  const back: SiteFetch = async (url) => {
    if (url.startsWith(www)) return { ok: false, error: 'host localhost is not in the allowlist', redirect: `${apex}${url.slice(www.length)}` };
    return { ok: true, buffer: Buffer.from('<html><head><title>x</title></head><body>home</body></html>'), contentType: 'text/html', filename: 'index.html' };
  };
  const warn3 = new Warnings();
  process.env.WEBWOW_IMPORT_ALLOWED_HOSTS = 'localhost,www.localhost';
  const down = await crawlSite({ baseUrl: www, pagePaths: ['/'], collections: [], warn: warn3, fetch: back, lookupImpl });
  delete process.env.WEBWOW_IMPORT_ALLOWED_HOSTS;
  assert.equal(down.reachable, true);
  assert.equal(down.origin, apex);
  assert.equal(warn3.count('site_unreachable'), 0);
});

test('parseSitePage / crawlSite: a 30000-deep page neither throws nor stops the crawl', async () => {
  const deep = 30_000;
  const deepHtml =
    `<!DOCTYPE html><html lang="de"><head><title>Deep | Site</title></head><body>` +
    `<h1 class="logoanimation">WORKS</h1>` +
    `<div class="collection-list-wrapper w-dyn-list"><div class="w-dyn-items">${card('a', 'A', '2020', '1x1', 'Öl', `${ORIGIN}/cdn/a.jpg`)}</div></div>` +
    `${'<div class="deep">'.repeat(deep)}<span>${'<span>'.repeat(deep)}leaf${'</span>'.repeat(deep)}</span>${'</div>'.repeat(deep)}` +
    `<div class="rich w-richtext">${'<p>'.repeat(deep)}x${'</p>'.repeat(deep)}</div>` +
    `<div class="footer">Copyright</div></body></html>`;
  // Pure parse: the shallow content survives, the deep subtrees are skipped.
  const page = parseSitePage(deepHtml, `${ORIGIN}/`);
  assert.equal(page.title, 'Deep | Site');
  assert.equal(page.lists.length, 1);
  assert.equal(page.lists[0].items[0].values.get('div.div-block-6#0')?.text, undefined);
  assert.equal(page.lists[0].items[0].links[0], '/werke/a');
  assert.equal(page.values.get('h1.logoanimation#0')?.text, 'WORKS');
  assert.equal(page.values.get('div.footer#0')?.text, 'Copyright');

  // Through the crawl (probe + queue), with a parser that throws on one page: that page fails, the crawl goes on.
  const site = stubSite({ '/': deepHtml, '/work': deepHtml, '/werke/a': DETAIL_HTML });
  const warn = new Warnings();
  process.env.WEBWOW_IMPORT_ALLOWED_HOSTS = 'localhost';
  const crawl = await crawlSite({ baseUrl: ORIGIN, pagePaths: ['/', '/work'], collections: [{ name: 'Werke', folder: 'werke', slugs: ['a'] }], warn, fetch: site.fetch });
  delete process.env.WEBWOW_IMPORT_ALLOWED_HOSTS;
  assert.equal(crawl.reachable, true);
  assert.equal(crawl.stats.fetched, 3);
  assert.equal(crawl.stats.failed, 2, 'the two 404 item links of DETAIL_HTML, nothing else');
  assert.ok(warn.list.filter((w) => w.code === 'site_page_failed').every((w) => /HTTP 404$/.test(w.message)), 'no "could not parse page"');
  assert.equal(crawl.pages.get('/work')?.lists.length, 1);
  assert.equal(crawl.detail.get('werke')?.get('a')?.title, 'Affinität | Valeska von Brase');
  assert.equal(warn.count('site_unreachable'), 0);
});

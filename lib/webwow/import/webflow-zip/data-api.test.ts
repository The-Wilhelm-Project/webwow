import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

// data-api.ts -> safe-fetch.ts -> `@/lib/webwow/storage`, which carries `import 'server-only'`.
{
  const filename = require.resolve('server-only');
  const mod = new Module(filename) as Module & { loaded: boolean };
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = {};
  require.cache[filename] = mod;
}

import { getCmsFieldType } from '@/lib/apps/webflow/field-mapping';

import {
  apiValueToCell,
  buildApiCollectionPlan,
  createWebflowApiClient,
  discoverSiteId,
  fetchCmsFromApi,
  KNOWN_WEBFLOW_FIELD_TYPES,
  MAX_ITEMS_PER_COLLECTION,
  mergeCmsPlans,
  planApiFields,
  redactToken,
  resolveApiBase,
  WEBFLOW_API_BASE,
  WebflowApiError,
} from './data-api';
import { isPublishableRow } from './cms';
import { WfImportError } from './types';
import { Warnings } from './warnings';

import type { WebflowCollection, WebflowField, WebflowItem } from '@/lib/apps/webflow/types';
import type { WfCollectionPlan } from './cms';

const TOKEN = 'wf_token_0123456789abcdef';
const SITE = '696e3d580d900572c87f065a';
const COLLECTION = '696e3e261a55566a62dc5508';

function field(partial: Partial<WebflowField> & Pick<WebflowField, 'slug' | 'type'>): WebflowField {
  return {
    id: `f-${partial.slug}`,
    isEditable: true,
    isRequired: false,
    displayName: partial.slug,
    ...partial,
  } as WebflowField;
}

/** A fetch stub: one canned response per endpoint suffix, plus a request log. */
function stubFetch(routes: Array<{ match: RegExp; status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({ url, headers });
    const route = routes.find((r) => r.match.test(url));
    if (!route) return new Response('{"message":"no stub route"}', { status: 404, headers: { 'content-type': 'application/json' } });
    const status = route.status ?? 200;
    const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? {});
    return new Response(status === 204 ? null : body, { status, headers: { 'content-type': 'application/json', ...(route.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const publicLookup = async () => [{ address: '151.101.1.195' }];

// ─── Value mapping ────────────────────────────────────────────────────────────

test('apiValueToCell: scalars keep their CSV spelling', () => {
  assert.equal(apiValueToCell('Hallo', field({ slug: 't', type: 'PlainText' })), 'Hallo');
  assert.equal(apiValueToCell('a@b.de', field({ slug: 'e', type: 'Email' })), 'a@b.de');
  assert.equal(apiValueToCell('#ff0000', field({ slug: 'c', type: 'Color' })), '#ff0000');
  assert.equal(apiValueToCell('https://example.com', field({ slug: 'l', type: 'Link' })), 'https://example.com');
  assert.equal(apiValueToCell(null, field({ slug: 't', type: 'PlainText' })), '');
  assert.equal(apiValueToCell(undefined, field({ slug: 't', type: 'PlainText' })), '');
});

test('apiValueToCell: Number keeps the value, not the JSON spelling', () => {
  assert.equal(apiValueToCell(1998, field({ slug: 'n', type: 'Number' })), '1998');
  assert.equal(apiValueToCell(2.5, field({ slug: 'n', type: 'Number' })), '2.5');
  assert.equal(apiValueToCell('42', field({ slug: 'n', type: 'Number' })), '42');
  assert.equal(apiValueToCell('nope', field({ slug: 'n', type: 'Number' })), '');
  assert.equal(apiValueToCell(Number.NaN, field({ slug: 'n', type: 'Number' })), '');
});

test('apiValueToCell: Switch is a real boolean, not the string "on"', () => {
  assert.equal(apiValueToCell(true, field({ slug: 's', type: 'Switch' })), 'true');
  assert.equal(apiValueToCell(false, field({ slug: 's', type: 'Switch' })), 'false');
  assert.equal(apiValueToCell('yes', field({ slug: 's', type: 'Switch' })), 'true');
  assert.equal(apiValueToCell('', field({ slug: 's', type: 'Switch' })), 'false');
});

test('apiValueToCell: Date / DateTime normalise to ISO', () => {
  assert.equal(apiValueToCell('2024-03-26T10:00:00Z', field({ slug: 'd', type: 'DateTime' })), '2024-03-26T10:00:00.000Z');
  assert.equal(apiValueToCell('2024-03-26', field({ slug: 'd', type: 'Date' })), '2024-03-26T00:00:00.000Z');
  assert.equal(apiValueToCell('not a date', field({ slug: 'd', type: 'DateTime' })), '');
});

test('apiValueToCell: Option resolves the id to its label', () => {
  const f = field({
    slug: 'kategorie',
    type: 'Option',
    validations: { options: [{ id: 'opt-1', name: ' Malerei ' }, { id: 'opt-2', name: 'Skulptur' }] },
  });
  assert.equal(apiValueToCell('opt-1', f), 'Malerei');
  assert.equal(apiValueToCell('opt-2', f), 'Skulptur');
  // Unknown ids fall back to the id rather than dropping the value.
  assert.equal(apiValueToCell('opt-9', f), 'opt-9');
  assert.equal(apiValueToCell('', f), '');
});

test('apiValueToCell: references serialise to the `;` token list importCms resolves', () => {
  assert.equal(apiValueToCell('itm-1', field({ slug: 'r', type: 'Reference' })), 'itm-1');
  assert.equal(apiValueToCell(['itm-1', 'itm-2'], field({ slug: 'r', type: 'MultiReference' })), 'itm-1;itm-2');
  assert.equal(apiValueToCell([], field({ slug: 'r', type: 'MultiReference' })), '');
  assert.equal(apiValueToCell('itm-1', field({ slug: 'r', type: 'MultiReference' })), '');
});

test('apiValueToCell: assets become their URL, multi-image a `;` list', () => {
  const image = { fileId: 'a1', url: 'https://cdn.prod.website-files.com/x/one.jpg', alt: 'Eins' };
  const image2 = { fileId: 'a2', url: 'https://cdn.prod.website-files.com/x/two.jpg', alt: null };
  assert.equal(apiValueToCell(image, field({ slug: 'i', type: 'Image' })), image.url);
  assert.equal(apiValueToCell([image, image2], field({ slug: 'i', type: 'MultiImage' })), `${image.url};${image2.url}`);
  assert.equal(apiValueToCell({ url: 'https://cdn.prod.website-files.com/x/doc.pdf' }, field({ slug: 'f', type: 'File' })), 'https://cdn.prod.website-files.com/x/doc.pdf');
  assert.equal(apiValueToCell({ url: 'https://youtu.be/abc', html: '<iframe>' }, field({ slug: 'v', type: 'Video' })), 'https://youtu.be/abc');
  assert.equal(apiValueToCell(null, field({ slug: 'i', type: 'Image' })), '');
});

test('apiValueToCell: RichText stays HTML so importCms runs the same converter as the CSV path', () => {
  const html = '<h2>Titel</h2><p>Ein <strong>Satz</strong>.</p>';
  assert.equal(apiValueToCell(html, field({ slug: 'b', type: 'RichText' })), html);
});

// ─── Field planning ───────────────────────────────────────────────────────────

test('planApiFields: every Webflow type maps to the ycode type upstream declares', () => {
  const expected: Record<string, string> = {
    PlainText: 'text', RichText: 'rich_text', Image: 'image', MultiImage: 'image',
    Video: 'text', Link: 'text', Email: 'email', Phone: 'phone', Number: 'number',
    DateTime: 'date', Date: 'date_only', Switch: 'boolean', Color: 'color',
    Option: 'option', Reference: 'reference', MultiReference: 'multi_reference',
    File: 'document', Set: 'text', User: 'text',
  };
  // The local type list must not drift from upstream's FIELD_TYPE_MAP.
  assert.deepEqual([...KNOWN_WEBFLOW_FIELD_TYPES].sort(), Object.keys(expected).sort());
  for (const [wf, ycode] of Object.entries(expected)) assert.equal(getCmsFieldType(wf), ycode, wf);
  // Anything outside the set silently becomes text upstream — which is why the set exists.
  assert.equal(getCmsFieldType('GeoPoint'), 'text');
});

test('planApiFields: built-ins become keyed Name / Slug, custom fields stay editable', () => {
  const collection: WebflowCollection = {
    id: COLLECTION, displayName: 'Werke', singularName: 'Werk', slug: 'werke',
    fields: [
      field({ slug: 'name', type: 'PlainText', displayName: 'Name' }),
      field({ slug: 'slug', type: 'PlainText', displayName: 'Slug' }),
      field({ slug: 'jahr', type: 'Number', displayName: 'Jahr' }),
    ],
  };
  const plans = planApiFields(collection);
  assert.deepEqual(plans.map((p) => [p.header, p.key, p.type, p.system]), [
    ['Name', 'name', 'text', true],
    ['Slug', 'slug', 'text', true],
    ['jahr', null, 'number', false],
  ]);
  assert.equal(plans.every((p) => p.guessed === false), true, 'API types are never guessed');
});

test('planApiFields: MultiImage is multiple, references carry their target, Option its choices', () => {
  const collection: WebflowCollection = {
    id: COLLECTION, displayName: 'Werke', singularName: 'Werk', slug: 'werke',
    fields: [
      field({ slug: 'bilder', type: 'MultiImage', displayName: 'Bilder' }),
      field({ slug: 'ausstellung', type: 'MultiReference', displayName: 'Ausstellungen', validations: { collectionId: 'abc123' } }),
      field({ slug: 'kategorie', type: 'Option', displayName: 'Kategorie', validations: { options: [{ id: 'o1', name: 'Malerei' }] } }),
    ],
  };
  const [images, refs, option] = planApiFields(collection);
  assert.equal(images.multiple, true);
  assert.equal(refs.type, 'multi_reference');
  assert.equal(refs.referenceTargetWebflowId, 'abc123');
  assert.equal(option.type, 'option');
  assert.deepEqual(option.options, [{ id: 'o1', name: 'Malerei' }]);
});

test('planApiFields: a field slug that collides with a meta column is namespaced away', () => {
  const collection: WebflowCollection = {
    id: COLLECTION, displayName: 'X', singularName: 'X', slug: 'x',
    fields: [field({ slug: 'Item ID', type: 'PlainText', displayName: 'Item ID' })],
  };
  const [plan] = planApiFields(collection);
  assert.equal(plan.header, 'wf-Item ID');
});

test('planApiFields: an unknown field type is imported as text and reported', () => {
  const warn = new Warnings();
  const collection: WebflowCollection = {
    id: COLLECTION, displayName: 'X', singularName: 'X', slug: 'x',
    fields: [field({ slug: 'geo', type: 'GeoPoint' as never, displayName: 'Geo' })],
  };
  const [plan] = planApiFields(collection, warn);
  assert.equal(plan.type, 'text');
  assert.equal(warn.count('cms_api_partial'), 1);
});

test('planApiFields: a reference without a target collection is reported', () => {
  const warn = new Warnings();
  const collection: WebflowCollection = {
    id: COLLECTION, displayName: 'X', singularName: 'X', slug: 'x',
    fields: [field({ slug: 'ref', type: 'Reference', displayName: 'Ref' })],
  };
  planApiFields(collection, warn);
  assert.equal(warn.count('cms_api_partial'), 1);
});

// ─── Collection plan ──────────────────────────────────────────────────────────

const WERKE: WebflowCollection = {
  id: COLLECTION,
  displayName: 'Werke',
  singularName: 'Werk',
  slug: 'werke',
  fields: [
    field({ slug: 'name', type: 'PlainText', displayName: 'Name' }),
    field({ slug: 'slug', type: 'PlainText', displayName: 'Slug' }),
    field({ slug: 'jahr', type: 'Number', displayName: 'Jahr' }),
    field({ slug: 'bilder', type: 'MultiImage', displayName: 'Bilder' }),
    field({ slug: 'kategorie', type: 'Option', displayName: 'Kategorie', validations: { options: [{ id: 'o1', name: 'Malerei' }] } }),
  ],
};

const ITEMS: WebflowItem[] = [
  {
    id: 'itm-1',
    createdOn: '2024-01-02T09:00:00Z',
    lastUpdated: '2024-02-02T09:00:00Z',
    lastPublished: '2024-02-03T09:00:00Z',
    isArchived: false,
    isDraft: false,
    fieldData: {
      name: 'Südinsel',
      slug: 'suedinsel',
      jahr: 1998,
      bilder: [{ url: 'https://cdn.prod.website-files.com/x/one.jpg' }, { url: 'https://cdn.prod.website-files.com/x/two.jpg' }],
      kategorie: 'o1',
    },
  },
  {
    id: 'itm-2',
    createdOn: '2024-01-03T09:00:00Z',
    lastUpdated: '2024-01-03T09:00:00Z',
    lastPublished: null,
    isArchived: false,
    isDraft: true,
    fieldData: { name: 'Entwurf', slug: 'entwurf' },
  },
];

test('buildApiCollectionPlan: rows match the CSV row contract importCms reads', () => {
  const plan = buildApiCollectionPlan(WERKE, ITEMS, 0);
  assert.equal(plan.csv.name, 'Werke');
  assert.equal(plan.csv.webflowId, COLLECTION);
  assert.equal(plan.csv.rows.length, 2);

  const [first, second] = plan.csv.rows;
  assert.equal(first['Item ID'], 'itm-1');
  assert.equal(first['Name'], 'Südinsel');
  assert.equal(first['Slug'], 'suedinsel');
  assert.equal(first['jahr'], '1998');
  assert.equal(first['bilder'], 'https://cdn.prod.website-files.com/x/one.jpg;https://cdn.prod.website-files.com/x/two.jpg');
  assert.equal(first['kategorie'], 'Malerei');
  assert.equal(first['Created On'], '2024-01-02T09:00:00.000Z');
  assert.equal(first['Published On'], '2024-02-03T09:00:00.000Z');
  assert.equal(first['Draft'], 'false');

  // isPublishableRow is the CSV path's own gate — the synthesised rows drive it unchanged.
  assert.equal(isPublishableRow(first), true);
  assert.equal(isPublishableRow(second), false, 'a draft item is not publishable');
  assert.equal(second['jahr'], '', 'an unset field is an empty cell, not "undefined"');
});

test('buildApiCollectionPlan: an item with neither name nor slug is reported', () => {
  const warn = new Warnings();
  buildApiCollectionPlan(WERKE, [{ id: 'itm-3', fieldData: {} } as WebflowItem], 0, warn);
  assert.equal(warn.count('cms_api_partial'), 1);
});

// ─── Site id discovery ────────────────────────────────────────────────────────

test('discoverSiteId: reads data-wf-site from the export', () => {
  assert.equal(discoverSiteId(['<html data-wf-domain="x.webflow.io" data-wf-page="p" data-wf-site="696E3D580D900572C87F065A">']), SITE);
  assert.equal(discoverSiteId(['<html lang="de">', `<html data-wf-site="${SITE}">`]), SITE);
  assert.equal(discoverSiteId(['<html lang="de">']), null);
  assert.equal(discoverSiteId([]), null);
});

// ─── Client ───────────────────────────────────────────────────────────────────

const GUARDED = { url: WEBFLOW_API_BASE, guarded: true } as const;

test('client: GETs the documented endpoints with the bearer token and API version', async () => {
  const { impl, calls } = stubFetch([
    { match: /\/sites\/[^/]+$/, body: { id: SITE, displayName: 'Valeska' } },
    { match: /\/sites\/[^/]+\/collections$/, body: { collections: [{ id: COLLECTION, displayName: 'Werke', slug: 'werke' }] } },
    { match: /\/collections\/[^/?]+$/, body: WERKE },
  ]);
  const client = createWebflowApiClient({ token: TOKEN, siteId: SITE, fetchImpl: impl, lookupImpl: publicLookup, base: GUARDED });

  const site = await client.getSite();
  assert.equal(site.displayName, 'Valeska');
  const collections = await client.listCollections();
  assert.equal(collections.length, 1);
  await client.getCollection(COLLECTION);

  assert.deepEqual(calls.map((c) => c.url), [
    `${WEBFLOW_API_BASE}/sites/${SITE}`,
    `${WEBFLOW_API_BASE}/sites/${SITE}/collections`,
    `${WEBFLOW_API_BASE}/collections/${COLLECTION}`,
  ]);
  for (const call of calls) {
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers['accept-version'], '2.0.0');
  }
});

test('client: listAllItems drains Webflow pagination', async () => {
  const page = (n: number, count: number) => ({ items: Array.from({ length: count }, (_, i) => ({ id: `itm-${n}-${i}`, fieldData: {} })) });
  const seen: string[] = [];
  const impl = (async (input: string | URL) => {
    const url = String(input);
    seen.push(url);
    const offset = Number(new URL(url).searchParams.get('offset'));
    const body = offset === 0 ? page(0, 100) : offset === 100 ? page(1, 100) : page(2, 7);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const client = createWebflowApiClient({ token: TOKEN, siteId: SITE, fetchImpl: impl, lookupImpl: publicLookup, base: GUARDED });
  const items = await client.listAllItems(COLLECTION);
  assert.equal(items.length, 207);
  assert.equal(seen.length, 3);
  assert.match(seen[1], /offset=100/);
});

test('client: 401 / 403 / 404 keep their status so the caller can explain them', async () => {
  for (const status of [401, 403, 404]) {
    const { impl } = stubFetch([{ match: /./, status, body: { message: 'nope' } }]);
    const client = createWebflowApiClient({ token: TOKEN, siteId: SITE, fetchImpl: impl, lookupImpl: publicLookup, base: GUARDED });
    await assert.rejects(client.getSite(), (error: unknown) => error instanceof WebflowApiError && error.status === status);
  }
});

test('client: 429 backs off for Retry-After and retries, then gives up', async () => {
  const waits: number[] = [];
  let attempts = 0;
  const impl = (async () => {
    attempts++;
    return new Response('{"message":"rate limit"}', { status: 429, headers: { 'retry-after': '2', 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const client = createWebflowApiClient({
    token: TOKEN, siteId: SITE, fetchImpl: impl, lookupImpl: publicLookup, base: GUARDED,
    maxAttempts: 3, sleep: async (ms) => { waits.push(ms); },
  });
  await assert.rejects(client.getSite(), (error: unknown) => error instanceof WebflowApiError && error.status === 429);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [2000, 2000], 'waits between attempts, not after the last one');
});

test('client: a 429 that clears is retried transparently', async () => {
  let attempts = 0;
  const impl = (async () => {
    attempts++;
    if (attempts === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '1', 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: SITE, displayName: 'Valeska' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const client = createWebflowApiClient({ token: TOKEN, siteId: SITE, fetchImpl: impl, lookupImpl: publicLookup, base: GUARDED, sleep: async () => {} });
  assert.equal((await client.getSite()).displayName, 'Valeska');
  assert.equal(attempts, 2);
});

test('client: the token never appears in an error, even when the API echoes it', async () => {
  const { impl } = stubFetch([{ match: /./, status: 400, body: { message: `bad token ${TOKEN} supplied` } }]);
  const client = createWebflowApiClient({ token: TOKEN, siteId: SITE, fetchImpl: impl, lookupImpl: publicLookup, base: GUARDED });
  await assert.rejects(client.getSite(), (error: unknown) => {
    const message = (error as Error).message;
    assert.equal(message.includes(TOKEN), false, message);
    assert.match(message, /<redacted>/);
    return true;
  });
});

test('redactToken leaves short strings alone and scrubs real tokens', () => {
  assert.equal(redactToken('x abc y', 'abc'), 'x abc y');
  assert.equal(redactToken(`x ${TOKEN} y`, TOKEN), 'x <redacted> y');
});

test('client: the safe-fetch guard blocks a host that is not Webflow', async () => {
  let fetched = false;
  const impl = (async () => { fetched = true; return new Response('{}'); }) as unknown as typeof fetch;
  const client = createWebflowApiClient({
    token: TOKEN, siteId: SITE, fetchImpl: impl, lookupImpl: publicLookup,
    base: { url: 'https://api.evil.example/v2', guarded: true },
  });
  await assert.rejects(client.getSite(), (error: unknown) => error instanceof WebflowApiError && /not in the allowlist/.test(error.message));
  assert.equal(fetched, false, 'the request is never sent');
});

test('client: the guard also blocks a Webflow hostname that resolves to a private address', async () => {
  const impl = (async () => new Response('{}')) as unknown as typeof fetch;
  const client = createWebflowApiClient({
    token: TOKEN, siteId: SITE, fetchImpl: impl, base: GUARDED,
    lookupImpl: async () => [{ address: '127.0.0.1' }],
  });
  await assert.rejects(client.getSite(), (error: unknown) => error instanceof WebflowApiError && /not a public|non-public/.test(error.message));
});

test('client: an id that would escape the API path is refused before any request', async () => {
  let fetched = false;
  const impl = (async () => { fetched = true; return new Response('{}'); }) as unknown as typeof fetch;
  assert.throws(
    () => createWebflowApiClient({ token: TOKEN, siteId: '../../admin', fetchImpl: impl, base: GUARDED }),
    (error: unknown) => error instanceof WfImportError && error.code === 'webflow_api_bad_id',
  );
  const client = createWebflowApiClient({ token: TOKEN, siteId: SITE, fetchImpl: impl, lookupImpl: publicLookup, base: GUARDED });
  await assert.rejects(client.getCollection('a/b'), (error: unknown) => error instanceof WfImportError && error.code === 'webflow_api_bad_id');
  assert.equal(fetched, false);
});

test('client: an empty token is refused up front', () => {
  assert.throws(
    () => createWebflowApiClient({ token: '   ', siteId: SITE }),
    (error: unknown) => error instanceof WfImportError && error.code === 'webflow_api_no_token',
  );
});

test('resolveApiBase: the stub override is ignored in production', () => {
  assert.deepEqual(resolveApiBase({ NODE_ENV: 'production', WEBWOW_WEBFLOW_API_BASE: 'http://127.0.0.1:9/v2' }), { url: WEBFLOW_API_BASE, guarded: true });
  assert.deepEqual(resolveApiBase({ NODE_ENV: 'development', WEBWOW_WEBFLOW_API_BASE: 'http://127.0.0.1:9/v2/' }), { url: 'http://127.0.0.1:9/v2', guarded: false });
  assert.deepEqual(resolveApiBase({ NODE_ENV: 'development' }), { url: WEBFLOW_API_BASE, guarded: true });
});

// ─── fetchCmsFromApi ──────────────────────────────────────────────────────────

const FAKE_CLIENT = {
  getSite: async () => ({ id: SITE, displayName: 'Valeska von Brase', shortName: 'valeska' }),
  listCollections: async () => [{ id: COLLECTION, displayName: 'Werke', singularName: 'Werk', slug: 'werke' }],
  getCollection: async () => WERKE,
  listAllItems: async () => ITEMS,
};

test('fetchCmsFromApi: discovers the site id from the export when none was entered', async () => {
  const result = await fetchCmsFromApi({
    credentials: { token: TOKEN },
    pageHtml: [`<html data-wf-site="${SITE}" data-wf-page="p">`],
    client: FAKE_CLIENT,
  });
  assert.equal(result.siteId, SITE);
  assert.equal(result.siteName, 'Valeska von Brase');
  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0].csv.rows.length, 2);
});

test('fetchCmsFromApi: no site id anywhere is a clean failure', async () => {
  await assert.rejects(
    fetchCmsFromApi({ credentials: { token: TOKEN }, pageHtml: ['<html lang="de">'], client: FAKE_CLIENT }),
    (error: unknown) => error instanceof WfImportError && error.code === 'webflow_api_no_site',
  );
});

test('fetchCmsFromApi: one unreadable collection is skipped, not fatal', async () => {
  const warn = new Warnings();
  const result = await fetchCmsFromApi({
    credentials: { token: TOKEN, siteId: SITE },
    warn,
    client: {
      ...FAKE_CLIENT,
      listCollections: async () => [
        { id: COLLECTION, displayName: 'Werke', singularName: 'Werk', slug: 'werke' },
        { id: 'deadbeefdeadbeefdeadbeef', displayName: 'Weg', singularName: 'Weg', slug: 'weg' },
      ],
      getCollection: async (id: string) => {
        if (id !== COLLECTION) throw new WebflowApiError(404, `/collections/${id}`, 'gone');
        return WERKE;
      },
    },
  });
  assert.equal(result.plans.length, 1, 'the readable collection still imports');
  assert.equal(warn.count('cms_api_partial'), 1);
  assert.match(warn.list[0].message, /"Weg" could not be read/);
});

test('fetchCmsFromApi: a collection at the paging cap is reported as truncated', async () => {
  const warn = new Warnings();
  const many = Array.from({ length: MAX_ITEMS_PER_COLLECTION }, (_, i) => ({ id: `itm-${i}`, fieldData: { name: `n${i}`, slug: `s${i}` } }));
  await fetchCmsFromApi({
    credentials: { token: TOKEN, siteId: SITE },
    warn,
    client: { ...FAKE_CLIENT, listAllItems: async () => many },
  });
  assert.equal(warn.count('cms_api_partial'), 1);
  assert.match(warn.list[0].message, /only the first 10000 were read/);
});

test('fetchCmsFromApi: API failures become user-facing import errors', async () => {
  const cases: [number, string][] = [
    [401, 'webflow_api_unauthorized'],
    [403, 'webflow_api_forbidden'],
    [404, 'webflow_api_not_found'],
    [429, 'webflow_api_rate_limited'],
    [500, 'webflow_api_failed'],
  ];
  for (const [status, code] of cases) {
    await assert.rejects(
      fetchCmsFromApi({
        credentials: { token: TOKEN, siteId: SITE },
        client: { ...FAKE_CLIENT, getSite: async () => { throw new WebflowApiError(status, `/sites/${SITE}`, 'boom'); } },
      }),
      (error: unknown) => {
        assert.ok(error instanceof WfImportError, `${status} produced ${error}`);
        assert.equal((error as WfImportError).code, code);
        assert.equal((error as Error).message.includes(TOKEN), false);
        return true;
      },
    );
  }
});

// ─── Merge ────────────────────────────────────────────────────────────────────

function csvPlan(name: string, webflowId: string | null, rows = 1): WfCollectionPlan {
  return {
    csv: { name, webflowId, filename: `${name}.csv`, headers: ['Name', 'Slug'], rows: Array.from({ length: rows }, (_, i) => ({ Name: `${name} ${i}`, Slug: `${name}-${i}` })), order: 0 },
    fields: [{ header: 'Name', name: 'Name', key: 'name', type: 'text', system: true, guessed: false, reason: 'built-in name' }],
  };
}

test('mergeCmsPlans: no API plans leaves the CSV path untouched', () => {
  const csv = [csvPlan('Werke', COLLECTION)];
  const merged = mergeCmsPlans({ csvPlans: csv, apiPlans: [] });
  assert.equal(merged.source, 'csv');
  assert.equal(merged.plans[0], csv[0]);
});

test('mergeCmsPlans: the API wins for the same collection id', () => {
  const api = buildApiCollectionPlan(WERKE, ITEMS, 0);
  const merged = mergeCmsPlans({ csvPlans: [csvPlan('Werke alt', COLLECTION)], apiPlans: [api] });
  assert.equal(merged.source, 'api');
  assert.equal(merged.plans.length, 1);
  assert.equal(merged.plans[0].csv.rows.length, 2);
  assert.equal(merged.plans[0].csv.webflowId, COLLECTION);
});

test('mergeCmsPlans: falls back to a name match when the CSV carries no id', () => {
  const api = buildApiCollectionPlan(WERKE, ITEMS, 0);
  const merged = mergeCmsPlans({ csvPlans: [csvPlan('werke', null)], apiPlans: [api] });
  assert.equal(merged.plans.length, 1);
  assert.equal(merged.plans[0].csv.rows.length, 2);

  // Webflow pluralises the collection name but not the singular one, so the
  // match tolerates a trailing "s" — the same rule `cms.ts` uses for CSVs.
  const posts = buildApiCollectionPlan({ ...WERKE, id: 'aaaabbbbccccddddeeeeffff', displayName: 'Posts', slug: 'posts' }, [], 0);
  assert.equal(mergeCmsPlans({ csvPlans: [csvPlan('Post', null)], apiPlans: [posts] }).plans.length, 1);
});

test('mergeCmsPlans: a CSV collection the API does not have still imports, and says so', () => {
  const warn = new Warnings();
  const api = buildApiCollectionPlan(WERKE, ITEMS, 0);
  const merged = mergeCmsPlans({ csvPlans: [csvPlan('Werke', COLLECTION), csvPlan('Presse', 'deadbeefdeadbeefdeadbeef')], apiPlans: [api], warn });
  assert.equal(merged.plans.length, 2);
  assert.equal(merged.source, 'mixed');
  assert.equal(warn.count('cms_api_partial'), 1);
  assert.match(warn.list.find((w) => w.code === 'cms_api_partial')!.message, /Presse/);
});

test('mergeCmsPlans: an API collection nothing in the export references is imported and reported', () => {
  const warn = new Warnings();
  const api = buildApiCollectionPlan(WERKE, ITEMS, 0);
  const merged = mergeCmsPlans({ csvPlans: [], apiPlans: [api], pageNames: ['index', 'about'], warn });
  assert.equal(merged.plans.length, 1);
  assert.equal(warn.count('cms_api_extra'), 1);
  assert.match(warn.list[0].message, /Werke/);
});

test('mergeCmsPlans: a detail_ page counts as the export referencing the collection', () => {
  const warn = new Warnings();
  const api = buildApiCollectionPlan(WERKE, ITEMS, 0);
  mergeCmsPlans({ csvPlans: [], apiPlans: [api], pageNames: ['index', 'detail_werke'], warn });
  assert.equal(warn.count('cms_api_extra'), 0);
});

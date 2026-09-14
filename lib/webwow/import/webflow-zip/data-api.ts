/**
 * Webflow Data API (REST v2) as an OPTIONAL, better CMS source.
 *
 * The ZIP export stays the source of truth for layout, CSS and interactions.
 * Its CMS half — the CSV files — is the weakest part of it: every column is a
 * string, so `cms.ts` has to *infer* the type of each field from its values and
 * warns (`csv_type_guess`) when it had to guess, an Option field is
 * indistinguishable from free text, and an empty column carries no type at all.
 * When the user supplies a Webflow API token, the same collections arrive as
 * canonical typed JSON instead: `MultiImage`, `MultiReference`, `RichText`,
 * `Option` (with its full choice list), `Date`/`DateTime`, `Number`, `Switch`.
 *
 * Discipline (kept from `origin/wip/zero-config-bridge`'s
 * `lib/services/webflow-data-api-client.ts`, which this adapts):
 *   - read-only: only GET, and only the four endpoints below;
 *   - request-scoped: the token lives in a closure for the duration of one
 *     import run. It is never written to the database (`route.ts` stores an
 *     empty payload), never logged, never put in a warning or an error message
 *     (`redactToken` scrubs anything the API echoes back), and never returned;
 *   - every request goes through `checkUrlSafety` — the URL half of v2's
 *     `safeFetch` guard: https only, no credentials in the URL, host on the
 *     allowlist (`api.webflow.com`), every resolved address public. `safeFetch`
 *     itself cannot be used here because it neither sends an `Authorization`
 *     header nor returns a parsed body.
 *
 * What this module does NOT do: it never replaces the CSV path. Without a token
 * nothing here runs. With one, API collections are merged over the CSV ones by
 * Webflow collection id (`mergeCmsPlans`), and a collection that exists only in
 * the CSV export still imports from the CSV.
 *
 * Output shape: `WfCollectionPlan[]`, i.e. exactly what `inferSchema` produces
 * from CSVs — so `importCms`, `binding.ts` and the whole downstream pipeline
 * run unchanged, and the two sources cannot drift apart. Values are serialised
 * into the same cell conventions the CSV uses (`;`-separated lists, asset URLs,
 * rich text as HTML), because that is the contract `importCms` already
 * implements: it splits image lists, re-hosts every asset URL through
 * `safeFetch`, resolves reference tokens against `Item ID` and converts rich
 * text with upstream's converter. Round-tripping through those conventions is
 * what keeps one persistence path for both sources.
 */

import { getCmsFieldType, isMultiAssetType, resolveOptionLabel } from '@/lib/apps/webflow/field-mapping';

import { checkUrlSafety } from './safe-fetch';
import { WfImportError } from './types';

import type { WebflowCollection, WebflowField, WebflowFieldType, WebflowItem, WebflowSite } from '@/lib/apps/webflow/types';
import type { WfCollectionPlan, WfCsvCollection, WfFieldPlan } from './cms';
import type { Warnings } from './warnings';

// ─── Client ───────────────────────────────────────────────────────────────────

export const WEBFLOW_API_BASE = 'https://api.webflow.com/v2';
export const WEBFLOW_API_VERSION = '2.0.0';

/** The only host the client may talk to in a deployed build. */
export const WEBFLOW_API_HOSTS: RegExp[] = [/^api\.webflow\.com$/i];

const DEFAULT_TIMEOUT_MS = 20_000;
/** Attempts per endpoint, including the first (so 4 = 1 try + 3 retries). */
const DEFAULT_MAX_ATTEMPTS = 4;
/** Webflow caps a page of items at 100. */
const ITEMS_PAGE_SIZE = 100;
/** Hard stop so a mis-behaving endpoint cannot page forever. */
export const MAX_ITEM_PAGES = 100;
/** Items a single collection can contribute before `listAllItems` stops paging. */
export const MAX_ITEMS_PER_COLLECTION = MAX_ITEM_PAGES * ITEMS_PAGE_SIZE;

export class WebflowApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly detail: string,
  ) {
    super(`Webflow API ${status || 'request'} on ${endpoint}${detail ? `: ${detail}` : ''}`);
    this.name = 'WebflowApiError';
  }
}

/** Replace every occurrence of the token with `<redacted>`. Applied to anything that can reach a log, a warning or the response. */
export function redactToken(text: string, token: string): string {
  const t = token.trim();
  if (t.length < 8) return text;
  return text.split(t).join('<redacted>');
}

export interface WebflowApiBase {
  url: string;
  /** False only for the non-production stub override — see `resolveApiBase`. */
  guarded: boolean;
}

/**
 * The API base URL. In production this is always Webflow's own host and the
 * full SSRF guard applies. `WEBWOW_WEBFLOW_API_BASE` redirects the client at a
 * local stub (the API is not reachable from CI or a sandbox) and is honoured
 * **only** when `NODE_ENV !== 'production'`, so a deployed build cannot be
 * pointed anywhere else by an environment variable.
 */
export function resolveApiBase(env: Record<string, string | undefined> = process.env): WebflowApiBase {
  const override = (env.WEBWOW_WEBFLOW_API_BASE ?? '').trim();
  if (override && env.NODE_ENV !== 'production') return { url: override.replace(/\/+$/, ''), guarded: false };
  return { url: WEBFLOW_API_BASE, guarded: true };
}

export interface WebflowApiClient {
  getSite(): Promise<WebflowSite>;
  listCollections(): Promise<WebflowCollection[]>;
  getCollection(collectionId: string): Promise<WebflowCollection>;
  listAllItems(collectionId: string): Promise<WebflowItem[]>;
}

export interface CreateWebflowApiClientOptions {
  token: string;
  siteId: string;
  /** Injectable for tests / the local stub. */
  fetchImpl?: typeof fetch;
  lookupImpl?: (host: string) => Promise<{ address: string }[]>;
  base?: WebflowApiBase;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Injectable so the 429 back-off can be tested without waiting. */
  sleep?: (ms: number) => Promise<void>;
}

/** Webflow object ids are 24-hex, but a segment is validated only for shape — anything else would end up in a URL path. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function idSegment(kind: string, value: string): string {
  const v = (value ?? '').trim();
  if (!ID_RE.test(v)) {
    throw new WfImportError('webflow_api_bad_id', `"${v.slice(0, 40)}" is not a valid Webflow ${kind} id`);
  }
  return encodeURIComponent(v);
}

function detailFrom(body: unknown, fallback: string): string {
  if (typeof body === 'string') return body.slice(0, 300).trim() || fallback;
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['message', 'msg', 'error', 'details']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 300);
    }
  }
  return fallback;
}

const RETRYABLE = new Set([429, 502, 503, 504]);

/**
 * A read-only, request-scoped client. Nothing about the token escapes this
 * closure: it is written into one header and scrubbed out of every message.
 */
export function createWebflowApiClient(opts: CreateWebflowApiClientOptions): WebflowApiClient {
  const token = opts.token.trim();
  const siteId = opts.siteId.trim();
  if (!token) throw new WfImportError('webflow_api_no_token', 'A Webflow API token is required');
  if (!siteId) throw new WfImportError('webflow_api_no_site', 'A Webflow site id is required');

  const base = opts.base ?? resolveApiBase();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const site = idSegment('site', siteId);

  async function guard(url: URL, endpoint: string): Promise<void> {
    if (base.guarded) {
      const problem = await checkUrlSafety(url, WEBFLOW_API_HOSTS, opts.lookupImpl);
      if (problem) throw new WebflowApiError(0, endpoint, `request blocked: ${problem}`);
      return;
    }
    // Stub mode: the host is deliberately not public, but the protocol and
    // credential rules still hold so a malformed override cannot leak the token
    // into a URL or send it over plain text to an arbitrary scheme.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new WebflowApiError(0, endpoint, `unsupported protocol ${url.protocol}`);
    if (url.username || url.password) throw new WebflowApiError(0, endpoint, 'URLs with credentials are not allowed');
  }

  async function call<T>(endpoint: string): Promise<T> {
    let url: URL;
    try {
      url = new URL(`${base.url}${endpoint}`);
    } catch {
      throw new WebflowApiError(0, endpoint, 'invalid API URL');
    }

    let lastRetryable: WebflowApiError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await guard(url, endpoint);

      let response: Response;
      try {
        response = await fetchImpl(url.toString(), {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            authorization: `Bearer ${token}`,
            'accept-version': WEBFLOW_API_VERSION,
            accept: 'application/json',
          },
        });
      } catch (error) {
        const raw = error instanceof Error ? (error.name === 'TimeoutError' || error.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : error.message) : String(error);
        throw new WebflowApiError(0, endpoint, redactToken(raw, token));
      }

      if (RETRYABLE.has(response.status)) {
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
        const waitMs = Math.min(Math.max(Number.isFinite(retryAfter) ? retryAfter : attempt, 1), 30) * 1000;
        try {
          await response.body?.cancel();
        } catch {
          // ignore
        }
        lastRetryable = new WebflowApiError(response.status, endpoint, response.status === 429 ? 'rate limited' : 'temporarily unavailable');
        if (attempt < maxAttempts) {
          await sleep(waitMs);
          continue;
        }
        throw lastRetryable;
      }

      if (!response.ok) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = await response.text().catch(() => '');
        }
        throw new WebflowApiError(response.status, endpoint, redactToken(detailFrom(body, `HTTP ${response.status}`), token));
      }

      try {
        return (await response.json()) as T;
      } catch {
        throw new WebflowApiError(response.status, endpoint, 'response was not valid JSON');
      }
    }
    throw lastRetryable ?? new WebflowApiError(0, endpoint, 'request failed');
  }

  return {
    getSite: () => call<WebflowSite>(`/sites/${site}`),

    async listCollections() {
      const data = await call<{ collections?: WebflowCollection[] }>(`/sites/${site}/collections`);
      return data.collections ?? [];
    },

    // `async` so a malformed id rejects rather than throwing synchronously out
    // of a method whose signature promises otherwise.
    async getCollection(collectionId: string) {
      return call<WebflowCollection>(`/collections/${idSegment('collection', collectionId)}`);
    },

    async listAllItems(collectionId: string) {
      const id = idSegment('collection', collectionId);
      const all: WebflowItem[] = [];
      let offset = 0;
      for (let page = 0; page < MAX_ITEM_PAGES; page++) {
        const data = await call<{ items?: WebflowItem[] }>(`/collections/${id}/items?limit=${ITEMS_PAGE_SIZE}&offset=${offset}`);
        const batch = data.items ?? [];
        all.push(...batch);
        if (batch.length < ITEMS_PAGE_SIZE) break;
        offset += batch.length;
      }
      return all;
    },
  };
}

// ─── Site id discovery ────────────────────────────────────────────────────────

/** Every page of a Webflow export carries `<html … data-wf-site="<24 hex>">`. */
const WF_SITE_RE = /data-wf-site\s*=\s*"([0-9a-fA-F]{24})"/;

/** The site id the export was published from, or null when no page declares one. */
export function discoverSiteId(pageHtml: Iterable<string>): string | null {
  for (const html of pageHtml) {
    const match = html.match(WF_SITE_RE);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

// ─── Field → plan ─────────────────────────────────────────────────────────────

/**
 * The Webflow field types upstream's `getCmsFieldType` knows
 * (`lib/apps/webflow/field-mapping.ts` `FIELD_TYPE_MAP`, which is not
 * exported). Anything outside this set silently becomes `text` there, so it is
 * listed here to raise a `cms_api_partial` warning instead of importing a
 * mystery column. `data-api.test.ts` asserts the set still matches.
 */
export const KNOWN_WEBFLOW_FIELD_TYPES: ReadonlySet<string> = new Set<WebflowFieldType>([
  'PlainText', 'RichText', 'Image', 'MultiImage', 'Video', 'Link', 'Email', 'Phone',
  'Number', 'DateTime', 'Date', 'Switch', 'Color', 'Option', 'Reference', 'MultiReference',
  'File', 'Set', 'User',
]);

/** Webflow's own built-in fields; they become ycode's keyed `Name` / `Slug`. */
const SYSTEM_SLUGS: Record<string, { key: 'name' | 'slug'; header: 'Name' | 'Slug' }> = {
  name: { key: 'name', header: 'Name' },
  slug: { key: 'slug', header: 'Slug' },
};

/** Row keys `importCms` reads directly; a field header may never collide with one. */
const RESERVED_HEADERS = new Set(['Collection ID', 'Locale ID', 'Item ID', 'Archived', 'Draft', 'Created On', 'Updated On', 'Published On', 'Name', 'Slug']);

function assetUrlOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const url = (value as Record<string, unknown>).url;
    if (typeof url === 'string') return url.trim();
  }
  return '';
}

function isoOrEmpty(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString();
}

/**
 * One `fieldData` value → the CSV cell convention `importCms` consumes.
 *
 * Not upstream's `transformFieldValue`: that produces the *final* stored value
 * (TipTap JSON for rich text, a JSON array for multi-reference), which would
 * bypass `importCms`'s asset re-hosting, its reference resolution and its rich
 * text image rewriting. The cell conventions are the seam the CSV path already
 * defines — `;` separates a list, an asset is its URL, rich text is HTML.
 */
export function apiValueToCell(value: unknown, field: WebflowField): string {
  if (value === null || value === undefined) return '';

  switch (field.type) {
    case 'RichText':
      return typeof value === 'string' ? value : '';

    case 'Number':
      if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
      if (typeof value === 'string') {
        const parsed = Number.parseFloat(value.trim());
        return Number.isFinite(parsed) ? String(parsed) : '';
      }
      return '';

    case 'Switch':
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      if (typeof value === 'string') return /^(true|1|yes|y|on)$/i.test(value.trim()) ? 'true' : 'false';
      return value ? 'true' : 'false';

    case 'Date':
    case 'DateTime':
      return isoOrEmpty(value);

    case 'Option':
      return typeof value === 'string' && value ? resolveOptionLabel(value, field.validations?.options) : '';

    case 'Reference':
      return typeof value === 'string' ? value.trim() : '';

    case 'MultiReference':
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && !!id.trim()).map((id) => id.trim()).join(';') : '';

    case 'Image':
    case 'File':
      return assetUrlOf(value);

    case 'MultiImage':
      return Array.isArray(value) ? value.map(assetUrlOf).filter(Boolean).join(';') : assetUrlOf(value);

    case 'Video':
      return assetUrlOf(value);

    case 'Set':
      return Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(';') : String(value);

    case 'PlainText':
    case 'Email':
    case 'Phone':
    case 'Color':
    case 'Link':
    case 'User':
      return typeof value === 'string' ? value : String(value);

    default:
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return JSON.stringify(value);
  }
}

export interface ApiFieldPlan extends WfFieldPlan {
  /** The Webflow field this came from — the row builder needs its `slug` and `type`. */
  api: WebflowField;
}

/** A field plan per Webflow field, in Webflow's own field order. `null` for a field we refuse to import. */
export function planApiFields(collection: WebflowCollection, warn?: Warnings): ApiFieldPlan[] {
  const out: ApiFieldPlan[] = [];
  const used = new Set<string>();
  const label = collection.displayName || collection.slug || collection.id;

  for (const field of collection.fields ?? []) {
    const system = SYSTEM_SLUGS[field.slug];
    if (system) {
      out.push({ header: system.header, name: system.header, key: system.key, type: 'text', system: true, guessed: false, reason: `Webflow API built-in ${field.slug}`, api: field });
      used.add(system.header);
      continue;
    }

    if (!KNOWN_WEBFLOW_FIELD_TYPES.has(field.type)) {
      warn?.add('cms_api_partial', `${label}.${field.displayName}: Webflow field type ${field.type} has no ycode equivalent; imported as text`);
    }

    // The header is only a row key, so the field slug (unique per collection by
    // Webflow's own rules) is the safest choice; a collision with one of the
    // meta columns `importCms` reads by name is namespaced away.
    let header = RESERVED_HEADERS.has(field.slug) ? `wf-${field.slug}` : field.slug;
    let n = 2;
    while (used.has(header)) header = `${field.slug}-${n++}`;
    used.add(header);

    const type = getCmsFieldType(field.type);
    const plan: ApiFieldPlan = {
      header,
      name: (field.displayName || field.slug).trim(),
      key: null,
      type,
      system: false,
      guessed: false,
      reason: `Webflow API type ${field.type}`,
      api: field,
    };
    if (isMultiAssetType(field.type)) plan.multiple = true;
    if (type === 'reference' || type === 'multi_reference') {
      plan.referenceTargetWebflowId = field.validations?.collectionId ?? null;
      if (!plan.referenceTargetWebflowId) {
        warn?.add('cms_api_partial', `${label}.${plan.name}: ${field.type} field names no target collection; imported as text`);
      }
    }
    if (field.type === 'Option') {
      const options = (field.validations?.options ?? []).map((o) => ({ id: o.id, name: o.name.trim() })).filter((o) => o.name);
      if (options.length > 0) plan.options = options;
    }
    out.push(plan);
  }

  return out;
}

/** The meta columns every synthesised row carries, matching the CSV export's own names. */
function metaRow(item: WebflowItem): Record<string, string> {
  return {
    'Item ID': item.id,
    'Archived': item.isArchived ? 'true' : 'false',
    'Draft': item.isDraft ? 'true' : 'false',
    'Created On': isoOrEmpty(item.createdOn),
    'Updated On': isoOrEmpty(item.lastUpdated),
    'Published On': isoOrEmpty(item.lastPublished),
  };
}

/**
 * One API collection + its items → the same `WfCollectionPlan` shape
 * `inferSchema` builds from a CSV, so `importCms` cannot tell the two apart.
 */
export function buildApiCollectionPlan(collection: WebflowCollection, items: WebflowItem[], order: number, warn?: Warnings): WfCollectionPlan {
  const fields = planApiFields(collection, warn);
  const headers = ['Item ID', 'Archived', 'Draft', 'Created On', 'Updated On', 'Published On', ...fields.map((f) => f.header)];

  const rows = items.map((item, index) => {
    const data = (item.fieldData ?? {}) as Record<string, unknown>;
    const row: Record<string, string> = metaRow(item);
    row['Name'] = typeof data.name === 'string' ? data.name : '';
    row['Slug'] = typeof data.slug === 'string' ? data.slug : '';
    for (const field of fields) {
      if (field.system) continue;
      row[field.header] = apiValueToCell(data[field.api.slug], field.api);
    }
    if (!row['Name'] && !row['Slug']) {
      warn?.add('cms_api_partial', `${collection.displayName || collection.slug}: item ${index + 1} (${item.id}) has neither name nor slug`);
    }
    return row;
  });

  const csv: WfCsvCollection = {
    name: (collection.displayName || collection.singularName || collection.slug || 'Collection').trim(),
    webflowId: collection.id ? collection.id.toLowerCase() : null,
    filename: `webflow-api:${collection.slug || collection.id}`,
    headers,
    rows,
    order,
  };

  return { csv, fields };
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export interface WfDataApiCredentials {
  token: string;
  /** Optional; discovered from the export's `data-wf-site` when absent. */
  siteId?: string;
}

export interface FetchCmsFromApiOptions {
  credentials: WfDataApiCredentials;
  /** Page HTML from the export, used to discover the site id when none was given. */
  pageHtml?: Iterable<string>;
  warn?: Warnings;
  client?: WebflowApiClient;
  clientOptions?: Partial<CreateWebflowApiClientOptions>;
}

export interface WfApiCms {
  siteId: string;
  siteName: string;
  plans: WfCollectionPlan[];
}

/** Turn a `WebflowApiError` into the user-facing, machine-readable import failure. */
function toImportError(error: unknown, token: string): WfImportError {
  if (error instanceof WfImportError) return error;
  if (error instanceof WebflowApiError) {
    switch (error.status) {
      case 401:
        return new WfImportError('webflow_api_unauthorized', 'Webflow rejected the API token (401). Check that it was copied completely and has not been revoked.');
      case 403:
        return new WfImportError('webflow_api_forbidden', `Webflow refused the request (403). The token is valid but is missing a scope or does not cover this site — it needs "CMS: read" and "Sites: read". (${error.detail})`);
      case 404:
        return new WfImportError('webflow_api_not_found', `Webflow found nothing at ${error.endpoint} (404). Check the site id — it must be the site the export came from.`);
      case 429:
        return new WfImportError('webflow_api_rate_limited', 'Webflow rate-limited the import (429) and kept doing so after several waits. Try again in a minute, or import from the CSV export instead.');
      default:
        return new WfImportError('webflow_api_failed', redactToken(error.message, token));
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return new WfImportError('webflow_api_failed', redactToken(message, token));
}

/**
 * Read the site's whole CMS through the Data API. Throws `WfImportError` — the
 * caller runs this before the first database write, so a bad token, a missing
 * scope or a rate limit aborts the import without leaving anything behind.
 */
export async function fetchCmsFromApi(opts: FetchCmsFromApiOptions): Promise<WfApiCms> {
  const token = opts.credentials.token.trim();
  const warn = opts.warn;
  const siteId = (opts.credentials.siteId ?? '').trim() || discoverSiteId(opts.pageHtml ?? []) || '';
  if (!siteId) {
    throw new WfImportError('webflow_api_no_site', 'No Webflow site id: none was entered and no page in the export carries a data-wf-site attribute.');
  }

  const client = opts.client ?? createWebflowApiClient({ token, siteId, ...opts.clientOptions });

  try {
    const site = await client.getSite();
    const summaries = await client.listCollections();
    const plans: WfCollectionPlan[] = [];
    let order = 0;
    for (const summary of summaries) {
      const label = summary.displayName || summary.slug || summary.id;
      let collection: WebflowCollection;
      let items;
      try {
        // Per-collection failures are not fatal: a collection deleted between
        // the listing and the read, or one this token may not see, should cost
        // that collection — not the whole import, which by now has a valid site
        // and other collections worth having.
        const full = await client.getCollection(summary.id);
        collection = { ...summary, ...full };
        items = await client.listAllItems(summary.id);
      } catch (error) {
        const detail = error instanceof WebflowApiError ? `HTTP ${error.status}` : error instanceof Error ? redactToken(error.message, token) : String(error);
        warn?.add('cms_api_partial', `collection "${label}" could not be read from the Webflow API (${detail}); skipped`);
        continue;
      }
      if (items.length >= MAX_ITEMS_PER_COLLECTION) {
        warn?.add('cms_api_partial', `collection "${label}" has at least ${MAX_ITEMS_PER_COLLECTION} items; only the first ${MAX_ITEMS_PER_COLLECTION} were read`);
      }
      plans.push(buildApiCollectionPlan(collection, items, order++, warn));
    }
    return { siteId, siteName: site.displayName || site.shortName || siteId, plans };
  } catch (error) {
    throw toImportError(error, token);
  }
}

// ─── Merge with the CSV plans ─────────────────────────────────────────────────

export type WfCmsSource = 'csv' | 'api' | 'mixed';

export interface MergeCmsPlansOptions {
  csvPlans: WfCollectionPlan[];
  apiPlans: WfCollectionPlan[];
  /** Page basenames from the export — a `detail_<x>` page is evidence that the export uses collection `<x>`. */
  pageNames?: Iterable<string>;
  warn?: Warnings;
}

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** Webflow pluralises a collection's display name; `detail_werke` ↔ `Werke`, `detail_post` ↔ `Posts`. */
function looseMatch(a: string, b: string): boolean {
  const x = normalise(a);
  const y = normalise(b);
  if (!x || !y) return false;
  const strip = (s: string) => s.replace(/s$/, '');
  return x === y || strip(x) === y || x === strip(y) || strip(x) === strip(y);
}

/**
 * API collections win over the CSV for the same Webflow collection (matched by
 * collection id, then by name), CSV-only collections keep the CSV path, and
 * API-only collections are appended. Both directions are reported:
 *
 *   - a collection in the CSV export with no counterpart in the API — the token
 *     probably points at a different site, or the collection was deleted since
 *     the export;
 *   - a collection in the API that nothing in the export references (no CSV, no
 *     `detail_*` page) — imported anyway, because that is the point of the API
 *     source, but the user should know it appeared.
 */
export function mergeCmsPlans(opts: MergeCmsPlansOptions): { plans: WfCollectionPlan[]; source: WfCmsSource } {
  const { csvPlans, apiPlans, warn } = opts;
  if (apiPlans.length === 0) return { plans: csvPlans, source: 'csv' };

  const pages = [...(opts.pageNames ?? [])];
  const apiById = new Map(apiPlans.filter((p) => p.csv.webflowId).map((p) => [p.csv.webflowId!, p]));
  const claimed = new Set<WfCollectionPlan>();
  const plans: WfCollectionPlan[] = [];
  let replaced = 0;
  let csvOnly = 0;

  for (const csvPlan of csvPlans) {
    const match =
      (csvPlan.csv.webflowId ? apiById.get(csvPlan.csv.webflowId) : undefined)
      ?? apiPlans.find((p) => !claimed.has(p) && looseMatch(p.csv.name, csvPlan.csv.name));
    if (match && !claimed.has(match)) {
      claimed.add(match);
      plans.push({ ...match, csv: { ...match.csv, order: csvPlan.csv.order } });
      replaced++;
      continue;
    }
    csvOnly++;
    warn?.add('cms_api_partial', `collection "${csvPlan.csv.name}" from the CSV export has no counterpart in the Webflow API; imported from the CSV`);
    plans.push(csvPlan);
  }

  for (const apiPlan of apiPlans) {
    if (claimed.has(apiPlan)) continue;
    const referenced = pages.some((page) => /^detail[_-]/i.test(page) && looseMatch(page.replace(/^detail[_-]/i, ''), apiPlan.csv.name));
    if (!referenced) {
      warn?.add('cms_api_extra', `collection "${apiPlan.csv.name}" exists in the Webflow API but nothing in the export references it; imported anyway (${apiPlan.csv.rows.length} items)`);
    }
    plans.push({ ...apiPlan, csv: { ...apiPlan.csv, order: plans.length } });
  }

  const source: WfCmsSource = csvOnly > 0 && replaced + (apiPlans.length - claimed.size) > 0 ? 'mixed' : csvOnly > 0 ? 'csv' : 'api';
  return { plans, source };
}

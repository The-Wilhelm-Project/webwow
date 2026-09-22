/**
 * Webflow API Client
 *
 * Server-side functions for the Webflow REST v2 API.
 * Handles token validation, sites, collections, and items
 * (both staged and live variants).
 *
 * API Documentation: https://developers.webflow.com/data/reference
 */

import type {
  WebflowSite,
  WebflowSitesResponse,
  WebflowCollection,
  WebflowCollectionsResponse,
  WebflowItem,
  WebflowItemsResponse,
} from './types';

const WEBFLOW_API_URL = 'https://api.webflow.com/v2';
const WEBFLOW_API_VERSION = '2.0.0';

// Webflow rate limit: 60 req/min for v2 (1 req/sec is safe).
// We pace requests to ~17 req/sec headroom (~60ms between requests),
// then back off on 429 responses.
const RATE_LIMIT_DELAY_MS = 60;
let lastRequestAt = 0;

/** Default page size for paginated item listing (Webflow max is 100). */
const ITEMS_PAGE_SIZE = 100;

/** Max attempts for transient errors (429 / 5xx). */
const MAX_RETRIES = 5;

// =============================================================================
// API Helpers
// =============================================================================

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < RATE_LIMIT_DELAY_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

interface WebflowRequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

function buildUrl(path: string, query?: WebflowRequestOptions['query']): string {
  const url = new URL(`${WEBFLOW_API_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function webflowRequest<T>(
  token: string,
  path: string,
  options: WebflowRequestOptions = {}
): Promise<T> {
  const { method = 'GET', body, query } = options;
  const url = buildUrl(path, query);

  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt < MAX_RETRIES) {
    attempt++;
    await waitForRateLimit();

    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'accept-version': WEBFLOW_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    // Honor Retry-After on 429 / 503 then retry.
    if (response.status === 429 || response.status === 503) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '1', 10);
      const waitMs = Math.min(Math.max(retryAfter, 1), 30) * 1000;
      await new Promise((r) => setTimeout(r, waitMs));
      lastError = new Error(`Webflow rate limited (status ${response.status})`);
      continue;
    }

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      const detail = (errorBody as Record<string, unknown>)?.message
        ?? (errorBody as Record<string, unknown>)?.msg
        ?? `${response.status} ${response.statusText}`;
      throw new Error(`Webflow API error: ${detail}`);
    }

    if (response.status === 204) return {} as T;
    return response.json();
  }

  throw lastError ?? new Error('Webflow request failed after retries');
}

// =============================================================================
// Token Validation
// =============================================================================

/**
 * Validate a Webflow API token by calling `GET /sites`. We use this rather
 * than `/token/authorized_by` because the latter requires the
 * `authorized_user:read` scope, which most CMS-only tokens don't have.
 * The migration needs `sites:read` + `cms:read` anyway, so confirming we
 * can list sites is the most relevant check.
 */
export async function testToken(token: string): Promise<{ valid: boolean; error?: string }> {
  try {
    await webflowRequest<WebflowSitesResponse>(token, '/sites');
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Invalid token',
    };
  }
}

// =============================================================================
// Sites
// =============================================================================

/** List all Webflow sites the token has access to. */
export async function listSites(token: string): Promise<WebflowSite[]> {
  const response = await webflowRequest<WebflowSitesResponse>(token, '/sites');
  return response.sites ?? [];
}

/** Fetch a single site by id. */
export async function getSite(token: string, siteId: string): Promise<WebflowSite> {
  return webflowRequest<WebflowSite>(token, `/sites/${siteId}`);
}

// =============================================================================
// Collections
// =============================================================================

/**
 * List collection summaries for a site. Note: each entry does NOT include
 * `fields` — call `getCollection` for the full schema.
 */
export async function listCollections(
  token: string,
  siteId: string
): Promise<WebflowCollection[]> {
  const response = await webflowRequest<WebflowCollectionsResponse>(
    token,
    `/sites/${siteId}/collections`
  );
  return response.collections ?? [];
}

/** Fetch a collection's full schema, including its `fields[]`. */
export async function getCollection(
  token: string,
  collectionId: string
): Promise<WebflowCollection> {
  return webflowRequest<WebflowCollection>(token, `/collections/${collectionId}`);
}

/**
 * Convenience: list all collections for a site WITH their fields populated.
 * Performs one summary request and one detail request per collection.
 */
export async function listCollectionsWithFields(
  token: string,
  siteId: string
): Promise<WebflowCollection[]> {
  const summaries = await listCollections(token, siteId);
  const detailed: WebflowCollection[] = [];
  for (const summary of summaries) {
    const full = await getCollection(token, summary.id);
    detailed.push({ ...summary, ...full });
  }
  return detailed;
}

// =============================================================================
// Items
// =============================================================================

interface ListItemsOptions {
  /** When true, list the published/live variant of items. */
  live?: boolean;
}

/**
 * List ALL items for a collection, paging through Webflow's offset-based
 * pagination. When `live=true` we hit the `/items/live` endpoint, which
 * returns only items currently published on the site.
 */
export async function listItems(
  token: string,
  collectionId: string,
  options: ListItemsOptions = {}
): Promise<WebflowItem[]> {
  const path = options.live
    ? `/collections/${collectionId}/items/live`
    : `/collections/${collectionId}/items`;

  const all: WebflowItem[] = [];
  let offset = 0;

  while (true) {
    const response = await webflowRequest<WebflowItemsResponse>(token, path, {
      query: { limit: ITEMS_PAGE_SIZE, offset },
    });

    const batch = response.items ?? [];
    all.push(...batch);

    if (batch.length < ITEMS_PAGE_SIZE) break;
    offset += batch.length;

    // Safety net for runaway pagination.
    if (offset > 100_000) break;
  }

  return all;
}

/**
 * Return the set of item ids currently live for a collection. Used by
 * the migration / re-sync to decide which YCode draft items to publish.
 */
export async function listLiveItemIds(
  token: string,
  collectionId: string
): Promise<Set<string>> {
  const items = await listItems(token, collectionId, { live: true });
  return new Set(items.map((item) => item.id));
}

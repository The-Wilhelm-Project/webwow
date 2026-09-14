/**
 * Airtable API Client
 *
 * Server-side functions for communicating with the Airtable REST API.
 * Handles bases, tables, records, and webhook management.
 *
 * API Documentation: https://airtable.com/developers/web/api
 */

import type {
  AirtableBase,
  AirtableBasesResponse,
  AirtableTable,
  AirtableTablesResponse,
  AirtableRecord,
  AirtablePaginatedResponse,
  AirtableWebhookPayload,
  AirtableWebhookCreateResponse,
} from './types';

const AIRTABLE_API_URL = 'https://api.airtable.com/v0';
const AIRTABLE_META_URL = 'https://api.airtable.com/v0/meta';

// Rate limit: 5 req/s per base
const RATE_LIMIT_DELAY_MS = 220;
const lastRequestByBase = new Map<string, number>();

// =============================================================================
// API Helpers
// =============================================================================

async function waitForRateLimit(baseId: string): Promise<void> {
  const now = Date.now();
  const last = lastRequestByBase.get(baseId) ?? 0;
  const elapsed = now - last;

  if (elapsed < RATE_LIMIT_DELAY_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS - elapsed));
  }

  lastRequestByBase.set(baseId, Date.now());
}

interface AirtableRequestOptions {
  method?: string;
  body?: unknown;
  baseId?: string;
}

async function airtableRequest<T>(
  token: string,
  url: string,
  options: AirtableRequestOptions = {}
): Promise<T> {
  const { method = 'GET', body, baseId } = options;

  if (baseId) {
    await waitForRateLimit(baseId);
  }

  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const message = (errorData as Record<string, unknown>).error
      ? JSON.stringify((errorData as Record<string, unknown>).error)
      : `Airtable API error: ${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  if (response.status === 204) return {} as T;
  return response.json();
}

// =============================================================================
// Token Validation
// =============================================================================

/** Test if a Personal Access Token is valid */
export async function testToken(token: string): Promise<{ valid: boolean; error?: string }> {
  try {
    await airtableRequest<AirtableBasesResponse>(token, `${AIRTABLE_META_URL}/bases`);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Invalid token',
    };
  }
}

// =============================================================================
// Bases & Tables
// =============================================================================

/** List all accessible bases */
export async function listBases(token: string): Promise<AirtableBase[]> {
  const allBases: AirtableBase[] = [];
  let offset: string | undefined;

  do {
    const url = offset
      ? `${AIRTABLE_META_URL}/bases?offset=${offset}`
      : `${AIRTABLE_META_URL}/bases`;

    const response = await airtableRequest<AirtableBasesResponse>(token, url);
    allBases.push(...response.bases);
    offset = response.offset;
  } while (offset);

  return allBases;
}

/** List tables and their fields for a base */
export async function listTables(token: string, baseId: string): Promise<AirtableTable[]> {
  const response = await airtableRequest<AirtableTablesResponse>(
    token,
    `${AIRTABLE_META_URL}/bases/${baseId}/tables`,
    { baseId }
  );
  return response.tables;
}

// =============================================================================
// Records
// =============================================================================

/** Fetch all records from a table (handles pagination) */
export async function listAllRecords(
  token: string,
  baseId: string,
  tableId: string
): Promise<AirtableRecord[]> {
  const allRecords: AirtableRecord[] = [];
  let offset: string | undefined;

  do {
    const params = new URLSearchParams({ returnFieldsByFieldId: 'true' });
    if (offset) params.set('offset', offset);

    const response = await airtableRequest<AirtablePaginatedResponse<AirtableRecord>>(
      token,
      `${AIRTABLE_API_URL}/${baseId}/${tableId}?${params}`,
      { baseId }
    );

    allRecords.push(...(response.records ?? []));
    offset = response.offset;
  } while (offset);

  return allRecords;
}

/** Fetch specific records by IDs using filterByFormula */
export async function listRecordsByIds(
  token: string,
  baseId: string,
  tableId: string,
  recordIds: string[]
): Promise<AirtableRecord[]> {
  if (recordIds.length === 0) return [];

  const formula = recordIds.length === 1
    ? `RECORD_ID()='${recordIds[0]}'`
    : `OR(${recordIds.map((id) => `RECORD_ID()='${id}'`).join(',')})`;

  const allRecords: AirtableRecord[] = [];
  let offset: string | undefined;

  do {
    const params = new URLSearchParams({
      returnFieldsByFieldId: 'true',
      filterByFormula: formula,
    });
    if (offset) params.set('offset', offset);

    const response = await airtableRequest<AirtablePaginatedResponse<AirtableRecord>>(
      token,
      `${AIRTABLE_API_URL}/${baseId}/${tableId}?${params}`,
      { baseId }
    );

    allRecords.push(...(response.records ?? []));
    offset = response.offset;
  } while (offset);

  return allRecords;
}

// =============================================================================
// Webhooks
// =============================================================================

/** Register a webhook for table data changes on a base */
export async function createWebhook(
  token: string,
  baseId: string,
  tableId: string,
  notificationUrl: string
): Promise<AirtableWebhookCreateResponse> {
  return airtableRequest<AirtableWebhookCreateResponse>(
    token,
    `${AIRTABLE_API_URL}/bases/${baseId}/webhooks`,
    {
      method: 'POST',
      baseId,
      body: {
        notificationUrl,
        specification: {
          options: {
            filters: {
              dataTypes: ['tableData'],
              recordChangeScope: tableId,
            },
          },
        },
      },
    }
  );
}

/** Fetch webhook payloads (cursor-based) */
export async function getWebhookPayloads(
  token: string,
  baseId: string,
  webhookId: string,
  cursor?: number
): Promise<AirtableWebhookPayload> {
  const params = cursor ? `?cursor=${cursor}` : '';
  return airtableRequest<AirtableWebhookPayload>(
    token,
    `${AIRTABLE_API_URL}/bases/${baseId}/webhooks/${webhookId}/payloads${params}`,
    { baseId }
  );
}

/** Refresh a webhook to extend its expiry */
export async function refreshWebhook(
  token: string,
  baseId: string,
  webhookId: string
): Promise<{ expirationTime: string }> {
  return airtableRequest<{ expirationTime: string }>(
    token,
    `${AIRTABLE_API_URL}/bases/${baseId}/webhooks/${webhookId}/refresh`,
    { method: 'POST', baseId }
  );
}

/** Delete a webhook */
export async function deleteWebhook(
  token: string,
  baseId: string,
  webhookId: string
): Promise<void> {
  try {
    await airtableRequest<void>(
      token,
      `${AIRTABLE_API_URL}/bases/${baseId}/webhooks/${webhookId}`,
      { method: 'DELETE', baseId }
    );
  } catch {
    // Treat NOT_FOUND as success — webhook already gone
  }
}

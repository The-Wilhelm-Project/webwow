/**
 * Frontend API client for Airtable integration.
 * Centralizes all builder-side fetch calls to avoid duplicated URLs and headers.
 */

import type {
  AirtableBase,
  AirtableTable,
  AirtableConnection,
  AirtableFieldMapping,
} from './types';

const BASE = '/ycode/api/apps/airtable';
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

import { ToastError } from '@/lib/toast-error';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json();
  if (body.error) {
    throw body.detail
      ? new ToastError(body.error, body.detail)
      : new Error(body.error);
  }
  return body.data as T;
}

function jsonPost<T>(url: string, payload: unknown): Promise<T> {
  return jsonFetch<T>(url, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

function jsonPut<T>(url: string, payload: unknown): Promise<T> {
  return jsonFetch<T>(url, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

// =============================================================================
// Connection cache — shared across components to avoid redundant fetches
// =============================================================================

let cachedConnections: AirtableConnection[] = [];
let connectionsFetchPromise: Promise<AirtableConnection[]> | null = null;

/** Fetch connections once and cache; deduplicates concurrent calls */
export function fetchCachedConnections(): Promise<AirtableConnection[]> {
  if (connectionsFetchPromise) return connectionsFetchPromise;

  connectionsFetchPromise = jsonFetch<AirtableConnection[]>(`${BASE}/connections`)
    .then((conns) => { cachedConnections = conns; return conns; })
    .catch(() => cachedConnections)
    .finally(() => { connectionsFetchPromise = null; });

  return connectionsFetchPromise;
}

/** Get a connection for a collection from the cache (instant, no network) */
export function getCachedConnection(collectionId: string): AirtableConnection | null {
  return cachedConnections.find((c) => c.collectionId === collectionId) ?? null;
}

/** Get the set of CMS field IDs that are synced by Airtable for a given collection */
export function getSyncedFieldIds(collectionId: string): Set<string> {
  const conn = getCachedConnection(collectionId);
  if (!conn) return new Set();
  return new Set(conn.fieldMapping.map((m) => m.cmsFieldId));
}

export const airtableApi = {
  getSettings: () => jsonFetch<Record<string, string>>(`${BASE}/settings`),

  saveSettings: (settings: Record<string, string>) =>
    jsonPut<void>(`${BASE}/settings`, settings),

  deleteSettings: () =>
    jsonFetch<void>(`${BASE}/settings`, { method: 'DELETE' }),

  testToken: (apiToken: string) =>
    jsonPost<{ valid: boolean }>(`${BASE}/test`, { api_token: apiToken }),

  listBases: () => jsonFetch<AirtableBase[]>(`${BASE}/bases`),

  listTables: (baseId: string) =>
    jsonFetch<AirtableTable[]>(`${BASE}/bases/${baseId}/tables`),

  getConnections: () => jsonFetch<AirtableConnection[]>(`${BASE}/connections`),

  createConnection: (payload: {
    baseId: string;
    baseName?: string;
    tableId: string;
    tableName?: string;
    collectionId: string;
    collectionName?: string;
    fieldMapping: AirtableFieldMapping[];
  }) => jsonPost<AirtableConnection>(`${BASE}/connections`, payload),

  updateConnection: (connectionId: string, fieldMapping: AirtableFieldMapping[]) =>
    jsonPut<AirtableConnection>(`${BASE}/connections/${connectionId}`, { fieldMapping }),

  deleteConnection: (connectionId: string) =>
    jsonFetch<{ success: boolean }>(`${BASE}/connections/${connectionId}`, {
      method: 'DELETE',
    }),

  sync: (connectionId: string) =>
    jsonPost<{ created: number; updated: number; deleted: number }>(
      `${BASE}/sync`,
      { connectionId }
    ),

  setupWebhook: (connectionId: string) =>
    jsonPost<{ webhookId: string; expiresAt: string }>(
      `${BASE}/webhook/setup`,
      { connectionId }
    ),

  refreshWebhook: (connectionId: string) =>
    jsonPost<{ expiresAt: string }>(
      `${BASE}/webhook/refresh`,
      { connectionId }
    ),

  disableWebhook: (connectionId: string) =>
    jsonPost<{ success: boolean }>(
      `${BASE}/webhook/disable`,
      { connectionId }
    ),
};

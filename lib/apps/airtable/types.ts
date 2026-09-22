/**
 * Airtable Integration Types
 *
 * Type definitions for the Airtable CMS sync integration.
 * Covers API responses, connection config, and field mapping.
 */

import type { CollectionFieldType } from '@/types';

// =============================================================================
// Airtable API Response Types
// =============================================================================

export interface AirtableBase {
  id: string;
  name: string;
  permissionLevel: string;
}

export interface AirtableTable {
  id: string;
  name: string;
  description?: string;
  fields: AirtableField[];
  primaryFieldId: string;
}

export interface AirtableField {
  id: string;
  name: string;
  type: AirtableFieldType;
  description?: string;
  options?: Record<string, unknown>;
}

export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

export interface AirtablePaginatedResponse<T> {
  records?: T[];
  offset?: string;
}

export interface AirtableBasesResponse {
  bases: AirtableBase[];
  offset?: string;
}

export interface AirtableTablesResponse {
  tables: AirtableTable[];
}

export interface AirtableWebhookPayload {
  cursor: number;
  mightHaveMore: boolean;
  payloads: Array<{
    timestamp: string;
    baseTransactionNumber: number;
    payloadFormat: string;
    actionMetadata?: {
      source: string;
      sourceMetadata?: Record<string, unknown>;
    };
    changedTablesById?: Record<string, {
      changedRecordsById?: Record<string, unknown>;
      createdRecordsById?: Record<string, unknown>;
      destroyedRecordIds?: string[];
      changedFieldsById?: Record<string, unknown>;
      createdFieldsById?: Record<string, unknown>;
      destroyedFieldIds?: string[];
    }>;
  }>;
}

export interface AirtableWebhookCreateResponse {
  id: string;
  macSecretBase64: string;
  expirationTime: string;
}

// =============================================================================
// Airtable Field Types
// =============================================================================

export type AirtableFieldType =
  | 'singleLineText'
  | 'email'
  | 'url'
  | 'multilineText'
  | 'number'
  | 'percent'
  | 'currency'
  | 'singleSelect'
  | 'multipleSelects'
  | 'singleCollaborator'
  | 'multipleCollaborators'
  | 'multipleRecordLinks'
  | 'date'
  | 'dateTime'
  | 'phoneNumber'
  | 'multipleAttachments'
  | 'checkbox'
  | 'formula'
  | 'createdTime'
  | 'rollup'
  | 'count'
  | 'lookup'
  | 'multipleLookupValues'
  | 'autoNumber'
  | 'barcode'
  | 'rating'
  | 'richText'
  | 'duration'
  | 'lastModifiedTime'
  | 'button'
  | 'createdBy'
  | 'lastModifiedBy'
  | 'externalSyncSource'
  | 'aiText';

// =============================================================================
// Connection Configuration (stored in app_settings)
// =============================================================================

export interface AirtableFieldMapping {
  airtableFieldId: string;
  airtableFieldName: string;
  airtableFieldType: AirtableFieldType;
  cmsFieldId: string;
  cmsFieldName: string;
  cmsFieldType: CollectionFieldType;
}

export interface AirtableConnection {
  id: string;
  baseId: string;
  baseName: string;
  tableId: string;
  tableName: string;
  collectionId: string;
  collectionName: string;
  fieldMapping: AirtableFieldMapping[];
  /** CMS field ID of the hidden airtable_id tracking field */
  recordIdFieldId: string;
  webhookId: string | null;
  webhookCursor: number;
  webhookSecret: string | null;
  webhookExpiresAt: string | null;
  /** Set when a webhook refresh fails (expired/deleted) and fields are cleared */
  webhookExpiredAt: string | null;
  lastSyncedAt: string | null;
  syncStatus: AirtableSyncStatus;
  syncError: string | null;
  /** Cached attachment fingerprints from last sync, keyed by "recordId:fieldId" */
  attachmentFingerprints?: Record<string, string>;
}

export type AirtableSyncStatus = 'idle' | 'syncing' | 'error';

// =============================================================================
// Webhook Change Tracking
// =============================================================================

/** Aggregated record-level changes extracted from webhook payloads for a single table */
export interface TableChanges {
  createdRecordIds: string[];
  changedRecordIds: string[];
  destroyedRecordIds: string[];
}

// =============================================================================
// Sync Results
// =============================================================================

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  errors: string[];
  syncedAt: string;
}

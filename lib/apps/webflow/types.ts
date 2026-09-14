/**
 * Webflow Integration Types
 *
 * Type definitions for the Webflow CMS migration integration.
 * Covers Webflow REST v2 API responses, import/migration state,
 * and per-collection mapping records persisted in app_settings.
 */

// =============================================================================
// Webflow Field Types
// =============================================================================

/**
 * Subset of Webflow CMS v2 field types we actively map. Unknown types fall
 * back to plain text so a migration never aborts on a new field type.
 */
export type WebflowFieldType =
  | 'PlainText'
  | 'RichText'
  | 'Image'
  | 'MultiImage'
  | 'Video'
  | 'Link'
  | 'Email'
  | 'Phone'
  | 'Number'
  | 'DateTime'
  | 'Date'
  | 'Switch'
  | 'Color'
  | 'Option'
  | 'Reference'
  | 'MultiReference'
  | 'File'
  | 'Set'
  | 'User';

// =============================================================================
// Webflow API Response Types
// =============================================================================

export interface WebflowSite {
  id: string;
  displayName: string;
  shortName: string;
  previewUrl?: string;
  timeZone?: string;
  createdOn?: string;
  lastUpdated?: string;
  lastPublished?: string | null;
}

export interface WebflowSitesResponse {
  sites: WebflowSite[];
}

export interface WebflowFieldValidations {
  /** For Option fields: list of `{ id, name }` choices. */
  options?: Array<{ id: string; name: string }>;
  /** For Reference / MultiReference fields. */
  collectionId?: string;
  /** Number / formatting metadata. */
  format?: string;
  precision?: number;
}

export interface WebflowField {
  id: string;
  isEditable: boolean;
  isRequired: boolean;
  type: WebflowFieldType;
  slug: string;
  displayName: string;
  helpText?: string;
  validations?: WebflowFieldValidations;
}

export interface WebflowCollection {
  id: string;
  displayName: string;
  singularName: string;
  slug: string;
  createdOn?: string;
  lastUpdated?: string;
  /** Present on `getCollection`, absent on `listCollections` summaries. */
  fields?: WebflowField[];
}

export interface WebflowCollectionsResponse {
  collections: WebflowCollection[];
}

/**
 * Item shape returned by both `/items` (staged) and `/items/live`.
 * Webflow's static fields (`name`, `slug`) live alongside user-defined
 * fields inside `fieldData`, keyed by each field's `slug`.
 */
export interface WebflowItem {
  id: string;
  cmsLocaleId?: string;
  lastPublished?: string | null;
  lastUpdated?: string;
  createdOn?: string;
  isArchived?: boolean;
  isDraft?: boolean;
  fieldData: Record<string, unknown>;
}

export interface WebflowItemsResponse {
  items: WebflowItem[];
  pagination?: {
    limit: number;
    offset: number;
    total: number;
  };
}

/** Asset reference returned for Image / File / MultiImage fields. */
export interface WebflowAsset {
  fileId?: string;
  url: string;
  alt?: string | null;
  /** Webflow occasionally returns `name`/`fileName` instead of a direct file name in the URL. */
  name?: string;
  fileName?: string;
}

// =============================================================================
// Migration / Import State (stored in app_settings)
// =============================================================================

export type WebflowSyncStatus = 'idle' | 'syncing' | 'error';

/**
 * One row inside a `WebflowImport.collectionMappings` array — links a single
 * Webflow CMS collection to the YCode collection that was created for it.
 */
export interface WebflowCollectionMapping {
  webflowCollectionId: string;
  webflowCollectionName: string;
  webflowSlug: string;
  ycodeCollectionId: string;
  ycodeCollectionName: string;
  /** YCode field ID of the hidden `webflow_id` tracking field. */
  recordIdFieldId: string;
  /**
   * Mapping of Webflow field id -> YCode field id, captured at migration time.
   * Used by re-sync so it doesn't have to re-derive the mapping.
   */
  fieldIdMap: Record<string, string>;
  /** Mapping of Webflow slug -> YCode field id (lookup by slug for `fieldData`). */
  fieldSlugMap: Record<string, string>;
  /** Webflow field ids whose YCode counterpart is a Reference / MultiReference. */
  referenceFieldIds: string[];
}

/**
 * Top-level import record — one per migrated Webflow site. Stored as a JSON
 * array under `app_settings (app_id='webflow', key='imports')`.
 */
export interface WebflowImport {
  id: string;
  siteId: string;
  siteName: string;
  collectionMappings: WebflowCollectionMapping[];
  lastSyncedAt: string | null;
  syncStatus: WebflowSyncStatus;
  syncError: string | null;
  /**
   * Cached asset fingerprints from the most recent sync, keyed by
   * `<webflowItemId>:<webflowFieldId>`. Avoids re-downloading assets that
   * haven't changed on the Webflow side.
   */
  assetFingerprints?: Record<string, string>;
}

// =============================================================================
// Sync / Migration Result
// =============================================================================

export interface CollectionMigrationResult {
  webflowCollectionId: string;
  webflowCollectionName: string;
  ycodeCollectionId: string;
  created: number;
  updated: number;
  deleted: number;
  published: number;
  errors: string[];
}

export interface SyncResult {
  collections: CollectionMigrationResult[];
  syncedAt: string;
  errors: string[];
}

/**
 * Resolve CMS Variables Utilities
 *
 * Utilities for resolving CMS field variables to actual values from collection items.
 *
 * This file contains both client-safe and server-only functions:
 * - Client-safe: resolveInlineVariables (re-exported from inline-variables.ts)
 * - Server-only: Asset resolution functions (require database access)
 */

import type { FieldVariable, CollectionItemWithValues, CollectionField } from '@/types';
import { isValidUUID } from '@/lib/utils';
import { getAssetProxyUrl } from '@/lib/asset-utils';
import { formatFieldValue } from '@/lib/cms-variables-utils';
import { isAssetFieldType, isDateFieldType, isMultipleAssetField } from '@/lib/collection-field-utils';
import { buildAbsoluteAssetUrl, getSiteBaseUrl } from '@/lib/url-utils';

// Re-export client-safe inline variable resolver
export { resolveInlineVariables } from '@/lib/inline-variables';

const PLACEHOLDER_REGEX = /\{\{([^}]+)\}\}/g;

/** Lazily resolves the site base URL once, memoized per resolution pass. */
type SiteBaseUrlResolver = () => Promise<string | null>;

/**
 * Options for placeholder resolution. `tenantId`/`primaryDomainUrl` are ignored
 * in single-tenant deployments and used by multi-tenant deployments to scope
 * data access and resolve the correct per-tenant absolute URLs.
 */
export interface ResolveCustomCodeOptions {
  tenantId?: string;
  primaryDomainUrl?: string | null;
}

/**
 * Resolve the site's canonical base URL from settings + environment (SERVER-ONLY).
 */
async function resolveSiteBaseUrl(options: ResolveCustomCodeOptions): Promise<string | null> {
  const { getSettingByKey } = await import('@/lib/repositories/settingsRepository');
  const globalCanonicalUrl = await getSettingByKey('global_canonical_url', options.tenantId).catch(() => null);
  return getSiteBaseUrl({ globalCanonicalUrl, primaryDomainUrl: options.primaryDomainUrl });
}

/**
 * Resolve a single field's stored value to its display string.
 * Asset fields store the asset UUID, so they are resolved to an absolute public URL.
 */
async function resolveFieldDisplayValue(
  field: CollectionField,
  rawValue: string | undefined,
  isPublished: boolean,
  getBaseUrl: SiteBaseUrlResolver,
  tenantId?: string
): Promise<string> {
  if (rawValue == null) return '';

  if (isAssetFieldType(field.type) && !isMultipleAssetField(field)) {
    const url = await resolveImageUrl(String(rawValue), null, isPublished, tenantId);
    if (!url) return '';
    return buildAbsoluteAssetUrl(await getBaseUrl(), url) ?? url;
  }

  // Rich text is stored as a Tiptap object; serialize to plain text instead of
  // "[object Object]". Other field types keep their raw stored string so values
  // like ISO dates remain intact for JSON-LD and other custom code.
  if (field.type === 'rich_text') {
    return formatFieldValue(rawValue, field.type);
  }

  return String(rawValue);
}

/**
 * Resolve a dotted field path against a collection level, following reference
 * fields into their referenced items ({{Field}}, {{Ref.Field}}, {{Ref.Ref.Field}}).
 * Returns null when a field name is unknown (placeholder kept as-is).
 */
async function resolveFieldPath(
  segments: string[],
  fieldsByName: Map<string, CollectionField>,
  values: Record<string, string>,
  isPublished: boolean,
  getBaseUrl: SiteBaseUrlResolver,
  tenantId?: string
): Promise<string | null> {
  const field = fieldsByName.get(segments[0]);
  if (!field) return null;

  // Last segment: resolve to the field's display value (asset-aware).
  if (segments.length === 1) {
    return resolveFieldDisplayValue(field, values[field.id], isPublished, getBaseUrl, tenantId);
  }

  // Deeper segments require a single reference field to traverse.
  if (field.type !== 'reference' || !field.reference_collection_id) {
    return null;
  }

  const referencedItemId = values[field.id];
  if (!referencedItemId || typeof referencedItemId !== 'string' || !isValidUUID(referencedItemId)) {
    return '';
  }

  const { getFieldsByCollectionId } = await import('@/lib/repositories/collectionFieldRepository');
  const { getItemWithValues } = await import('@/lib/repositories/collectionItemRepository');

  const referencedItem = await getItemWithValues(referencedItemId, isPublished, tenantId);
  if (!referencedItem) return '';

  const referencedFields = await getFieldsByCollectionId(field.reference_collection_id, isPublished, undefined, tenantId);
  const referencedFieldsByName = new Map(referencedFields.map(refField => [refField.name, refField]));

  return resolveFieldPath(segments.slice(1), referencedFieldsByName, referencedItem.values, isPublished, getBaseUrl, tenantId);
}

/**
 * Resolve a single placeholder token to its value, or null to keep it as-is.
 * Supports top-level fields ({{Field}}) and reference paths ({{Ref.Field}}).
 */
async function resolvePlaceholderToken(
  token: string,
  collectionItem: CollectionItemWithValues,
  fieldsByName: Map<string, CollectionField>,
  isPublished: boolean,
  getBaseUrl: SiteBaseUrlResolver,
  tenantId?: string
): Promise<string | null> {
  const segments = token.split('.').map(segment => segment.trim());
  if (segments.some(segment => segment.length === 0)) return null;

  return resolveFieldPath(segments, fieldsByName, collectionItem.values, isPublished, getBaseUrl, tenantId);
}

/**
 * Return the item with its top-level date fields replaced by their raw stored
 * ISO values. Item date values are pre-formatted for display (e.g. "Aug 20,
 * 2026"), but custom code (JSON-LD, scripts) needs machine-readable ISO 8601.
 * Other values (including translated text) are preserved.
 */
async function withRawDateFieldValues(
  collectionItem: CollectionItemWithValues,
  fields: CollectionField[],
  isPublished: boolean,
  tenantId?: string
): Promise<CollectionItemWithValues> {
  const dateFieldIds = fields.filter(field => isDateFieldType(field.type)).map(field => field.id);
  if (dateFieldIds.length === 0) return collectionItem;

  const { getItemWithValues } = await import('@/lib/repositories/collectionItemRepository');
  const rawItem = await getItemWithValues(collectionItem.id, isPublished, tenantId);
  if (!rawItem) return collectionItem;

  const values = { ...collectionItem.values };
  for (const fieldId of dateFieldIds) {
    if (rawItem.values[fieldId] != null) values[fieldId] = rawItem.values[fieldId];
  }
  return { ...collectionItem, values };
}

/**
 * Resolve {{FieldName}} placeholders in custom code with actual field values.
 * Asset fields resolve to their public URL and references support the
 * {{ReferenceField.NestedField}} syntax. Unknown fields are left untouched.
 *
 * SERVER-ONLY: Requires collection fields and database access.
 */
export async function resolveCustomCodePlaceholders(
  code: string,
  collectionItem: CollectionItemWithValues | null | undefined,
  fields: CollectionField[],
  isPublished: boolean = false,
  options: ResolveCustomCodeOptions = {}
): Promise<string> {
  if (!collectionItem || !collectionItem.values || !fields.length || !code.includes('{{')) {
    return code;
  }

  // Custom code emits machine-readable output, so resolve against raw ISO dates
  // rather than the display-formatted values used for on-page rendering.
  const effectiveItem = await withRawDateFieldValues(collectionItem, fields, isPublished, options.tenantId);

  const fieldsByName = new Map(fields.map(field => [field.name, field]));

  // Resolve the site base URL at most once, and only when an asset placeholder
  // actually needs to be absolutized.
  let baseUrlPromise: Promise<string | null> | null = null;
  const getBaseUrl: SiteBaseUrlResolver = () => {
    if (!baseUrlPromise) baseUrlPromise = resolveSiteBaseUrl(options);
    return baseUrlPromise;
  };

  // Resolve each unique placeholder once (null = leave the placeholder untouched).
  const resolvedTokens = new Map<string, string | null>();
  for (const [, rawToken] of code.matchAll(PLACEHOLDER_REGEX)) {
    const token = rawToken.trim();
    if (resolvedTokens.has(token)) continue;
    resolvedTokens.set(token, await resolvePlaceholderToken(token, effectiveItem, fieldsByName, isPublished, getBaseUrl, options.tenantId));
  }

  return code.replace(PLACEHOLDER_REGEX, (match, rawToken) => {
    const value = resolvedTokens.get(rawToken.trim());
    return value == null ? match : value;
  });
}

/**
 * SERVER-ONLY FUNCTIONS BELOW
 * These functions require database access and should only be imported server-side.
 * Import them conditionally or use dynamic imports in server components.
 */

/**
 * Resolve a FieldVariable to an asset URL (SERVER-ONLY)
 * Returns the public_url of the asset stored in the field, or null if not found
 *
 * SERVER-ONLY: Requires database access via getAssetById
 * @param isPublished - Whether to fetch published (true) or draft (false) asset (default: false)
 */
export async function resolveFieldVariableToAssetUrl(
  fieldVariable: FieldVariable,
  collectionItem: CollectionItemWithValues | null | undefined,
  isPublished: boolean = false,
  tenantId?: string
): Promise<string | null> {
  // Dynamic import to ensure server-only code is only loaded server-side
  const { getAssetById } = await import('@/lib/repositories/assetRepository');

  if (!collectionItem || !collectionItem.values) {
    return null;
  }

  const fieldId = fieldVariable.data.field_id;
  if (!fieldId) {
    return null;
  }
  const assetId = collectionItem.values[fieldId];

  if (!assetId || typeof assetId !== 'string') {
    return null;
  }

  // Validate that assetId is a valid UUID before attempting to fetch
  if (!isValidUUID(assetId)) {
    console.warn(`[resolveFieldVariableToAssetUrl] Invalid UUID format: ${assetId}`);
    return null;
  }

  const asset = await getAssetById(assetId, isPublished, tenantId);
  if (!asset) return null;
  return getAssetProxyUrl(asset) || asset.public_url || null;
}

/**
 * Resolve image field variable or asset ID to URL (SERVER-ONLY)
 * Handles both FieldVariable and string (asset ID) cases
 *
 * SERVER-ONLY: Requires database access via getAssetById
 * @param isPublished - Whether to fetch published (true) or draft (false) asset (default: false)
 */
export async function resolveImageUrl(
  image: string | FieldVariable | null,
  collectionItem: CollectionItemWithValues | null | undefined,
  isPublished: boolean = false,
  tenantId?: string
): Promise<string | null> {
  // Dynamic import to ensure server-only code is only loaded server-side
  const { getAssetById } = await import('@/lib/repositories/assetRepository');

  if (!image) {
    return null;
  }

  // If it's already a string (asset ID), validate UUID format before fetching
  if (typeof image === 'string') {
    // Validate that it's a valid UUID before attempting to fetch
    if (!isValidUUID(image)) {
      console.warn(`[resolveImageUrl] Invalid UUID format: ${image}`);
      return null;
    }

    const asset = await getAssetById(image, isPublished, tenantId);
    if (!asset) return null;
    return getAssetProxyUrl(asset) || asset.public_url || null;
  }

  // If it's a FieldVariable, resolve it
  if (image.type === 'field') {
    return await resolveFieldVariableToAssetUrl(image, collectionItem, isPublished, tenantId);
  }

  return null;
}

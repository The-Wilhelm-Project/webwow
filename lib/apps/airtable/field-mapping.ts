/**
 * Airtable -> CMS Field Type Mapping
 *
 * Maps Airtable field types to CMS CollectionFieldType and
 * transforms Airtable field values into CMS-compatible strings.
 */

import type { CollectionFieldType, CollectionLinkValue } from '@/types';
import type { AirtableFieldType } from './types';
import { markdownToTiptapJson } from './markdown-to-tiptap';

// =============================================================================
// Type Mapping
// =============================================================================

const FIELD_TYPE_MAP: Record<AirtableFieldType, CollectionFieldType> = {
  singleLineText: 'text',
  email: 'email',
  url: 'link',
  multilineText: 'text',
  number: 'number',
  percent: 'number',
  currency: 'number',
  singleSelect: 'text',
  multipleSelects: 'text',
  singleCollaborator: 'text',
  multipleCollaborators: 'text',
  multipleRecordLinks: 'text',
  date: 'date_only',
  dateTime: 'date',
  phoneNumber: 'phone',
  multipleAttachments: 'image',
  checkbox: 'boolean',
  formula: 'text',
  createdTime: 'date',
  rollup: 'text',
  count: 'number',
  lookup: 'text',
  multipleLookupValues: 'text',
  autoNumber: 'number',
  barcode: 'text',
  rating: 'number',
  richText: 'rich_text',
  duration: 'number',
  lastModifiedTime: 'date',
  button: 'link',
  createdBy: 'text',
  lastModifiedBy: 'text',
  externalSyncSource: 'text',
  aiText: 'text',
};

/** Get the CMS field type for an Airtable field type */
export function getCmsFieldType(airtableType: AirtableFieldType): CollectionFieldType {
  return FIELD_TYPE_MAP[airtableType] || 'text';
}

const AIRTABLE_FIELD_TYPE_LABELS: Record<AirtableFieldType, string> = {
  singleLineText: 'Text',
  email: 'Email',
  url: 'URL',
  multilineText: 'Long text',
  number: 'Number',
  percent: 'Percent',
  currency: 'Currency',
  singleSelect: 'Single select',
  multipleSelects: 'Multiple select',
  singleCollaborator: 'Collaborator',
  multipleCollaborators: 'Collaborators',
  multipleRecordLinks: 'Linked records',
  date: 'Date',
  dateTime: 'Date & Time',
  phoneNumber: 'Phone',
  multipleAttachments: 'Attachments',
  checkbox: 'Checkbox',
  formula: 'Formula',
  createdTime: 'Created time',
  rollup: 'Rollup',
  count: 'Count',
  lookup: 'Lookup',
  multipleLookupValues: 'Lookup',
  autoNumber: 'Auto number',
  barcode: 'Barcode',
  rating: 'Rating',
  richText: 'Rich text',
  duration: 'Duration',
  lastModifiedTime: 'Modified time',
  button: 'Button URL',
  createdBy: 'Created by',
  lastModifiedBy: 'Modified by',
  externalSyncSource: 'Sync source',
  aiText: 'AI text',
};

/** Get human-readable label for an Airtable field type */
export function getAirtableFieldTypeLabel(type: AirtableFieldType | string): string {
  return AIRTABLE_FIELD_TYPE_LABELS[type as AirtableFieldType] ?? type;
}

// Hoisted Sets for isFieldTypeCompatible — allocated once at module scope
const NUMERIC_AIRTABLE = new Set<AirtableFieldType>([
  'number', 'percent', 'currency', 'count', 'rating', 'duration', 'autoNumber',
]);
const DATE_AIRTABLE = new Set<AirtableFieldType>([
  'date', 'dateTime', 'createdTime', 'lastModifiedTime',
]);
const TEXT_LIKE_AIRTABLE = new Set<AirtableFieldType>([
  'singleLineText', 'multilineText', 'richText', 'formula', 'rollup',
  'lookup', 'multipleLookupValues', 'aiText',
]);
const LINK_LIKE_AIRTABLE = new Set<AirtableFieldType>([
  'url', 'singleLineText', 'formula', 'button',
]);
const EMAIL_LIKE_AIRTABLE = new Set<AirtableFieldType>([
  'email', 'singleLineText', 'singleCollaborator', 'createdBy', 'lastModifiedBy',
]);
const COLOR_LIKE_AIRTABLE = new Set<AirtableFieldType>([
  'singleLineText', 'formula', 'singleSelect',
]);
const STATUS_LIKE_AIRTABLE = new Set<AirtableFieldType>([
  'singleSelect', 'singleLineText', 'formula',
]);
const MEDIA_CMS_TYPES = new Set<CollectionFieldType>(['audio', 'video', 'document']);
const MEDIA_AIRTABLE = new Set<AirtableFieldType>(['multipleAttachments', 'url']);

/** Check if an Airtable field type is compatible with a CMS field type */
export function isFieldTypeCompatible(
  airtableType: AirtableFieldType,
  cmsType: CollectionFieldType
): boolean {
  if (getCmsFieldType(airtableType) === cmsType) return true;
  if (cmsType === 'text') return true;
  if (cmsType === 'number' && NUMERIC_AIRTABLE.has(airtableType)) return true;
  if ((cmsType === 'date' || cmsType === 'date_only') && DATE_AIRTABLE.has(airtableType)) return true;
  if (cmsType === 'rich_text' && TEXT_LIKE_AIRTABLE.has(airtableType)) return true;
  if (cmsType === 'image' && MEDIA_AIRTABLE.has(airtableType)) return true;
  if (cmsType === 'link' && LINK_LIKE_AIRTABLE.has(airtableType)) return true;
  if (cmsType === 'email' && EMAIL_LIKE_AIRTABLE.has(airtableType)) return true;
  if (cmsType === 'phone' && (airtableType === 'phoneNumber' || airtableType === 'singleLineText')) return true;
  if (cmsType === 'boolean' && (airtableType === 'checkbox' || airtableType === 'number')) return true;
  if (cmsType === 'color' && COLOR_LIKE_AIRTABLE.has(airtableType)) return true;
  if (cmsType === 'status' && STATUS_LIKE_AIRTABLE.has(airtableType)) return true;
  if (MEDIA_CMS_TYPES.has(cmsType) && MEDIA_AIRTABLE.has(airtableType)) return true;
  if ((cmsType === 'reference' || cmsType === 'multi_reference') && airtableType === 'multipleRecordLinks') return true;
  return false;
}

// =============================================================================
// Value Transformation
// =============================================================================

/**
 * Transform an Airtable field value into a CMS-compatible string.
 * @param cmsType - Optional target CMS type, used for format-aware conversion (e.g. markdown → TipTap JSON)
 */
export function transformFieldValue(
  value: unknown,
  airtableType: AirtableFieldType,
  cmsType?: CollectionFieldType
): string | null {
  if (value === null || value === undefined) return null;

  switch (airtableType) {
    case 'richText':
      if (cmsType === 'rich_text' && typeof value === 'string') {
        return markdownToTiptapJson(value);
      }
      return typeof value === 'string' ? value : String(value);

    case 'checkbox':
      return value ? 'true' : 'false';

    case 'number':
    case 'percent':
    case 'currency':
    case 'count':
    case 'rating':
    case 'duration':
    case 'autoNumber':
      return String(value);

    case 'multipleSelects':
      return Array.isArray(value) ? value.join(', ') : String(value);

    case 'multipleAttachments':
      return extractAttachmentUrl(value);

    case 'singleCollaborator':
    case 'createdBy':
    case 'lastModifiedBy':
      return extractCollaboratorField(value, cmsType);

    case 'multipleCollaborators':
      return extractMultipleCollaboratorFields(value, cmsType);

    case 'date':
    case 'dateTime':
    case 'createdTime':
    case 'lastModifiedTime': {
      const str = String(value);
      if (cmsType === 'date_only') {
        // Extract just the date portion; if it includes time in UTC,
        // parse properly so the date doesn't shift across day boundaries
        if (str.includes('T')) {
          return str.slice(0, 10);
        }
        return str;
      }
      // For CMS 'date' (datetime), ensure we have a full ISO timestamp
      if (!str.includes('T')) {
        return `${str}T00:00:00.000Z`;
      }
      return str;
    }

    case 'multipleRecordLinks':
      return Array.isArray(value) ? value.join(', ') : String(value);

    case 'lookup':
    case 'rollup':
    case 'multipleLookupValues':
      if (Array.isArray(value)) {
        return value
          .filter((v) => v !== null && v !== undefined && typeof v !== 'object')
          .map(String)
          .join(', ') || null;
      }
      return typeof value === 'object' ? null : String(value);

    case 'barcode':
      return typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>).text as string ?? null
        : String(value);

    case 'url':
      // CMS 'link' fields store a CollectionLinkValue JSON object, not a raw URL.
      return cmsType === 'link' ? toLinkValueJson(value, airtableType) : String(value);

    case 'button': {
      if (typeof value !== 'object' || value === null) return null;
      const btn = value as Record<string, unknown>;
      if (cmsType === 'link') return toLinkValueJson(value, airtableType);
      return btn.label as string ?? null;
    }

    default:
      // singleLineText / formula mapped to a 'link' field need link-value JSON.
      if (cmsType === 'link') return toLinkValueJson(value, airtableType);
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

/** Wrap a link-compatible Airtable value into a CollectionLinkValue JSON string */
function toLinkValueJson(value: unknown, airtableType: AirtableFieldType): string | null {
  let url: string | null = null;
  if (airtableType === 'button') {
    const btnUrl = typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>).url
      : null;
    url = typeof btnUrl === 'string' && btnUrl.trim() ? btnUrl.trim() : null;
  } else if (typeof value !== 'object') {
    url = String(value).trim() || null;
  }
  if (!url) return null;
  const linkValue: CollectionLinkValue = { type: 'url', url };
  return JSON.stringify(linkValue);
}

function extractAttachmentUrl(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value[0]?.url ?? null;
}

function getCollaboratorProp(collab: Record<string, unknown>, cmsType?: CollectionFieldType): string | null {
  if (cmsType === 'email') return (collab.email as string) ?? null;
  return (collab.name as string) ?? (collab.email as string) ?? null;
}

function extractCollaboratorField(value: unknown, cmsType?: CollectionFieldType): string | null {
  if (typeof value !== 'object' || value === null) return null;
  return getCollaboratorProp(value as Record<string, unknown>, cmsType);
}

function extractMultipleCollaboratorFields(value: unknown, cmsType?: CollectionFieldType): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value
    .map((c) => getCollaboratorProp(c as Record<string, unknown>, cmsType) ?? '')
    .filter(Boolean)
    .join(', ');
}

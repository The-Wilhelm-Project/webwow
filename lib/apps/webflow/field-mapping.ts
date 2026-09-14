/**
 * Webflow -> CMS Field Type Mapping
 *
 * Maps Webflow CMS v2 field types to YCode CollectionFieldType and
 * transforms Webflow field values into CMS-compatible string values for
 * storage in `collection_item_values.value`.
 */

import type { CollectionFieldType } from '@/types';
import type { WebflowFieldType } from './types';
import { htmlToTiptapJson } from './html-to-tiptap';

// =============================================================================
// Type Mapping
// =============================================================================

const FIELD_TYPE_MAP: Record<WebflowFieldType, CollectionFieldType> = {
  PlainText: 'text',
  RichText: 'rich_text',
  Image: 'image',
  MultiImage: 'image',
  Video: 'text',
  Link: 'text',
  Email: 'email',
  Phone: 'phone',
  Number: 'number',
  DateTime: 'date',
  Date: 'date_only',
  Switch: 'boolean',
  Color: 'color',
  Option: 'option',
  Reference: 'reference',
  MultiReference: 'multi_reference',
  File: 'document',
  Set: 'text',
  User: 'text',
};

/** Map a Webflow field type to its YCode equivalent. */
export function getCmsFieldType(webflowType: WebflowFieldType | string): CollectionFieldType {
  return FIELD_TYPE_MAP[webflowType as WebflowFieldType] ?? 'text';
}

/** Webflow field types that produce multi-asset YCode fields. */
const MULTI_ASSET_TYPES = new Set<WebflowFieldType>(['MultiImage']);

/** Returns true if the YCode field for this Webflow type should accept multiple files. */
export function isMultiAssetType(webflowType: WebflowFieldType | string): boolean {
  return MULTI_ASSET_TYPES.has(webflowType as WebflowFieldType);
}

const WEBFLOW_FIELD_TYPE_LABELS: Record<WebflowFieldType, string> = {
  PlainText: 'Plain text',
  RichText: 'Rich text',
  Image: 'Image',
  MultiImage: 'Multi image',
  Video: 'Video',
  Link: 'Link',
  Email: 'Email',
  Phone: 'Phone',
  Number: 'Number',
  DateTime: 'Date & time',
  Date: 'Date',
  Switch: 'Switch',
  Color: 'Color',
  Option: 'Option',
  Reference: 'Reference',
  MultiReference: 'Multi-reference',
  File: 'File',
  Set: 'Set',
  User: 'User',
};

export function getWebflowFieldTypeLabel(type: WebflowFieldType | string): string {
  return WEBFLOW_FIELD_TYPE_LABELS[type as WebflowFieldType] ?? type;
}

// =============================================================================
// Value Transformation
// =============================================================================

/**
 * Transform a Webflow `fieldData` value into the string form YCode expects
 * for `collection_item_values.value`. Returns `null` for empty values so
 * downstream code can short-circuit.
 *
 * Reference / MultiReference values are NOT resolved here — they remain raw
 * Webflow item ids. The migration service runs a second pass to convert them
 * into YCode item ids.
 *
 * Asset values (Image / MultiImage / File / Video) are also pass-through —
 * the migration service is responsible for downloading and re-uploading
 * them, then writing the resulting asset id(s) into the value column.
 */
export function transformFieldValue(
  value: unknown,
  webflowType: WebflowFieldType | string,
  cmsType: CollectionFieldType
): string | null {
  if (value === null || value === undefined) return null;

  switch (webflowType) {
    case 'PlainText':
    case 'Email':
    case 'Phone':
    case 'Color': {
      if (typeof value !== 'string') return String(value);
      return value === '' ? null : value;
    }

    case 'RichText': {
      if (typeof value !== 'string') return null;
      if (cmsType === 'rich_text') return htmlToTiptapJson(value);
      return value;
    }

    case 'Number': {
      if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? String(parsed) : null;
      }
      return null;
    }

    case 'Switch': {
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      if (typeof value === 'string') {
        return value === 'true' || value === '1' || value === 'yes' ? 'true' : 'false';
      }
      return value ? 'true' : 'false';
    }

    case 'Date':
    case 'DateTime': {
      if (typeof value !== 'string' || value === '') return null;
      const d = new Date(value);
      if (isNaN(d.getTime())) return null;
      return d.toISOString();
    }

    case 'Link': {
      // Webflow Link fields hold a plain URL — stored as text in YCode so the
      // user can rebind it via the link picker if they want.
      if (typeof value !== 'string' || value === '') return null;
      return value;
    }

    case 'Option': {
      // Webflow stores the option's id; mapping to its display name is the
      // caller's job (it has access to the field's `validations.options`).
      if (typeof value !== 'string') return String(value);
      return value === '' ? null : value;
    }

    case 'Reference': {
      if (typeof value !== 'string') return null;
      return value === '' ? null : value;
    }

    case 'MultiReference': {
      if (!Array.isArray(value)) return null;
      const ids = value.filter((id): id is string => typeof id === 'string' && id !== '');
      return ids.length === 0 ? null : JSON.stringify(ids);
    }

    case 'Image':
    case 'MultiImage':
    case 'File': {
      // Pass-through — replaced by the migration service after upload.
      if (value === null || value === '') return null;
      return typeof value === 'string' ? value : JSON.stringify(value);
    }

    case 'Video': {
      // Webflow Video fields store an oEmbed URL or `{ url, html }` payload.
      // We persist just the URL as text so it stays human-readable.
      if (typeof value === 'string') return value === '' ? null : value;
      if (value && typeof value === 'object') {
        const url = (value as Record<string, unknown>).url;
        return typeof url === 'string' && url !== '' ? url : null;
      }
      return null;
    }

    case 'Set': {
      if (Array.isArray(value)) return JSON.stringify(value);
      return typeof value === 'string' ? value : JSON.stringify(value);
    }

    default: {
      if (typeof value === 'string') return value === '' ? null : value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return JSON.stringify(value);
    }
  }
}

/**
 * Resolve an Option field's id to its display name using the field's
 * `validations.options` list. Returns the original id if no match is found.
 *
 * Names are trimmed to match how YCode stores option values (the builder
 * trims option names on save and uses them as the persisted value).
 */
export function resolveOptionLabel(
  optionId: string,
  options: Array<{ id: string; name: string }> | undefined
): string {
  if (!options) return optionId;
  const match = options.find((o) => o.id === optionId);
  return match?.name.trim() ?? optionId;
}

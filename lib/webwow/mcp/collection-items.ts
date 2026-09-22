/**
 * CMS helpers for the MCP collection tools (lib/mcp/tools/collections.ts).
 *
 * The MCP tools created collections and items with less than the builder:
 *  - `create_collection` inserted only the collection row. The builder
 *    (stores/useCollectionsStore.ts `createCollection`) and the sample
 *    collections (lib/services/sampleCollectionService.ts) also create the
 *    built-in fields ID, Status, Name, Slug, Created Date, Updated Date. Without
 *    them an MCP collection had no Name/Slug columns in the CMS, no status and
 *    could not drive a dynamic page (slug field).
 *  - `create_collection_item` created the item row first and then wrote the
 *    values. A value key that was not a field id of the collection (an agent
 *    passing "name" or "Slug") failed with a raw SQL error ("invalid input
 *    syntax for type uuid") and left an empty item behind. It also skipped the
 *    auto values the builder route sets (ID = max + 1, Created/Updated Date,
 *    app/(builder)/ycode/api/collections/[id]/items/route.ts POST).
 *
 * Pure functions only (unit-tested in collection-items.test.ts); the tools call
 * the repositories.
 */

import type { CollectionField, CollectionFieldType } from '@/types';

export interface BuiltInFieldDefinition {
  name: string;
  key: string;
  type: CollectionFieldType;
  order: number;
  fillable: boolean;
  hidden: boolean;
  is_computed?: boolean;
}

/** Same list, order and flags as the builder's `createCollection` (stores/useCollectionsStore.ts). */
export const BUILT_IN_COLLECTION_FIELDS: BuiltInFieldDefinition[] = [
  { name: 'ID', key: 'id', type: 'number', order: 0, fillable: false, hidden: false },
  { name: 'Status', key: 'status', type: 'status', order: 1, fillable: false, hidden: false, is_computed: true },
  { name: 'Name', key: 'name', type: 'text', order: 2, fillable: true, hidden: false },
  { name: 'Slug', key: 'slug', type: 'text', order: 3, fillable: true, hidden: false },
  { name: 'Created Date', key: 'created_at', type: 'date', order: 4, fillable: false, hidden: false },
  { name: 'Updated Date', key: 'updated_at', type: 'date', order: 5, fillable: false, hidden: false },
];

type FieldLike = Pick<CollectionField, 'id' | 'name' | 'key' | 'type'>;

export interface ResolvedValues {
  /** Values keyed by field id. */
  values: Record<string, unknown>;
  /** Keys that match no field (by id, key or name). */
  unknown: string[];
  /** Keys that match more than one field by name. */
  ambiguous: string[];
}

/**
 * Map value keys to field ids: a field id wins, then a field `key` (built-ins:
 * id, name, slug, …), then a unique case-insensitive field name.
 */
export function resolveValueKeys(values: Record<string, unknown>, fields: FieldLike[]): ResolvedValues {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const out: ResolvedValues = { values: {}, unknown: [], ambiguous: [] };
  for (const [rawKey, value] of Object.entries(values)) {
    if (byId.has(rawKey)) {
      out.values[rawKey] = value;
      continue;
    }
    const byKey = fields.filter((f) => f.key && f.key === rawKey);
    if (byKey.length === 1) {
      out.values[byKey[0].id] = value;
      continue;
    }
    const wanted = rawKey.trim().toLowerCase();
    const byName = fields.filter((f) => f.name.trim().toLowerCase() === wanted);
    if (byName.length === 1) out.values[byName[0].id] = value;
    else if (byName.length > 1) out.ambiguous.push(rawKey);
    else out.unknown.push(rawKey);
  }
  return out;
}

/** Error text for keys that cannot be written (lists the fields the agent can use). */
export function describeUnresolvedKeys(resolved: ResolvedValues, fields: FieldLike[]): string | null {
  if (resolved.unknown.length === 0 && resolved.ambiguous.length === 0) return null;
  const parts: string[] = [];
  if (resolved.unknown.length) parts.push(`unknown field(s): ${resolved.unknown.join(', ')}`);
  if (resolved.ambiguous.length) parts.push(`ambiguous field name(s), use the field id: ${resolved.ambiguous.join(', ')}`);
  const list = fields.map((f) => `${f.id} (${f.name}${f.key ? `, key ${f.key}` : ''}, ${f.type})`).join('; ');
  return `Error: ${parts.join('; ')}. Nothing was written. Fields of this collection: ${list}`;
}

/**
 * Auto values for a new item, like the builder's item route: ID = max + 1,
 * Created/Updated Date = now (only for fields that exist). Values the caller set
 * explicitly are kept.
 */
export function autoItemValues(fields: FieldLike[], maxId: number, nowIso: string, given: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const idField = fields.find((f) => f.key === 'id');
  const created = fields.find((f) => f.key === 'created_at');
  const updated = fields.find((f) => f.key === 'updated_at');
  if (idField && given[idField.id] === undefined) out[idField.id] = String(maxId + 1);
  if (created && given[created.id] === undefined) out[created.id] = nowIso;
  if (updated && given[updated.id] === undefined) out[updated.id] = nowIso;
  return out;
}

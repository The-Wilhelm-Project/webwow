/**
 * Shared schema + builder for the AND-of-ORs condition model used by both
 * collection filters (`variables.collection.filters`) and conditional
 * visibility (`variables.conditionalVisibility`). Both persist the same
 * `VisibilityConditionGroup[]` shape, so the MCP exposes one condition
 * vocabulary and one builder, keeping the two tools from drifting apart.
 */

import { z } from 'zod';
import type {
  CollectionField,
  Layer,
  VisibilityCondition,
  VisibilityConditionGroup,
  VisibilityOperator,
} from '@/types';
import { findLayerById } from '@/lib/mcp/utils';
import { getOperatorsForFieldType, operatorRequiresValue } from '@/lib/collection-field-utils';

// Operators whose value is a JSON array of collection item IDs.
const ITEM_SELECTION_OPERATORS = new Set<VisibilityOperator>([
  'is_one_of', 'is_not_one_of', 'contains_all_of', 'contains_exactly',
]);

// Field types whose "current page" binding compares against the current dynamic
// page item's identity rather than a scalar field value.
const REFERENCE_FIELD_TYPES = new Set(['reference', 'multi_reference']);

/** Filter/visibility condition on a collection field. */
export const fieldConditionSchema = z.object({
  source: z.literal('field'),
  field_id: z.string().describe('Collection field ID to test'),
  operator: z.string().describe('Operator valid for the field type (e.g. "is", "contains", "is_one_of", "has_items", "is_between")'),
  value: z.string().optional().describe('Compare value for scalar fields (booleans use "true"/"false"; dates use YYYY-MM-DD or a preset).'),
  value2: z.string().optional().describe('Second bound for the "is_between" date operator.'),
  item_ids: z.array(z.string()).optional().describe('Collection item IDs for reference / multi_reference operators.'),
  value_mode: z.enum(['static', 'current_page']).optional().describe('"current_page" binds the compare value to the current dynamic page item. Defaults to "static".'),
  current_page_field_id: z.string().optional().describe('For value_mode "current_page" on a scalar field: the field on the page\'s collection whose value is compared.'),
  input_layer_id: z.string().optional().describe('Link the value to a filter input layer (inside a Filter element) so visitors control it at runtime. Overrides the static value.'),
  input_layer_id2: z.string().optional().describe('Link the second bound (is_between) to a filter input layer.'),
});

/** Filter/visibility condition on the item's own identity (self). */
export const itemIdConditionSchema = z.object({
  source: z.literal('item_id'),
  operator: z.enum(['is_one_of', 'is_not_one_of']).default('is_one_of').describe('Whether the item must be (or must not be) in the set.'),
  item_ids: z.array(z.string()).optional().describe('Collection item IDs to match against.'),
  includes_current_page_item: z.boolean().optional().describe('Include the current dynamic page item in the match set.'),
});

/** Visibility-only condition on the item count of another Collection List on the page. */
export const pageCollectionConditionSchema = z.object({
  source: z.literal('page_collection'),
  collection_layer_id: z.string().describe('A Collection List layer on the page whose item count is tested.'),
  operator: z.enum(['item_count', 'has_items', 'has_no_items']).default('has_items'),
  compare_operator: z.enum(['eq', 'lt', 'lte', 'gt', 'gte']).optional().describe('For operator "item_count": how to compare the count.'),
  compare_value: z.number().int().optional().describe('For operator "item_count": the number to compare against.'),
});

export type FieldConditionInput = z.infer<typeof fieldConditionSchema>;
export type ItemIdConditionInput = z.infer<typeof itemIdConditionSchema>;
export type PageCollectionConditionInput = z.infer<typeof pageCollectionConditionSchema>;
export type RawCondition = FieldConditionInput | ItemIdConditionInput | PageCollectionConditionInput;

interface BuildContext {
  fieldsById: Map<string, CollectionField>;
  layers: Layer[];
  id: string;
}

function buildCondition(input: RawCondition, ctx: BuildContext): { condition: VisibilityCondition } | { error: string } {
  const { id } = ctx;

  if (input.source === 'item_id') {
    return {
      condition: {
        id,
        source: 'self',
        operator: input.operator,
        value: JSON.stringify(input.item_ids ?? []),
        includesCurrentPageItem: input.includes_current_page_item ?? false,
      },
    };
  }

  if (input.source === 'page_collection') {
    const target = findLayerById(ctx.layers, input.collection_layer_id);
    if (!target || !target.variables?.collection) {
      return { error: `Layer "${input.collection_layer_id}" is not a Collection List.` };
    }
    const condition: VisibilityCondition = {
      id,
      source: 'page_collection',
      collectionLayerId: input.collection_layer_id,
      collectionLayerName: target.customName || target.name,
      operator: input.operator,
    };
    if (input.operator === 'item_count') {
      condition.compareOperator = input.compare_operator ?? 'eq';
      condition.compareValue = input.compare_value ?? 0;
    }
    return { condition };
  }

  const field = ctx.fieldsById.get(input.field_id);
  if (!field) {
    return { error: `Field "${input.field_id}" not found in the collection.` };
  }

  const allowed = getOperatorsForFieldType(field.type).map((o) => o.value);
  if (!allowed.includes(input.operator as VisibilityOperator)) {
    return { error: `Operator "${input.operator}" is not valid for field "${field.name}" (${field.type}). Allowed: ${allowed.join(', ')}.` };
  }

  const operator = input.operator as VisibilityOperator;
  const isReferenceField = REFERENCE_FIELD_TYPES.has(field.type);
  const condition: VisibilityCondition = {
    id,
    source: 'collection_field',
    fieldId: field.id,
    fieldType: field.type,
    operator,
    ...(field.reference_collection_id ? { referenceCollectionId: field.reference_collection_id } : {}),
  };

  if (input.input_layer_id) condition.inputLayerId = input.input_layer_id;
  if (input.input_layer_id2) condition.inputLayerId2 = input.input_layer_id2;

  if (input.value_mode === 'current_page') {
    condition.valueMode = 'current_page';
    if (isReferenceField) {
      condition.value = JSON.stringify(input.item_ids ?? []);
    } else {
      if (!input.current_page_field_id) {
        return { error: `current_page_field_id is required for value_mode "current_page" on scalar field "${field.name}".` };
      }
      condition.currentPageFieldId = input.current_page_field_id;
    }
  } else if (input.input_layer_id) {
    // Value is supplied by the linked filter input at runtime — no static value.
  } else if (ITEM_SELECTION_OPERATORS.has(operator)) {
    condition.value = JSON.stringify(input.item_ids ?? []);
  } else if (operatorRequiresValue(operator)) {
    condition.value = input.value ?? '';
    if (operator === 'is_between') {
      condition.value2 = input.value2 ?? '';
    }
  }

  return { condition };
}

/**
 * Build the persisted `VisibilityConditionGroup[]` from the MCP-facing groups.
 * Returns an error string for unknown fields/operators or invalid references.
 */
export function buildConditionGroups(
  groups: { conditions: RawCondition[] }[],
  ctx: { fieldsById: Map<string, CollectionField>; layers: Layer[] },
): { groups: VisibilityConditionGroup[] } | { error: string } {
  const ts = Date.now();
  const built: VisibilityConditionGroup[] = [];

  for (let gi = 0; gi < groups.length; gi += 1) {
    const conditions: VisibilityCondition[] = [];
    for (let ci = 0; ci < groups[gi].conditions.length; ci += 1) {
      const result = buildCondition(groups[gi].conditions[ci], {
        fieldsById: ctx.fieldsById,
        layers: ctx.layers,
        id: `vc-${ts}-${gi}-${ci}`,
      });
      if ('error' in result) return { error: result.error };
      conditions.push(result.condition);
    }
    built.push({ id: `vc-g-${ts}-${gi}`, conditions });
  }

  return { groups: built };
}

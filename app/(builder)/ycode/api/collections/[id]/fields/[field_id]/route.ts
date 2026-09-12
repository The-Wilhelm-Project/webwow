import { NextRequest, NextResponse } from 'next/server';
import { getFieldById, updateField, deleteField } from '@/lib/repositories/collectionFieldRepository';
import { isValidFieldType, VALID_FIELD_TYPES } from '@/lib/collection-field-utils';
import { getItemsByCollectionId } from '@/lib/repositories/collectionItemRepository';
import { clearValuesForField, renameValuesForField } from '@/lib/repositories/collectionItemValueRepository';
import { deleteTranslationsInBulk } from '@/lib/repositories/translationRepository';
import { noCache } from '@/lib/api-response';

// Disable caching for this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/collections/[id]/fields/[field_id]
 * Get field by ID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; field_id: string }> }
) {
  try {
    const { field_id } = await params;
    const fieldId = field_id; // UUID string, no parsing needed

    const field = await getFieldById(fieldId);

    if (!field) {
      return noCache({ error: 'Field not found' }, 404);
    }

    return noCache({ data: field });
  } catch (error) {
    console.error('Error fetching field:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch field' },
      500
    );
  }
}

/**
 * PUT /ycode/api/collections/[id]/fields/[field_id]
 * Update field
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; field_id: string }> }
) {
  try {
    const { field_id } = await params;
    const fieldId = field_id; // UUID string, no parsing needed

    const body = await request.json();

    // Validate field type if provided
    if (body.type && !isValidFieldType(body.type)) {
      return noCache(
        { error: `Invalid field type. Must be one of: ${VALID_FIELD_TYPES.join(', ')}` },
        400
      );
    }

    // Get existing field to check protected settings
    const existingField = await getFieldById(fieldId);
    if (!existingField) {
      return noCache({ error: 'Field not found' }, 404);
    }

    // Prevent disabling multiple once it's enabled (would cause data loss)
    if (existingField.data?.multiple === true && body.data?.multiple === false) {
      return noCache(
        { error: 'Cannot disable multiple files setting once enabled' },
        400
      );
    }

    // Validate count config when updating a count field. The field type can't
    // change after creation but the count source could be re-pointed.
    if (existingField.type === 'count' && body.data?.count) {
      const cfg = body.data.count;
      if (!cfg.collectionId || !cfg.fieldId) {
        return noCache(
          { error: 'Count fields require data.count.collectionId and data.count.fieldId' },
          400,
        );
      }

      const sourceField = await getFieldById(cfg.fieldId, false);
      if (!sourceField || sourceField.collection_id !== cfg.collectionId) {
        return noCache({ error: 'Count source field not found in the chosen collection' }, 400);
      }
      if (sourceField.type !== 'reference' && sourceField.type !== 'multi_reference') {
        return noCache({ error: 'Count source field must be a reference or multi_reference field' }, 400);
      }
      if (sourceField.reference_collection_id !== existingField.collection_id) {
        return noCache({ error: 'Count source field must reference this collection' }, 400);
      }

      // Count fields are always computed and never directly editable.
      body.is_computed = true;
      body.fillable = false;
    }

    // Detect option renames and removals (by stable id) for option-type
    // fields. Item values store the option name, so we propagate renames and
    // clear any item value whose option was removed from the field config.
    const optionRenames: { oldName: string; newName: string }[] = [];
    const removedOptionNames: string[] = [];
    if (existingField.type === 'option' && Array.isArray(body.data?.options)) {
      const previousOptions = Array.isArray(existingField.data?.options)
        ? existingField.data.options
        : [];
      const nextOptions = body.data.options as { id: string; name: string }[];
      const nextIds = new Set(nextOptions.map(o => o.id));
      const previousById = new Map(previousOptions.map((o: { id: string; name: string }) => [o.id, o.name]));

      for (const next of nextOptions) {
        const previousName = previousById.get(next.id);
        const newName = (next.name ?? '').trim();
        if (typeof previousName === 'string' && previousName !== newName) {
          optionRenames.push({ oldName: previousName, newName });
        }
      }

      for (const previous of previousOptions as { id: string; name: string }[]) {
        if (!nextIds.has(previous.id)) {
          removedOptionNames.push(previous.name);
        }
      }
    }

    const field = await updateField(fieldId, body);

    if (optionRenames.length > 0) {
      await Promise.all(
        optionRenames.map(({ oldName, newName }) =>
          renameValuesForField(fieldId, oldName, newName)
        )
      );
    }

    if (removedOptionNames.length > 0) {
      await Promise.all(
        removedOptionNames.map((name) => clearValuesForField(fieldId, name))
      );
    }

    return noCache({ data: field });
  } catch (error) {
    console.error('Error updating field:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to update field' },
      500
    );
  }
}

/**
 * DELETE /ycode/api/collections/[id]/fields/[field_id]
 * Delete field (soft delete) and all associated translations
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; field_id: string }> }
) {
  try {
    const { id, field_id } = await params;
    const collectionId = id;
    const fieldId = field_id; // UUID string, no parsing needed

    // Check if field is built-in before deleting
    const field = await getFieldById(fieldId);

    if (!field) {
      return noCache({ error: 'Field not found' }, 404);
    }

    if (field.key) {
      return noCache({ error: 'Cannot delete built-in fields' }, 400);
    }

    // Get all items in this collection to delete translations for this field
    const { items } = await getItemsByCollectionId(collectionId, false);

    // Delete translations for this field across all items in a single query
    if (items.length > 0) {
      const itemIds = items.map(item => item.id);
      const contentKey = field.key ? `field:key:${field.key}` : `field:id:${fieldId}`;
      await deleteTranslationsInBulk('cms', itemIds, [contentKey]);
    }

    await deleteField(fieldId);

    return noCache({ data: { success: true } }, 200);
  } catch (error) {
    console.error('Error deleting field:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to delete field' },
      500
    );
  }
}

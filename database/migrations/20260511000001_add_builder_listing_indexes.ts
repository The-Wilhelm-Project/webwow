import { Knex } from 'knex';

/**
 * Add composite partial indexes covering the hot builder listing queries.
 *
 * Each index targets a query path that previously fell back to a
 * single-column seek + post-filter + sort:
 *
 * - `idx_collection_items_listing` covers
 *   `WHERE collection_id = ? AND is_published = ? AND deleted_at IS NULL
 *    ORDER BY manual_order ASC, created_at DESC`,
 *   the workhorse query behind every CMS table render and every iframe
 *   page render that resolves a collection.
 *
 * - `idx_civ_field_published` covers
 *   `WHERE field_id = ? AND is_published = ? AND deleted_at IS NULL`,
 *   used by count-field enrichment and `getValuesByFieldId`. The existing
 *   `idx_civ_item_published` is keyed on `item_id`, so per-field scans
 *   currently hit the whole EAV table.
 *
 * - `idx_collection_fields_listing` covers
 *   `WHERE collection_id = ? AND is_published = ? AND deleted_at IS NULL
 *    ORDER BY "order"`,
 *   called dozens of times per builder load.
 *
 * Partial `WHERE deleted_at IS NULL` keeps the indexes small and matches
 * how the repositories filter every read.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_collection_items_listing
    ON collection_items (collection_id, is_published, manual_order, created_at DESC)
    WHERE deleted_at IS NULL
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_civ_field_published
    ON collection_item_values (field_id, is_published)
    WHERE deleted_at IS NULL
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_collection_fields_listing
    ON collection_fields (collection_id, is_published, "order")
    WHERE deleted_at IS NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_collection_items_listing');
  await knex.raw('DROP INDEX IF EXISTS idx_civ_field_published');
  await knex.raw('DROP INDEX IF EXISTS idx_collection_fields_listing');
}

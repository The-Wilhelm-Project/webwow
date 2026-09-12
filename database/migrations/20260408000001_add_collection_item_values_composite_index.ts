import { Knex } from 'knex';

/**
 * Add a composite index on (item_id, is_published, deleted_at) to
 * collection_item_values for faster bulk value lookups.
 *
 * The existing single-column index on item_id forces PostgreSQL to
 * filter is_published and deleted_at as post-index predicates.
 * A covering partial index lets the planner satisfy the full WHERE
 * clause from the index alone, dramatically speeding up the
 * getValuesByItemIds query (IN with many item IDs).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_civ_item_published
    ON collection_item_values (item_id, is_published)
    WHERE deleted_at IS NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_civ_item_published');
}

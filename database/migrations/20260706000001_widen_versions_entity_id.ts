import { Knex } from 'knex';

/**
 * Migration: Widen versions.entity_id from uuid to text
 *
 * Undo/redo history for components is now scoped per variant, keyed by
 * `${componentId}:${variantId}`. That composite value is not a valid UUID, so
 * the entity_id column must accept free-form text. Page and layer-style ids
 * remain plain UUID strings and stay valid as text.
 *
 * Idempotent: only alters the column when it is still typed as uuid.
 */
export async function up(knex: Knex): Promise<void> {
  const result = await knex.raw(`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_name = 'versions' AND column_name = 'entity_id'
  `);

  const dataType: string | undefined = result?.rows?.[0]?.data_type;

  if (dataType && dataType.toLowerCase() === 'uuid') {
    await knex.raw(`
      ALTER TABLE versions
      ALTER COLUMN entity_id TYPE text USING entity_id::text;
    `);
  }

  // Drop legacy component versions keyed by a bare componentId. History is now
  // scoped per variant (`componentId:variantId`), so these rows are orphaned
  // and would never be read. Idempotent — a re-run finds nothing to delete.
  await knex.raw(`
    DELETE FROM versions
    WHERE entity_type = 'component'
      AND entity_id::text NOT LIKE '%:%';
  `);
}

export async function down(knex: Knex): Promise<void> {
  const result = await knex.raw(`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_name = 'versions' AND column_name = 'entity_id'
  `);

  const dataType: string | undefined = result?.rows?.[0]?.data_type;

  if (dataType && dataType.toLowerCase() !== 'uuid') {
    // Drop rows whose entity_id is not a valid UUID (e.g. per-variant component
    // history) so the column can be converted back to uuid.
    await knex.raw(`
      DELETE FROM versions
      WHERE entity_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
    `);

    await knex.raw(`
      ALTER TABLE versions
      ALTER COLUMN entity_id TYPE uuid USING entity_id::uuid;
    `);
  }
}

import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('collection_imports', (table) => {
    table.jsonb('csv_data').nullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('collection_imports', (table) => {
    table.jsonb('csv_data').notNullable().alter();
  });
}

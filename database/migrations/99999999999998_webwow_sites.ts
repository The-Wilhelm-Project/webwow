import type { Knex } from 'knex';
// Relative import on purpose: the knex CLI loads migrations under ts-node (no `@/` alias).
import { databaseNameOf } from '../../lib/webwow/sites/database-url';

/**
 * Migration: Webwow multi-site registry (`webwow_sites`)
 *
 * One row per site; the default row (`id = 'default'`, `database_name = null`)
 * stands for the `DATABASE_URL` database itself, other rows point at their own
 * database on the same server. See docs/MULTISITE.md.
 *
 * The table and the default row are created ONLY in the main database
 * (`current_database()` equals the database of `DATABASE_URL`). The same
 * migration also runs inside every site database (in-app `runMigrations()` and
 * `webwow:sites migrate`) and does nothing there: site databases carry no
 * registry. Idempotent: safe on fresh databases, existing installs and the
 * template-apply / project-import replay path.
 */

export async function up(knex: Knex): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return; // build/probe contexts without a database

  const result = await knex.raw('select current_database() as current');
  const current = (result as { rows?: Array<{ current?: string }> }).rows?.[0]?.current;
  if (current !== databaseNameOf(url)) return; // site databases carry no registry

  if (!(await knex.schema.hasTable('webwow_sites'))) {
    await knex.schema.createTable('webwow_sites', (t) => {
      t.text('id').primary();
      t.text('slug').notNullable().unique();
      t.text('name').notNullable();
      t.text('database_name').nullable(); // null = the DATABASE_URL database itself
      t.jsonb('domains').notNullable().defaultTo('[]');
      t.boolean('is_default').notNullable().defaultTo(false);
      t.text('editor_password_hash').nullable();
      t.integer('editor_password_version').notNullable().defaultTo(0);
      t.text('thumbnail_url').nullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('last_opened_at', { useTz: true }).nullable();
    });
    await knex.raw('create unique index webwow_sites_one_default on webwow_sites ((is_default)) where is_default');
  }

  // Seed the default row with the existing site name (settings.value is jsonb; pg returns it parsed,
  // older drivers/replay paths may hand back the raw JSON text).
  let name = 'My Site';
  if (await knex.schema.hasTable('settings')) {
    const row = await knex('settings').where('key', 'site_name').first();
    const value: unknown = row?.value;
    if (typeof value === 'string') {
      try {
        const parsed: unknown = JSON.parse(value);
        name = typeof parsed === 'string' && parsed ? parsed : value || name;
      } catch {
        name = value || name;
      }
    }
  }

  // Fresh installs: this file sorts before 99999999999999_webwow_defaults.ts, which turns
  // upstream's branded 'Ycode Site' into 'My Site' — apply the same whitelabel rule here.
  if (name === 'Ycode Site') name = 'My Site';

  await knex('webwow_sites')
    .insert({ id: 'default', slug: 'default', name: name || 'My Site', database_name: null, is_default: true })
    .onConflict('id')
    .ignore();
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('webwow_sites');
}

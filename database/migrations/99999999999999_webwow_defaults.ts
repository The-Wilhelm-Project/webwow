import type { Knex } from 'knex';

/**
 * Migration: Webwow whitelabel defaults
 *
 * Runs after every upstream migration (name sorts last) and adjusts the
 * `settings` rows that upstream seeds with Ycode branding
 * (see 20250101000005_create_settings_table.ts for the key/value jsonb format):
 *
 *   - `ycode_badge`      -> false (inserted or updated; the badge is off in Webwow)
 *   - `site_name`        -> 'My Site'  only while it is still upstream's 'Ycode Site'
 *   - `site_description` -> ''         only while it is still upstream's 'Built with Ycode'
 *
 * Installations upgraded from the old Webwow fork carry `webwow_badge` /
 * `webwow_version` rows that upstream code never reads (it reads `ycode_badge`
 * / `ycode_version`). `webwow_badge` is deleted; `webwow_version` is renamed to
 * `ycode_version` when that key is absent, otherwise dropped.
 *
 * Every statement is a no-op when re-run, so the migration is safe on both
 * fresh databases and existing ones. `down` intentionally does nothing: these
 * are user-facing settings, not schema.
 */

const jsonValue = (value: unknown): string => JSON.stringify(value);

export async function up(knex: Knex): Promise<void> {
  // ycode_badge = false — insert or overwrite.
  await knex('settings')
    .insert({ key: 'ycode_badge', value: jsonValue(false) })
    .onConflict('key')
    .merge({ value: jsonValue(false), updated_at: knex.fn.now() });

  // Replace upstream's branded defaults only if they were never changed.
  await knex('settings')
    .where('key', 'site_name')
    .whereRaw('value = ?::jsonb', [jsonValue('Ycode Site')])
    .update({ value: jsonValue('My Site'), updated_at: knex.fn.now() });

  await knex('settings')
    .where('key', 'site_description')
    .whereRaw('value = ?::jsonb', [jsonValue('Built with Ycode')])
    .update({ value: jsonValue(''), updated_at: knex.fn.now() });

  // Legacy keys written by the old fork.
  await knex('settings').where('key', 'webwow_badge').delete();

  await knex.raw(`
    UPDATE settings
    SET key = 'ycode_version', updated_at = now()
    WHERE key = 'webwow_version'
      AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'ycode_version')
  `);
  await knex('settings').where('key', 'webwow_version').delete();
}

export async function down(_knex: Knex): Promise<void> {
  // No-op: settings values are user data and are not reverted.
}

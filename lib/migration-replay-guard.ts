import type { Knex } from 'knex';

/**
 * Migration Replay Guard
 *
 * Template apply and project import replay migration up()s directly —
 * OUTSIDE knex's applied-migrations tracking — to bring old template/export
 * data up to the current schema. Those replays run against the live
 * production schema, so a migration that drops or truncates an existing
 * table (e.g. a "drop and recreate" development convenience) destroys real
 * user data, not template data.
 *
 * This happened in production: replaying the app_settings create migration
 * dropped the shared table and wiped every tenant's integration config.
 *
 * `guardKnexForMigrationReplay` wraps a knex client so destructive DDL
 * fails fast during replay. The thrown error is caught per-migration by the
 * replay loops, so a blocked migration is skipped while the rest still run.
 * Tracked migration runners (migrate:latest etc.) must NOT use this guard:
 * they run each migration exactly once, where destructive ops can be
 * intentional.
 */

/** SQL verbs that destroy data and must never run during migration replay. */
const DESTRUCTIVE_REPLAY_SQL = /\b(drop\s+table|truncate)\b/i;

type AnyFn = (...args: unknown[]) => unknown;

export function guardKnexForMigrationReplay(knex: Knex): Knex {
  const blocked = (what: string): never => {
    throw new Error(
      `[migrationReplay] Blocked destructive operation during migration replay: ${what}. ` +
        'Replayed migrations run against live data; make the migration idempotent instead of dropping tables.'
    );
  };

  const guardSql = (sql: unknown, context: string): void => {
    if (typeof sql === 'string' && DESTRUCTIVE_REPLAY_SQL.test(sql)) {
      blocked(`${context} "${sql.trim().slice(0, 120)}"`);
    }
  };

  const knexProps = knex as unknown as Record<PropertyKey, unknown>;

  return new Proxy(knex as object, {
    get(_target, prop) {
      if (prop === 'schema') {
        const schema = knex.schema as unknown as Record<PropertyKey, unknown>;
        return new Proxy(schema, {
          get(_schemaTarget, schemaProp) {
            if (schemaProp === 'dropTable' || schemaProp === 'dropTableIfExists') {
              return (tableName: unknown) => blocked(`schema.${String(schemaProp)}('${String(tableName)}')`);
            }
            const value = schema[schemaProp];
            if (schemaProp === 'raw' && typeof value === 'function') {
              return (...args: unknown[]) => {
                guardSql(args[0], 'schema.raw');
                return (value as AnyFn).apply(schema, args);
              };
            }
            return typeof value === 'function' ? (value as AnyFn).bind(schema) : value;
          },
        });
      }
      const value = knexProps[prop];
      if (prop === 'raw' && typeof value === 'function') {
        return (...args: unknown[]) => {
          guardSql(args[0], 'raw');
          return (value as AnyFn).apply(knex, args);
        };
      }
      return typeof value === 'function' ? (value as AnyFn).bind(knex) : value;
    },
  }) as Knex;
}

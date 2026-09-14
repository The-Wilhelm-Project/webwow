/**
 * Main (registry) database handle for the multi-site layer.
 *
 * `getMainDb()` is a plain `pg` knex instance bound to `DATABASE_URL` — never
 * site-aware — and the only handle for `webwow_sites` and `auth.users`.
 * The config is built from `DATABASE_URL` directly (no `knexfile` import) to
 * avoid the cycle knexfile -> pg-client -> registry -> main-db -> knexfile.
 *
 * No `server-only`, no `@/` imports: `lib/webwow/db.ts` carries `import 'server-only'`,
 * this file is loaded by the knex CLI through `knexfile.ts`.
 */

import knex, { type Knex } from 'knex';
import { baseConnection, poolNumber } from './database-url';

const g = globalThis as unknown as {
  __webwowMainKnex?: Knex;
  __webwowPgTypesConfigured?: boolean;
};

/**
 * Configure the global `pg` type parsers once per process so rows look like
 * PostgREST responses: timestamptz/timestamp -> ISO strings, int8 and numeric -> numbers.
 * (Moved here from lib/webwow/db.ts; the parsers are global to the `pg` module and
 * therefore apply to the main pool, the shim pool and every site pool.)
 */
export function configurePgTypesOnce(): void {
  if (g.__webwowPgTypesConfigured) return;
  g.__webwowPgTypesConfigured = true;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pg = require('pg') as { types: { setTypeParser: (oid: number, parser: (value: string) => unknown) => void } };
    const { types } = pg;
    const toIso = (value: string | null): string | null => {
      if (value === null) return null;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toISOString();
    };
    // timestamptz / timestamp -> ISO strings (PostgREST returns strings, not Date objects)
    types.setTypeParser(1184, toIso);
    types.setTypeParser(1114, toIso);
    // int8 (count(*), bigint) -> number
    types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));
    // numeric -> number
    types.setTypeParser(1700, (value: string) => Number.parseFloat(value));
  } catch (error) {
    console.warn('[webwow/db] Could not configure pg type parsers:', error);
  }
}

/** Plain knex bound to DATABASE_URL (registry + users). Small pool, never site-aware. */
export async function getMainDb(): Promise<Knex> {
  if (!g.__webwowMainKnex) {
    configurePgTypesOnce();
    g.__webwowMainKnex = knex({
      client: 'pg',
      connection: async () => baseConnection(),
      pool: { min: 0, max: poolNumber('DB_POOL_MAIN_MAX', 5), idleTimeoutMillis: 30000 },
    });
  }
  return g.__webwowMainKnex;
}

/** Destroy the main pool (scripts / tests / duplicateSite quiesce). Recreated lazily. */
export async function closeMainDb(): Promise<void> {
  const db = g.__webwowMainKnex;
  g.__webwowMainKnex = undefined;
  if (db) await db.destroy();
}

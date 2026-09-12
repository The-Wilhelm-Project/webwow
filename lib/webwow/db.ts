/**
 * Webwow database access for the compatibility layer.
 *
 * Wraps the upstream knex client and configures pg type parsers so that rows
 * look like PostgREST responses (timestamps as ISO strings, int8 as numbers).
 */

import 'server-only';

import knex, { type Knex } from 'knex';
import knexfileConfig from '../../knexfile';

const globalForWebwowDb = globalThis as unknown as {
  __webwowPgTypesConfigured?: boolean;
  __webwowShimKnex?: Knex;
};

function configurePgTypes(): void {
  if (globalForWebwowDb.__webwowPgTypesConfigured) return;
  globalForWebwowDb.__webwowPgTypesConfigured = true;

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

/**
 * Get the knex instance used by the compatibility layer.
 *
 * Deliberately NOT the instance from `lib/knex-client.ts`: upstream treats that
 * one as a short-lived "migration/template" client and calls `closeKnexClient()`
 * (pool destroy) at the end of project import/export and template apply. All
 * regular queries of upstream code go through this shim, so they get their own
 * long-lived pool (stored on globalThis to survive Next.js HMR).
 */
export async function getDb(): Promise<Knex> {
  configurePgTypes();
  if (!globalForWebwowDb.__webwowShimKnex) {
    const environment = process.env.NODE_ENV || 'development';
    const config = knexfileConfig[environment] ?? knexfileConfig.development;
    globalForWebwowDb.__webwowShimKnex = knex(config);
  }
  return globalForWebwowDb.__webwowShimKnex;
}

/** Destroy the shim pool (tests / scripts only). */
export async function closeDb(): Promise<void> {
  if (globalForWebwowDb.__webwowShimKnex) {
    await globalForWebwowDb.__webwowShimKnex.destroy();
    globalForWebwowDb.__webwowShimKnex = undefined;
  }
}

/** Quick connectivity check. */
export async function testDb(): Promise<{ success: boolean; error?: string }> {
  try {
    const db = await getDb();
    await db.raw('SELECT 1');
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Database connection failed' };
  }
}

/**
 * Webwow database access for the compatibility layer.
 *
 * Wraps the upstream knex client and configures pg type parsers so that rows
 * look like PostgREST responses (timestamps as ISO strings, int8 as numbers).
 * The parsers live in `lib/webwow/sites/main-db.ts` (shared with the main/registry
 * pool and the per-site pools of the multi-site layer).
 */

import 'server-only';

import knex, { type Knex } from 'knex';
import knexfileConfig from '../../knexfile';
import { configurePgTypesOnce } from './sites/main-db';

const globalForWebwowDb = globalThis as unknown as {
  __webwowShimKnex?: Knex;
};

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
  configurePgTypesOnce();
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

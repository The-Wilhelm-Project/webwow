/**
 * Site-aware knex client (multi-site).
 *
 * `knexfile.ts` uses `client: WebwowPgClient`, so upstream's `getKnexClient()`,
 * our `getDb()`, the knex CLI and `runMigrations()` all become site-aware with
 * no upstream change: `acquireConnection()` reads the current site id
 * synchronously (`siteStore` -> signed request header -> `default`) and, for a
 * non-default site, hands out a connection from that site's own plain knex
 * pool (same DATABASE_URL with the database name replaced). Connections are
 * tagged so `releaseConnection()` routes them back. Transactions pin one
 * connection for their whole life (the trx client bypasses us), so the site is
 * chosen once at BEGIN.
 *
 * Per-site pools are promise-memoised (no check-then-set race), capped by an
 * LRU (`WEBWOW_MAX_SITE_POOLS`, default 20) and kept on `globalThis` so HMR
 * copies and the proxy bundle share them. `destroy()` is inherited: it only
 * destroys the main pool (upstream calls `closeKnexClient()` after import/
 * export/template apply while other sites may be mid-query).
 *
 * Verified against knex 3.1 internals: acquire/release are the only pool touch
 * points outside client.js; trx clients are `Object.create(prototype)` copies
 * with no instance fields; `withUserParams` clones share the pool by reference
 * (findings-multisite-db §1). Per-site state must therefore live at module/global
 * level, never on `this`.
 *
 * No `server-only`, no `@/` imports (loaded by the knex CLI under ts-node).
 */

import knex, { type Knex } from 'knex';
import { DEFAULT_SITE_ID } from './ids';
import { getCurrentSiteId } from './request-site';
import { baseConnection, poolNumber, withDatabase } from './database-url';
import { getSiteDatabaseName } from './registry';
import { configurePgTypesOnce } from './main-db';

// Untyped JS dialect; knex has no exports map, so the deep path resolves in Node, ts-node and both bundlers.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ClientPG: typeof Knex.Client = require('knex/lib/dialects/postgres');

type Tagged = { __webwowSite?: string; end?: (cb?: (err?: Error) => void) => unknown };

export interface PoolEntry {
  knex: Knex;
  databaseName: string;
  lastUsed: number;
}

export type PoolFactory = (siteId: string) => Promise<PoolEntry>;

const POOLS = Symbol.for('webwow.sitePools');
const READY = Symbol.for('webwow.sitePoolsReady');
const g = globalThis as unknown as Record<symbol, Map<string, unknown> | undefined>;

/** Promise-memoised pools (pending + ready). */
const sitePools: Map<string, Promise<PoolEntry>> = (g[POOLS] as Map<string, Promise<PoolEntry>> | undefined) ?? ((g[POOLS] = new Map()) as Map<string, Promise<PoolEntry>>);
/** Resolved entries only (LRU bookkeeping). */
const readyPools: Map<string, PoolEntry> = (g[READY] as Map<string, PoolEntry> | undefined) ?? ((g[READY] = new Map()) as Map<string, PoolEntry>);

function sitePoolConfig(databaseName: string): Knex.Config {
  return {
    client: 'pg', // plain client for the inner instance (no recursion)
    connection: async () => {
      const c = baseConnection();
      return { ...c, connectionString: withDatabase(c.connectionString, databaseName) };
    },
    pool: {
      min: 0,
      max: poolNumber('DB_POOL_SITE_MAX', 5),
      idleTimeoutMillis: poolNumber('DB_POOL_IDLE_TIMEOUT_MS', 30000),
      acquireTimeoutMillis: poolNumber('DB_POOL_ACQUIRE_TIMEOUT_MS', 20000),
      createTimeoutMillis: poolNumber('DB_POOL_CREATE_TIMEOUT_MS', 20000),
    },
  };
}

const defaultPoolFactory: PoolFactory = async (siteId) => {
  const databaseName = await getSiteDatabaseName(siteId); // main DB registry (cached)
  if (!databaseName) throw new Error(`[webwow/sites] unknown site "${siteId}"`);
  configurePgTypesOnce();
  return { knex: knex(sitePoolConfig(databaseName)), databaseName, lastUsed: Date.now() };
};

let poolFactory: PoolFactory = defaultPoolFactory;

function poolStats(entry: PoolEntry): { used: number; pending: number } {
  const pool = entry.knex.client.pool as { numUsed?: () => number; numPendingAcquires?: () => number } | undefined;
  return { used: pool?.numUsed?.() ?? 0, pending: pool?.numPendingAcquires?.() ?? 0 };
}

/** LRU cap: while more than WEBWOW_MAX_SITE_POOLS pools exist, destroy the least recently used idle one (never `keep`, the pool being opened). */
async function evictIdlePoolsIfNeeded(keep: string): Promise<void> {
  const max = Math.max(1, poolNumber('WEBWOW_MAX_SITE_POOLS', 20));
  while (sitePools.size > max) {
    let victim: [string, PoolEntry] | null = null;
    for (const [id, entry] of readyPools) {
      if (id === keep) continue;
      const { used, pending } = poolStats(entry);
      if (used > 0 || pending > 0) continue;
      if (!victim || entry.lastUsed < victim[1].lastUsed) victim = [id, entry];
    }
    if (!victim) break; // every pool is busy: exceed the cap rather than block
    await destroySitePools(victim[0]);
  }
}

/** The (memoised) pool for a non-default site; a failed creation is not cached. */
export function getSitePool(siteId: string): Promise<PoolEntry> {
  let p = sitePools.get(siteId);
  if (!p) {
    p = (async () => {
      const entry = await poolFactory(siteId);
      if (sitePools.get(siteId) !== p) {
        // destroyed while being created (deleteSite raced the first request): do not keep it
        await entry.knex.destroy().catch(() => undefined);
        throw new Error(`[webwow/sites] pool for "${siteId}" was destroyed while opening`);
      }
      readyPools.set(siteId, entry);
      await evictIdlePoolsIfNeeded(siteId);
      return entry;
    })();
    sitePools.set(siteId, p);
    p.catch(() => {
      if (sitePools.get(siteId) === p) sitePools.delete(siteId);
      readyPools.delete(siteId);
    });
  }
  return p;
}

/** Destroy one site's pool (site deleted/duplicated, tests). In-use connections are waited for by tarn. */
export async function destroySitePools(siteId: string): Promise<void> {
  const p = sitePools.get(siteId);
  if (!p) return;
  sitePools.delete(siteId);
  readyPools.delete(siteId);
  const entry = await p.catch(() => null);
  if (entry) await entry.knex.destroy();
}

export async function destroyAllSitePools(): Promise<void> {
  await Promise.all([...sitePools.keys()].map((id) => destroySitePools(id)));
}

/** Number of pools currently known (pending + ready); diagnostics/tests. */
export function sitePoolCount(): number {
  return sitePools.size;
}

export class WebwowPgClient extends ClientPG {
  async acquireConnection(): Promise<any> {
    const siteId = getCurrentSiteId(); // synchronous, before any await
    if (siteId === DEFAULT_SITE_ID) {
      const c = await super.acquireConnection();
      (c as Tagged).__webwowSite = DEFAULT_SITE_ID;
      return c;
    }
    const entry = await getSitePool(siteId);
    entry.lastUsed = Date.now();
    const c = await entry.knex.client.acquireConnection();
    (c as Tagged).__webwowSite = siteId;
    return c;
  }

  async releaseConnection(connection: any): Promise<void> {
    const siteId = (connection as Tagged).__webwowSite ?? DEFAULT_SITE_ID;
    if (siteId === DEFAULT_SITE_ID) return super.releaseConnection(connection);
    const p = sitePools.get(siteId);
    if (!p) {
      // pool destroyed mid-request: end the raw pg client instead of leaking it
      try {
        await (connection as Tagged).end?.();
      } catch {
        // ignore
      }
      return;
    }
    const entry = await p;
    return entry.knex.client.releaseConnection(connection);
  }
  // destroy(): inherited — destroys only the main pool (site pools are module-owned).
}

// ---------------------------------------------------------------------------
// Test hooks (node:test only)
// ---------------------------------------------------------------------------

export function __setPoolFactoryForTests(factory: PoolFactory | null): void {
  poolFactory = factory ?? defaultPoolFactory;
}

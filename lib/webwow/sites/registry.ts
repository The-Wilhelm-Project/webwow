/**
 * Site registry (`webwow_sites` in the main database) with an in-process cache.
 *
 * Reads go through `getMainDb()` only — never through the site-aware pool
 * (`pg-client.ts` asks this module for a site's database name, so a lookup
 * through the site-aware client would recurse). The cache lives on
 * `globalThis` (`Symbol.for('webwow.sitesCache')`) so the proxy and app
 * bundles share it; `invalidateRegistry()` also bumps
 * `globalThis.__webwowSitesVersion`.
 *
 * No `server-only`, no `@/` imports (loaded through knexfile.ts by the knex CLI).
 */

import type { Knex } from 'knex';
import { DEFAULT_SITE_ID } from './ids';
import { getMainDb } from './main-db';

export interface SiteRow {
  id: string;
  slug: string;
  name: string;
  database_name: string | null;
  domains: string[];
  is_default: boolean;
  editor_password_hash: string | null;
  editor_password_version: number;
  thumbnail_url: string | null;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
}

const CACHE_TTL_MS = 10_000;
const AVAILABLE_TTL_MS = 60_000;
const CACHE_KEY = Symbol.for('webwow.sitesCache');

/** Minimal knex surface the registry needs (lets tests inject a stub). */
export type MainDbLike = Pick<Knex, 'schema'> & ((table: string) => Knex.QueryBuilder);

interface RegistryCache {
  rows: SiteRow[] | null;
  fetchedAt: number;
  version: number;
  inflight: Promise<SiteRow[]> | null;
  available: { value: boolean; checkedAt: number } | null;
  availableInflight: Promise<boolean> | null;
  warnedUnavailable: boolean;
  warnedStale: boolean;
}

const g = globalThis as unknown as Record<symbol, RegistryCache | undefined> & { __webwowSitesVersion?: number };

const cache: RegistryCache = g[CACHE_KEY] ?? (g[CACHE_KEY] = {
  rows: null,
  fetchedAt: 0,
  version: 0,
  inflight: null,
  available: null,
  availableInflight: null,
  warnedUnavailable: false,
  warnedStale: false,
});

let mainDbOverride: MainDbLike | null = null;
let clock: () => number = () => Date.now();

async function mainDb(): Promise<MainDbLike> {
  return mainDbOverride ?? ((await getMainDb()) as unknown as MainDbLike);
}

function normalizeRow(row: Record<string, unknown>): SiteRow {
  let domains: unknown = row.domains;
  if (typeof domains === 'string') {
    try { domains = JSON.parse(domains); } catch { domains = []; }
  }
  const toIso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name ?? ''),
    database_name: row.database_name == null ? null : String(row.database_name),
    domains: Array.isArray(domains) ? domains.filter((d): d is string => typeof d === 'string') : [],
    is_default: row.is_default === true,
    editor_password_hash: row.editor_password_hash == null ? null : String(row.editor_password_hash),
    editor_password_version: Number(row.editor_password_version ?? 0) || 0,
    thumbnail_url: row.thumbnail_url == null ? null : String(row.thumbnail_url),
    created_at: toIso(row.created_at) ?? '',
    updated_at: toIso(row.updated_at) ?? '',
    last_opened_at: toIso(row.last_opened_at),
  };
}

function currentVersion(): number {
  return g.__webwowSitesVersion ?? 0;
}

/** Cached snapshot of every registry row (10 s TTL; refreshed after `invalidateRegistry()`). */
export async function listSites(): Promise<SiteRow[]> {
  const version = currentVersion();
  if (cache.rows && cache.version === version && clock() - cache.fetchedAt < CACHE_TTL_MS) return cache.rows;
  if (cache.inflight) return cache.inflight;
  cache.inflight = (async () => {
    try {
      const db = await mainDb();
      const rows = (await db('webwow_sites').select('*').orderBy('created_at', 'asc')) as Record<string, unknown>[];
      const normalized = rows.map(normalizeRow);
      cache.rows = normalized;
      cache.fetchedAt = clock();
      cache.version = version;
      cache.warnedStale = false;
      return normalized;
    } catch (error) {
      if (cache.rows) {
        if (!cache.warnedStale) {
          cache.warnedStale = true;
          console.warn('[webwow/sites] registry refresh failed, serving the cached snapshot:', error instanceof Error ? error.message : error);
        }
        cache.fetchedAt = clock();
        return cache.rows;
      }
      throw error;
    } finally {
      cache.inflight = null;
    }
  })();
  return cache.inflight;
}

export async function getSite(id: string): Promise<SiteRow | null> {
  if (typeof id !== 'string' || !id) return null;
  return (await listSites()).find((s) => s.id === id) ?? null;
}

export async function getSiteBySlug(slug: string): Promise<SiteRow | null> {
  if (typeof slug !== 'string' || !slug) return null;
  return (await listSites()).find((s) => s.slug === slug) ?? null;
}

/** Database name of a non-default site (null when unknown). `default` throws: it never has its own pool. */
export async function getSiteDatabaseName(id: string): Promise<string | null> {
  if (id === DEFAULT_SITE_ID) throw new Error('[webwow/sites] the default site uses the DATABASE_URL pool');
  const site = await getSite(id);
  return site?.database_name ?? null;
}

/** Drop the cached snapshot (after any registry mutation) and bump the cross-bundle version. */
export function invalidateRegistry(): void {
  g.__webwowSitesVersion = currentVersion() + 1;
  cache.rows = null;
  cache.fetchedAt = 0;
  cache.available = null;
}

/** `webwow_sites` exists in the main DB (memoised 60 s). false -> single-site behaviour everywhere. */
export async function registryAvailable(): Promise<boolean> {
  if (cache.available && clock() - cache.available.checkedAt < AVAILABLE_TTL_MS) return cache.available.value;
  if (cache.availableInflight) return cache.availableInflight;
  cache.availableInflight = (async () => {
    try {
      const db = await mainDb();
      const value = await db.schema.hasTable('webwow_sites');
      cache.available = { value, checkedAt: clock() };
      if (value) cache.warnedUnavailable = false;
      return value;
    } catch (error) {
      if (!cache.warnedUnavailable) {
        cache.warnedUnavailable = true;
        console.warn('[webwow/sites] registry unavailable, running in single-site mode:', error instanceof Error ? error.message : error);
      }
      cache.available = { value: false, checkedAt: clock() };
      return false;
    } finally {
      cache.availableInflight = null;
    }
  })();
  return cache.availableInflight;
}

/** More than one registered site. */
export async function isMultiSiteInstall(): Promise<boolean> {
  return (await listSites()).length > 1;
}

// ---------------------------------------------------------------------------
// Test hooks (node:test only)
// ---------------------------------------------------------------------------

export function __setMainDbForTests(db: MainDbLike | null): void {
  mainDbOverride = db;
  __resetRegistryForTests();
}

export function __setClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

export function __resetRegistryForTests(): void {
  cache.rows = null;
  cache.fetchedAt = 0;
  cache.inflight = null;
  cache.available = null;
  cache.availableInflight = null;
  cache.warnedUnavailable = false;
  cache.warnedStale = false;
}

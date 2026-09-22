/**
 * Current site id for the running request (multi-site).
 *
 * Precedence: `siteStore` (explicit `runInSite`) -> signed `x-webwow-site`
 * request header set by the proxy -> `default`. `getCurrentSiteId()` is
 * synchronous, never throws and never marks a page dynamic: it reads the
 * request store's sealed headers directly instead of calling `headers()`
 * (which throws inside cache scopes and bails out of static generation).
 *
 * `resolveSiteIdForCache()` is the one place that calls the public `headers()`
 * on purpose — only in multi-site mode (`WEBWOW_MULTI_SITE=1`) and only outside
 * cache scopes — so published pages become dynamic per request there and stay
 * fully static in single-site mode.
 *
 * No `server-only`, no `@/` imports (loaded through knexfile.ts by the knex CLI).
 */

import { siteStore } from './context';
import { DEFAULT_SITE_ID } from './ids';
import { verifySiteHeader } from './site-header';

export const SITE_HEADER = 'x-webwow-site';

interface WorkUnitStoreLike {
  type?: string;
  headers?: { get?: (name: string) => string | null | undefined };
}

/** The Next work-unit store, or undefined outside Next (CLI, tests) or when the internal path changes. */
function safeWorkUnitStore(): WorkUnitStoreLike | undefined {
  try {
    // Internal but fenced by request-site.test.ts (fails loudly on a Next bump).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('next/dist/server/app-render/work-unit-async-storage.external') as {
      workUnitAsyncStorage: { getStore(): WorkUnitStoreLike | undefined };
    };
    return mod.workUnitAsyncStorage.getStore();
  } catch {
    return undefined;
  }
}

/** Verified site id from the proxy-signed header of the current request store, if any. */
export function siteIdFromWorkUnitHeaders(): string | undefined {
  const store = safeWorkUnitStore();
  if (store && (store.type === 'request' || store.type === 'prerender-runtime' || store.type === 'private-cache')) {
    let raw: string | null | undefined;
    try {
      raw = store.headers?.get?.(SITE_HEADER);
    } catch {
      raw = undefined;
    }
    return raw ? verifySiteHeader(raw) ?? undefined : undefined; // forged/unsigned -> undefined -> default
  }
  return undefined;
}

/** Synchronous site id: siteStore -> signed request header -> `default`. Never throws. */
export function getCurrentSiteId(): string {
  return siteStore.getStore() ?? siteIdFromWorkUnitHeaders() ?? DEFAULT_SITE_ID;
}

/** `WEBWOW_MULTI_SITE=1|true` (build-time and runtime flag; see docs/MULTISITE.md). */
export function isMultiSiteMode(): boolean {
  return process.env.WEBWOW_MULTI_SITE === '1' || process.env.WEBWOW_MULTI_SITE === 'true';
}

/**
 * Site id for the `next/cache` wrapper. Single-site mode never touches `headers()`
 * (pages stay static). Multi-site mode calls `headers()` outside cache scopes:
 * under `prerender-legacy` that throws `DynamicServerError` (the page becomes
 * dynamic, intended) — never swallow it here.
 */
export async function resolveSiteIdForCache(): Promise<string> {
  const pinned = siteStore.getStore();
  if (pinned) return pinned;
  if (!isMultiSiteMode()) return DEFAULT_SITE_ID;
  const store = safeWorkUnitStore();
  if (store && (store.type === 'unstable-cache' || store.type === 'cache')) return DEFAULT_SITE_ID; // nested cache scope: headers() would throw (E838)
  const { headers } = await import('next/headers');
  const raw = (await headers()).get(SITE_HEADER);
  return (raw && verifySiteHeader(raw)) || DEFAULT_SITE_ID;
}

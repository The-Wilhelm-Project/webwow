/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Site-scoped `next/cache` (multi-site).
 *
 * Aliased for the bare specifier 'next/cache' on the SERVER only (next.config.ts:
 * Turbopack conditional alias + webpack `isServer` alias). 'next/cache.js' is a
 * different request string and resolves to Next's real module (verified on
 * next 16.3.0 with Turbopack and webpack, scratchpad probe-alias2), so the
 * spread below keeps every current and future export; only `unstable_cache`
 * and `revalidateTag` are overridden.
 *
 * Written as an ES module with explicit named exports: a `.ts` file that contains
 * any `import` is treated as ESM by Turbopack, so `module.exports` would be
 * invisible ("the module has no exports at all"). `next-cache.test.ts` asserts
 * that this file re-exports every key of Next's own `cache.js`, so a Next bump
 * that adds an export fails the test instead of failing at runtime.
 *
 * Behaviour: single-site (`WEBWOW_MULTI_SITE` unset) -> `resolveSiteIdForCache()`
 * returns `default` without touching `headers()` -> keys/tags byte-identical to
 * upstream, published pages stay static. Multi-site -> one real `unstable_cache`
 * per site, created lazily at call time with the ORIGINAL callback (`cb.toString()`
 * is part of Next's key), key part `site:<id>` and tags prefixed `s-<id>-`; the
 * callback runs inside `siteStore.run(siteId)` because `headers()` throws inside
 * the 'unstable-cache' scope.
 */

import type * as NextCache from 'next/cache';

const real = require('next/cache.js') as typeof NextCache;
const { siteStore } = require('./sites/context') as typeof import('./sites/context');
const { getCurrentSiteId, resolveSiteIdForCache } = require('./sites/request-site') as typeof import('./sites/request-site');
const { DEFAULT_SITE_ID } = require('./sites/ids') as typeof import('./sites/ids');

type UnstableCache = typeof NextCache.unstable_cache;
type CacheOptions = NonNullable<Parameters<UnstableCache>[2]>;
type RevalidateProfile = Parameters<typeof NextCache.revalidateTag>[1];

/** `tag` for the default site, `s-<siteId>-<tag>` for every other site. */
function siteTag(tag: string, siteId: string = getCurrentSiteId()): string {
  return siteId === DEFAULT_SITE_ID ? tag : `s-${siteId}-${tag}`;
}

function unstable_cache<T extends (...args: any[]) => Promise<any>>(cb: T, keyParts?: string[], options: CacheOptions = {}): T {
  const perSite = new Map<string, T>();
  const cached = async (...args: unknown[]) => {
    const siteId = await resolveSiteIdForCache();
    let fn = perSite.get(siteId);
    if (!fn) {
      fn = (siteId === DEFAULT_SITE_ID
        ? real.unstable_cache(cb, keyParts, options)
        : real.unstable_cache(cb, [...(keyParts ?? []), `site:${siteId}`], { ...options, tags: options.tags?.map((t) => siteTag(t, siteId)) })) as T;
      perSite.set(siteId, fn);
    }
    const run = fn;
    return siteStore.run(siteId, () => run(...args)); // cb runs in an 'unstable-cache' scope: headers() throws there, siteStore does not
  };
  return cached as unknown as T;
}

function revalidateTag(tag: string, profile?: RevalidateProfile): ReturnType<typeof NextCache.revalidateTag> {
  return (real.revalidateTag as (tag: string, profile?: RevalidateProfile) => ReturnType<typeof NextCache.revalidateTag>)(siteTag(tag), profile);
}

// Pass-through exports (must stay in sync with node_modules/next/cache.js —
// fenced by next-cache.test.ts).
export const revalidatePath = real.revalidatePath;
export const updateTag = real.updateTag;
export const unstable_noStore = real.unstable_noStore;
export const cacheLife = real.cacheLife;
export const cacheTag = real.cacheTag;
export const refresh = real.refresh;
export const unstable_cacheLife = (real as unknown as Record<string, unknown>).unstable_cacheLife;
export const unstable_cacheTag = (real as unknown as Record<string, unknown>).unstable_cacheTag;
export const io = (real as unknown as Record<string, unknown>).io;

export { unstable_cache, revalidateTag, siteTag };

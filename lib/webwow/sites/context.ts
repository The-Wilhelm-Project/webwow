/**
 * Site context (AsyncLocalStorage) for the multi-site compatibility layer.
 *
 * The store carries the current site id through every async continuation
 * (knex acquisitions, storage writes, cache wrapper). It lives on `globalThis`
 * under a `Symbol.for` key so the proxy bundle, the app bundle and HMR copies
 * of this module share one instance.
 *
 * No `server-only`, no `@/` imports: loaded by `knexfile.ts` under the knex CLI.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { DEFAULT_SITE_ID } from './ids';

const KEY = Symbol.for('webwow.siteStore');
const g = globalThis as unknown as Record<symbol, AsyncLocalStorage<string> | undefined>;

export const siteStore: AsyncLocalStorage<string> = g[KEY] ?? (g[KEY] = new AsyncLocalStorage<string>());

/** Run `fn` with `siteId` as the current site (wins over the request header). */
export function runInSite<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
  return siteStore.run(siteId, fn);
}

/** Site id pinned by `runInSite`/`siteStore.run`, if any. */
export function siteIdFromStore(): string | undefined {
  return siteStore.getStore();
}

export { DEFAULT_SITE_ID };

/* eslint-disable @typescript-eslint/no-require-imports */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
process.env.PAGE_AUTH_SECRET = 'next-cache-test-secret';
delete process.env.WEBWOW_MULTI_SITE;

function stubModule(id: string, exports: unknown): void {
  const filename = require.resolve(id);
  const mod = new Module(filename) as Module & { loaded: boolean };
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

// The real next/cache.js is replaced by a recording fake (its export names mirror node_modules/next/cache.js).
interface CacheCall { cb: unknown; keyParts: string[] | undefined; options: { tags?: string[]; revalidate?: number | false } }
/** What the recording fake's cached function resolves to (the wrapper keeps the callback's own type). */
interface FakeResult { result: unknown; keyParts: string[] | undefined; tags: string[] | undefined }
const constructed: CacheCall[] = [];
const revalidated: Array<[string, unknown]> = [];
const fakeReal = {
  unstable_cache: (cb: (...a: unknown[]) => Promise<unknown>, keyParts?: string[], options: CacheCall['options'] = {}) => {
    constructed.push({ cb, keyParts, options });
    return async (...args: unknown[]) => ({ result: await cb(...args), keyParts, tags: options.tags });
  },
  revalidateTag: (tag: string, profile?: unknown) => { revalidated.push([tag, profile]); },
  revalidatePath: () => 'revalidatePath',
  updateTag: () => 'updateTag',
  unstable_noStore: () => 'unstable_noStore',
  cacheLife: () => 'cacheLife',
  unstable_cacheLife: () => 'unstable_cacheLife',
  cacheTag: () => 'cacheTag',
  unstable_cacheTag: () => 'unstable_cacheTag',
  refresh: () => 'refresh',
  io: { marker: 'io' },
};
stubModule('next/cache.js', fakeReal);

let headersCalls = 0;
stubModule('next/headers', { headers: async () => { headersCalls += 1; return new Headers(); } });

import { siteStore } from './sites/context';
const wrapper = require('./next-cache') as typeof import('next/cache') & { siteTag: (tag: string, siteId?: string) => string };
const { workUnitAsyncStorage } = require('next/dist/server/app-render/work-unit-async-storage.external');

test('module exports contain every key of next/cache.js plus siteTag', () => {
  for (const key of Object.keys(fakeReal)) assert.ok(key in wrapper, key);
  for (const key of ['revalidatePath', 'updateTag', 'unstable_noStore', 'cacheLife', 'unstable_cacheLife', 'cacheTag', 'unstable_cacheTag', 'refresh', 'io']) {
    assert.equal((wrapper as unknown as Record<string, unknown>)[key], (fakeReal as Record<string, unknown>)[key], `${key} is passed through`);
  }
  assert.notEqual(wrapper.unstable_cache, fakeReal.unstable_cache);
  assert.notEqual(wrapper.revalidateTag, fakeReal.revalidateTag);
  assert.equal(typeof wrapper.siteTag, 'function');
});

test('single-site mode: identical keyParts/tags, original callback, no headers()', async () => {
  constructed.length = 0;
  headersCalls = 0;
  const cb = async (a: number) => a * 2;
  const cached = wrapper.unstable_cache(cb, ['k'], { tags: ['t'], revalidate: 60 });
  assert.deepEqual(await cached(21), { result: 42, keyParts: ['k'], tags: ['t'] });
  assert.equal(constructed.length, 1);
  assert.equal(constructed[0].cb, cb, 'original cb is passed (cb.toString() is part of the key)');
  assert.deepEqual(constructed[0].keyParts, ['k']);
  assert.deepEqual(constructed[0].options, { tags: ['t'], revalidate: 60 });
  await cached(1);
  assert.equal(constructed.length, 1, 'constructed once');
  assert.equal(headersCalls, 0);
});

test('inside siteStore.run: site key part, prefixed tags, one real cache per site, cb sees the site', async () => {
  constructed.length = 0;
  let seen: string | undefined;
  const cb = async () => { seen = siteStore.getStore(); return 'v'; };
  const cached = wrapper.unstable_cache(cb, ['k'], { tags: ['t', 'all-pages'] });
  const r1 = await siteStore.run('s_1000000000', () => cached());
  assert.deepEqual(r1, { result: 'v', keyParts: ['k', 'site:s_1000000000'], tags: ['s-s_1000000000-t', 's-s_1000000000-all-pages'] });
  assert.equal(seen, 's_1000000000');
  await siteStore.run('s_1000000000', () => cached());
  assert.equal(constructed.length, 1, 'one real cache per site');
  await siteStore.run('s_2000000000', () => cached());
  assert.equal(constructed.length, 2);
  assert.deepEqual(constructed[1].keyParts, ['k', 'site:s_2000000000']);
  assert.equal(constructed[1].cb, cb);
  const r3 = (await cached()) as unknown as FakeResult;
  assert.deepEqual(r3.keyParts, ['k'], 'default site outside the store');
  assert.equal(constructed.length, 3);
  const noKeys = wrapper.unstable_cache(async () => 1, undefined, {});
  assert.deepEqual(((await siteStore.run('s_1000000000', () => noKeys())) as unknown as FakeResult).keyParts, ['site:s_1000000000']);
});

test('revalidateTag prefixes inside the store and passes the profile through', () => {
  revalidated.length = 0;
  siteStore.run('s_1000000000', () => wrapper.revalidateTag('t', { expire: 0 } as never));
  wrapper.revalidateTag('t', 'max' as never);
  assert.deepEqual(revalidated, [['s-s_1000000000-t', { expire: 0 }], ['t', 'max']]);
  assert.equal(wrapper.siteTag('t'), 't');
  assert.equal(wrapper.siteTag('t', 's_1000000000'), 's-s_1000000000-t');
});

test('multi-site mode: inside an unstable-cache work-unit store the resolver uses the ALS value, never headers()', async () => {
  process.env.WEBWOW_MULTI_SITE = '1';
  headersCalls = 0;
  constructed.length = 0;
  try {
    const cached = wrapper.unstable_cache(async () => 'x', ['k'], { tags: ['t'] });
    const inner = { type: 'unstable-cache', phase: 'render', implicitTags: null };
    const r = await workUnitAsyncStorage.run(inner, () => siteStore.run('s_1000000000', () => cached()));
    assert.deepEqual(r.keyParts, ['k', 'site:s_1000000000']);
    const d = await workUnitAsyncStorage.run(inner, () => cached());
    assert.deepEqual(d.keyParts, ['k'], 'nested cache scope without ALS -> default');
    assert.equal(headersCalls, 0);
    // outside any cache scope the resolver consults headers() (stubbed here -> no site header -> default)
    const o = (await cached()) as unknown as FakeResult;
    assert.deepEqual(o.keyParts, ['k']);
    assert.equal(headersCalls, 1);
  } finally {
    delete process.env.WEBWOW_MULTI_SITE;
  }
});

/* eslint-disable @typescript-eslint/no-require-imports */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';

// Next only uses a real AsyncLocalStorage when the environment provides it globally
// (node-environment-baseline.js); install it before the work-unit storage module is created.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
process.env.PAGE_AUTH_SECRET = 'request-site-test-secret';
delete process.env.WEBWOW_MULTI_SITE;

// Stub `next/headers` so a call is observable (and never reaches Next's request machinery).
let headersCalls = 0;
const headersPath = require.resolve('next/headers');
const stub = new Module(headersPath) as Module & { loaded: boolean };
stub.filename = headersPath;
stub.loaded = true;
stub.exports = {
  headers: async () => {
    headersCalls += 1;
    return new Headers({ 'x-webwow-site': signSiteHeader('s_fromheader', process.env.PAGE_AUTH_SECRET!) });
  },
};
require.cache[headersPath] = stub;

import { signSiteHeader } from './site-header';
import { siteStore } from './context';
import { SITE_HEADER, getCurrentSiteId, isMultiSiteMode, resolveSiteIdForCache, siteIdFromWorkUnitHeaders } from './request-site';

const { workUnitAsyncStorage } = require('next/dist/server/app-render/work-unit-async-storage.external');
const { createRequestStoreForAPI } = require('next/dist/server/async-storage/request-store');

function requestStore(headers: Record<string, string>) {
  const url = new URL('http://x/');
  return createRequestStoreForAPI(new Request(url, { headers }), url, null, undefined, undefined, undefined);
}

test('Next internals used by request-site still exist (fence for Next bumps)', () => {
  assert.equal(typeof workUnitAsyncStorage.getStore, 'function');
  assert.equal(typeof workUnitAsyncStorage.run, 'function');
  assert.ok(workUnitAsyncStorage instanceof AsyncLocalStorage, 'work-unit storage must be a real AsyncLocalStorage');
  const store = requestStore({});
  assert.equal(store.type, 'request');
  assert.equal(typeof store.headers.get, 'function');
});

test('signed header in a real request store -> site id', () => {
  const store = requestStore({ [SITE_HEADER]: signSiteHeader('s_abcdefghij', process.env.PAGE_AUTH_SECRET!) });
  workUnitAsyncStorage.run(store, () => {
    assert.equal(siteIdFromWorkUnitHeaders(), 's_abcdefghij');
    assert.equal(getCurrentSiteId(), 's_abcdefghij');
  });
});

test('unsigned or forged header -> default', () => {
  workUnitAsyncStorage.run(requestStore({ [SITE_HEADER]: 's_abcdefghij' }), () => {
    assert.equal(getCurrentSiteId(), 'default');
  });
  workUnitAsyncStorage.run(requestStore({ [SITE_HEADER]: signSiteHeader('s_abcdefghij', 'wrong-secret') }), () => {
    assert.equal(getCurrentSiteId(), 'default');
  });
  workUnitAsyncStorage.run(requestStore({}), () => {
    assert.equal(getCurrentSiteId(), 'default');
  });
});

test('cache-scope stores and no store -> default', () => {
  workUnitAsyncStorage.run({ type: 'unstable-cache', phase: 'render', implicitTags: null }, () => {
    assert.equal(getCurrentSiteId(), 'default');
  });
  workUnitAsyncStorage.run({ type: 'prerender-legacy', phase: 'render' }, () => {
    assert.equal(getCurrentSiteId(), 'default');
  });
  assert.equal(getCurrentSiteId(), 'default');
});

test('siteStore wins over the header', () => {
  const store = requestStore({ [SITE_HEADER]: signSiteHeader('s_abcdefghij', process.env.PAGE_AUTH_SECRET!) });
  workUnitAsyncStorage.run(store, () => {
    siteStore.run('s_x000000000', () => {
      assert.equal(getCurrentSiteId(), 's_x000000000');
    });
    assert.equal(getCurrentSiteId(), 's_abcdefghij');
  });
});

test('resolveSiteIdForCache never calls headers() in single-site mode', async () => {
  delete process.env.WEBWOW_MULTI_SITE;
  assert.equal(isMultiSiteMode(), false);
  headersCalls = 0;
  assert.equal(await resolveSiteIdForCache(), 'default');
  const store = requestStore({ [SITE_HEADER]: signSiteHeader('s_abcdefghij', process.env.PAGE_AUTH_SECRET!) });
  assert.equal(await workUnitAsyncStorage.run(store, () => resolveSiteIdForCache()), 'default');
  assert.equal(await siteStore.run('s_pinned0000', () => resolveSiteIdForCache()), 's_pinned0000');
  assert.equal(headersCalls, 0);
});

test('resolveSiteIdForCache in multi-site mode: store wins, cache scopes skip headers(), otherwise headers()', async () => {
  process.env.WEBWOW_MULTI_SITE = '1';
  try {
    assert.equal(isMultiSiteMode(), true);
    headersCalls = 0;
    assert.equal(await siteStore.run('s_pinned0000', () => resolveSiteIdForCache()), 's_pinned0000');
    assert.equal(await workUnitAsyncStorage.run({ type: 'unstable-cache', phase: 'render' }, () => resolveSiteIdForCache()), 'default');
    assert.equal(await workUnitAsyncStorage.run({ type: 'cache', phase: 'render' }, () => resolveSiteIdForCache()), 'default');
    assert.equal(headersCalls, 0);
    assert.equal(await resolveSiteIdForCache(), 's_fromheader');
    assert.equal(headersCalls, 1);
  } finally {
    delete process.env.WEBWOW_MULTI_SITE;
  }
});

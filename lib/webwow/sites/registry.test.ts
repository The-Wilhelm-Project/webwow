import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetRegistryForTests,
  __setClockForTests,
  __setMainDbForTests,
  getSite,
  getSiteBySlug,
  getSiteDatabaseName,
  invalidateRegistry,
  isMultiSiteInstall,
  listSites,
  registryAvailable,
  type MainDbLike,
} from './registry';

interface FakeState { rows: Record<string, unknown>[]; fetches: number; hasTable: boolean; hasTableCalls: number; fail?: Error | null }

function fakeDb(state: FakeState): MainDbLike {
  const builder = {
    select() { return builder; },
    orderBy() { return builder; },
    then(resolve: (rows: unknown) => unknown, reject?: (e: unknown) => unknown) {
      state.fetches += 1;
      return (state.fail ? Promise.reject(state.fail) : Promise.resolve(state.rows.map((r) => ({ ...r })))).then(resolve, reject);
    },
  };
  const db = ((table: string) => {
    assert.equal(table, 'webwow_sites');
    return builder;
  }) as unknown as MainDbLike;
  (db as unknown as { schema: unknown }).schema = {
    hasTable: async (name: string) => {
      state.hasTableCalls += 1;
      assert.equal(name, 'webwow_sites');
      if (state.fail) throw state.fail;
      return state.hasTable;
    },
  };
  return db;
}

const rows = [
  { id: 'default', slug: 'default', name: 'My Site', database_name: null, domains: [], is_default: true, editor_password_hash: null, editor_password_version: 0, thumbnail_url: null, created_at: new Date('2026-01-01T00:00:00Z'), updated_at: '2026-01-01T00:00:00.000Z', last_opened_at: null },
  { id: 's_abcdefghij', slug: 'valeska', name: 'Valeska', database_name: 'webwow_site_valeska', domains: '["valeska.example.com"]', is_default: false, editor_password_hash: 'h', editor_password_version: '2', thumbnail_url: null, created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-02-01T00:00:00.000Z', last_opened_at: null },
];

test('listSites caches for the TTL, refreshes when stale and after invalidateRegistry()', async () => {
  let now = 1_000_000;
  __setClockForTests(() => now);
  const state: FakeState = { rows, fetches: 0, hasTable: true, hasTableCalls: 0 };
  __setMainDbForTests(fakeDb(state));
  try {
    const first = await listSites();
    assert.equal(first.length, 2);
    assert.equal(state.fetches, 1);
    assert.deepEqual(first[1].domains, ['valeska.example.com']);
    assert.equal(first[1].editor_password_version, 2);
    assert.equal(first[0].created_at, '2026-01-01T00:00:00.000Z');

    now += 5_000;
    await listSites();
    assert.equal(state.fetches, 1, 'within TTL: no refetch');

    now += 6_000;
    await listSites();
    assert.equal(state.fetches, 2, 'after TTL: refetch');

    invalidateRegistry();
    await listSites();
    assert.equal(state.fetches, 3, 'invalidate: refetch');

    // concurrent callers share one in-flight query
    now += 20_000;
    await Promise.all([listSites(), listSites(), listSites()]);
    assert.equal(state.fetches, 4);
  } finally {
    __setMainDbForTests(null);
    __setClockForTests(null);
  }
});

test('getSite / getSiteBySlug / getSiteDatabaseName / isMultiSiteInstall', async () => {
  const state: FakeState = { rows, fetches: 0, hasTable: true, hasTableCalls: 0 };
  __setMainDbForTests(fakeDb(state));
  try {
    assert.equal((await getSite('s_abcdefghij'))?.name, 'Valeska');
    assert.equal(await getSite('nope'), null);
    assert.equal(await getSite(''), null);
    assert.equal((await getSiteBySlug('valeska'))?.id, 's_abcdefghij');
    assert.equal(await getSiteBySlug('other'), null);
    assert.equal(await getSiteDatabaseName('s_abcdefghij'), 'webwow_site_valeska');
    assert.equal(await getSiteDatabaseName('s_unknown000'), null);
    await assert.rejects(getSiteDatabaseName('default'));
    assert.equal(await isMultiSiteInstall(), true);
    assert.equal(state.fetches, 1, 'all lookups share the snapshot');
  } finally {
    __setMainDbForTests(null);
  }
});

test('registryAvailable memoises hasTable and reports false on errors', async () => {
  let now = 5_000_000;
  __setClockForTests(() => now);
  const state: FakeState = { rows, fetches: 0, hasTable: false, hasTableCalls: 0 };
  __setMainDbForTests(fakeDb(state));
  try {
    assert.equal(await registryAvailable(), false);
    assert.equal(await registryAvailable(), false);
    assert.equal(state.hasTableCalls, 1);
    state.hasTable = true;
    now += 61_000;
    assert.equal(await registryAvailable(), true);
    assert.equal(state.hasTableCalls, 2);
    invalidateRegistry();
    assert.equal(await registryAvailable(), true);
    assert.equal(state.hasTableCalls, 3, 'invalidate re-checks');

    __resetRegistryForTests();
    state.fail = new Error('connection refused');
    const warn = console.warn;
    const warned: unknown[] = [];
    console.warn = (...args: unknown[]) => { warned.push(args); };
    try {
      assert.equal(await registryAvailable(), false);
      assert.equal(await registryAvailable(), false);
    } finally {
      console.warn = warn;
    }
    assert.equal(warned.length, 1, 'logs once');
  } finally {
    __setMainDbForTests(null);
    __setClockForTests(null);
  }
});

test('listSites serves the cached snapshot when a refresh fails', async () => {
  let now = 9_000_000;
  __setClockForTests(() => now);
  const state: FakeState = { rows, fetches: 0, hasTable: true, hasTableCalls: 0 };
  __setMainDbForTests(fakeDb(state));
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal((await listSites()).length, 2);
    state.fail = new Error('db down');
    now += 20_000;
    assert.equal((await listSites()).length, 2, 'stale snapshot');
    __resetRegistryForTests();
    await assert.rejects(listSites(), /db down/);
  } finally {
    console.warn = warn;
    __setMainDbForTests(null);
    __setClockForTests(null);
  }
});

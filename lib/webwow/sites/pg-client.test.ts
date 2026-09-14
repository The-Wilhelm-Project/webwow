/* eslint-disable @typescript-eslint/no-require-imports */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import knex, { type Knex } from 'knex';
import { siteStore } from './context';
import { WebwowPgClient, __setPoolFactoryForTests, destroySitePools, destroyAllSitePools, getSitePool, sitePoolCount, type PoolEntry } from './pg-client';

const ClientPG = require('knex/lib/dialects/postgres');

interface StubConn { __webwowSite?: string; id: string; ended: number; end: () => Promise<void> }

function stubEntry(databaseName: string, log: string[]): PoolEntry & { conns: StubConn[] } {
  const conns: StubConn[] = [];
  let seq = 0;
  const client = {
    pool: { numUsed: () => conns.length, numPendingAcquires: () => 0 },
    async acquireConnection() {
      const conn: StubConn = { id: `${databaseName}#${++seq}`, ended: 0, end: async () => { conn.ended += 1; } };
      conns.push(conn);
      log.push(`acquire ${conn.id}`);
      return conn;
    },
    async releaseConnection(conn: StubConn) {
      conns.splice(conns.indexOf(conn), 1);
      log.push(`release ${conn.id}`);
    },
  };
  const fake = { client, destroy: async () => { log.push(`destroy ${databaseName}`); } } as unknown as Knex;
  return { knex: fake, databaseName, lastUsed: Date.now(), conns };
}

test('knexfile-style config instantiates the subclass of knex/lib/dialects/postgres', async () => {
  const db = knex({ client: WebwowPgClient, connection: async () => ({ connectionString: 'postgresql://x' }) });
  try {
    assert.ok(db.client instanceof ClientPG);
    assert.ok(db.client instanceof WebwowPgClient);
    assert.equal(db.client.driverName, 'pg');
    assert.equal(db.client.dialect, 'postgresql');
    assert.ok(db.client.pool, 'main pool is initialised');
    const clone = db.withUserParams({});
    assert.ok(clone.client instanceof WebwowPgClient, 'withUserParams clone keeps the prototype');
    assert.equal(clone.client.pool, db.client.pool, 'clone shares the main pool');
    assert.equal(Object.getPrototypeOf(clone.client), WebwowPgClient.prototype);
  } finally {
    await db.destroy();
  }
});

test('acquire/release inside siteStore.run route to the site pool and tag the connection', async () => {
  const log: string[] = [];
  let created = 0;
  const entries = new Map<string, ReturnType<typeof stubEntry>>();
  __setPoolFactoryForTests(async (siteId) => {
    created += 1;
    await new Promise((r) => setTimeout(r, 5)); // simulate the registry lookup
    const e = stubEntry(`db_${siteId}`, log);
    entries.set(siteId, e);
    return e;
  });
  const db = knex({ client: WebwowPgClient, connection: async () => ({ connectionString: 'postgresql://x' }) });
  try {
    const conn = await siteStore.run('s_1000000000', () => db.client.acquireConnection()) as StubConn;
    assert.equal(conn.__webwowSite, 's_1000000000');
    assert.equal(conn.id, 'db_s_1000000000#1');
    assert.equal(created, 1);
    await db.client.releaseConnection(conn);
    assert.deepEqual(log, ['acquire db_s_1000000000#1', 'release db_s_1000000000#1']);

    // 20 parallel first acquisitions of a fresh site create exactly one pool
    const conns = await siteStore.run('s_2000000000', () => Promise.all(Array.from({ length: 20 }, () => db.client.acquireConnection()))) as StubConn[];
    assert.equal(created, 2);
    assert.equal(new Set(conns.map((c) => c.__webwowSite)).size, 1);
    assert.ok(conns.every((c) => c.id.startsWith('db_s_2000000000#')));
    await Promise.all(conns.map((c) => db.client.releaseConnection(c)));
    assert.equal(entries.get('s_2000000000')!.conns.length, 0);

    // the memoised pool is reused
    const again = await siteStore.run('s_2000000000', () => db.client.acquireConnection()) as StubConn;
    assert.equal(created, 2);
    await db.client.releaseConnection(again);

    // releaseConnection after destroySitePools ends the raw client instead of leaking it
    const orphan = await siteStore.run('s_1000000000', () => db.client.acquireConnection()) as StubConn;
    await destroySitePools('s_1000000000');
    assert.ok(log.includes('destroy db_s_1000000000'));
    await db.client.releaseConnection(orphan);
    assert.equal(orphan.ended, 1);
    assert.equal(sitePoolCount(), 1);

    // a failed creation is not cached
    __setPoolFactoryForTests(async () => { throw new Error('unknown site'); });
    await assert.rejects(siteStore.run('s_3000000000', () => db.client.acquireConnection()), /unknown site/);
    assert.equal(sitePoolCount(), 1);
    await assert.rejects(getSitePool('s_3000000000'), /unknown site/);
  } finally {
    __setPoolFactoryForTests(null);
    await destroyAllSitePools();
    await db.destroy();
  }
});

test('the pool being opened is never its own LRU victim (every other pool busy)', async () => {
  const log: string[] = [];
  process.env.WEBWOW_MAX_SITE_POOLS = '1';
  __setPoolFactoryForTests(async (siteId) => stubEntry(`db_${siteId}`, log));
  const db = knex({ client: WebwowPgClient, connection: async () => ({ connectionString: 'postgresql://x' }) });
  try {
    const busy = await siteStore.run('s_e000000000', () => db.client.acquireConnection()) as StubConn;
    await getSitePool('s_f000000000'); // cap exceeded, but the only idle pool is the one being opened
    assert.equal(sitePoolCount(), 2, 'cap exceeded rather than destroying the new pool');
    assert.ok(!log.includes('destroy db_s_f000000000'));
    assert.ok(!log.includes('destroy db_s_e000000000'));
    const c = await siteStore.run('s_f000000000', () => db.client.acquireConnection()) as StubConn;
    assert.equal(c.__webwowSite, 's_f000000000');
    await db.client.releaseConnection(c);
    await db.client.releaseConnection(busy);
  } finally {
    delete process.env.WEBWOW_MAX_SITE_POOLS;
    __setPoolFactoryForTests(null);
    await destroyAllSitePools();
    await db.destroy();
  }
});

test('LRU cap destroys the least recently used idle pool', async () => {
  const log: string[] = [];
  process.env.WEBWOW_MAX_SITE_POOLS = '2';
  __setPoolFactoryForTests(async (siteId) => stubEntry(`db_${siteId}`, log));
  const db = knex({ client: WebwowPgClient, connection: async () => ({ connectionString: 'postgresql://x' }) });
  try {
    const a = await getSitePool('s_a000000000');
    a.lastUsed = 1;
    const b = await getSitePool('s_b000000000');
    b.lastUsed = 2;
    assert.equal(sitePoolCount(), 2);
    await getSitePool('s_c000000000');
    assert.equal(sitePoolCount(), 2);
    assert.ok(log.includes('destroy db_s_a000000000'), 'LRU victim destroyed');
    assert.ok(!log.includes('destroy db_s_b000000000'));

    // busy pools are never evicted
    const busy = await siteStore.run('s_b000000000', () => db.client.acquireConnection()) as StubConn;
    const c = await getSitePool('s_c000000000');
    c.lastUsed = 3;
    await getSitePool('s_d000000000');
    assert.ok(!log.includes('destroy db_s_b000000000'), 'busy pool kept');
    assert.ok(log.includes('destroy db_s_c000000000'));
    await db.client.releaseConnection(busy);
  } finally {
    delete process.env.WEBWOW_MAX_SITE_POOLS;
    __setPoolFactoryForTests(null);
    await destroyAllSitePools();
    await db.destroy();
  }
});

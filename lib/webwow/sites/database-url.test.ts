import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseConnection, databaseNameOf, poolNumber, withDatabase } from './database-url';

test('withDatabase keeps credentials, host, port and query string', () => {
  assert.equal(
    withDatabase('postgresql://u:p@h:5432/a?sslmode=require', 'b'),
    'postgresql://u:p@h:5432/b?sslmode=require',
  );
  assert.equal(withDatabase('postgres://u:p@h/a', 'webwow_site_x'), 'postgres://u:p@h/webwow_site_x');
  assert.equal(withDatabase('postgresql://localhost/db', 'other'), 'postgresql://localhost/other');
});

test('withDatabase encodes names and databaseNameOf decodes them', () => {
  const url = withDatabase('postgresql://u:p@h:5432/a', 'my db');
  assert.equal(url, 'postgresql://u:p@h:5432/my%20db');
  assert.equal(databaseNameOf(url), 'my db');
  assert.equal(databaseNameOf('postgresql://u:p@h:5432/webwow_merge'), 'webwow_merge');
  assert.equal(databaseNameOf('postgresql://u:p@h:5432/a?sslmode=require'), 'a');
  assert.equal(databaseNameOf(withDatabase('postgresql://u:p@h:5432/a', 'webwow_site_x')), 'webwow_site_x');
});

test('withDatabase falls back to a loose parser for host-less socket URLs', () => {
  const url = 'postgresql://u:p@/a?host=/var/run/postgresql';
  assert.equal(withDatabase(url, 'b'), 'postgresql://u:p@/b?host=/var/run/postgresql');
  assert.equal(databaseNameOf(url), 'a');
  assert.throws(() => withDatabase('not a url', 'b'));
});

test('baseConnection mirrors knexfile rules', () => {
  const saved = { url: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL };
  try {
    delete process.env.DATABASE_URL;
    assert.throws(() => baseConnection(), /DATABASE_URL is not set/);
    process.env.DATABASE_URL = 'postgresql://u:p@h/a';
    delete process.env.DATABASE_SSL;
    assert.deepEqual(baseConnection(), { connectionString: 'postgresql://u:p@h/a' });
    for (const v of ['true', '1', 'require']) {
      process.env.DATABASE_SSL = v;
      assert.deepEqual(baseConnection(), { connectionString: 'postgresql://u:p@h/a', ssl: { rejectUnauthorized: false } });
    }
    process.env.DATABASE_SSL = 'false';
    assert.deepEqual(baseConnection(), { connectionString: 'postgresql://u:p@h/a' });
  } finally {
    if (saved.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.url;
    if (saved.ssl === undefined) delete process.env.DATABASE_SSL; else process.env.DATABASE_SSL = saved.ssl;
  }
});

test('poolNumber parses integers with a fallback', () => {
  const saved = process.env.WEBWOW_TEST_POOL;
  try {
    delete process.env.WEBWOW_TEST_POOL;
    assert.equal(poolNumber('WEBWOW_TEST_POOL', 7), 7);
    process.env.WEBWOW_TEST_POOL = '12';
    assert.equal(poolNumber('WEBWOW_TEST_POOL', 7), 12);
    process.env.WEBWOW_TEST_POOL = 'abc';
    assert.equal(poolNumber('WEBWOW_TEST_POOL', 7), 7);
  } finally {
    if (saved === undefined) delete process.env.WEBWOW_TEST_POOL; else process.env.WEBWOW_TEST_POOL = saved;
  }
});

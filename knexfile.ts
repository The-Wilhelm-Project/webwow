import type { Knex } from 'knex';
import path from 'path';

/**
 * Knex Configuration for Webwow
 *
 * Webwow runs against a plain PostgreSQL database (no Supabase). The connection
 * comes from `DATABASE_URL`; migrations live in `database/migrations` and are the
 * unmodified upstream ycode migrations plus the Webwow bootstrap/defaults ones.
 */

function getPoolNumber(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;

  return Number.isFinite(parsed) ? parsed : fallback;
}

function getConnection(): Knex.PgConnectionConfig {
  const url = process.env.DATABASE_URL;

  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and configure the PostgreSQL connection.');
  }

  const ssl = process.env.DATABASE_SSL;
  if (ssl === 'true' || ssl === '1' || ssl === 'require') {
    return { connectionString: url, ssl: { rejectUnauthorized: false } };
  }

  return { connectionString: url };
}

const createConfig = (): Knex.Config => ({
  client: 'pg',
  // Resolved lazily so importing this file (e.g. from Next.js) never throws.
  connection: async () => getConnection(),
  migrations: {
    directory: path.join(process.cwd(), 'database/migrations'),
    extension: 'ts',
    tableName: 'migrations',
  },
  pool: {
    // Keep idle usage low in Next.js dev to avoid exhausting DB limits
    // when multiple workers/HMR are active.
    min: getPoolNumber('DB_POOL_MIN', 0),
    max: getPoolNumber('DB_POOL_MAX', 20),
    acquireTimeoutMillis: getPoolNumber('DB_POOL_ACQUIRE_TIMEOUT_MS', 20000),
    createTimeoutMillis: getPoolNumber('DB_POOL_CREATE_TIMEOUT_MS', 20000),
    idleTimeoutMillis: getPoolNumber('DB_POOL_IDLE_TIMEOUT_MS', 30000),
  },
});

const config: { [key: string]: Knex.Config } = {
  development: createConfig(),
  production: createConfig(),
  test: createConfig(),
};

export default config;

/**
 * DATABASE_URL helpers for the multi-site layer.
 *
 * No `server-only`, no `@/` imports (knex CLI + migrations load this file).
 * The rules of `baseConnection()` mirror `knexfile.ts` (`getConnection()`):
 * `DATABASE_URL` is mandatory, `DATABASE_SSL=true|1|require` adds
 * `ssl: { rejectUnauthorized: false }`.
 */

export interface BaseConnection {
  connectionString: string;
  ssl?: { rejectUnauthorized: false };
}

// Fallback parser for URLs the WHATWG parser rejects (e.g. `postgresql://u:p@/db?host=/var/run/postgresql`):
// scheme + authority (may be empty) + path + query/fragment.
const LOOSE_URL_RE = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(\/[^?#]*)?(.*)$/i;

/** Same URL with the database (path) replaced; credentials, host, port and query string are kept. */
export function withDatabase(databaseUrl: string, databaseName: string): string {
  const encoded = encodeURIComponent(databaseName);
  try {
    const url = new URL(databaseUrl);
    url.pathname = `/${encoded}`;
    return url.toString();
  } catch {
    const match = LOOSE_URL_RE.exec(databaseUrl);
    if (!match) throw new Error('Invalid DATABASE_URL');
    return `${match[1]}/${encoded}${match[3] ?? ''}`;
  }
}

/** Database name (decoded path without the leading slash) of a connection URL. */
export function databaseNameOf(databaseUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(databaseUrl).pathname;
  } catch {
    const match = LOOSE_URL_RE.exec(databaseUrl);
    if (!match) throw new Error('Invalid DATABASE_URL');
    pathname = match[2] ?? '';
  }
  return decodeURIComponent(pathname.replace(/^\/+/, ''));
}

/** Connection settings for `DATABASE_URL` (same rules as knexfile.ts). Throws when unset. */
export function baseConnection(): BaseConnection {
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

/** Integer from the environment with a fallback (`DB_POOL_*`, `WEBWOW_MAX_SITE_POOLS`). */
export function poolNumber(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

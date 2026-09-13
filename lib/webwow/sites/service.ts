/**
 * Site provisioning service (multi-site) — docs/MULTISITE.md.
 *
 * createSite / updateSite / setEditorPassword / deleteSite / openSite /
 * importProjectIntoSite / exportSite / duplicateSite. Every CREATE/DROP DATABASE
 * statement runs on `getMainDb()` (plain pool, never inside a transaction and
 * never through the site-aware client); site-DB work uses the site's own pool
 * (`getSitePool()`) or `runInSite()` for the upstream services. A module-level
 * mutex serialises the provisioning operations.
 *
 * No `server-only` here: `scripts/webwow-sites.ts` loads this module under
 * ts-node. Next-only modules (migration service with its `require.context`
 * loader, project import/export, cache service, agent config, the db shim) are
 * imported lazily inside the functions that need them; the CLI passes its own
 * migrator to `createSite()`.
 */

import path from 'path';
import type { Knex } from 'knex';
import { hashPassword } from '@/lib/webwow/password';
import { ToastError } from '@/lib/toast-error';
import { getMainDb } from '@/lib/webwow/sites/main-db';
import { getSite, invalidateRegistry, listSites, type SiteRow } from '@/lib/webwow/sites/registry';
import { DEFAULT_SITE_ID, RESERVED_SLUGS, SITE_ID_RE, SITE_SLUG_RE, newSiteId, slugToDatabaseName, slugify } from '@/lib/webwow/sites/ids';
import { destroySitePools, getSitePool } from '@/lib/webwow/sites/pg-client';
import { runInSite } from '@/lib/webwow/sites/context';
import { databaseNameOf } from '@/lib/webwow/sites/database-url';

// Opaque require so the bundler's static analysis does not see dynamic `fs.*` paths
// (same reason as lib/webwow/storage.ts: Turbopack would trace the whole project).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'fs/promises') as typeof import('fs/promises');

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error with an HTTP status and a stable code (the sites API maps it 1:1). */
export class SiteServiceError extends Error {
  status: number;
  code: string;
  /** Optional title (ToastError style) for the UI. */
  title?: string;

  constructor(message: string, status = 400, code = 'invalid_request', title?: string) {
    super(message);
    this.name = 'SiteServiceError';
    this.status = status;
    this.code = code;
    this.title = title;
  }
}

export function isSiteServiceError(error: unknown): error is SiteServiceError {
  return error instanceof SiteServiceError || (!!error && typeof error === 'object' && (error as { name?: string }).name === 'SiteServiceError');
}

// ---------------------------------------------------------------------------
// Pure validation helpers (unit tested)
// ---------------------------------------------------------------------------

export const SITE_NAME_MAX_LENGTH = 80;
export const EDITOR_PASSWORD_MIN_LENGTH = 10;
export const EDITOR_PASSWORD_MAX_LENGTH = 128;

export function validateSiteName(name: unknown): string {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value) throw new SiteServiceError('A site name is required', 400, 'invalid_name');
  if (value.length > SITE_NAME_MAX_LENGTH) throw new SiteServiceError(`The site name must be at most ${SITE_NAME_MAX_LENGTH} characters`, 400, 'invalid_name');
  return value;
}

export function validateSlug(slug: unknown): string {
  const value = typeof slug === 'string' ? slug.trim().toLowerCase() : '';
  if (!value || !SITE_SLUG_RE.test(value)) {
    throw new SiteServiceError('The slug may contain lower-case letters, digits and hyphens (1-50 characters, no leading/trailing hyphen)', 400, 'invalid_slug');
  }
  if (RESERVED_SLUGS.has(value)) throw new SiteServiceError(`The slug "${value}" is reserved`, 400, 'reserved_slug');
  return value;
}

const DOMAIN_RE = /^[a-z0-9.-]+$/;

/** Lower-cased, trimmed, port stripped, validated, de-duplicated domains. */
export function normalizeDomains(domains: unknown): string[] {
  if (!Array.isArray(domains)) throw new SiteServiceError('domains must be a list of host names', 400, 'invalid_domain');
  const out: string[] = [];
  for (const raw of domains) {
    if (typeof raw !== 'string') throw new SiteServiceError('domains must be a list of host names', 400, 'invalid_domain');
    let host = raw.trim().toLowerCase();
    if (!host) continue;
    host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
    if (!host || host.length > 253 || !DOMAIN_RE.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) {
      throw new SiteServiceError(`"${raw}" is not a valid host name`, 400, 'invalid_domain');
    }
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

export function validateEditorPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < EDITOR_PASSWORD_MIN_LENGTH) {
    throw new SiteServiceError(`The editor password must be at least ${EDITOR_PASSWORD_MIN_LENGTH} characters`, 400, 'password_too_short');
  }
  if (password.length > EDITOR_PASSWORD_MAX_LENGTH) {
    throw new SiteServiceError(`The editor password must be at most ${EDITOR_PASSWORD_MAX_LENGTH} characters`, 400, 'password_too_long');
  }
  return password;
}

/**
 * Tables emptied in a duplicated site right after the copy (critique-security 1.4):
 * every credential/secret/history table of the source, incl. `auth.users` and the
 * registry when the source is the main database. Only tables that exist are touched.
 */
export const SCRUB_TABLES: string[] = [
  'auth.users',
  'api_keys',
  'app_settings',
  'mcp_tokens',
  'mcp_oauth_codes',
  'mcp_oauth_clients',
  'webhooks',
  'webhook_deliveries',
  'form_submissions',
  'webflow_imports',
  'versions',
  'ai_chats',
  'collection_imports',
  'webwow_sites',
];

/** Settings keys removed from a duplicated site (besides the agent secret keys). */
export function isScrubbedSettingKey(key: string, isAgentSecret: (key: string) => boolean): boolean {
  return isAgentSecret(key) || key.startsWith('email_') || key.startsWith('smtp_') || key === 'published_at';
}

/** Fallback for `lib/agent/config.ts isAgentSecretSettingKey` when that module cannot be loaded (CLI). */
export function looksLikeAgentSecretKey(key: string): boolean {
  return /^ai_[a-z0-9]+_api_key(:|$)/.test(key);
}

export interface RewriteColumn { table: string; column: string; dataType: string }
export interface RewriteStatement { sql: string; bindings: unknown[] }

/** Whitelisted casts back to the column type (never interpolate the raw `data_type`). */
const REWRITE_CASTS: Record<string, string> = { text: 'text', 'character varying': 'text', json: 'json', jsonb: 'jsonb' };

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeRegexReplacement(value: string): string {
  return value.replace(/\\/g, '\\\\');
}

/**
 * UPDATE statements that rewrite public storage URLs in every text-like column
 * of a duplicated site: `from` -> `to`. For a non-default source `from` is
 * `/public/<bucket>/sites/<src>/` (plain `replace`); for the default source
 * `from` is `/public/<bucket>/` and the rewrite must not touch other sites'
 * `/public/<bucket>/sites/...` URLs -> `regexp_replace` with a negative lookahead.
 */
export function buildUrlRewriteStatements(columns: RewriteColumn[], from: string, to: string, options: { defaultSource?: boolean } = {}): RewriteStatement[] {
  const defaultSource = options.defaultSource ?? !/\/sites\/[^/]+\/$/.test(from);
  const out: RewriteStatement[] = [];
  for (const c of columns) {
    const cast = REWRITE_CASTS[c.dataType];
    if (!cast) continue;
    const like = `%${escapeLike(from)}%`;
    if (defaultSource) {
      out.push({
        sql: `UPDATE ?? SET ?? = regexp_replace(??::text, ?, ?, 'g')::${cast} WHERE ??::text LIKE ?`,
        bindings: [c.table, c.column, c.column, `${escapeRegex(from)}(?!sites/)`, escapeRegexReplacement(to), c.column, like],
      });
    } else {
      out.push({
        sql: `UPDATE ?? SET ?? = replace(??::text, ?, ?)::${cast} WHERE ??::text LIKE ?`,
        bindings: [c.table, c.column, c.column, from, to, c.column, like],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

const MUTEX_KEY = Symbol.for('webwow.sitesMutex');
const g = globalThis as unknown as Record<symbol, AsyncMutex | undefined>;
const mutex: AsyncMutex = g[MUTEX_KEY] ?? (g[MUTEX_KEY] = new AsyncMutex());

/** `UPLOAD_DIR` (same rule as lib/webwow/storage.ts getUploadDir(), which carries `server-only`). */
function uploadDir(): string {
  const configured = process.env.UPLOAD_DIR;
  return configured ? path.resolve(configured) : path.join(process.cwd(), 'uploads');
}

function assertSiteId(id: unknown): string {
  if (typeof id !== 'string' || !SITE_ID_RE.test(id)) throw new SiteServiceError('Invalid site id', 400, 'invalid_site');
  return id;
}

/** Fresh registry row (cache invalidated first) or 404. */
async function requireRow(id: string): Promise<SiteRow> {
  assertSiteId(id);
  invalidateRegistry();
  const row = await getSite(id);
  if (!row) throw new SiteServiceError('Site not found', 404, 'not_found');
  return row;
}

/** `PAGE_AUTH_SECRET`/`AUTH_SECRET` must be configured: the signed site header and every session depend on it. */
function assertSecretConfigured(): void {
  const configured = process.env.PAGE_AUTH_SECRET || process.env.AUTH_SECRET;
  if (!configured || !configured.trim()) {
    throw new SiteServiceError('Set PAGE_AUTH_SECRET before enabling multiple sites', 400, 'secret_required');
  }
}

/** Knex bound to a site's database: the main pool for the default site, the site pool otherwise. */
async function siteDb(siteId: string): Promise<Knex> {
  if (siteId === DEFAULT_SITE_ID) return getMainDb();
  return (await getSitePool(siteId)).knex;
}

function pgCode(error: unknown): string | undefined {
  return error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
}

function mapCreateDatabaseError(error: unknown, databaseName: string): Error {
  const code = pgCode(error);
  if (code === '42501') {
    return new SiteServiceError('The database role needs CREATEDB (ALTER ROLE <user> CREATEDB) or create the database manually and register it', 500, 'createdb_denied');
  }
  if (code === '42P04') {
    return new SiteServiceError(`The database "${databaseName}" already exists`, 409, 'database_exists');
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function createDatabase(main: Knex, databaseName: string): Promise<void> {
  try {
    await main.raw('CREATE DATABASE ??', [databaseName]);
  } catch (error) {
    throw mapCreateDatabaseError(error, databaseName);
  }
}

async function dropDatabase(main: Knex, databaseName: string): Promise<void> {
  try {
    await main.raw('DROP DATABASE ?? WITH (FORCE)', [databaseName]);
  } catch (error) {
    if (pgCode(error) === '3D000') return; // already gone
    throw error;
  }
}

/** Undo a half-finished createSite/duplicateSite (pools, database, registry row). */
async function compensateCreate(main: Knex, id: string, databaseName: string): Promise<void> {
  await destroySitePools(id).catch(() => undefined);
  await main('webwow_sites').where('id', id).delete().catch(() => undefined);
  await dropDatabase(main, databaseName).catch((error) => {
    console.warn(`[webwow/sites] could not drop database "${databaseName}" while compensating:`, error instanceof Error ? error.message : error);
  });
  invalidateRegistry();
}

/** `settings.site_name` of a (migrated) site database. */
async function setSiteNameSetting(db: Knex, name: string): Promise<void> {
  const value = db.raw('?::jsonb', [JSON.stringify(name)]);
  await db('settings')
    .insert({ key: 'site_name', value, updated_at: db.fn.now() })
    .onConflict('key')
    .merge({ value, updated_at: db.fn.now() });
}

/** In-app migrator: upstream runMigrations()/runSeeds() inside the site context (require.context loader, Next only). */
async function migrateInApp(siteId: string): Promise<void> {
  const { runMigrations } = await import('@/lib/services/migrationService');
  const { runSeeds } = await import('@/lib/services/seedService');
  await runInSite(siteId, async () => {
    const result = await runMigrations();
    if (!result.success) {
      const message = result.error ?? 'Migration failed';
      const hint = /role "[^"]+" does not exist/.test(message)
        ? ' — the main database must be migrated once with the CLI (npm run migrate:latest) so the cluster-wide roles exist'
        : '';
      throw new SiteServiceError(`${message}${hint}`, 500, 'migration_failed');
    }
    await runSeeds();
  });
}

async function removeSiteFiles(siteId: string): Promise<void> {
  assertSiteId(siteId);
  if (siteId === DEFAULT_SITE_ID) return;
  await fs.rm(path.join(uploadDir(), 'sites', siteId), { recursive: true, force: true });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateSiteInput { name: string; slug?: string }

export interface CreateSiteOptions {
  /** Custom migrator (the CLI uses `knex.migrate.latest()`; the app uses upstream runMigrations()). */
  migrate?: (siteId: string, databaseName: string) => Promise<void>;
}

/** Provision a new site: registry row + own database, migrated and named (SPEC §4.1). */
export async function createSite(input: CreateSiteInput, options: CreateSiteOptions = {}): Promise<SiteRow> {
  return mutex.run(async () => {
    const name = validateSiteName(input.name);
    const slug = validateSlug(input.slug ? input.slug : slugify(name));
    assertSecretConfigured();
    const main = await getMainDb();
    if (await main('webwow_sites').where('slug', slug).first()) {
      throw new SiteServiceError(`The slug "${slug}" is already used by another site`, 409, 'slug_taken');
    }
    const databaseName = slugToDatabaseName(slug);
    const id = newSiteId();

    await createDatabase(main, databaseName);
    try {
      await main('webwow_sites').insert({
        id,
        slug,
        name,
        database_name: databaseName,
        domains: main.raw('?::jsonb', ['[]']),
        is_default: false,
      });
      invalidateRegistry();
      await (options.migrate ?? migrateInApp)(id, databaseName);
      await setSiteNameSetting(await siteDb(id), name);
      invalidateRegistry();
      return (await getSite(id))!;
    } catch (error) {
      await compensateCreate(main, id, databaseName);
      throw error;
    }
  });
}

export interface UpdateSiteInput { name?: string; slug?: string; domains?: string[] }

/** Rename / re-slug (the database name stays) / set domains (SPEC §4.3). */
export async function updateSite(id: string, patch: UpdateSiteInput): Promise<SiteRow> {
  const row = await requireRow(id);
  const main = await getMainDb();
  const update: Record<string, unknown> = {};

  if (patch.name !== undefined) update.name = validateSiteName(patch.name);

  if (patch.slug !== undefined && patch.slug !== row.slug) {
    const slug = validateSlug(patch.slug);
    if (await main('webwow_sites').where('slug', slug).whereNot('id', id).first()) {
      throw new SiteServiceError(`The slug "${slug}" is already used by another site`, 409, 'slug_taken');
    }
    update.slug = slug;
  }

  if (patch.domains !== undefined) {
    const domains = normalizeDomains(patch.domains);
    const others = (await listSites()).filter((s) => s.id !== id);
    for (const domain of domains) {
      const owner = others.find((s) => s.domains.includes(domain));
      if (owner) throw new SiteServiceError(`The domain "${domain}" is already used by "${owner.name}"`, 409, 'domain_taken');
    }
    update.domains = main.raw('?::jsonb', [JSON.stringify(domains)]);
  }

  if (Object.keys(update).length > 0) {
    update.updated_at = main.fn.now();
    await main('webwow_sites').where('id', id).update(update);
  }
  invalidateRegistry();
  return (await getSite(id))!;
}

/** Set (min 10 chars) or clear (`null`) the editor password; both bump `editor_password_version` (sessions revoked). */
export async function setEditorPassword(id: string, password: string | null): Promise<SiteRow> {
  await requireRow(id);
  const hash = password === null ? null : hashPassword(validateEditorPassword(password));
  const main = await getMainDb();
  await main('webwow_sites').where('id', id).update({
    editor_password_hash: hash,
    editor_password_version: main.raw('editor_password_version + 1'),
    updated_at: main.fn.now(),
  });
  invalidateRegistry();
  return (await getSite(id))!;
}

/** Drop the site's database, files, synthetic editor user and registry row (SPEC §4.2). */
export async function deleteSite(id: string): Promise<void> {
  return mutex.run(async () => {
    const row = await requireRow(id);
    if (row.is_default || row.id === DEFAULT_SITE_ID) {
      throw new SiteServiceError('The default site cannot be deleted', 400, 'default_site');
    }
    const main = await getMainDb();
    await destroySitePools(id);
    // Synthetic `?edit` editor account (same statement as auth-server deleteSiteEditorUser; that module is server-only).
    await main('auth.users').whereRaw("raw_app_meta_data->>'webwow_editor_site' = ?", [id]).delete();
    if (row.database_name) await dropDatabase(main, row.database_name);
    await removeSiteFiles(id);
    await main('webwow_sites').where('id', id).delete();
    invalidateRegistry();
  });
}

/** `last_opened_at = now()` (dashboard "Open"). */
export async function openSite(id: string): Promise<void> {
  await requireRow(id);
  const main = await getMainDb();
  await main('webwow_sites').where('id', id).update({ last_opened_at: main.fn.now() });
  invalidateRegistry();
}

/** Apply a `.ycode` export to a site through upstream unpackImport()/importProject() inside the site context (Addendum B). */
export async function importProjectIntoSite(id: string, file: Buffer, password?: string): Promise<{ stats: unknown }> {
  return mutex.run(async () => {
    const row = await requireRow(id);
    const { unpackImport, importProject } = await import('@/lib/services/projectService');

    let parsed: ReturnType<typeof unpackImport>;
    try {
      parsed = unpackImport(file, password);
    } catch (error) {
      if (error instanceof ToastError) throw new SiteServiceError(error.description, 400, 'invalid_file', error.title);
      throw new SiteServiceError(error instanceof Error ? error.message : 'Invalid .ycode file', 400, 'invalid_file');
    }

    const result = await runInSite(id, () => importProject(parsed.manifest, parsed.data, parsed.files));
    if (!result.success) throw new SiteServiceError(result.error ?? 'Import failed', 500, 'import_failed');

    await setSiteNameSetting(await siteDb(id), row.name);
    try {
      const { clearAllCache } = await import('@/lib/services/cacheService');
      await runInSite(id, () => clearAllCache());
    } catch (error) {
      console.error('[webwow/sites] cache invalidation after import failed:', error instanceof Error ? error.message : error);
    }
    return { stats: result.stats };
  });
}

/** Stream the site as a `.ycode` export (upstream exportProject()/packExportToStream() inside the site context). */
export async function exportSite(id: string, password?: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number; filename: string }> {
  const row = await requireRow(id);
  const { exportProject, packExportToStream, getExportFilename, sanitizeProjectNameSlug } = await import('@/lib/services/projectService');
  const result = await runInSite(id, () => exportProject());
  if (!result.success || !result.export) throw new SiteServiceError(result.error ?? 'Export failed', 500, 'export_failed');
  result.export.manifest.projectName = sanitizeProjectNameSlug(row.slug);
  const { stream, size } = packExportToStream(result.export, password);
  return { stream, size, filename: getExportFilename(result.export.manifest) };
}

// ---------------------------------------------------------------------------
// duplicateSite (SPEC §4.4, M9)
// ---------------------------------------------------------------------------

/** Close this process's idle connections to the main database (they would block `CREATE DATABASE ... TEMPLATE <main>`). */
async function quiesceMainDb(): Promise<void> {
  try {
    const { closeDb } = await import('@/lib/webwow/db');
    await closeDb();
  } catch {
    // server-only module outside Next (CLI): nothing to close
  }
  try {
    const { closeKnexClient } = await import('@/lib/knex-client');
    await closeKnexClient();
  } catch {
    // ignore
  }
}

/** `CREATE DATABASE new TEMPLATE source`; on 55006 terminate the other backends of the source once and retry on the same connection. */
async function createDatabaseFromTemplate(main: Knex, databaseName: string, templateName: string): Promise<void> {
  const sql = main.raw('CREATE DATABASE ?? TEMPLATE ??', [databaseName, templateName]).toQuery();
  try {
    await main.raw(sql);
    return;
  } catch (error) {
    if (pgCode(error) !== '55006') throw mapCreateDatabaseError(error, databaseName);
  }
  // Other sessions use the source: terminate them and retry on the SAME connection
  // (its own session does not count; a different pooled connection would).
  const connection = await main.client.acquireConnection() as { query: (config: { text: string; values?: unknown[] }) => Promise<unknown> };
  try {
    await connection.query({
      text: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      values: [templateName],
    });
    await sleep(300);
    try {
      await connection.query({ text: sql });
    } catch (error) {
      if (pgCode(error) === '55006') throw new SiteServiceError('Source database is in use; retry in a moment', 503, 'source_in_use');
      throw mapCreateDatabaseError(error, databaseName);
    }
  } finally {
    await main.client.releaseConnection(connection);
  }
}

async function agentSecretPredicate(): Promise<(key: string) => boolean> {
  try {
    const { isAgentSecretSettingKey } = await import('@/lib/agent/config');
    return isAgentSecretSettingKey;
  } catch {
    return looksLikeAgentSecretKey;
  }
}

/** Empty every credential/history table, drop secret settings, release the migration lock — one transaction. */
async function scrubCopy(db: Knex): Promise<void> {
  const rows = (await db('information_schema.tables')
    .select('table_schema', 'table_name')
    .whereIn('table_schema', ['public', 'auth'])
    .where('table_type', 'BASE TABLE')) as Array<{ table_schema: string; table_name: string }>;
  const present = new Set(rows.map((r) => (r.table_schema === 'public' ? r.table_name : `${r.table_schema}.${r.table_name}`)));
  const toTruncate = SCRUB_TABLES.filter((t) => present.has(t));
  const isAgentSecret = await agentSecretPredicate();

  await db.transaction(async (trx) => {
    if (toTruncate.length > 0) {
      await trx.raw(`TRUNCATE ${toTruncate.map(() => '??').join(', ')}`, toTruncate);
    }
    if (present.has('settings')) {
      const keys = ((await trx('settings').select('key')) as Array<{ key: string }>).map((r) => r.key);
      const doomed = keys.filter((key) => isScrubbedSettingKey(key, isAgentSecret));
      if (doomed.length > 0) await trx('settings').whereIn('key', doomed).delete();
    }
    if (present.has('migrations_lock')) {
      await trx('migrations_lock').update({ is_locked: 0 });
    }
  });
}

/** Copy the source's files into `UPLOAD_DIR/sites/<new>/`; returns the bucket names found. */
async function copySiteFiles(source: SiteRow, newId: string): Promise<string[]> {
  const root = uploadDir();
  const dest = path.join(root, 'sites', assertSiteId(newId));
  const buckets: string[] = [];
  const srcRoot = source.is_default ? root : path.join(root, 'sites', assertSiteId(source.id));
  if (!(await pathExists(srcRoot))) return buckets;
  const entries = await fs.readdir(srcRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (source.is_default && entry.name === 'sites') continue; // other sites' roots
    buckets.push(entry.name);
    await fs.cp(path.join(srcRoot, entry.name), path.join(dest, entry.name), { recursive: true });
  }
  return buckets;
}

/** Rewrite public storage URLs of the source into the copy's `sites/<new>/` namespace. */
async function rewriteStorageUrls(db: Knex, source: SiteRow, newId: string, buckets: string[]): Promise<void> {
  const tables = ((await db('information_schema.tables').select('table_name').where({ table_schema: 'public', table_type: 'BASE TABLE' })) as Array<{ table_name: string }>)
    .map((r) => r.table_name);
  const columns = ((await db('information_schema.columns')
    .select('table_name', 'column_name', 'data_type')
    .where('table_schema', 'public')
    .whereIn('table_name', tables)
    .whereIn('data_type', Object.keys(REWRITE_CASTS))
    .whereNot('is_generated', 'ALWAYS')) as Array<{ table_name: string; column_name: string; data_type: string }>)
    .map((c) => ({ table: c.table_name, column: c.column_name, dataType: c.data_type }));

  for (const bucket of new Set([...buckets, 'assets'])) {
    const from = source.is_default ? `/public/${bucket}/` : `/public/${bucket}/sites/${source.id}/`;
    const to = `/public/${bucket}/sites/${newId}/`;
    for (const statement of buildUrlRewriteStatements(columns, from, to, { defaultSource: source.is_default })) {
      await db.raw(statement.sql, statement.bindings);
    }
  }
}

export interface DuplicateSiteOptions {
  /** Required when the source is the default site (its copy briefly interrupts every site). */
  confirmMainCopy?: boolean;
  slug?: string;
}

/**
 * Copy a site: `CREATE DATABASE ... TEMPLATE`, scrub list, files, URL rewrite (SPEC §4.4).
 * Owner-only at the API layer. Terminating the main DB's backends (default source)
 * interrupts every other site's registry lookups for a moment.
 */
export async function duplicateSite(sourceId: string, name: string, opts: DuplicateSiteOptions = {}): Promise<SiteRow> {
  return mutex.run(async () => {
    const source = await requireRow(sourceId);
    const newName = validateSiteName(name);
    const slug = validateSlug(opts.slug ? opts.slug : slugify(newName));
    assertSecretConfigured();
    if (source.is_default && !opts.confirmMainCopy) {
      throw new SiteServiceError('Duplicating the default site briefly interrupts every site; confirm to continue', 400, 'confirm_main_copy');
    }
    const main = await getMainDb();
    if (await main('webwow_sites').where('slug', slug).first()) {
      throw new SiteServiceError(`The slug "${slug}" is already used by another site`, 409, 'slug_taken');
    }
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new SiteServiceError('DATABASE_URL is not set', 500, 'no_database');
    const sourceDatabase = source.database_name ?? databaseNameOf(databaseUrl);
    const databaseName = slugToDatabaseName(slug);
    const newId = newSiteId();

    // Quiesce the source: its pools must not hold connections during the TEMPLATE copy.
    if (source.is_default) await quiesceMainDb();
    else await destroySitePools(source.id);

    await createDatabaseFromTemplate(main, databaseName, sourceDatabase);
    try {
      await main('webwow_sites').insert({
        id: newId,
        slug,
        name: newName,
        database_name: databaseName,
        domains: main.raw('?::jsonb', ['[]']),
        is_default: false,
      });
      invalidateRegistry();
      const db = await siteDb(newId);
      await scrubCopy(db);
      const buckets = await copySiteFiles(source, newId);
      await rewriteStorageUrls(db, source, newId, buckets);
      await setSiteNameSetting(db, newName);
      invalidateRegistry();
      return (await getSite(newId))!;
    } catch (error) {
      await compensateCreate(main, newId, databaseName);
      await removeSiteFiles(newId).catch(() => undefined);
      throw error;
    }
  });
}

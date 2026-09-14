/**
 * Webwow sites CLI (multi-site, docs/MULTISITE.md).
 *
 *   npm run webwow:sites -- list
 *   npm run webwow:sites -- migrate                                  # every registered site database (docker-entrypoint.sh)
 *   npm run webwow:sites -- create <name> [slug]
 *   npm run webwow:sites -- delete <slug> --yes
 *   npm run webwow:sites -- set-editor-password <slug> <password|->  # `-` clears (disables editor access)
 *
 * Reads DATABASE_URL (and PAGE_AUTH_SECRET, required by `create`) from the
 * environment; `.env` is loaded by the npm script.
 *
 * Keep on relative imports; loaded by ts-node (`tsconfig-paths/register` resolves
 * the `@/` imports of the modules used here). Never import migrationService /
 * migrations-loader: their `require.context` loader exists only inside the Next
 * bundles. Site databases are migrated with `knex.migrate.latest()` over
 * database/migrations on a plain knex instance bound to the site's database.
 */

import path from 'path';
import knex from 'knex';
import { baseConnection, withDatabase } from '../lib/webwow/sites/database-url';
import { closeMainDb } from '../lib/webwow/sites/main-db';
import { getSiteBySlug, invalidateRegistry, listSites, registryAvailable, type SiteRow } from '../lib/webwow/sites/registry';
import { destroyAllSitePools } from '../lib/webwow/sites/pg-client';
import { createSite, deleteSite, isSiteServiceError, setEditorPassword } from '../lib/webwow/sites/service';

const USAGE = `usage: webwow-sites <command>
  list
  migrate
  create <name> [slug]
  delete <slug> --yes
  set-editor-password <slug> <password|->`;

/** Run pending migrations of one site database (plain knex, CLI Migrator, `migrations` table like knexfile.ts). */
async function migrateDatabase(databaseName: string): Promise<{ batch: number; migrations: string[] }> {
  const base = baseConnection();
  const db = knex({
    client: 'pg',
    connection: { ...base, connectionString: withDatabase(base.connectionString, databaseName) },
    migrations: {
      directory: path.join(process.cwd(), 'database/migrations'),
      extension: 'ts',
      tableName: 'migrations',
    },
    pool: { min: 0, max: 2 },
  });
  try {
    const [batch, migrations] = (await db.migrate.latest()) as [number, string[]];
    return { batch, migrations };
  } finally {
    await db.destroy();
  }
}

function describe(site: SiteRow): string {
  const flags = [site.is_default ? 'default' : null, site.editor_password_hash ? 'editor-access' : null].filter(Boolean).join(',');
  return [
    site.slug,
    site.name,
    site.id,
    site.database_name ?? '(DATABASE_URL)',
    site.domains.length ? site.domains.join(',') : '-',
    flags || '-',
  ].join('\t');
}

async function requireBySlug(slug: string | undefined): Promise<SiteRow> {
  if (!slug) throw new Error('missing <slug>');
  invalidateRegistry();
  const site = await getSiteBySlug(slug);
  if (!site) throw new Error(`site "${slug}" not found (see: webwow-sites list)`);
  return site;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  switch (command) {
    case 'list': {
      if (!(await registryAvailable())) {
        console.log('No site registry yet (run the migrations first: npm run migrate:latest).');
        break;
      }
      const sites = await listSites();
      console.log(['slug', 'name', 'id', 'database', 'domains', 'flags'].join('\t'));
      for (const site of sites) console.log(describe(site));
      break;
    }
    case 'migrate': {
      if (!(await registryAvailable())) {
        console.log('[webwow] No site registry yet; nothing to migrate.');
        break;
      }
      const sites = (await listSites()).filter((s) => s.database_name);
      if (sites.length === 0) {
        console.log('[webwow] No site databases registered; nothing to migrate.');
        break;
      }
      let failed = 0;
      for (const site of sites) {
        try {
          const { batch, migrations } = await migrateDatabase(site.database_name!);
          console.log(migrations.length
            ? `[webwow] ${site.slug} (${site.database_name}): batch ${batch} ran ${migrations.length} migration(s)`
            : `[webwow] ${site.slug} (${site.database_name}): up to date`);
        } catch (error) {
          failed += 1;
          console.error(`[webwow] ${site.slug} (${site.database_name}): migration failed:`, error instanceof Error ? error.message : error);
        }
      }
      if (failed > 0) throw new Error(`${failed} site database(s) failed to migrate`);
      break;
    }
    case 'create': {
      const [name, slug] = args;
      if (!name) throw new Error('usage: create <name> [slug]');
      const site = await createSite({ name, slug }, { migrate: async (_siteId, databaseName) => { await migrateDatabase(databaseName); } });
      console.log(`Created site "${site.name}" (slug ${site.slug}, id ${site.id}, database ${site.database_name})`);
      break;
    }
    case 'delete': {
      const [slug, flag] = args;
      if (!slug) throw new Error('usage: delete <slug> --yes');
      const site = await requireBySlug(slug);
      if (flag !== '--yes') {
        throw new Error(`refusing to delete "${site.name}" (${site.slug}) and drop database "${site.database_name}": add --yes to confirm`);
      }
      await deleteSite(site.id);
      console.log(`Deleted site "${site.name}" (${site.slug}); database ${site.database_name} dropped`);
      break;
    }
    case 'set-editor-password': {
      const [slug, password] = args;
      if (!slug || !password) throw new Error('usage: set-editor-password <slug> <password|->');
      const site = await requireBySlug(slug);
      const updated = await setEditorPassword(site.id, password === '-' ? null : password);
      console.log(password === '-'
        ? `Editor access disabled for "${updated.name}" (open editor sessions ended; version ${updated.editor_password_version})`
        : `Editor password set for "${updated.name}" (open editor sessions ended; version ${updated.editor_password_version})`);
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    if (isSiteServiceError(error)) console.error(`${error.message} (${error.code})`);
    else console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await destroyAllSitePools().catch(() => undefined);
    await closeMainDb().catch(() => undefined);
  });

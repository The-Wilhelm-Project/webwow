/**
 * Apply the universal website ontology from the command line (docs/universal-ontology.md).
 *
 *   npm run webwow:universal-template                          # collections + samples + pages
 *   npm run webwow:universal-template -- --no-samples          # schema + pages only
 *   npm run webwow:universal-template -- --no-pages            # schema + samples only
 *   npm run webwow:universal-template -- --site <slug>         # another site (multi-site, see webwow:sites list)
 *
 * Reads DATABASE_URL from the environment; `.env` is loaded by the npm script.
 */

// Several server modules import `server-only`, which throws outside of Next.js.
// Replace it with an empty module so the services can run from a plain Node script.
// Everything else is imported dynamically below, after the stub is in place.
const serverOnlyPath = require.resolve('server-only');
require.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  exports: {},
} as NodeJS.Module;

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function resolveSiteId(slug: string | undefined): Promise<string | undefined> {
  if (!slug) return undefined;
  const { getSiteBySlug } = await import('../lib/webwow/sites/registry');
  const site = await getSiteBySlug(slug);
  if (!site) throw new Error(`site "${slug}" not found (see: npm run webwow:sites -- list)`);
  return site.id;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const withSamples = !args.includes('--no-samples');
  const withPages = !args.includes('--no-pages');
  const siteId = await resolveSiteId(optionValue(args, '--site'));

  const { applyUniversalTemplate } = await import('../lib/webwow/templates/universal-template');
  const { runInSite } = await import('../lib/webwow/sites/context');
  const apply = () => applyUniversalTemplate({ withSamples, withPages });
  const result = siteId ? await runInSite(siteId, apply) : await apply();

  console.log(`Universal ontology v${result.version} applied${siteId ? ` to site ${siteId}` : ''}.`);
  console.log('\nCollections:');
  for (const c of result.collections) {
    console.log(`  ${c.created ? '+' : '='} ${c.name.padEnd(14)} fields: ${c.fields}  items: ${c.items}`);
  }
  console.log('\nFolders:');
  for (const f of result.folders) {
    console.log(`  ${f.created ? '+' : '='} /${f.slug}`);
  }
  console.log('\nPages:');
  for (const p of result.pages) {
    console.log(`  ${p.created ? '+' : '='} ${p.path.padEnd(28)} ${p.name}`);
  }
  console.log('\n(+ created, = already existed and was reused)');
}

main()
  .catch((error) => {
    console.error('Failed to apply universal template:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Both pools: the "Supabase" shim (lib/webwow/db) and the upstream knex client some repositories use
    const { closeDb } = await import('../lib/webwow/db');
    const { closeKnexClient } = await import('../lib/knex-client');
    const { destroyAllSitePools } = await import('../lib/webwow/sites/pg-client');
    const { closeMainDb } = await import('../lib/webwow/sites/main-db');
    await closeDb().catch(() => undefined);
    await closeKnexClient().catch(() => undefined);
    await destroyAllSitePools().catch(() => undefined);
    await closeMainDb().catch(() => undefined);
  });

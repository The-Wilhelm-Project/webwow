/**
 * Apply the universal website ontology from the command line.
 *
 * Usage:
 *   npm run template:universal                 # collections + samples + pages
 *   npm run template:universal -- --no-samples # schema + pages only
 *   npm run template:universal -- --no-pages   # schema + samples only
 *
 * Requires DATABASE_URL (see .env.example).
 */
import 'dotenv/config';

// Several server modules import `server-only`, which throws outside of Next.js.
// Replace it with an empty module so the services can run from a plain Node script.
const serverOnlyPath = require.resolve('server-only');
require.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  exports: {},
} as NodeJS.Module;

async function main() {
  const { applyUniversalTemplate } = await import('../lib/services/universalTemplateService');
  const args = process.argv.slice(2);
  const withSamples = !args.includes('--no-samples');
  const withPages = !args.includes('--no-pages');

  const result = await applyUniversalTemplate({ withSamples, withPages });

  console.log(`Universal ontology v${result.version} applied.`);
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
    const { closeKnexClient } = await import('../lib/knex-client');
    await closeKnexClient();
  });

import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { invalidateRegistry, listSites } from '@/lib/webwow/sites/registry';
import { getCurrentSiteId, isMultiSiteMode } from '@/lib/webwow/sites/request-site';
import { createSite } from '@/lib/webwow/sites/service';
import { readJsonBody, readString, siteJson, withSitesAccess } from './_shared';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/webwow/sites
 *
 * Every registered site (any regular user session).
 * `{ data: { sites, currentSiteId, multiSite } }` — `currentSiteId` is the site
 * this request resolved to (cookie/pin), `multiSite` the `WEBWOW_MULTI_SITE` flag.
 */
export async function GET() {
  return withSitesAccess('read', 'sites list', async () => {
    invalidateRegistry(); // fresh snapshot for the dashboard (the CLI may have changed the registry)
    const sites = await listSites();
    return noCache({
      data: {
        sites: sites.map((row) => siteJson(row)),
        currentSiteId: getCurrentSiteId(),
        multiSite: isMultiSiteMode(),
      },
    });
  });
}

/**
 * POST /ycode/api/webwow/sites  (owner|admin)
 * Body: `{ name, slug? }` -> 201 `{ data: site }`.
 * Errors: 400 validation (`invalid_name`, `invalid_slug`, `reserved_slug`, `secret_required`),
 * 409 `slug_taken` / `database_exists`, 500 `createdb_denied` / `migration_failed`.
 */
export async function POST(request: NextRequest) {
  return withSitesAccess('admin', 'sites create', async () => {
    const body = await readJsonBody(request);
    const name = readString(body, 'name') ?? '';
    const slug = readString(body, 'slug');
    const row = await createSite({ name, slug: slug || undefined });
    return noCache({ data: siteJson(row) }, 201);
  });
}

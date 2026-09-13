import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { SITE_ID_RE } from '@/lib/webwow/sites/ids';
import { getSite, invalidateRegistry } from '@/lib/webwow/sites/registry';
import { SiteServiceError, deleteSite, updateSite, type UpdateSiteInput } from '@/lib/webwow/sites/service';
import { readJsonBody, readString, siteJson, withSitesAccess } from '../_shared';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Params = { params: Promise<{ id: string }> };

async function siteIdOf({ params }: Params): Promise<string> {
  const { id } = await params;
  if (typeof id !== 'string' || !SITE_ID_RE.test(id)) throw new SiteServiceError('Invalid site id', 400, 'invalid_site');
  return id;
}

/**
 * GET /ycode/api/webwow/sites/[id]  (any regular user session)
 */
export async function GET(_request: NextRequest, ctx: Params) {
  return withSitesAccess('read', 'sites get', async () => {
    const id = await siteIdOf(ctx);
    invalidateRegistry();
    const row = await getSite(id);
    if (!row) throw new SiteServiceError('Site not found', 404, 'not_found');
    return noCache({ data: siteJson(row) });
  });
}

/**
 * PATCH /ycode/api/webwow/sites/[id]  (owner|admin)
 * Body: `{ name?, slug?, domains?: string[] }`. The database name never changes with the slug.
 */
export async function PATCH(request: NextRequest, ctx: Params) {
  return withSitesAccess('admin', 'sites update', async () => {
    const id = await siteIdOf(ctx);
    const body = await readJsonBody(request);
    const patch: UpdateSiteInput = {};
    const name = readString(body, 'name');
    if (name !== undefined) patch.name = name;
    const slug = readString(body, 'slug');
    if (slug !== undefined) patch.slug = slug;
    if (body.domains !== undefined) {
      if (!Array.isArray(body.domains)) throw new SiteServiceError('domains must be a list of host names', 400, 'invalid_domain');
      patch.domains = body.domains as string[];
    }
    const row = await updateSite(id, patch);
    return noCache({ data: siteJson(row) });
  });
}

/**
 * DELETE /ycode/api/webwow/sites/[id]  (owner|admin; the default site is refused with 400 `default_site`)
 * Drops the site's database, files, synthetic editor user and registry row.
 */
export async function DELETE(_request: NextRequest, ctx: Params) {
  return withSitesAccess('admin', 'sites delete', async () => {
    const id = await siteIdOf(ctx);
    await deleteSite(id);
    return noCache({ data: { deleted: true, id } });
  });
}

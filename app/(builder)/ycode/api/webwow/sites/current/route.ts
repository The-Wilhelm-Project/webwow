import { noCache } from '@/lib/api-response';
import { DEFAULT_SITE_ID } from '@/lib/webwow/sites/ids';
import { getSite, listSites } from '@/lib/webwow/sites/registry';
import { getCurrentSiteId, isMultiSiteMode } from '@/lib/webwow/sites/request-site';
import { SiteServiceError } from '@/lib/webwow/sites/service';
import { siteJson, withSitesAccess } from '../_shared';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/webwow/sites/current
 *
 * The site this request resolved to (signed `x-webwow-site` header set by the
 * proxy from the editor pin / `webwow_site` cookie). Used by the builder's
 * site switcher. `{ data: { site, kind, multiSite, siteCount } }`.
 */
export async function GET() {
  return withSitesAccess('read', 'sites current', async (access) => {
    const id = getCurrentSiteId();
    let row = await getSite(id);
    if (!row && id !== DEFAULT_SITE_ID) row = await getSite(DEFAULT_SITE_ID); // stale cookie -> default
    if (!row) throw new SiteServiceError('Site not found', 404, 'not_found');
    const siteCount = (await listSites()).length;
    return noCache({
      data: {
        site: siteJson(row),
        kind: access.payload.kind === 'editor' ? 'editor' : 'user',
        multiSite: isMultiSiteMode(),
        siteCount,
      },
    });
  });
}

import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { setSiteCookie } from '@/lib/webwow/auth-server';
import { SITE_ID_RE } from '@/lib/webwow/sites/ids';
import { SiteServiceError, openSite } from '@/lib/webwow/sites/service';
import { withSitesAccess } from '../../_shared';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/webwow/sites/[id]/open  (any regular user session)
 *
 * Pins the builder to the site: cookie `webwow_site=<id>` (httpOnly, lax,
 * path `/`, 30 days, `secure` on https) and `last_opened_at = now()`.
 * `{ data: { redirect: '/ycode' } }` — the dashboard navigates there.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withSitesAccess('read', 'sites open', async () => {
    const { id } = await params;
    if (typeof id !== 'string' || !SITE_ID_RE.test(id)) throw new SiteServiceError('Invalid site id', 400, 'invalid_site');
    await openSite(id); // 404 when unknown
    await setSiteCookie(id);
    return noCache({ data: { redirect: '/ycode', siteId: id } });
  });
}

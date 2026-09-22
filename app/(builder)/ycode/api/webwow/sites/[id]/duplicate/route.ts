import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { SITE_ID_RE } from '@/lib/webwow/sites/ids';
import { SiteServiceError, duplicateSite } from '@/lib/webwow/sites/service';
import { readBoolean, readJsonBody, readString, siteJson, withSitesAccess } from '../../_shared';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

/**
 * POST /ycode/api/webwow/sites/[id]/duplicate  (owner only)
 * Body: `{ name, slug?, confirmMainCopy?: boolean }` -> 201 `{ data: site }`.
 *
 * Copies the database (`CREATE DATABASE ... TEMPLATE`), scrubs credentials,
 * copies the upload directory and rewrites storage URLs. Duplicating the
 * default site requires `confirmMainCopy` (400 `confirm_main_copy` otherwise)
 * because its backends may be terminated for a moment; 503 `source_in_use`
 * when the source stays busy.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withSitesAccess('owner', 'sites duplicate', async () => {
    const { id } = await params;
    if (typeof id !== 'string' || !SITE_ID_RE.test(id)) throw new SiteServiceError('Invalid site id', 400, 'invalid_site');
    const body = await readJsonBody(request);
    const name = readString(body, 'name') ?? '';
    const slug = readString(body, 'slug');
    const row = await duplicateSite(id, name, {
      slug: slug || undefined,
      confirmMainCopy: readBoolean(body, 'confirmMainCopy') === true,
    });
    return noCache({ data: siteJson(row) }, 201);
  });
}

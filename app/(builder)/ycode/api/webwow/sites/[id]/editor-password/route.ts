import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { SITE_ID_RE } from '@/lib/webwow/sites/ids';
import { SiteServiceError, setEditorPassword } from '@/lib/webwow/sites/service';
import { readJsonBody, siteJson, withSitesAccess } from '../../_shared';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * PUT /ycode/api/webwow/sites/[id]/editor-password  (owner|admin)
 * Body: `{ password: string | null }` — a string (min 10 chars) enables `?edit`
 * access with that password, `null` disables it. Both bump
 * `editor_password_version`, which ends every open editor session of the site.
 * `{ data: { editorPasswordSet, editor_password_version, site } }`.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withSitesAccess('admin', 'sites editor-password', async () => {
    const { id } = await params;
    if (typeof id !== 'string' || !SITE_ID_RE.test(id)) throw new SiteServiceError('Invalid site id', 400, 'invalid_site');
    const body = await readJsonBody(request);
    if (!('password' in body)) throw new SiteServiceError('Body must contain `password` (string or null)', 400, 'invalid_request');
    const password = body.password;
    if (password !== null && typeof password !== 'string') {
      throw new SiteServiceError('`password` must be a string or null', 400, 'invalid_request');
    }
    const row = await setEditorPassword(id, password);
    const json = siteJson(row);
    return noCache({ data: { editorPasswordSet: json.editorPasswordSet, editor_password_version: json.editor_password_version, site: json } });
  });
}

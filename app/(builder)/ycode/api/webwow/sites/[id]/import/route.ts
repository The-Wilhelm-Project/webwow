import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { SITE_ID_RE } from '@/lib/webwow/sites/ids';
import { SiteServiceError, importProjectIntoSite } from '@/lib/webwow/sites/service';
import { withSitesAccess } from '../../_shared';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

/**
 * POST /ycode/api/webwow/sites/[id]/import  (owner|admin)
 *
 * Apply a `.ycode` project export to the site (same code path as the builder's
 * "Import project", run inside the site's database/storage context).
 * multipart/form-data: `file` (required), `password` (optional, encrypted exports).
 * `{ data: { stats } }`; 400 `invalid_file`, 500 `import_failed`.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withSitesAccess('admin', 'sites import', async () => {
    const { id } = await params;
    if (typeof id !== 'string' || !SITE_ID_RE.test(id)) throw new SiteServiceError('Invalid site id', 400, 'invalid_site');

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      throw new SiteServiceError('Upload the .ycode file as multipart/form-data with the field name "file"', 400, 'invalid_file');
    }
    const file = formData.get('file');
    if (!file || !(file instanceof Blob)) {
      throw new SiteServiceError('No file provided. Upload a .ycode file as form-data with field name "file".', 400, 'invalid_file');
    }
    const password = formData.get('password');
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length === 0) throw new SiteServiceError('The uploaded file is empty', 400, 'invalid_file');

    const { stats } = await importProjectIntoSite(id, buffer, typeof password === 'string' && password ? password : undefined);
    return noCache({ data: { stats } });
  });
}

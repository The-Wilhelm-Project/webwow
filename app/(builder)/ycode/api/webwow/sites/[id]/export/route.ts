import { NextRequest, NextResponse } from 'next/server';
import { SITE_ID_RE } from '@/lib/webwow/sites/ids';
import { SiteServiceError, exportSite } from '@/lib/webwow/sites/service';
import { readJsonBody, readString, withSitesAccess } from '../../_shared';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

/**
 * POST /ycode/api/webwow/sites/[id]/export  (owner|admin)
 *
 * Streams the site as a `.ycode` project export (upstream `exportProject()` +
 * `packExportToStream()` inside the site context). JSON body `{ password? }`
 * encrypts the file. Errors are JSON (`siteErrorResponse`).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withSitesAccess('admin', 'sites export', async () => {
    const { id } = await params;
    if (typeof id !== 'string' || !SITE_ID_RE.test(id)) throw new SiteServiceError('Invalid site id', 400, 'invalid_site');
    const body = await readJsonBody(request);
    const password = readString(body, 'password');
    const { stream, size, filename } = await exportSite(id, password || undefined);
    return new NextResponse(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename.replace(/["\r\n]/g, '')}"`,
        'Content-Length': String(size),
        'Cache-Control': 'no-store',
      },
    });
  });
}

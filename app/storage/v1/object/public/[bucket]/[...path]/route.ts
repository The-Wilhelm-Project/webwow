import { NextRequest } from 'next/server';
import { createObjectResponse } from '@/lib/webwow/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /storage/v1/object/public/<bucket>/<path>
 *
 * Serves uploaded files from UPLOAD_DIR. The URL shape mirrors Supabase
 * Storage public URLs so `assets.public_url` values stay compatible.
 * Supports HTTP Range requests (video/audio seeking).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ bucket: string; path: string[] }> }
) {
  const { bucket, path } = await params;
  return createObjectResponse(bucket, path.join('/'), request.headers.get('range'));
}

export async function HEAD(
  request: NextRequest,
  { params }: { params: Promise<{ bucket: string; path: string[] }> }
) {
  const { bucket, path } = await params;
  const response = await createObjectResponse(bucket, path.join('/'), request.headers.get('range'));
  return new Response(null, { status: response.status, headers: response.headers });
}

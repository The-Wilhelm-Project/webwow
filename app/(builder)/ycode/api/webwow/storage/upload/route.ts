import { NextRequest, NextResponse } from 'next/server';
import { verifyUploadToken, writeObject } from '@/lib/webwow/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PUT /ycode/api/webwow/storage/upload?token=...
 *
 * Target of the "presigned upload URL" flow (see lib/webwow/storage.ts
 * `createSignedUploadUrl`). The token is an HMAC-signed { bucket, path, exp }.
 */
export async function PUT(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  const verified = token ? verifyUploadToken(token) : null;

  if (!verified) {
    return NextResponse.json({ error: 'Invalid or expired upload token' }, { status: 403 });
  }

  try {
    const body = Buffer.from(await request.arrayBuffer());
    const written = await writeObject(verified.bucket, verified.objectPath, body, { upsert: true });
    return NextResponse.json({ Key: `${verified.bucket}/${written.path}`, path: written.path, size: written.size });
  } catch (error) {
    console.error('[webwow storage/upload] failed:', error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}

export const POST = PUT;

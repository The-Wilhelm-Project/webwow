/**
 * Asset Proxy Route
 *
 * Serves assets with SEO-friendly URLs by proxying from Supabase Storage.
 * URL format: /a/{base62-hash}/{seo-friendly-name}.{ext}
 *
 * The hash is a base62-encoded UUID used for lookup.
 * The name segment is cosmetic (for SEO) and derived from the asset's filename.
 * If the name doesn't match the current filename, a 301 redirect is issued.
 *
 * Supports image resizing via query params (width, height, quality) using sharp.
 * Responses are cached with immutable headers so sharp only runs once per unique URL.
 */

import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { base62ToUuid } from '@/lib/convertion-utils';
import { getAssetProxyUrl, isAssetOfType, ASSET_CATEGORIES } from '@/lib/asset-utils';
import { getAssetForProxy } from '@/lib/repositories/assetRepository';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import { STORAGE_BUCKET } from '@/lib/asset-constants';

// Cache headers set at infrastructure level via next.config.ts headers()
// to prevent Next.js proxy from overriding them

function parseTransformParams(searchParams: URLSearchParams) {
  const width = parseInt(searchParams.get('width') || '');
  const height = parseInt(searchParams.get('height') || '');
  const quality = parseInt(searchParams.get('quality') || '');

  const hasParams = width > 0 || height > 0 || quality > 0;
  if (!hasParams) return null;

  return {
    width: width > 0 ? width : undefined,
    height: height > 0 ? height : undefined,
    quality: quality > 0 ? Math.min(quality, 100) : 80,
  };
}

/**
 * Whether a mime type can be safely resized in-process. SVGs are vector (no
 * point) and GIFs would lose animation when flattened — both fall through to
 * the original passthrough instead.
 */
function isResizableBitmap(mimeType: string | null | undefined): boolean {
  if (!mimeType || !mimeType.startsWith('image/')) return false;
  if (mimeType === 'image/svg+xml') return false;
  if (mimeType === 'image/gif') return false;
  return true;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hash: string; name: string[] }> }
) {
  try {
    const { hash, name } = await params;

    let assetId: string;
    try {
      assetId = base62ToUuid(hash);
    } catch {
      return new Response('Not found', { status: 404 });
    }

    const asset = await getAssetForProxy(assetId);
    if (!asset?.storage_path) {
      return new Response('Not found', { status: 404 });
    }

    const canonicalPath = getAssetProxyUrl(asset);
    if (canonicalPath) {
      const requestedName = name.join('/');
      const canonicalName = canonicalPath.split('/').slice(3).join('/');
      if (requestedName !== canonicalName) {
        const url = new URL(request.url);
        const redirectUrl = new URL(canonicalPath, url.origin);
        redirectUrl.search = url.search;
        return Response.redirect(redirectUrl.toString(), 301);
      }
    }

    const supabase = await getSupabaseAdmin();
    if (!supabase) {
      return new Response('Service unavailable', { status: 503 });
    }

    const { data: urlData } = supabase.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(asset.storage_path);

    const url = new URL(request.url);
    const isImage = isAssetOfType(asset.mime_type, ASSET_CATEGORIES.IMAGES);

    // Forward Range requests for media (video/audio). Safari refuses to play
    // a video unless the server responds with 206 Partial Content, so we proxy
    // the client's Range header to Supabase Storage (which supports ranges).
    const rangeHeader = request.headers.get('range');
    const upstreamHeaders: Record<string, string> = {};
    if (rangeHeader && !isImage) {
      upstreamHeaders.Range = rangeHeader;
    }

    const response = await fetch(urlData.publicUrl, { headers: upstreamHeaders });
    if (!response.ok && response.status !== 206) {
      return new Response('Not found', { status: 404 });
    }

    const transform = parseTransformParams(url.searchParams);
    // Resize the fetched original in-process with sharp. GIFs are excluded via
    // isResizableBitmap — Sharp flattens animated frames into a single static
    // image, so they fall through and stream as raw bytes below.
    if (transform && isImage && isResizableBitmap(asset.mime_type)) {
      const buffer = Buffer.from(await response.arrayBuffer());

      // Preserve AVIF on output (already highly compressed); re-encoding to WebP
      // would inflate size and lose quality.
      const isAvif = asset.mime_type === 'image/avif';

      try {
        let pipeline = sharp(buffer);

        if (transform.width || transform.height) {
          // `fit: 'inside'` scales down within the requested bounds while
          // preserving aspect ratio — it never crops. Cropping is a display
          // concern handled by CSS `object-fit` on the rendered element; using
          // `fit: 'cover'` here crops the sides whenever both dimensions are
          // present, silently fighting the element's own `object-fit`.
          pipeline = pipeline.resize(transform.width, transform.height, {
            fit: 'inside',
            withoutEnlargement: true,
          });
        }

        pipeline = isAvif
          ? pipeline.avif({ quality: transform.quality })
          : pipeline.webp({ quality: transform.quality });

        const resized = await pipeline.toBuffer();

        return new Response(new Uint8Array(resized), {
          status: 200,
          headers: {
            'Content-Type': isAvif ? 'image/avif' : 'image/webp',
            'Content-Length': resized.length.toString(),
          },
        });
      } catch {
        // Sharp's bundled decoder can't decode some bitstreams (e.g. 10/12-bit
        // AVIF, which browsers still render). Since the decode failure blocks
        // any re-encode, serve the original bytes untouched rather than failing.
        return new Response(new Uint8Array(buffer), {
          status: 200,
          headers: {
            'Content-Type': asset.mime_type || 'application/octet-stream',
            'Content-Length': buffer.length.toString(),
          },
        });
      }
    }

    // Mirror the upstream status (206 for partial content) and range headers so
    // Safari can stream/seek the video. Advertise Accept-Ranges so clients know
    // range requests are supported even on the initial full response.
    const headers = new Headers({
      'Content-Type': asset.mime_type || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
    });

    const contentRange = response.headers.get('content-range');
    if (contentRange) headers.set('Content-Range', contentRange);

    const contentLength = response.headers.get('content-length');
    if (contentLength) headers.set('Content-Length', contentLength);

    return new Response(response.body, {
      status: response.status,
      headers,
    });
  } catch {
    return new Response('Internal server error', { status: 500 });
  }
}

/**
 * Shared server-side handling for inline base64 images in rich-text content.
 *
 * Any ingestion path that authors rich-text (TipTap JSON) — the AI/MCP collection
 * item tools, the Airtable/Webflow importers, direct editor saves — can end up
 * with `data:image/...;base64,...` blobs embedded directly in the content. Those
 * multi-MB values blow past the serverless payload limit and block publishing.
 *
 * These helpers decode each inline image, upload it to the asset manager (via the
 * same `uploadFile` path used elsewhere, so tenant scoping and WebP conversion
 * are inherited), and rewrite the node `src` to the hosted URL.
 */

import { extractRichTextImageUrls, isDataImageUrl, parseDataImageUri, replaceRichTextImageUrls } from '@/lib/csv-utils';
import { uploadFile } from '@/lib/file-upload';

/** Cheap gate so non-image values skip parsing entirely. */
const DATA_IMAGE_MARKER = 'data:image';

/** Build a File from a base64 data-image URI so it can go through uploadFile. */
function dataUriToFile(dataUri: string): File | null {
  const parsed = parseDataImageUri(dataUri);
  if (!parsed) return null;
  const buffer = Buffer.from(parsed.base64, 'base64');
  if (buffer.length === 0) return null;
  const filename = `inline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${parsed.extension}`;
  return new File([buffer], filename, { type: parsed.mimeType });
}

/** Upload one base64 data-image URI, returning its hosted asset (or null on failure). */
async function uploadDataUri(dataUri: string): Promise<{ assetId: string; publicUrl: string } | null> {
  const file = dataUriToFile(dataUri);
  if (!file) return null;
  const asset = await uploadFile(file, 'rich-text-inline');
  if (!asset?.public_url) return null;
  return { assetId: asset.id, publicUrl: asset.public_url };
}

/** Collect the unique inline base64 image srcs referenced by a rich-text value. */
function collectDataImageSrcs(value: string): string[] {
  return extractRichTextImageUrls(value)
    .map((ref) => ref.src)
    .filter(isDataImageUrl);
}

/**
 * Replace inline base64 images in a single rich-text (TipTap JSON) value with
 * hosted asset URLs. Returns the value untouched when it holds no base64 image
 * or isn't rich-text JSON, so it's safe to call on any value.
 */
export async function uploadInlineRichTextImages(value: string | null): Promise<string | null> {
  if (!value || !value.includes(DATA_IMAGE_MARKER)) return value;

  const uniqueSrcs = Array.from(new Set(collectDataImageSrcs(value)));
  if (uniqueSrcs.length === 0) return value;

  const srcToAsset = new Map<string, { assetId: string; publicUrl: string }>();
  for (const src of uniqueSrcs) {
    const uploaded = await uploadDataUri(src);
    if (uploaded) srcToAsset.set(src, uploaded);
  }

  return srcToAsset.size > 0 ? replaceRichTextImageUrls(value, srcToAsset) : value;
}

/**
 * In-place variant for bulk value rows: uploads every unique inline base64 image
 * across the batch once, then rewrites each affected row's `value`. No-op when
 * the batch contains no base64 images.
 */
export async function uploadInlineRichTextImagesInRows<T extends { value: string | null }>(rows: T[]): Promise<void> {
  const affected = rows.filter((row): row is T & { value: string } =>
    !!row.value && row.value.includes(DATA_IMAGE_MARKER));
  if (affected.length === 0) return;

  const uniqueSrcs = new Set<string>();
  for (const row of affected) {
    for (const src of collectDataImageSrcs(row.value)) uniqueSrcs.add(src);
  }

  const srcToAsset = new Map<string, { assetId: string; publicUrl: string }>();
  for (const src of uniqueSrcs) {
    const uploaded = await uploadDataUri(src);
    if (uploaded) srcToAsset.set(src, uploaded);
  }
  if (srcToAsset.size === 0) return;

  for (const row of affected) {
    row.value = replaceRichTextImageUrls(row.value, srcToAsset);
  }
}

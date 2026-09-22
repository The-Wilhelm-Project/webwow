/**
 * Webflow site export ZIP -> classified bundle.
 *
 * Entries are read lazily (`JSZip` `file.async` on demand, memoised) so a large
 * export never sits in memory twice. Every limit (`ZIP_LIMITS`) is enforced on
 * the declared central-directory sizes before any entry is decompressed, and
 * again on the real size when an entry is read (declared sizes can lie).
 */

import JSZip from 'jszip';
import { normalizeObjectPath } from '@/lib/webwow/storage';
import { WfImportError } from './types';
import type { Warnings } from './warnings';

export const ZIP_LIMITS = {
  /** Upload size cap (the multipart file). */
  maxUploadBytes: 200 * 2 ** 20,
  /** Largest single entry. */
  maxEntryBytes: 100 * 2 ** 20,
  /** Sum of all declared entry sizes. */
  maxTotalBytes: 2 ** 30,
  maxEntries: 20_000,
  /** uncompressed / compressed — zip-bomb guard. */
  maxRatio: 200,
};

export type ZipLimits = typeof ZIP_LIMITS;

export interface WfZipFile {
  /** Root-relative path inside the export (`images/x.jpg`). */
  path: string;
  /** Declared uncompressed size. */
  size: number;
  data(): Promise<Buffer>;
  text(): Promise<string>;
}

export interface WfZipBundle {
  /** Stripped common prefix (`''` or `valeska-von-brase.webflow/`). */
  root: string;
  /** basename w/o `.html` -> file (`401.html` / `404.html` go to `errorPages`). */
  pages: Map<string, WfZipFile>;
  errorPages: Map<'401' | '404', WfZipFile>;
  css: { site: WfZipFile[]; components?: WfZipFile; normalize?: WfZipFile };
  js: WfZipFile[];
  /** Every other entry by root-relative path (`images/x.jpg`, `videos/y.mp4`, `fonts/z.woff2`, `documents/…`). */
  files: Map<string, WfZipFile>;
  /** Lines of MISSING.txt. */
  missing: string[];
  /** Entries that were not imported (traversal names, system files). */
  skipped: { path: string; reason: string }[];
}

export interface OpenZipOptions {
  warn?: Warnings;
  limits?: Partial<ZipLimits>;
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|svg|bmp|ico|tiff?)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|ogv|m4v|mpe?g)$/i;
const FONT_EXT = /\.(woff2?|ttf|otf|eot)$/i;

export function isImagePath(p: string): boolean {
  return IMAGE_EXT.test(stripQuery(p));
}

export function isVideoPath(p: string): boolean {
  return VIDEO_EXT.test(stripQuery(p));
}

export function isFontPath(p: string): boolean {
  return FONT_EXT.test(stripQuery(p));
}

function stripQuery(p: string): string {
  const q = p.indexOf('?');
  const h = p.indexOf('#');
  let end = p.length;
  if (q !== -1) end = Math.min(end, q);
  if (h !== -1) end = Math.min(end, h);
  return p.slice(0, end);
}

interface RawEntry {
  name: string;
  normalized: string;
  object: JSZip.JSZipObject;
  size: number;
  compressed: number;
}

interface JsZipInternals {
  _data?: { uncompressedSize?: number; compressedSize?: number };
  uncompressedSize?: number;
}

function declaredSizes(object: JSZip.JSZipObject): { size: number; compressed: number } {
  const internal = object as unknown as JsZipInternals;
  const size = internal._data?.uncompressedSize ?? internal.uncompressedSize ?? -1;
  const compressed = internal._data?.compressedSize ?? -1;
  return { size: Number.isFinite(size) ? size : -1, compressed: Number.isFinite(compressed) ? compressed : -1 };
}

function isSystemEntry(name: string): boolean {
  const base = name.split('/').pop() ?? name;
  return name.startsWith('__MACOSX/') || name.includes('/__MACOSX/') || base === '.DS_Store' || base === 'Thumbs.db' || base.startsWith('._');
}

function makeFile(entry: RawEntry, path: string, maxEntryBytes: number): WfZipFile {
  let cached: Promise<Buffer> | null = null;
  const data = (): Promise<Buffer> => {
    if (!cached) {
      cached = entry.object.async('nodebuffer').then((buf) => {
        if (buf.length > maxEntryBytes) {
          throw new WfImportError('zip_entry_too_large', `ZIP entry ${path} is larger than ${Math.round(maxEntryBytes / 2 ** 20)} MB`);
        }
        return buf;
      });
      cached.catch(() => {
        cached = null;
      });
    }
    return cached;
  };
  return {
    path,
    size: entry.size,
    data,
    text: async () => (await data()).toString('utf8').replace(/^\uFEFF/, ''),
  };
}

/**
 * Open a Webflow export ZIP. Throws `WfImportError` with code `zip_too_large`,
 * `zip_entry_too_large`, `zip_ratio` or `zip_entries` when a limit is exceeded;
 * traversal names are skipped with a `zip_entry_skipped` warning.
 */
export async function openWebflowZip(buffer: Buffer, opts: OpenZipOptions = {}): Promise<WfZipBundle> {
  const limits: ZipLimits = { ...ZIP_LIMITS, ...opts.limits };
  const warn = opts.warn;
  if (buffer.length > limits.maxUploadBytes) {
    throw new WfImportError('zip_too_large', `ZIP upload is larger than ${Math.round(limits.maxUploadBytes / 2 ** 20)} MB`);
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (error) {
    throw new WfImportError('zip_invalid', `Not a valid ZIP file: ${error instanceof Error ? error.message : String(error)}`);
  }

  const skipped: WfZipBundle['skipped'] = [];
  const entries: RawEntry[] = [];
  let count = 0;
  for (const [name, object] of Object.entries(zip.files)) {
    if (object.dir || name.endsWith('/')) continue;
    count++;
    if (count > limits.maxEntries) {
      throw new WfImportError('zip_entries', `ZIP has more than ${limits.maxEntries} entries`);
    }
    if (isSystemEntry(name)) {
      skipped.push({ path: name, reason: 'system file' });
      continue;
    }
    const normalized = normalizeObjectPath(name);
    if (!normalized || normalized !== name.replace(/\\/g, '/').replace(/^\/+/, '') || normalized.split('/').includes('..')) {
      skipped.push({ path: name, reason: 'invalid or traversing path' });
      warn?.add('zip_entry_skipped', `ZIP entry skipped (invalid path): ${name}`);
      continue;
    }
    const { size, compressed } = declaredSizes(object);
    entries.push({ name, normalized, object, size, compressed });
  }

  // Sizes: declared first; unknown sizes are measured by reading the entry.
  let total = 0;
  let totalCompressed = 0;
  for (const entry of entries) {
    if (entry.size < 0) {
      const buf = await entry.object.async('nodebuffer');
      entry.size = buf.length;
    }
    if (entry.size > limits.maxEntryBytes) {
      throw new WfImportError('zip_entry_too_large', `ZIP entry ${entry.normalized} is larger than ${Math.round(limits.maxEntryBytes / 2 ** 20)} MB`);
    }
    total += entry.size;
    if (total > limits.maxTotalBytes) {
      throw new WfImportError('zip_too_large', `ZIP content is larger than ${Math.round(limits.maxTotalBytes / 2 ** 20)} MB uncompressed`);
    }
    totalCompressed += entry.compressed > 0 ? entry.compressed : 0;
  }
  const denominator = totalCompressed > 0 ? totalCompressed : buffer.length;
  if (denominator > 0 && total / denominator > limits.maxRatio) {
    throw new WfImportError('zip_ratio', `ZIP compression ratio ${Math.round(total / denominator)} exceeds ${limits.maxRatio}`);
  }

  // Root prefix: the single top-level directory shared by every entry, but only
  // when it actually wraps the export (a page beneath it or a `.webflow` name).
  let root = '';
  if (entries.length > 0) {
    const firstSegments = new Set(entries.map((e) => (e.normalized.includes('/') ? e.normalized.slice(0, e.normalized.indexOf('/') + 1) : '')));
    if (firstSegments.size === 1) {
      const candidate = [...firstSegments][0];
      if (candidate) {
        const hasPage = entries.some((e) => /^[^/]+\.html$/i.test(e.normalized.slice(candidate.length)));
        if (hasPage || /\.webflow\/$/i.test(candidate)) root = candidate;
      }
    }
  }

  const bundle: WfZipBundle = {
    root,
    pages: new Map(),
    errorPages: new Map(),
    css: { site: [] },
    js: [],
    files: new Map(),
    missing: [],
    skipped,
  };

  for (const entry of entries) {
    const rel = entry.normalized.slice(root.length);
    if (!rel) continue;
    const file = makeFile(entry, rel, limits.maxEntryBytes);
    const lower = rel.toLowerCase();
    if (!rel.includes('/') && lower.endsWith('.html')) {
      const base = rel.slice(0, -5);
      if (base === '401' || base === '404') bundle.errorPages.set(base, file);
      else bundle.pages.set(base, file);
      continue;
    }
    if (/^css\/[^/]+\.css$/.test(lower)) {
      const base = lower.slice(4);
      if (base === 'normalize.css') bundle.css.normalize = file;
      else if (base.includes('components')) bundle.css.components = file;
      else bundle.css.site.push(file);
      continue;
    }
    if (/^js\/[^/]+\.js$/.test(lower)) {
      bundle.js.push(file);
      continue;
    }
    if (lower === 'missing.txt') {
      const text = await file.text();
      bundle.missing = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !/\s/.test(l));
      continue;
    }
    bundle.files.set(rel, file);
  }

  return bundle;
}

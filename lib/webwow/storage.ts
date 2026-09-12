/**
 * Local-disk storage for the Webwow compatibility layer.
 *
 * Mirrors the subset of the Supabase Storage client API that upstream ycode
 * uses (`storage.from(bucket).upload/remove/download/list/getPublicUrl/
 * createSignedUploadUrl/createSignedUrl`, `storage.emptyBucket/deleteBucket`).
 *
 * Files live in `UPLOAD_DIR/<bucket>/<object path>` (default `./uploads`).
 * The old Webwow fork stored files directly in `UPLOAD_DIR/<object path>`;
 * that legacy location is still read as a fallback.
 *
 * Public URLs are relative: `/storage/v1/object/public/<bucket>/<path>`.
 * They are served by `app/storage/v1/object/public/[bucket]/[...path]/route.ts`
 * and, for server-side `fetch()` calls in upstream code, by the interceptor in
 * `lib/webwow/fetch-intercept.ts`.
 */

import 'server-only';

import path from 'path';
import { createHmac, timingSafeEqual } from 'crypto';
import { getSessionSecret } from '@/lib/webwow/secret';

// The filesystem modules are loaded through an opaque require so that the
// bundler's static analysis does not see `fs.*` calls with dynamic paths.
// Turbopack otherwise flags "Dynamic filesystem access causes tracing of the
// whole project", which bloats the standalone output and — in dev — makes
// every route compile retain the whole project graph (multi-GB memory).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'fs/promises') as typeof import('fs/promises');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createReadStream } = require(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'fs') as typeof import('fs');

export const PUBLIC_STORAGE_PREFIX = '/storage/v1/object/public';
export const SIGNED_UPLOAD_PATH = '/ycode/api/webwow/storage/upload';

export function getUploadDir(): string {
  const configured = process.env.UPLOAD_DIR;
  return configured ? path.resolve(configured) : path.join(process.cwd(), 'uploads');
}

export interface StorageError {
  message: string;
  statusCode?: string;
  error?: string;
}

interface StorageResult<T> {
  data: T | null;
  error: StorageError | null;
}

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.ogv': 'video/ogg',
  '.mpeg': 'video/mpeg', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.aac': 'audio/aac', '.weba': 'audio/webm',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.zip': 'application/zip', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html', '.xml': 'application/xml',
};

export function guessMimeType(filename: string): string {
  return MIME_TYPES[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

const NUL = String.fromCharCode(0);

/** Normalise an object path and reject traversal attempts. Returns null when invalid. */
export function normalizeObjectPath(objectPath: string): string | null {
  const decoded = objectPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const normalized = path.posix.normalize(decoded);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..' || normalized.includes(NUL)) {
    return null;
  }
  return normalized;
}

function bucketDir(bucket: string): string {
  const safeBucket = normalizeObjectPath(bucket);
  if (!safeBucket || safeBucket.includes('/')) throw new Error(`Invalid bucket name: ${bucket}`);
  return path.join(/* turbopackIgnore: true */ getUploadDir(), safeBucket);
}

function objectFilePath(bucket: string, objectPath: string): string {
  const normalized = normalizeObjectPath(objectPath);
  if (!normalized) throw new Error(`Invalid object path: ${objectPath}`);
  return path.join(/* turbopackIgnore: true */ bucketDir(bucket), normalized);
}

/** Resolve the on-disk location of an object (new layout first, then legacy fork layout). */
export async function locateObject(bucket: string, objectPath: string): Promise<{ filePath: string; size: number; mtime: Date } | null> {
  const normalized = normalizeObjectPath(objectPath);
  if (!normalized) return null;

  const candidates = [objectFilePath(bucket, normalized), path.join(/* turbopackIgnore: true */ getUploadDir(), normalized)];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return { filePath: candidate, size: stat.size, mtime: stat.mtime };
    } catch {
      // try next
    }
  }
  return null;
}

export function encodeObjectPath(objectPath: string): string {
  return objectPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

export function getPublicUrl(bucket: string, objectPath: string): string {
  const normalized = normalizeObjectPath(objectPath) ?? objectPath;
  return `${PUBLIC_STORAGE_PREFIX}/${encodeURIComponent(bucket)}/${encodeObjectPath(normalized)}`;
}

/** Parse a public storage URL (relative or absolute) into bucket + object path. */
export function parsePublicUrl(url: string): { bucket: string; objectPath: string } | null {
  let pathname = url;
  try {
    if (/^https?:\/\//i.test(url)) pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const index = pathname.indexOf(`${PUBLIC_STORAGE_PREFIX}/`);
  if (index === -1) return null;
  const rest = pathname.slice(index + PUBLIC_STORAGE_PREFIX.length + 1);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  const bucket = decodeURIComponent(rest.slice(0, slash));
  const objectPath = rest.slice(slash + 1).split('/').map((segment) => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  }).join('/');
  const normalized = normalizeObjectPath(objectPath);
  if (!normalized) return null;
  return { bucket, objectPath: normalized };
}

// ---------------------------------------------------------------------------
// Signed upload tokens (presigned PUT flow)
// ---------------------------------------------------------------------------

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

export function signUploadToken(bucket: string, objectPath: string, ttlSeconds = 60 * 60): string {
  const payload = base64url(JSON.stringify({ b: bucket, p: objectPath, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const signature = createHmac('sha256', getSessionSecret()).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

export function verifyUploadToken(token: string): { bucket: string; objectPath: string } | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', getSessionSecret()).update(payload).digest('hex');
  if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try {
    const data = JSON.parse(fromBase64url(payload).toString('utf8')) as { b: string; p: string; exp: number };
    if (!data.b || !data.p || typeof data.exp !== 'number' || data.exp < Math.floor(Date.now() / 1000)) return null;
    const objectPath = normalizeObjectPath(data.p);
    if (!objectPath) return null;
    return { bucket: data.b, objectPath };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Body handling
// ---------------------------------------------------------------------------

async function toBuffer(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body && typeof (body as Blob).arrayBuffer === 'function') {
    return Buffer.from(await (body as Blob).arrayBuffer());
  }
  if (body && typeof (body as ReadableStream).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  throw new Error('Unsupported upload body type');
}

/** Write an object to disk (used by the upload route and the client shim). */
export async function writeObject(bucket: string, objectPath: string, body: unknown, options?: { upsert?: boolean }): Promise<{ path: string; size: number }> {
  const normalized = normalizeObjectPath(objectPath);
  if (!normalized) throw Object.assign(new Error('Invalid object path'), { statusCode: '400' });
  const filePath = objectFilePath(bucket, normalized);

  if (!options?.upsert) {
    let exists = false;
    try {
      await fs.access(filePath);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      throw Object.assign(new Error('The resource already exists'), { statusCode: '409', error: 'Duplicate' });
    }
  }

  const buffer = await toBuffer(body);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
  return { path: normalized, size: buffer.length };
}

export async function removeObjects(bucket: string, objectPaths: string[]): Promise<Array<{ name: string }>> {
  const removed: Array<{ name: string }> = [];
  for (const objectPath of objectPaths) {
    const located = await locateObject(bucket, objectPath);
    if (!located) continue;
    try {
      await fs.unlink(located.filePath);
      removed.push({ name: objectPath });
    } catch {
      // best effort
    }
  }
  return removed;
}

async function walkDir(dir: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await walkDir(path.join(/* turbopackIgnore: true */ dir, entry.name), relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Client-facing API (mirrors supabase-js `StorageClient`)
// ---------------------------------------------------------------------------

export function createStorageApi() {
  const from = (bucket: string) => ({
    async upload(objectPath: string, body: unknown, options?: { contentType?: string; upsert?: boolean; cacheControl?: string }): Promise<StorageResult<{ path: string; id: string; fullPath: string }>> {
      try {
        const written = await writeObject(bucket, objectPath, body, { upsert: options?.upsert });
        return { data: { path: written.path, id: written.path, fullPath: `${bucket}/${written.path}` }, error: null };
      } catch (error) {
        const err = error as Error & StorageError;
        return { data: null, error: { message: err.message, statusCode: err.statusCode ?? '500', error: err.error } };
      }
    },

    async update(objectPath: string, body: unknown, options?: { contentType?: string; cacheControl?: string }): Promise<StorageResult<{ path: string; id: string; fullPath: string }>> {
      return this.upload(objectPath, body, { ...options, upsert: true });
    },

    async remove(objectPaths: string[]): Promise<StorageResult<Array<{ name: string }>>> {
      try {
        return { data: await removeObjects(bucket, objectPaths), error: null };
      } catch (error) {
        return { data: null, error: { message: (error as Error).message, statusCode: '500' } };
      }
    },

    async download(objectPath: string, _options?: Record<string, unknown>): Promise<StorageResult<Blob>> {
      const located = await locateObject(bucket, objectPath);
      if (!located) {
        return { data: null, error: { message: 'Object not found', statusCode: '404', error: 'not_found' } };
      }
      const buffer = await fs.readFile(located.filePath);
      return { data: new Blob([new Uint8Array(buffer)], { type: guessMimeType(located.filePath) }), error: null };
    },

    async exists(objectPath: string): Promise<StorageResult<boolean>> {
      return { data: (await locateObject(bucket, objectPath)) !== null, error: null };
    },

    async info(objectPath: string): Promise<StorageResult<{ name: string; size: number; contentType: string; lastModified: string }>> {
      const located = await locateObject(bucket, objectPath);
      if (!located) return { data: null, error: { message: 'Object not found', statusCode: '404' } };
      return {
        data: { name: objectPath, size: located.size, contentType: guessMimeType(located.filePath), lastModified: located.mtime.toISOString() },
        error: null,
      };
    },

    async list(prefix = '', options?: { limit?: number; offset?: number; sortBy?: { column?: string; order?: string }; search?: string }): Promise<StorageResult<Array<Record<string, unknown>>>> {
      try {
        const normalizedPrefix = prefix ? normalizeObjectPath(prefix) : '';
        const base = normalizedPrefix ? path.join(/* turbopackIgnore: true */ bucketDir(bucket), normalizedPrefix) : bucketDir(bucket);
        const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
        let items = await Promise.all(entries.map(async (entry) => {
          const filePath = path.join(/* turbopackIgnore: true */ base, entry.name);
          const stat = await fs.stat(filePath).catch(() => null);
          return {
            name: entry.name,
            id: entry.isFile() ? `${normalizedPrefix ? `${normalizedPrefix}/` : ''}${entry.name}` : null,
            updated_at: stat?.mtime.toISOString() ?? null,
            created_at: stat?.birthtime.toISOString() ?? null,
            last_accessed_at: stat?.atime.toISOString() ?? null,
            metadata: entry.isFile() ? { size: stat?.size ?? 0, mimetype: guessMimeType(entry.name) } : null,
          };
        }));
        if (options?.search) items = items.filter((item) => item.name.includes(options.search!));
        items.sort((a, b) => a.name.localeCompare(b.name));
        if (options?.sortBy?.order === 'desc') items.reverse();
        const offset = options?.offset ?? 0;
        const limit = options?.limit ?? 100;
        return { data: items.slice(offset, offset + limit), error: null };
      } catch (error) {
        return { data: null, error: { message: (error as Error).message, statusCode: '500' } };
      }
    },

    async copy(fromPath: string, toPath: string): Promise<StorageResult<{ path: string }>> {
      const located = await locateObject(bucket, fromPath);
      if (!located) return { data: null, error: { message: 'Object not found', statusCode: '404' } };
      const target = objectFilePath(bucket, toPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(located.filePath, target);
      return { data: { path: `${bucket}/${normalizeObjectPath(toPath)}` }, error: null };
    },

    async move(fromPath: string, toPath: string): Promise<StorageResult<{ message: string }>> {
      const copied = await this.copy(fromPath, toPath);
      if (copied.error) return { data: null, error: copied.error };
      await removeObjects(bucket, [fromPath]);
      return { data: { message: 'Successfully moved' }, error: null };
    },

    getPublicUrl(objectPath: string, _options?: Record<string, unknown>): { data: { publicUrl: string } } {
      return { data: { publicUrl: getPublicUrl(bucket, objectPath) } };
    },

    async createSignedUrl(objectPath: string, _expiresIn: number, _options?: Record<string, unknown>): Promise<StorageResult<{ signedUrl: string }>> {
      return { data: { signedUrl: getPublicUrl(bucket, objectPath) }, error: null };
    },

    async createSignedUrls(objectPaths: string[], _expiresIn: number): Promise<StorageResult<Array<{ path: string; signedUrl: string; error: string | null }>>> {
      return { data: objectPaths.map((p) => ({ path: p, signedUrl: getPublicUrl(bucket, p), error: null })), error: null };
    },

    async createSignedUploadUrl(objectPath: string, _options?: { upsert?: boolean }): Promise<StorageResult<{ signedUrl: string; token: string; path: string }>> {
      const normalized = normalizeObjectPath(objectPath);
      if (!normalized) return { data: null, error: { message: 'Invalid object path', statusCode: '400' } };
      const token = signUploadToken(bucket, normalized);
      return {
        data: { signedUrl: `${SIGNED_UPLOAD_PATH}?token=${encodeURIComponent(token)}`, token, path: normalized },
        error: null,
      };
    },

    async uploadToSignedUrl(objectPath: string, token: string, body: unknown, options?: { contentType?: string; upsert?: boolean }): Promise<StorageResult<{ path: string; fullPath: string }>> {
      const verified = verifyUploadToken(token);
      if (!verified || verified.objectPath !== normalizeObjectPath(objectPath)) {
        return { data: null, error: { message: 'Invalid upload token', statusCode: '403' } };
      }
      const result = await this.upload(objectPath, body, { ...options, upsert: true });
      if (result.error || !result.data) return { data: null, error: result.error };
      return { data: { path: result.data.path, fullPath: result.data.fullPath }, error: null };
    },
  });

  return {
    from,

    async listBuckets(): Promise<StorageResult<Array<{ id: string; name: string; public: boolean }>>> {
      const entries = await fs.readdir(getUploadDir(), { withFileTypes: true }).catch(() => []);
      return { data: entries.filter((e) => e.isDirectory()).map((e) => ({ id: e.name, name: e.name, public: true })), error: null };
    },

    async getBucket(id: string): Promise<StorageResult<{ id: string; name: string; public: boolean }>> {
      return { data: { id, name: id, public: true }, error: null };
    },

    async createBucket(id: string, _options?: Record<string, unknown>): Promise<StorageResult<{ name: string }>> {
      await fs.mkdir(bucketDir(id), { recursive: true });
      return { data: { name: id }, error: null };
    },

    async updateBucket(id: string, _options?: Record<string, unknown>): Promise<StorageResult<{ message: string }>> {
      void id;
      return { data: { message: 'Successfully updated' }, error: null };
    },

    async emptyBucket(id: string): Promise<StorageResult<{ message: string }>> {
      try {
        const dir = bucketDir(id);
        const files = await walkDir(dir);
        for (const file of files) {
          await fs.unlink(path.join(/* turbopackIgnore: true */ dir, file)).catch(() => undefined);
        }
        return { data: { message: 'Successfully emptied' }, error: null };
      } catch (error) {
        return { data: null, error: { message: (error as Error).message, statusCode: '500' } };
      }
    },

    async deleteBucket(id: string): Promise<StorageResult<{ message: string }>> {
      try {
        await fs.rm(bucketDir(id), { recursive: true, force: true });
        return { data: { message: 'Successfully deleted' }, error: null };
      } catch (error) {
        return { data: null, error: { message: (error as Error).message, statusCode: '500' } };
      }
    },
  };
}

/** Build a Web `Response` for an object on disk, honouring HTTP Range requests. */
export async function createObjectResponse(bucket: string, objectPath: string, rangeHeader?: string | null, extraHeaders?: Record<string, string>): Promise<Response> {
  const located = await locateObject(bucket, objectPath);
  if (!located) {
    return new Response('Not found', { status: 404 });
  }

  const mimeType = guessMimeType(located.filePath);
  const headers = new Headers({
    'Content-Type': mimeType,
    'Accept-Ranges': 'bytes',
    'Last-Modified': located.mtime.toUTCString(),
    'Cache-Control': 'public, max-age=31536000, immutable',
    ...extraHeaders,
  });

  let start = 0;
  let end = located.size - 1;
  let status = 200;

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      if (match[1] !== '') start = Number.parseInt(match[1], 10);
      if (match[2] !== '') end = Number.parseInt(match[2], 10);
      if (match[1] === '' && match[2] !== '') {
        start = Math.max(0, located.size - Number.parseInt(match[2], 10));
        end = located.size - 1;
      }
      if (start > end || start >= located.size) {
        return new Response('Range Not Satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${located.size}` } });
      }
      end = Math.min(end, located.size - 1);
      status = 206;
      headers.set('Content-Range', `bytes ${start}-${end}/${located.size}`);
    }
  }

  headers.set('Content-Length', String(end - start + 1));

  if (located.size === 0) {
    return new Response(null, { status, headers });
  }

  const nodeStream = createReadStream(located.filePath, { start, end });
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer | string) => controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk)));
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (error) => controller.error(error));
    },
    cancel() {
      nodeStream.destroy();
    },
  });

  return new Response(webStream, { status, headers });
}

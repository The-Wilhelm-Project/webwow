/**
 * Writer interface shared by local / S3 / GitHub targets.
 *
 * Writers take the full list of output files at once. This shape:
 *   - lets the GitHub writer commit atomically (one push per export)
 *   - lets the local + S3 writers stay simple per-file loops
 *   - lets multiple targets run sequentially against the same artifact set
 */

import path from 'path'

import type { OutputTarget } from '../types'

export interface OutputFile {
  /** Relative key, e.g. "index.html" or "ycode/layouts/assets/foo.webp" */
  key: string
  body: string | Buffer
  contentType: string
}

export interface Writer {
  /** Human-readable target name for logging. */
  name: OutputTarget
  /** Writes the file list and returns the count actually written. */
  flush(files: OutputFile[]): Promise<number>
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
}

export function contentTypeFor(key: string): string {
  const ext = path.extname(key).toLowerCase()
  return MIME_TYPES[ext] ?? 'application/octet-stream'
}

const MEDIA_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export function mediaContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  return MEDIA_MIME_TYPES[ext] ?? 'application/octet-stream'
}

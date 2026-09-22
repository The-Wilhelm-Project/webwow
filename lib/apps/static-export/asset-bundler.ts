/**
 * Static export — asset bundlers.
 *
 * Two flavours:
 *   - public assets   : Ycode template placeholders that live in /public.
 *                        We read referenced URLs off disk and add them to
 *                        the output set so S3/GitHub-hosted exports don't
 *                        404 on `/ycode/layouts/assets/*`.
 *   - Supabase assets : user-uploaded files rendered via the `/a/<hash>/<name>`
 *                        proxy URL pattern. We decode the hash back to an
 *                        asset UUID, look up the row, fetch `public_url`,
 *                        and ship the bytes at the same proxy path so the
 *                        rendered HTML doesn't need rewriting.
 */

import fs from 'fs/promises'
import path from 'path'

import { base62ToUuid } from '@/lib/convertion-utils'
import { getSupabaseAdmin } from '@/lib/supabase-server'

import { mediaContentType, type OutputFile } from './writers/types'

/**
 * SEO-proxy URL pattern Ycode emits for asset variables: `/a/<22-char hash>/<filename>`.
 *
 * Stops at `?` and `&` so query-string variants (e.g. `?width=320`, `?width=1920`)
 * collapse to a single bundled file. Without this, separate files would be
 * saved with `?width=…` literally in the name — Amplify (and any static host)
 * ignores query params on path lookup.
 */
const ASSET_PROXY_URL_RE = /\/a\/([A-Za-z0-9]{22})\/[^"'\s)<>?&]+/g
const PROXY_FETCH_CONCURRENCY = 8

interface SupabaseAssetClient {
  from(table: 'assets'): {
    select(cols: string): {
      eq(col: string, val: unknown): {
        eq(col: string, val: unknown): {
          is(col: string, val: unknown): {
            maybeSingle(): Promise<{
              data: { id: string; filename: string; mime_type: string; public_url: string | null } | null
              error: { message: string } | null
            }>
          }
        }
      }
    }
  }
}

export async function collectSupabaseAssets(htmlOutputs: OutputFile[]): Promise<OutputFile[]> {
  const proxyUrls = new Set<string>()
  for (const f of htmlOutputs) {
    if (typeof f.body !== 'string') continue
    for (const m of f.body.matchAll(ASSET_PROXY_URL_RE)) {
      proxyUrls.add(m[0])
    }
  }
  if (proxyUrls.size === 0) return []

  const client = (await getSupabaseAdmin()) as SupabaseAssetClient | null
  if (!client) {
    console.warn('[Static Export] Could not bundle Supabase assets: Supabase client unavailable')
    return []
  }

  // Small concurrency cap so big sites don't open hundreds of sockets.
  const queue = Array.from(proxyUrls)
  const results: OutputFile[] = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(PROXY_FETCH_CONCURRENCY, queue.length) }, async () => {
    while (cursor < queue.length) {
      const proxyUrl = queue[cursor++]
      const file = await fetchAssetByProxyUrl(client, proxyUrl)
      if (file) results.push(file)
    }
  })
  await Promise.all(workers)
  return results
}

async function fetchAssetByProxyUrl(
  client: SupabaseAssetClient,
  proxyUrl: string,
): Promise<OutputFile | null> {
  const match = proxyUrl.match(/\/a\/([A-Za-z0-9]{22})\//)
  if (!match) return null

  let assetId: string
  try {
    assetId = base62ToUuid(match[1])
  } catch {
    return null
  }

  const { data: asset, error } = await client
    .from('assets')
    .select('id, filename, mime_type, public_url')
    .eq('id', assetId)
    .eq('is_published', true)
    .is('deleted_at', null)
    .maybeSingle()

  if (error || !asset?.public_url) {
    console.warn(`[Static Export] Could not look up asset for ${proxyUrl}: ${error?.message ?? 'not found'}`)
    return null
  }

  try {
    const response = await fetch(asset.public_url)
    if (!response.ok) {
      console.warn(`[Static Export] HTTP ${response.status} fetching ${asset.filename}`)
      return null
    }
    const buf = Buffer.from(await response.arrayBuffer())
    return {
      key: proxyUrl.replace(/^\/+/, ''),
      body: buf,
      contentType: asset.mime_type || mediaContentType(proxyUrl),
    }
  } catch (err) {
    console.warn(
      `[Static Export] Fetch failed for ${proxyUrl}: ${err instanceof Error ? err.message : err}`,
    )
    return null
  }
}

/**
 * Read referenced Ycode template placeholders from /public and append them
 * to the output list. Only the URLs actually used are pulled in.
 */
export async function collectPublicAssets(urlPaths: string[]): Promise<OutputFile[]> {
  const publicDir = path.join(process.cwd(), 'public')
  const out: OutputFile[] = []
  for (const urlPath of urlPaths) {
    const relPath = urlPath.replace(/^\/+/, '')
    try {
      const buf = await fs.readFile(path.join(publicDir, relPath))
      out.push({ key: relPath, body: buf, contentType: mediaContentType(relPath) })
    } catch (err) {
      console.warn(
        `[Static Export] Could not bundle ${urlPath}: ${
          err instanceof Error ? err.message : err
        }`,
      )
    }
  }
  return out
}

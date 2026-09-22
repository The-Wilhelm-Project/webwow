/**
 * Static export — output-key computation.
 *
 * S3-friendly path layout:
 *   - homepage / folder index → `<dir>/index.html`
 *   - any other page          → `<dir>/<slug>/index.html` (clean URLs)
 *   - error pages             → `<code>.html` at root
 */

import { buildSlugPath } from '@/lib/page-utils'

import type { Page, PageFolder } from '@/types'

export function computeOutputKey(page: Page, folders: PageFolder[]): string {
  if (page.error_page !== null && page.error_page !== undefined) {
    return `${page.error_page}.html`
  }

  const slugPath = buildSlugPath(page, folders, 'page')
  const trimmed = slugPath.replace(/^\/+/, '').replace(/\/+$/, '')

  if (!trimmed) return 'index.html'
  return `${trimmed}/index.html`
}

/**
 * Inverse of `computeOutputKey`: the public pathname for an exported file.
 * Error pages (`404.html`) have no public path and return `null`.
 */
export function pagePathFromOutputKey(outputKey: string): string | null {
  if (/^\d+\.html$/.test(outputKey)) {
    return null;
  }

  if (outputKey === 'index.html') {
    return '/';
  }

  if (outputKey.endsWith('/index.html')) {
    return `/${outputKey.slice(0, -'/index.html'.length)}`;
  }

  if (outputKey.endsWith('.html')) {
    return `/${outputKey.slice(0, -'.html'.length)}`;
  }

  return `/${outputKey.replace(/\/+$/, '')}`;
}

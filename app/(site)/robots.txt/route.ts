/**
 * Dynamic Robots.txt Route
 *
 * Generates robots.txt with configurable content and sitemap reference
 */

import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { getSettingsByKeys } from '@/lib/repositories/settingsRepository';
import { credentials } from '@/lib/credentials';
import { getRequestOrigin, getSiteBaseUrl } from '@/lib/url-utils';
import type { SitemapSettings } from '@/types';

export async function GET() {
  try {
    const requestOrigin = getRequestOrigin(await headers());

    const hasSupabaseCredentials = await credentials.exists();
    if (!hasSupabaseCredentials) {
      const baseUrl = getSiteBaseUrl({ requestOrigin }) || '';
      const fallback = `# Default robots.txt
User-agent: *
Allow: /
Disallow: /ycode/

# Sitemap
Sitemap: ${baseUrl}/sitemap.xml`;

      return new NextResponse(fallback, {
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=86400, s-maxage=86400',
        },
      });
    }

    const allSettings = await getSettingsByKeys(['robots_txt', 'sitemap', 'global_canonical_url']);
    const sitemapSettings = allSettings.sitemap as SitemapSettings | null;
    const sitemapEnabled = sitemapSettings?.mode && sitemapSettings.mode !== 'none';
    const baseUrl = getSiteBaseUrl({ globalCanonicalUrl: allSettings.global_canonical_url, requestOrigin }) || '';

    let content: string;

    const customRobots = allSettings.robots_txt;
    if (customRobots && typeof customRobots === 'string' && customRobots.trim()) {
      content = customRobots.trim();

      if (sitemapEnabled && !content.toLowerCase().includes('sitemap:')) {
        content += `\n\nSitemap: ${baseUrl}/sitemap.xml`;
      }
    } else {
      content = `# Default robots.txt
User-agent: *
Allow: /

# Disallow admin/editor paths
Disallow: /ycode/`;

      if (sitemapEnabled) {
        content += `\n\n# Sitemap\nSitemap: ${baseUrl}/sitemap.xml`;
      }
    }

    return new NextResponse(content, {
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'public, max-age=86400, s-maxage=86400',
      },
    });
  } catch (error) {
    console.error('[robots.txt] Error generating robots.txt:', error);

    // Return default on error
    const fallback = `User-agent: *
Allow: /
Disallow: /ycode/`;

    return new NextResponse(fallback, {
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }
}

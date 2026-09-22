import { NextRequest, NextResponse } from 'next/server';
import { fetchErrorPage } from '@/lib/page-fetcher';
import { getSettingsByKeys } from '@/lib/repositories/settingsRepository';
import { generateColorVariablesCss } from '@/lib/repositories/colorVariableRepository';

// Force dynamic rendering - no caching
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/error-page
 * 
 * Fetch error page data by error code
 * Query params: code (404, 401, 500), published (true/false)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const published = searchParams.get('published') === 'true';

    if (!code) {
      return NextResponse.json(
        { error: 'Error code is required' },
        { status: 400 }
      );
    }

    const errorCode = parseInt(code, 10);
    if (![401, 404, 500].includes(errorCode)) {
      return NextResponse.json(
        { error: 'Invalid error code. Must be 401, 404, or 500' },
        { status: 400 }
      );
    }

    // Fetch error page.
    // Webwow: fall back to the draft variant when nothing has been published yet, so a
    // freshly created or freshly imported site already serves its custom 401/404/500.
    let pageData = await fetchErrorPage(errorCode, published);
    if (!pageData && published) {
      pageData = await fetchErrorPage(errorCode, false);
    }

    if (!pageData) {
      return NextResponse.json(
        { error: 'Error page not found' },
        { status: 404 }
      );
    }

    const cssKey = published ? 'published_css' : 'draft_css';
    // Webwow: same fallback for the stylesheet - published_css is empty before the
    // first publish, which would render the error page unstyled.
    const fallbackCssKey = published ? 'draft_css' : 'published_css';
    const [settings, colorVariablesCss] = await Promise.all([
      getSettingsByKeys([cssKey, fallbackCssKey, 'ycode_badge']),
      generateColorVariablesCss(),
    ]);

    return NextResponse.json({
      pageData,
      css: settings[cssKey] || settings[fallbackCssKey] || null,
      colorVariablesCss,
      // Webwow: white-label fork - the badge is off unless a site explicitly turns it on.
      ycodeBadge: settings.ycode_badge ?? false,
    });
  } catch (error) {
    console.error('Failed to fetch error page:', error);
    return NextResponse.json(
      { error: 'Failed to fetch error page' },
      { status: 500 }
    );
  }
}

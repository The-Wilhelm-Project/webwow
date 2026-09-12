import Link from 'next/link';
import { unstable_cache } from 'next/cache';
import { fetchErrorPage, slimPageData } from '@/lib/page-fetcher';
import { fetchGlobalPageSettings } from '@/lib/generate-page-metadata';
import { getSettingByKey } from '@/lib/repositories/settingsRepository';
import { tenantStore } from '@/lib/supabase-server';
import PageRenderer from '@/components/PageRenderer';
import YcodeBadge from '@/components/YcodeBadge';

/** Cached lookup of the user's custom 404 page, invalidated on publish. */
function fetchCachedCustom404(tenantId?: string) {
  return unstable_cache(
    async () => {
      const data = await fetchErrorPage(404, true, tenantId);
      return data ? slimPageData(data) : null;
    },
    ['error-404'],
    { tags: ['all-pages'], revalidate: false }
  )();
}

/**
 * 404 boundary for public pages. Renders the user's custom 404 page when one
 * exists, otherwise a default fallback. Next.js serves this with a real HTTP
 * 404 status, which avoids soft-404 SEO penalties from search engines.
 */
export default async function NotFound() {
  const tenantId = tenantStore.getStore();

  const errorPageData = await fetchCachedCustom404(tenantId).catch(() => null);

  if (errorPageData) {
    const globalSettings = await fetchGlobalPageSettings().catch(() => null);
    const { page, pageLayers, components } = errorPageData;

    return (
      <PageRenderer
        page={page}
        layers={pageLayers.layers || []}
        components={components}
        generatedCss={globalSettings?.publishedCss || undefined}
        colorVariablesCss={globalSettings?.colorVariablesCss || undefined}
        globalCustomCodeHead={globalSettings?.globalCustomCodeHead}
        globalCustomCodeBody={globalSettings?.globalCustomCodeBody}
        ycodeBadge={globalSettings?.ycodeBadge ?? true}
      />
    );
  }

  let showBadge = true;
  try {
    const setting = await getSettingByKey('ycode_badge');
    showBadge = setting ?? true;
  } catch {
    // Supabase not configured
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="text-center max-w-md px-4">
        <h1 className="text-6xl font-bold text-gray-900 mb-4">404</h1>
        <h2 className="text-2xl font-semibold text-gray-800 mb-4">Page Not Found</h2>
        <p className="text-gray-600 mb-8">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <Link
          href="/"
          className="inline-block px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          Go Home
        </Link>
      </div>
      {showBadge && <YcodeBadge />}
    </div>
  );
}

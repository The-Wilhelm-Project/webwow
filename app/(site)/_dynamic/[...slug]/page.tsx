import { notFound, redirect, permanentRedirect } from 'next/navigation';
import { unstable_noStore } from 'next/cache';
import { fetchPageByPath, fetchErrorPage, PaginationContext } from '@/lib/page-fetcher';
import PageRenderer from '@/components/PageRenderer';
import PasswordForm from '@/components/PasswordForm';
import { fetchGlobalPageSettings } from '@/lib/generate-page-metadata';
import { getSettingByKey } from '@/lib/repositories/settingsRepository';
import { parseAuthCookie, getPasswordProtection, fetchFoldersForAuth } from '@/lib/page-auth';
import { matchRedirect } from '@/lib/redirect-utils';
import type { Redirect as RedirectType } from '@/types';

// Internal pagination path: always dynamic/no-store.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface DynamicSlugPageProps {
  params: Promise<{ slug: string | string[] }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function DynamicSlugPage({ params, searchParams }: DynamicSlugPageProps) {
  const { slug } = await params;
  const resolvedSearchParams = await searchParams;

  const slugPath = Array.isArray(slug) ? slug.join('/') : slug;
  const currentPath = `/${slugPath}`;

  const redirects = await getSettingByKey('redirects') as RedirectType[] | null;
  if (redirects && Array.isArray(redirects)) {
    const matched = matchRedirect(currentPath, redirects);
    if (matched) {
      if (matched.type === '302') {
        redirect(matched.newUrl);
      } else {
        permanentRedirect(matched.newUrl);
      }
    }
  }

  const pageNumbers: Record<string, number> = {};
  for (const [key, value] of Object.entries(resolvedSearchParams)) {
    if (key.startsWith('p_') && typeof value === 'string') {
      const pageNum = parseInt(value, 10);
      if (!isNaN(pageNum) && pageNum >= 1) {
        // The `p_` param carries the layer id with its `lyr-` prefix stripped.
        // Native cloud layers are `lyr-`-prefixed, but migrated (legacy) layers
        // use bare uids — register both forms so `resolveCollectionLayers`,
        // which looks up `pageNumbers[layer.id]`, matches whichever the layer
        // actually uses (otherwise the page number is dropped and the list
        // always renders page 1).
        const bareId = key.slice(2).replace(/^lyr-/, '');
        pageNumbers[bareId] = pageNum;
        pageNumbers[`lyr-${bareId}`] = pageNum;
      }
    }
  }

  unstable_noStore();

  const paginationContext: PaginationContext = {
    pageNumbers,
    defaultPage: 1,
  };

  const [data, globalSettings] = await Promise.all([
    fetchPageByPath(slugPath, true, paginationContext),
    fetchGlobalPageSettings(),
  ]);

  // Page not found: hand off to the 404 boundary for a real HTTP 404 status
  // (the custom 404 page is rendered there). Rendering content here would emit
  // a 200 "soft 404", which search engines penalize.
  if (!data) {
    notFound();
  }

  const { page, pageLayers, components, collectionItem, collectionFields, pageCollectionSortedItemIds, pageCollectionSortedItemSlugs, locale, availableLocales, translations } = data;

  const folders = await fetchFoldersForAuth(true);
  const protectionCheck = getPasswordProtection(page, folders, null);

  if (protectionCheck.isProtected) {
    const authCookie = await parseAuthCookie();
    const protection = getPasswordProtection(page, folders, authCookie);

    if (!protection.isUnlocked) {
      const errorPageData = await fetchErrorPage(401, true);

      if (errorPageData) {
        const { page: errorPage, pageLayers: errorPageLayers, components: errorComponents } = errorPageData;

        return (
          <PageRenderer
            page={errorPage}
            layers={errorPageLayers.layers || []}
            components={errorComponents}
            generatedCss={globalSettings.publishedCss || undefined}
            colorVariablesCss={globalSettings.colorVariablesCss || undefined}
            ycodeBadge={globalSettings.ycodeBadge}
            passwordProtection={{
              pageId: protection.protectedBy === 'page' ? protection.protectedById : undefined,
              folderId: protection.protectedBy === 'folder' ? protection.protectedById : undefined,
              redirectUrl: currentPath,
              isPublished: true,
            }}
          />
        );
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-white">
          <div className="text-center max-w-md px-4">
            <h1 className="text-6xl font-bold text-gray-900 mb-4">401</h1>
            <h2 className="text-2xl font-semibold text-gray-800 mb-4">Password Protected</h2>
            <p className="text-gray-600 mb-8">Enter the password to continue.</p>
            <PasswordForm
              pageId={protection.protectedBy === 'page' ? protection.protectedById : undefined}
              folderId={protection.protectedBy === 'folder' ? protection.protectedById : undefined}
              redirectUrl={currentPath}
              isPublished={true}
            />
          </div>
        </div>
      );
    }
  }

  return (
    <PageRenderer
      page={page}
      layers={pageLayers.layers || []}
      components={components}
      generatedCss={globalSettings.publishedCss || undefined}
      colorVariablesCss={globalSettings.colorVariablesCss || undefined}
      collectionItem={collectionItem}
      collectionFields={collectionFields}
      pageCollectionSortedItemIds={pageCollectionSortedItemIds}
      pageCollectionSortedItemSlugs={pageCollectionSortedItemSlugs}
      locale={locale}
      availableLocales={availableLocales}
      translations={translations}
      gaMeasurementId={globalSettings.gaMeasurementId}
      globalCustomCodeHead={globalSettings.globalCustomCodeHead}
      globalCustomCodeBody={globalSettings.globalCustomCodeBody}
      ycodeBadge={globalSettings.ycodeBadge}
    />
  );
}

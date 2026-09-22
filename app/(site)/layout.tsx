import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import SiteDocumentLayout, { generateSiteMetadata } from '@/components/site-document-layout';
import { fetchGlobalPageSettings } from '@/lib/generate-page-metadata';
import { parsePathnameForPageHead } from '@/lib/page-head-path';
import { resolveHtmlLang } from '@/lib/resolve-html-lang';
import { getSiteBaseUrl } from '@/lib/url-utils';

export const generateMetadata = generateSiteMetadata;

/**
 * Root layout for preview, pagination rewrites, and other non-published-page
 * public routes. Published pages use `(published)/[[...slug]]` so they can
 * set `<html lang>` from static params without calling headers().
 */
export default async function SiteLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const headersList = await headers();
  const pathname = headersList.get('x-pathname') || '/';
  const { isPreview, slugPath } = parsePathnameForPageHead(pathname);

  const [lang, globalSettings] = await Promise.all([
    resolveHtmlLang(slugPath, !isPreview),
    fetchGlobalPageSettings(isPreview).catch(() => null),
  ]);

  const baseUrl = getSiteBaseUrl({
    globalCanonicalUrl: globalSettings?.globalCanonicalUrl ?? null,
  });

  return (
    <SiteDocumentLayout
      lang={lang}
      pathname={pathname}
      baseUrl={baseUrl}
      publishedAt={globalSettings?.publishedAt ?? null}
      globalCustomCodeHead={globalSettings?.globalCustomCodeHead ?? null}
    >
      {children}
    </SiteDocumentLayout>
  );
}

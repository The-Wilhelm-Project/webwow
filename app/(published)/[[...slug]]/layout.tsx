import type { ReactNode } from 'react';
import SiteDocumentLayout, { generateSiteMetadata } from '@/components/site-document-layout';
import { fetchGlobalPageSettings } from '@/lib/generate-page-metadata';
import { resolveHtmlLang } from '@/lib/resolve-html-lang';
import { getSiteBaseUrl } from '@/lib/url-utils';

export const generateMetadata = generateSiteMetadata;

interface PublishedLayoutProps {
  children: ReactNode;
  params: Promise<{ slug?: string[] }>;
}

/**
 * Root layout for published pages. Lives inside the optional catch-all so it
 * receives the URL slug at static-generation time and can set `<html lang>`,
 * `dir`, and `<body class>` in the first HTML byte — required for SEO / a11y
 * (no after-paint script). Cloud ISR stays intact because this does not call
 * headers().
 */
export default async function PublishedLayout({
  children,
  params,
}: PublishedLayoutProps) {
  const { slug } = await params;
  const slugPath = slug?.join('/') ?? '';
  const pathname = slugPath ? `/${slugPath}` : '/';

  const [lang, globalSettings] = await Promise.all([
    resolveHtmlLang(slugPath, true),
    fetchGlobalPageSettings().catch(() => null),
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

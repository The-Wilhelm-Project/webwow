/**
 * Canonical, og:url, and hreflang for a public document.
 *
 * Shared by the live site layout and static export so both emit the same
 * absolute URLs. Returns nothing without a site base URL — relative canonicals
 * would be rewritten by the exporter's path relativizer.
 */

import {
  buildPageHreflangAlternates,
  type DynamicSlugContext,
  type HreflangAlternate,
} from '@/lib/hreflang-utils';
import { buildAbsolutePageUrl } from '@/lib/url-utils';

import type { Locale, Page, PageFolder, Translation } from '@/types';

export interface DocumentSeoLinks {
  canonical: string | null;
  ogUrl: string | null;
  hreflang: HreflangAlternate[];
}

const EMPTY_LINKS: DocumentSeoLinks = {
  canonical: null,
  ogUrl: null,
  hreflang: [],
};

export function shouldEmitHreflang(
  page: Pick<Page, 'error_page'> & { settings?: Page['settings'] },
  isPreview = false,
): boolean {
  return !isPreview && page.error_page === null && !page.settings?.seo?.noindex;
}

export function buildDocumentSeoLinks(params: {
  pagePath: string | null;
  baseUrl: string | null;
  page: Pick<Page, 'error_page'> & { settings?: Page['settings'] };
  folders: PageFolder[];
  locales: Locale[];
  translationsByLocale: Map<string, Record<string, Translation>>;
  dynamicSlug?: DynamicSlugContext | null;
  isPreview?: boolean;
}): DocumentSeoLinks {
  const { pagePath, baseUrl, page, isPreview = false } = params;

  if (!pagePath || !baseUrl || page.error_page !== null) {
    return EMPTY_LINKS;
  }

  const url = buildAbsolutePageUrl(baseUrl, pagePath);
  const hreflang = shouldEmitHreflang(page, isPreview)
    ? buildPageHreflangAlternates({
      page: page as Page,
      folders: params.folders,
      baseUrl,
      locales: params.locales,
      translationsByLocale: params.translationsByLocale,
      dynamicSlug: params.dynamicSlug,
    })
    : [];

  return {
    canonical: url,
    ogUrl: url,
    hreflang,
  };
}

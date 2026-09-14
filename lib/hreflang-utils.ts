/**
 * Hreflang Utility Functions
 *
 * Builds language alternate links for a page (and optional dynamic collection
 * item). Shared by the sitemap generator and the per-page <head> metadata so
 * both surfaces emit identical hreflang clusters.
 */

import type { Locale, Page, PageFolder, Translation } from '@/types';
import { buildSlugPath, buildLocalizedSlugPath, buildLocalizedDynamicPageUrl } from './page-utils';
import { getTranslatableKey } from './locale-runtime';
import { buildAbsolutePageUrl } from './url-utils';

export interface HreflangAlternate {
  hreflang: string;
  href: string;
}

/**
 * Slug context for a dynamic (CMS-driven) page. Required to resolve the
 * translated item slug per locale.
 */
export interface DynamicSlugContext {
  /** Collection item ID (translation source_id). */
  itemId: string;
  /** Default-locale slug value used as the fallback. */
  defaultValue: string;
}

/**
 * Content keys under which a CMS item's slug translation is stored. Slug-only
 * translation loaders (`getSlugTranslationsByLocale`) only ever return these,
 * so URL builders resolve translated slugs by trying both formats.
 */
const CMS_SLUG_CONTENT_KEYS = ['field:key:slug', 'slug'] as const;

/**
 * Return a CMS item's translated slug for a locale, or `undefined` when none
 * exists. Handles both the current (`field:key:slug`) and legacy (`slug`)
 * content-key formats.
 */
export function getTranslatedItemSlug(
  translations: Record<string, Translation> | undefined,
  itemId: string
): string | undefined {
  for (const contentKey of CMS_SLUG_CONTENT_KEYS) {
    const key = getTranslatableKey({ source_type: 'cms', source_id: itemId, content_key: contentKey });
    const value = translations?.[key]?.content_value;
    if (value) return value;
  }
  return undefined;
}

/**
 * Resolve a CMS item's translated slug for a locale, falling back to the
 * default-locale slug when no translation exists.
 */
function resolveTranslatedSlug(
  translations: Record<string, Translation> | undefined,
  itemId: string,
  fallback: string
): string {
  return getTranslatedItemSlug(translations, itemId) ?? fallback;
}

/**
 * Resolve the canonical localized path for a dynamic CMS item when the current
 * request used an off-canonical slug (e.g. the default slug under a locale that
 * has a translated slug, producing duplicate URLs). Returns `null` when the
 * request is already canonical or the item has no translated slug for the
 * locale.
 */
export function getOffCanonicalDynamicRedirect(params: {
  page: Page;
  folders: PageFolder[];
  locale: Locale | null | undefined;
  translations: Record<string, Translation> | undefined;
  itemId: string;
  currentPath: string;
}): string | null {
  const { page, folders, locale, translations, itemId, currentPath } = params;

  const translatedSlug = getTranslatedItemSlug(translations, itemId);
  if (!translatedSlug) return null;

  const canonicalPath = buildLocalizedDynamicPageUrl(page, folders, translatedSlug, locale, translations);
  return canonicalPath && canonicalPath !== currentPath ? canonicalPath : null;
}

/** Build the default-locale absolute URL for a dynamic item. */
function buildDynamicDefaultUrl(
  page: Page,
  folders: PageFolder[],
  baseUrl: string,
  slugValue: string
): string {
  const folderPath = buildSlugPath(page, folders, 'page', '').replace(/\/$/, '');
  const itemPath = folderPath ? `${folderPath}/${slugValue}` : `/${slugValue}`;
  return buildAbsolutePageUrl(baseUrl, itemPath);
}

/** Build a localized absolute URL for a dynamic item in a non-default locale. */
function buildDynamicLocalizedUrl(
  page: Page,
  folders: PageFolder[],
  baseUrl: string,
  locale: Locale,
  translations: Record<string, Translation> | undefined,
  dynamicSlug: DynamicSlugContext
): string {
  const localizedFolderPath = buildLocalizedSlugPath(
    page,
    folders,
    'page',
    locale,
    translations,
    ''
  ).replace(/\/$/, '');

  const translatedSlug = resolveTranslatedSlug(translations, dynamicSlug.itemId, dynamicSlug.defaultValue);

  const localizedItemPath = localizedFolderPath
    ? `${localizedFolderPath}/${translatedSlug}`
    : `/${locale.code}/${translatedSlug}`;

  return buildAbsolutePageUrl(baseUrl, localizedItemPath);
}

/**
 * Build the full set of hreflang alternates for a single page (or dynamic
 * collection item). Returns one entry per locale plus an `x-default` pointing
 * at the default-locale URL. Returns an empty array for single-locale sites.
 *
 * @example
 * buildPageHreflangAlternates({ page, folders, baseUrl, locales, translationsByLocale })
 * // [{ hreflang: 'en', href: 'https://x.com/about' },
 * //  { hreflang: 'fr', href: 'https://x.com/fr/a-propos' },
 * //  { hreflang: 'x-default', href: 'https://x.com/about' }]
 */
export function buildPageHreflangAlternates(params: {
  page: Page;
  folders: PageFolder[];
  baseUrl: string;
  locales: Locale[];
  translationsByLocale: Map<string, Record<string, Translation>>;
  dynamicSlug?: DynamicSlugContext | null;
}): HreflangAlternate[] {
  const { page, folders, baseUrl, locales, translationsByLocale, dynamicSlug } = params;

  // hreflang only makes sense when there's more than one language.
  if (locales.length <= 1) {
    return [];
  }

  const defaultLocale = locales.find(l => l.is_default);
  const nonDefaultLocales = locales.filter(l => !l.is_default);

  const defaultUrl = dynamicSlug
    ? buildDynamicDefaultUrl(page, folders, baseUrl, dynamicSlug.defaultValue)
    : buildAbsolutePageUrl(baseUrl, buildSlugPath(page, folders, 'page'));

  const alternates: HreflangAlternate[] = [];

  if (defaultLocale) {
    alternates.push({ hreflang: defaultLocale.code, href: defaultUrl });
  }

  for (const locale of nonDefaultLocales) {
    const translations = translationsByLocale.get(locale.id);
    const href = dynamicSlug
      ? buildDynamicLocalizedUrl(page, folders, baseUrl, locale, translations, dynamicSlug)
      : buildAbsolutePageUrl(baseUrl, buildLocalizedSlugPath(page, folders, 'page', locale, translations));
    alternates.push({ hreflang: locale.code, href });
  }

  // x-default lets search engines pick when no language matches the user.
  alternates.push({ hreflang: 'x-default', href: defaultUrl });

  return alternates;
}

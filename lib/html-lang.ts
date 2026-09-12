/**
 * Resolve the BCP-47 language and text direction for the document root
 * from a public-site pathname. Pure helpers — used by the document layout
 * and by unit tests.
 */

import { detectLocaleFromPath } from '@/lib/page-utils';

const FALLBACK_LANG = 'en';

/**
 * ISO 639 language subtags that the locale catalog marks as RTL.
 * Direction is a property of the language, not the region, so `ar-SA`
 * and `he-IL` resolve through the base subtag.
 */
const RTL_LANGUAGE_SUBTAGS = new Set([
  'ar',
  'dv',
  'fa',
  'he',
  'ks',
  'ku',
  'sd',
  'ug',
  'ur',
]);

export type HtmlDir = 'ltr' | 'rtl';

export interface HtmlLangLocale {
  code: string;
  is_default: boolean;
}

/**
 * Pick the document language from a slug path and the site's locale list.
 * Default-locale URLs have no prefix; other locales are the first segment.
 */
export function htmlLangFromLocales(
  slugPath: string,
  locales: HtmlLangLocale[],
): string {
  const defaultCode = locales.find((locale) => locale.is_default)?.code
    || locales[0]?.code
    || FALLBACK_LANG;

  if (!slugPath) {
    return defaultCode;
  }

  const detected = detectLocaleFromPath(
    slugPath,
    locales.map((locale) => locale.code),
  );

  if (!detected) {
    return defaultCode;
  }

  const matched = locales.find(
    (locale) => locale.code.toLowerCase() === detected.localeCode.toLowerCase(),
  );

  return matched?.code || defaultCode;
}

/**
 * Document `dir` for a BCP-47 language tag. Unknown codes default to `ltr`.
 */
export function htmlDirFromLang(lang: string): HtmlDir {
  const base = lang.toLowerCase().split('-')[0];
  return RTL_LANGUAGE_SUBTAGS.has(base) ? 'rtl' : 'ltr';
}

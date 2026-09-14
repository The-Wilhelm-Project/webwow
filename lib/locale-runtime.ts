/**
 * Locale Runtime Helpers
 *
 * Pure runtime helpers for resolving translations on the rendered page.
 * Lives in its own module (with zero deps on `lib/templates/*` or
 * `lib/layer-display-utils`) so the public renderer can pull them in
 * without dragging the builder-only translatable-item extractors and the
 * template tree behind them into the public bundle.
 */

import type { Translation } from '@/types';

/**
 * Build a stable storage key for any translation row.
 * Format: `{source_type}:{source_id}:{content_key}`
 * Pure helper — used by both runtime resolution (locale-aware page URLs)
 * and the builder-side extractors.
 */
export function getTranslatableKey(
  translation: Translation | { source_type: string; source_id: string; content_key: string }
): string {
  return `${translation.source_type}:${translation.source_id}:${translation.content_key}`;
}

/**
 * Build a translation key for a layer
 * @param pageId - Page ID
 * @param contentKey - Content key (e.g. `layer:layer-id:text`)
 * @param masterComponentId - Optional component ID — when set, the translation
 *   is namespaced under `component:{id}` instead of `page:{id}` so component
 *   instances share translations across pages.
 */
export function buildLayerTranslationKey(
  pageId: string,
  contentKey: string,
  masterComponentId?: string | undefined
): string {
  const sourcePrefix = masterComponentId
    ? `component:${masterComponentId}`
    : `page:${pageId}`;
  return `${sourcePrefix}:${contentKey}`;
}

/** Get translation from translations map by key */
export function getTranslationByKey(
  translations: Record<string, Translation> | null | undefined,
  translationKey: string
): Translation | undefined {
  if (!translations) return undefined;
  return translations[translationKey];
}

/**
 * Check if a translation has a valid non-empty text value.
 * Only returns true if translation is completed and has non-empty content.
 */
export function hasValidTranslationValue(translation: Translation | undefined): boolean {
  if (!translation || !translation.is_completed) {
    return false;
  }
  return !!(translation.content_value && translation.content_value.trim() !== '');
}

/**
 * Get the translation value if valid, otherwise undefined.
 * Pass `{ includeIncomplete: true }` to skip the `is_completed` gate (used by
 * the builder canvas to surface in-progress translations to the editor).
 */
export function getTranslationValue(
  translation: Translation | undefined,
  options?: { includeIncomplete?: boolean }
): string | undefined {
  if (!translation) return undefined;
  if (options?.includeIncomplete) {
    const value = translation.content_value;
    return value && value.trim() !== '' ? value : undefined;
  }
  if (hasValidTranslationValue(translation)) {
    return translation.content_value;
  }
  return undefined;
}

/**
 * Get translated asset ID if a translation exists.
 * Falls back to `originalAssetId` when no completed translation is found.
 */
export function getTranslatedAssetId(
  originalAssetId: string | undefined,
  contentKey: string,
  translations: Record<string, Translation> | null | undefined,
  pageId: string | undefined,
  masterComponentId?: string | undefined
): string | undefined {
  if (!originalAssetId || !translations || !pageId) return originalAssetId;

  const translationKey = buildLayerTranslationKey(pageId, contentKey, masterComponentId);
  const translation = getTranslationByKey(translations, translationKey);

  const translatedValue = getTranslationValue(translation);
  if (translatedValue) {
    return translatedValue;
  }

  return originalAssetId;
}

/**
 * Slim a per-locale translation catalog down to only the rows still needed
 * after server-side injection. Text/media translations are already baked into
 * the layer tree (via `injectTranslatedText`), so we drop them and keep:
 *   - slug rows — localized link/URL building (client + server)
 *   - seo rows (when `includeSeo`) — localized <title>/description/OG image
 * Dropping the rest keeps the full ~MB catalog out of `PageData` and the
 * serialized RSC/hydration payload on every localized page.
 */
export function slimTranslations(
  translations: Record<string, Translation> | null | undefined,
  options?: { includeSeo?: boolean }
): Record<string, Translation> | undefined {
  if (!translations) return undefined;

  const includeSeo = options?.includeSeo ?? false;
  const slim: Record<string, Translation> = {};
  for (const key in translations) {
    const contentKey = translations[key].content_key;
    const keep = contentKey === 'slug'
      || contentKey.endsWith(':slug')
      || (includeSeo && contentKey.startsWith('seo:'));
    if (keep) {
      slim[key] = translations[key];
    }
  }
  return slim;
}

/** Get translated text if a translation exists, otherwise return the original. */
export function getTranslatedText(
  originalText: string | undefined,
  contentKey: string,
  translations: Record<string, Translation> | null | undefined,
  pageId: string | undefined,
  masterComponentId?: string | undefined
): string | undefined {
  if (!originalText || !translations || !pageId) return originalText;

  const translationKey = buildLayerTranslationKey(pageId, contentKey, masterComponentId);
  const translation = getTranslationByKey(translations, translationKey);

  const translatedValue = getTranslationValue(translation);
  if (translatedValue) {
    return translatedValue;
  }

  return originalText;
}

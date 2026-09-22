'use client';

import { useMemo } from 'react';
import { useLocalisationStore } from '@/stores/useLocalisationStore';
import type { Locale } from '@/types';

/**
 * Returns the active locale state used to gate canvas + sidebar editing.
 *
 * `isLocalizing` is true when a non-default locale is selected. In that mode
 * the canvas becomes a read-only translation view: layer styles, structure,
 * and source content can't be edited; the right sidebar swaps to a per-layer
 * translation editor instead.
 */
export interface LocalizationModeState {
  currentLocale: Locale | null;
  defaultLocale: Locale | null;
  isLocalizing: boolean;
}

export function useLocalizationMode(): LocalizationModeState {
  const selectedLocaleId = useLocalisationStore((state) => state.selectedLocaleId);
  const locales = useLocalisationStore((state) => state.locales);
  const defaultLocale = useLocalisationStore((state) => state.defaultLocale);

  return useMemo(() => {
    const currentLocale = selectedLocaleId
      ? locales.find((l) => l.id === selectedLocaleId) ?? null
      : null;

    const isLocalizing = !!(currentLocale && !currentLocale.is_default);

    return { currentLocale, defaultLocale, isLocalizing };
  }, [selectedLocaleId, locales, defaultLocale]);
}

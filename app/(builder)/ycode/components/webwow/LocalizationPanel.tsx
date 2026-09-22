'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import { useLocalisationStore } from '@/stores/useLocalisationStore';
import { cn } from '@/lib/utils';
import type { RoutePanelProps } from './FormsPanel';
import { PanelSectionTitle } from './PanelLinkList';

/**
 * Locales of the site. A row switches the editing locale (same as the header's locale
 * selector); "Manage locales" opens `/ycode/localization`.
 */
function LocalizationPanel({ goTo }: RoutePanelProps) {
  const currentPath = usePathname();
  const locales = useLocalisationStore((state) => state.locales);
  const selectedLocaleId = useLocalisationStore((state) => state.selectedLocaleId);
  const setSelectedLocaleId = useLocalisationStore((state) => state.setSelectedLocaleId);
  const onRoute = currentPath?.startsWith('/ycode/localization') ?? false;

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-webwow-localization-panel>
      <div className="px-3 pt-3 pb-2 border-b">
        <Button
          size="sm" variant="secondary"
          className="w-full" onClick={() => goTo('/ycode/localization')}
          aria-current={onRoute ? 'page' : undefined}
        >
          <Icon name="globe" />
          Manage locales
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
        <PanelSectionTitle>Editing locale</PanelSectionTitle>
        {locales.length === 0 ? (
          <p className="px-4 py-2 text-xs text-muted-foreground">No locales yet. Add one under Manage locales.</p>
        ) : (
          <ul
            role="listbox" aria-label="Locales"
            className="flex flex-col gap-0.5 p-2"
          >
            {locales.map((locale) => {
              const selected = locale.id === selectedLocaleId;
              return (
                <li
                  key={locale.id} role="option"
                  aria-selected={selected}
                >
                  <button
                    type="button"
                    data-webwow-locale={locale.code}
                    onClick={() => setSelectedLocaleId(locale.id)}
                    className={cn(
                      'w-full h-8 px-2 rounded-md flex items-center gap-2 text-xs text-left cursor-pointer',
                      'hover:bg-secondary/70 outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selected && 'bg-secondary',
                    )}
                  >
                    <span className="w-8 shrink-0 uppercase text-[10px] font-medium text-muted-foreground">{locale.code}</span>
                    <span className="truncate">{locale.label}</span>
                    {locale.is_default && <Badge variant="secondary" className="ml-auto px-1.5 py-0 text-[10px]">Default</Badge>}
                    {selected && <Icon name="check" className={cn('size-3 shrink-0', !locale.is_default && 'ml-auto')} />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default React.memo(LocalizationPanel);

'use client';

import { memo } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Icon from '@/components/ui/icon';
import { useLocalisationStore } from '@/stores/useLocalisationStore';
import { useRole } from '@/hooks/use-role';

/**
 * Locale switcher for the header. Kept as its own memoized component that only
 * subscribes to locale state (never `translations`) so an async translation
 * load doesn't re-render it and interrupt the dropdown's close animation.
 */
function LocaleSelectorComponent() {
  const router = useRouter();
  const pathname = usePathname();
  const { canManageSettings } = useRole();

  const locales = useLocalisationStore((s) => s.locales);
  const selectedLocaleId = useLocalisationStore((s) => s.selectedLocaleId);
  const setSelectedLocaleId = useLocalisationStore((s) => s.setSelectedLocaleId);
  const loadTranslations = useLocalisationStore((s) => s.loadTranslations);

  const selectedLocale = selectedLocaleId
    ? locales.find((l) => l.id === selectedLocaleId) || null
    : null;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="ghost">
          <Icon name="globe" />
          {selectedLocale ? selectedLocale.code.toUpperCase() : 'EN'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canManageSettings && !pathname?.startsWith('/ycode/localization') && (
          <>
            <DropdownMenuItem onClick={() => router.push('/ycode/localization')}>
              Manage locales & translations
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuRadioGroup
          value={selectedLocaleId || ''}
          onValueChange={(value) => {
            setSelectedLocaleId(value);
            // Eager-load translations so the canvas reflects the new locale
            // without waiting for component-level effects to run. The store
            // short-circuits for the default locale and for cached locales.
            loadTranslations(value);
          }}
        >
          {locales.map((locale) => (
            <DropdownMenuRadioItem
              key={locale.id} value={locale.id}
              className="pr-8"
            >
              <span className="flex items-center gap-2 w-full">
                <span className="bg-secondary text-secondary-foreground text-[10px] font-semibold py-0.5 px-1.5 rounded-[6px] uppercase shrink-0">
                  {locale.code}
                </span>
                {locale.label}{locale.is_default && (<><span className="px-px">–</span>Default locale</>)}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const LocaleSelector = memo(LocaleSelectorComponent);

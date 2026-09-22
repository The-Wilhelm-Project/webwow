'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  BUILDER_THEMES,
  DEFAULT_THEME,
  THEME_CHANGE_EVENT,
  isBuilderTheme,
  isDarkTheme,
  persistTheme,
  readTheme,
  type BuilderTheme,
} from '@/lib/webwow/builder/theme';
import { yieldArrowKeysToRail } from './Rail';
import { RailIcon, type RailIconName } from './rail-icons';

export interface ThemeMenuProps {
  registerButton: (el: HTMLButtonElement | null) => void;
  /** Roving tabindex slot from the rail (0 for the current item, otherwise -1). */
  tabIndex: number;
  onFocus: () => void;
}

const THEME_ICONS: Record<BuilderTheme, RailIconName> = { system: 'monitor', light: 'sun', dark: 'moon' };

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Same rule as the HeaderBar's theme effect: `dark` class on `<html>`, value in localStorage. */
function applyTheme(theme: BuilderTheme): void {
  const root = document.documentElement;
  const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.classList.toggle('dark', isDarkTheme(theme, systemPrefersDark));
  persistTheme(localStorageOrNull(), theme);
}

/**
 * Theme switcher at the bottom of the rail (System / Light / Dark). It shares the stored value
 * and the `<html class="dark">` rule with the HeaderBar logo menu: changes made here are
 * announced with the `webwow:theme` event (the HeaderBar mirrors them into its state), and
 * the stored value is re-read whenever the menu opens so HeaderBar changes show up here.
 */
function ThemeMenu({ registerButton, tabIndex, onFocus }: ThemeMenuProps) {
  // Default until mounted (no localStorage during SSR - avoids a hydration mismatch).
  const [theme, setTheme] = useState<BuilderTheme>(DEFAULT_THEME);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setTheme(readTheme(localStorageOrNull()));
    const handleChange = (event: Event) => {
      const next = (event as CustomEvent<unknown>).detail;
      if (isBuilderTheme(next)) setTheme(next);
    };
    window.addEventListener(THEME_CHANGE_EVENT, handleChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, handleChange);
  }, []);

  const handleOpenChange = useCallback((next: boolean) => {
    if (next) setTheme(readTheme(localStorageOrNull()));
    setOpen(next);
  }, []);

  const select = useCallback((value: string) => {
    if (!isBuilderTheme(value)) return;
    setTheme(value);
    applyTheme(value);
    window.dispatchEvent(new CustomEvent<BuilderTheme>(THEME_CHANGE_EVENT, { detail: value }));
  }, []);

  const label = BUILDER_THEMES.find((entry) => entry.id === theme)?.label ?? theme;

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              ref={registerButton}
              data-rail-item="theme"
              data-theme-value={theme}
              tabIndex={tabIndex}
              onFocus={onFocus}
              onKeyDown={yieldArrowKeysToRail}
              aria-label={`Theme: ${label}`}
              aria-haspopup="menu"
              className={cn(
                'size-8 rounded-lg flex items-center justify-center text-muted-foreground cursor-pointer',
                'hover:bg-secondary/70 hover:text-foreground',
                'data-[state=open]:bg-secondary data-[state=open]:text-foreground',
                'outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              <RailIcon name={THEME_ICONS[theme]} className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>Theme · {label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="right" align="end"
        sideOffset={8} className="w-40"
      >
        <DropdownMenuLabel className="text-xs text-muted-foreground">Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={select}>
          {BUILDER_THEMES.map((entry) => (
            <DropdownMenuRadioItem key={entry.id} value={entry.id}>
              <RailIcon name={THEME_ICONS[entry.id]} className="size-3.5" />
              {entry.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default React.memo(ThemeMenu);

'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Icon, { type IconProps } from '@/components/ui/icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';
import { RailIcon, isRailIconName } from './rail-icons';
import { ariaKeyShortcuts, shortcutLabel, type RailItem, type RailItemId } from './railItems';

export interface RailButtonState {
  active: boolean;
  pressed?: boolean;
  current?: boolean;
  disabled?: boolean;
  disabledHint?: string;
}

export interface RailProps {
  items: readonly RailItem[];
  stateFor: (id: RailItemId) => RailButtonState;
  onActivate: (id: RailItemId) => void;
  /** Collects button refs so the container can return focus (Esc) to an item. */
  registerButton: (id: RailItemId, el: HTMLButtonElement | null) => void;
  /**
   * Rendered in place of a `kind: 'menu'` item (theme, profile: trigger + dropdown). The
   * trigger button must take `tabIndex` / `onFocus` so it joins the roving tabindex, and carry
   * `data-rail-item="<id>"`. Returning null renders nothing for that item.
   */
  renderMenu?: (id: RailItemId, props: RailProfileSlotProps) => React.ReactNode;
}

export interface RailProfileSlotProps {
  tabIndex: number;
  onFocus: () => void;
}

/**
 * For menu triggers (theme, profile): ArrowUp / ArrowDown move the roving focus, so prevent
 * Radix from opening the menu on ArrowDown; Enter / Space still open it.
 */
export function yieldArrowKeysToRail(e: React.KeyboardEvent<HTMLButtonElement>): void {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') e.preventDefault();
}

function useIsMac(): boolean {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    if (typeof navigator !== 'undefined') {
      setIsMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
    }
  }, []);
  return isMac;
}

function RailGlyph({ icon }: { icon: string }) {
  if (isRailIconName(icon)) return <RailIcon name={icon} className="size-4" />;
  return <Icon name={icon as IconProps['name']} className="size-4" />;
}

/**
 * The 48 px vertical icon bar. One tab stop with a roving tabindex; ArrowUp/Down, Home/End
 * move focus between items (the profile menu button included).
 */
function Rail({ items, stateFor, onActivate, registerButton, renderMenu }: RailProps) {
  const isMac = useIsMac();
  const [focusIndex, setFocusIndex] = useState<number>(() => {
    const first = items.findIndex((item) => stateFor(item.id).active);
    return first >= 0 ? first : 0;
  });

  const top = useMemo(() => items.filter((item) => item.group === 'top'), [items]);
  const bottom = useMemo(() => items.filter((item) => item.group === 'bottom'), [items]);
  const ordered = useMemo(() => [...top, ...bottom], [top, bottom]);

  const focusItem = useCallback((index: number) => {
    const count = ordered.length;
    if (count === 0) return;
    const next = ((index % count) + count) % count;
    setFocusIndex(next);
    const nav = document.querySelector<HTMLElement>('[data-webwow-rail]');
    const button = nav?.querySelector<HTMLElement>(`button[data-rail-item="${ordered[next].id}"]`);
    button?.focus();
  }, [ordered]);

  // One stable focus handler per item so memoized children (profile menu) keep their props.
  const focusHandlers = useMemo(() => ordered.map((_, index) => () => setFocusIndex(index)), [ordered]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    const index = ordered.findIndex((item) => target.closest(`button[data-rail-item="${item.id}"]`));
    if (index < 0) return;
    // An open menu trigger (theme, profile) owns the keyboard; a closed one yields the arrow
    // keys to the roving focus (the triggers prevent Radix's open-on-ArrowDown themselves).
    if (target.closest('button[data-rail-item]')?.getAttribute('data-state') === 'open') return;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusItem(index + 1); break;
      case 'ArrowUp': e.preventDefault(); focusItem(index - 1); break;
      case 'Home': e.preventDefault(); focusItem(0); break;
      case 'End': e.preventDefault(); focusItem(ordered.length - 1); break;
      default: break;
    }
  }, [ordered, focusItem]);

  const renderItem = (item: RailItem) => {
    const index = ordered.indexOf(item);
    const state = stateFor(item.id);
    const shortcut = shortcutLabel(item.id, isMac);
    const ariaLabel = shortcut ? `${item.label} (${shortcut})` : item.label;

    if (item.kind === 'menu') {
      const node = renderMenu?.(item.id, { tabIndex: index === focusIndex ? 0 : -1, onFocus: focusHandlers[index] });
      if (!node) return null;
      return (
        <li key={item.id} className="relative w-full flex justify-center">
          {node}
        </li>
      );
    }

    return (
      <li key={item.id} className="relative w-full flex justify-center">
        {state.active && (
          <span aria-hidden="true" className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-primary" />
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              ref={(el) => registerButton(item.id, el)}
              data-rail-item={item.id}
              data-active={state.active ? 'true' : 'false'}
              tabIndex={index === focusIndex ? 0 : -1}
              aria-label={ariaLabel}
              aria-pressed={state.pressed}
              aria-current={state.current ? 'page' : undefined}
              aria-disabled={state.disabled || undefined}
              aria-keyshortcuts={ariaKeyShortcuts(item.id, isMac)}
              onFocus={focusHandlers[index]}
              onClick={() => {
                if (state.disabled) return;
                onActivate(item.id);
              }}
              className={cn(
                'size-8 rounded-lg flex items-center justify-center text-muted-foreground cursor-pointer',
                'hover:bg-secondary/70 hover:text-foreground',
                'data-[active=true]:bg-secondary data-[active=true]:text-foreground',
                'aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground',
                'outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              <RailGlyph icon={item.icon} />
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="right" sideOffset={6}
            className="flex items-center gap-2"
          >
            <span>{item.label}</span>
            {shortcut && <Kbd>{shortcut}</Kbd>}
            {state.disabled && state.disabledHint && (
              <span className="opacity-70">· {state.disabledHint}</span>
            )}
          </TooltipContent>
        </Tooltip>
      </li>
    );
  };

  return (
    <nav
      aria-label="Builder"
      data-webwow-rail
      onKeyDown={handleKeyDown}
      className="w-12 shrink-0 h-full bg-background border-r flex flex-col items-center py-2 relative z-30"
    >
      <ul role="list" className="flex flex-col items-center gap-1 w-full">
        {top.map(renderItem)}
      </ul>
      <ul role="list" className="mt-auto flex flex-col items-center gap-1 w-full">
        {bottom.map(renderItem)}
      </ul>
    </nav>
  );
}

export default React.memo(Rail);

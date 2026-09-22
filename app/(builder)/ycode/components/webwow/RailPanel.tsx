'use client';

import React, { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { RailIcon } from './rail-icons';
import { RAIL_FLYOUT_WIDTH, type RailItemId } from './railItems';

export type RailPanelMode = 'pinned' | 'flyout' | 'hidden';

export interface PanelControlsProps {
  pinnable?: boolean;
  pinned?: boolean;
  onPin?: () => void;
  onClose: () => void;
  /** Tooltip for the close button ("Close" for flyouts, "Collapse (Z)" when pinned). */
  closeLabel?: string;
}

/** Pin + close buttons shared by the toolbar header, the Pages overlay and the Navigator header. */
export function PanelControls({ pinnable, pinned, onPin, onClose, closeLabel = 'Close panel' }: PanelControlsProps) {
  return (
    <div className="flex items-center gap-0.5 -my-1">
      {pinnable && onPin && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-pressed={pinned}
              aria-label={pinned ? 'Unpin panel' : 'Pin panel'}
              onClick={onPin}
              className={cn(pinned && 'text-foreground')}
            >
              <RailIcon name={pinned ? 'pin-filled' : 'pin'} className="size-3.5!" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{pinned ? 'Unpin panel' : 'Pin panel'}</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-xs" variant="ghost"
            aria-label={closeLabel} onClick={onClose}
          >
            <Icon name="x" className="size-3!" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{closeLabel}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export interface RailPanelProps extends PanelControlsProps {
  id: RailItemId;
  title: string;
  mode: RailPanelMode;
  /** Pinned width (from `useResizableSidebar`). */
  width: number;
  /** Viewport x of a flyout (rail + pinned panel). */
  flyoutLeft: number;
  /**
   * `toolbar`: 40 px header with title/search/controls.
   * `native`: the body renders the upstream 56 px list header itself; controls overlay it
   *   (the body must keep `pr-14` on that header so its own buttons stay visible).
   * `none`: the body owns the whole header (Navigator).
   */
  header?: 'toolbar' | 'native' | 'none';
  search?: { value: string; onChange: (value: string) => void; placeholder?: string };
  headerActions?: React.ReactNode;
  /**
   * Esc in the header search field (with an empty query). Defaults to `onClose`; the
   * container passes a handler that also returns focus to the rail icon (spec §7).
   */
  onEscape?: () => void;
  onResizeMouseDown?: (e: React.MouseEvent) => void;
  isResizing?: boolean;
  /** Extra classes on the body wrapper. */
  bodyClassName?: string;
  children: React.ReactNode;
}

/**
 * Panel frame next to the rail. Pinned = in-flow flex child that pushes the canvas;
 * flyout = fixed overlay at `flyoutLeft`; hidden = display:none (content stays mounted).
 */
export default function RailPanel({
  id,
  title,
  mode,
  width,
  flyoutLeft,
  header = 'toolbar',
  search,
  headerActions,
  onEscape,
  onResizeMouseDown,
  isResizing,
  bodyClassName,
  pinnable,
  pinned,
  onPin,
  onClose,
  closeLabel,
  children,
}: RailPanelProps) {
  const rootRef = useRef<HTMLElement>(null);
  const handledModeRef = useRef<RailPanelMode | null>(null);

  // Focus moves into the panel when it opens: an explicit `data-autofocus` target, else the
  // panel's own header search field, else the title. Inputs that upstream content renders in
  // the body are skipped on purpose: they may sit in an inactive tab (ElementLibrary's
  // component search) and the rail's Esc shortcut ignores keydowns inside inputs.
  // A panel that mounts pinned (page load) never steals focus; a panel that mounts as a
  // flyout (lazy panels opened by the user) does. The ref makes the effect idempotent for
  // React's development double-invocation, and the frame callback is not cancelled on
  // cleanup for the same reason (it checks the live DOM instead).
  useEffect(() => {
    const prev = handledModeRef.current;
    if (prev === mode) return;
    handledModeRef.current = mode;
    if (mode === 'hidden') return;
    if (prev === null ? mode !== 'flyout' : prev !== 'hidden') return;
    requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root || root.dataset.mode !== mode) return;
      const target =
        root.querySelector<HTMLElement>('[data-autofocus]') ||
        root.querySelector<HTMLElement>('[data-panel-search]') ||
        root.querySelector<HTMLElement>('[data-panel-title]');
      target?.focus({ preventScroll: true });
    });
  }, [mode]);

  const controls = (
    <PanelControls
      pinnable={pinnable}
      pinned={pinned}
      onPin={onPin}
      onClose={onClose}
      closeLabel={closeLabel ?? (mode === 'pinned' ? 'Collapse panel' : 'Close panel')}
    />
  );

  return (
    <section
      ref={rootRef}
      role="region"
      aria-label={`${title} panel`}
      data-webwow-rail-panel={id}
      data-mode={mode}
      className={cn(
        // No overflow clipping on the section itself: the resize handle sticks out over the
        // canvas (`-right-1.5`), so the body wrapper below clips the content instead.
        'bg-background border-r flex flex-col',
        mode === 'pinned' && 'relative shrink-0 h-full',
        mode === 'flyout' && 'fixed top-14 bottom-0 z-50 shadow-lg',
        mode === 'hidden' && 'hidden',
      )}
      style={
        mode === 'pinned'
          ? { width: `${width}px` }
          : { left: `${flyoutLeft}px`, width: `${RAIL_FLYOUT_WIDTH}px` }
      }
    >
      {header === 'toolbar' && (
        <div className="h-10 shrink-0 px-3 flex items-center gap-2 border-b">
          <h2
            tabIndex={-1} data-panel-title
            className="text-xs font-medium truncate outline-none"
          >{title}</h2>
          {search && (
            <div className="relative flex-1 min-w-0">
              <Icon name="search" className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground pointer-events-none" />
              <Input
                data-panel-search
                value={search.value}
                onChange={(e) => search.onChange(e.target.value)}
                onKeyDown={(e) => {
                  // Esc in the search field: clear the query first, close the panel when empty
                  // (the global shortcut ignores Esc while an input is focused, so the
                  // refocusing close path has to be reached from here).
                  if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (search.value) {
                    search.onChange('');
                  } else {
                    (onEscape ?? onClose)();
                  }
                }}
                placeholder={search.placeholder ?? 'Search…'}
                aria-label={`Search ${title.toLowerCase()}`}
                className="h-7 text-xs pl-7"
              />
            </div>
          )}
          {!search && <div className="flex-1" />}
          {headerActions}
          {controls}
        </div>
      )}
      {header === 'native' && (
        <div className="absolute top-0 right-3 h-14 flex items-center z-30">{controls}</div>
      )}
      <div
        className={cn(
          'flex-1 min-h-0 flex flex-col overflow-hidden',
          header === 'native' && 'px-4',
          bodyClassName,
        )}
      >
        {children}
      </div>

      {mode === 'pinned' && onResizeMouseDown && (
        <div
          onMouseDown={onResizeMouseDown}
          className="absolute top-0 -right-1.5 w-3 h-full cursor-col-resize z-30 flex items-center justify-center group/resize"
          aria-hidden="true"
        >
          <div className="w-0.5 h-full bg-transparent group-hover/resize:bg-primary/50 group-active/resize:bg-primary/70 transition-colors" />
        </div>
      )}
      {mode === 'pinned' && isResizing && (
        <div className="fixed inset-0 z-50 cursor-col-resize" aria-hidden="true" />
      )}
    </section>
  );
}

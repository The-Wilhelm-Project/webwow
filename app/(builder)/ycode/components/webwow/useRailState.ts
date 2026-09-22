'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useEditorStore } from '@/stores/useEditorStore';
import {
  DEFAULT_RAIL_STORAGE,
  RAIL_PANEL_DEFAULT_WIDTH,
  RAIL_PANEL_MAX_WIDTH,
  RAIL_PANEL_MIN_WIDTH,
  RAIL_STORAGE_KEY,
  clampPanelWidth,
  parseRailStorage,
  safeGet,
  safeSet,
  serializeRailStorage,
  type PinnedId,
  type RailItemId,
  type RailStorage,
} from './railItems';

export interface RailState {
  pinned: PinnedId;
  /** Pinned panel temporarily hidden (session only). */
  collapsed: boolean;
  flyout: RailItemId | null;
}

type Action =
  | { type: 'toggle'; id: RailItemId; pinnedUsable: boolean }
  | { type: 'openFlyout'; id: RailItemId; pinnedUsable: boolean }
  | { type: 'closeFlyout' }
  | { type: 'pin'; id: Exclude<PinnedId, null> }
  | { type: 'unpin'; id: Exclude<PinnedId, null> }
  | { type: 'collapse'; collapsed: boolean };

export function railReducer(state: RailState, action: Action): RailState {
  switch (action.type) {
    case 'toggle': {
      // `pinnedUsable` is false on routes without a pinned panel (CMS, settings, ...):
      // the pinned item then behaves like any other flyout there.
      if (action.id === state.pinned && action.pinnedUsable) {
        return { ...state, collapsed: !state.collapsed };
      }
      if (state.flyout === action.id) return { ...state, flyout: null };
      return { ...state, flyout: action.id };
    }
    case 'openFlyout': {
      if (action.id === state.pinned && action.pinnedUsable) {
        return state.collapsed ? { ...state, collapsed: false } : state;
      }
      return state.flyout === action.id ? state : { ...state, flyout: action.id };
    }
    case 'closeFlyout':
      return state.flyout === null ? state : { ...state, flyout: null };
    case 'pin':
      return { pinned: action.id, collapsed: false, flyout: state.flyout === action.id ? null : state.flyout };
    case 'unpin':
      if (state.pinned !== action.id) return state;
      return { pinned: null, collapsed: false, flyout: action.id };
    case 'collapse':
      return state.collapsed === action.collapsed ? state : { ...state, collapsed: action.collapsed };
    default:
      return state;
  }
}

/** Reads `webwow.rail.v1` once (SSR safe). */
export function readRailStorage(): RailStorage {
  if (typeof window === 'undefined') return { ...DEFAULT_RAIL_STORAGE };
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return parseRailStorage(safeGet(storage, RAIL_STORAGE_KEY));
}

export function writeRailStorage(state: RailStorage): boolean {
  if (typeof window === 'undefined') return false;
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return safeSet(storage, RAIL_STORAGE_KEY, serializeRailStorage(state));
}

/**
 * Drag-to-resize for the pinned panel. Same gestures as the upstream `useResizableSidebar`
 * (drag the handle, double-click resets, body cursor + `sidebarResizing` while dragging) but
 * without its unguarded `localStorage` reads/writes: the width is persisted by `useRailState`
 * through `writeRailStorage()` only, so blocked storage can never throw during render.
 */
export function useRailResize(initialWidth: number) {
  const setSidebarResizing = useEditorStore((state) => state.setSidebarResizing);
  const [width, setWidth] = useState(() => clampPanelWidth(initialWidth));
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(width);
  const latestWidth = useRef(width);

  useEffect(() => {
    latestWidth.current = width;
  }, [width]);

  const stopDragging = useCallback(() => {
    isDraggingRef.current = false;
    setIsDragging(false);
    setSidebarResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, [setSidebarResizing]);

  const handleMouseDown = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    if (e.detail === 2) {
      stopDragging();
      setWidth(RAIL_PANEL_DEFAULT_WIDTH);
      return;
    }
    isDraggingRef.current = true;
    setIsDragging(true);
    setSidebarResizing(true);
    startX.current = e.clientX;
    startWidth.current = latestWidth.current;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [stopDragging, setSidebarResizing]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const next = startWidth.current + (e.clientX - startX.current);
      setWidth(Math.min(RAIL_PANEL_MAX_WIDTH, Math.max(RAIL_PANEL_MIN_WIDTH, next)));
    };
    const handleMouseUp = () => {
      if (!isDraggingRef.current) return;
      stopDragging();
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [stopDragging]);

  return { width, isDragging, handleMouseDown };
}

export interface UseRailStateOptions {
  stored: RailStorage;
  initialFlyout?: RailItemId | null;
  /** Current panel width, mirrored into `webwow.rail.v1` when it settles. */
  width: number;
  widthSettled: boolean;
}

export function useRailState({ stored, initialFlyout = null, width, widthSettled }: UseRailStateOptions) {
  const [state, dispatch] = useReducer(railReducer, undefined, () => ({
    pinned: stored.pinned,
    collapsed: false,
    flyout: initialFlyout,
  }));

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Persist pinned + width (never `collapsed` / `flyout`).
  useEffect(() => {
    if (!widthSettled) return;
    writeRailStorage({ pinned: state.pinned, width });
  }, [state.pinned, width, widthSettled]);

  const toggle = useCallback((id: RailItemId, pinnedUsable: boolean) => dispatch({ type: 'toggle', id, pinnedUsable }), []);
  const openFlyout = useCallback((id: RailItemId, pinnedUsable: boolean) => dispatch({ type: 'openFlyout', id, pinnedUsable }), []);
  const closeFlyout = useCallback(() => dispatch({ type: 'closeFlyout' }), []);
  const pin = useCallback((id: Exclude<PinnedId, null>) => dispatch({ type: 'pin', id }), []);
  const unpin = useCallback((id: Exclude<PinnedId, null>) => dispatch({ type: 'unpin', id }), []);
  const setCollapsed = useCallback((collapsed: boolean) => dispatch({ type: 'collapse', collapsed }), []);

  return useMemo(
    () => ({ state, stateRef, toggle, openFlyout, closeFlyout, pin, unpin, setCollapsed }),
    [state, toggle, openFlyout, closeFlyout, pin, unpin, setCollapsed],
  );
}

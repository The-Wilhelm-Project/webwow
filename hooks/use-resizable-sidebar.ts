'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

import { useEditorStore } from '@/stores/useEditorStore';

const STORAGE_KEY_PREFIX = 'ycode-sidebar-width-';

interface UseResizableSidebarOptions {
  side: 'left' | 'right';
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  storageKey?: string;
}

/**
 * Hook for making a sidebar resizable via a drag handle.
 * Persists width to localStorage and constrains within min/max bounds.
 * Returns isDragging so consumers can render an iframe overlay during resize.
 */
export function useResizableSidebar({
  side,
  defaultWidth = 256,
  minWidth = 200,
  maxWidth = 480,
  storageKey,
}: UseResizableSidebarOptions) {
  const resolvedKey = storageKey ?? `${STORAGE_KEY_PREFIX}${side}`;
  const setSidebarResizing = useEditorStore((state) => state.setSidebarResizing);
  const setLeftSidebarWidth = useEditorStore((state) => state.setLeftSidebarWidth);

  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return defaultWidth;
    const stored = localStorage.getItem(resolvedKey);
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (!isNaN(parsed) && parsed >= minWidth && parsed <= maxWidth) return parsed;
    }
    return defaultWidth;
  });

  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(width);
  const latestWidth = useRef(width);

  useEffect(() => {
    latestWidth.current = width;
    if (side === 'left') setLeftSidebarWidth(width);
  }, [width, side, setLeftSidebarWidth]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();

    if (e.detail === 2) {
      isDraggingRef.current = false;
      setIsDragging(false);
      setSidebarResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setWidth(defaultWidth);
      localStorage.setItem(resolvedKey, String(defaultWidth));
      return;
    }

    isDraggingRef.current = true;
    setIsDragging(true);
    setSidebarResizing(true);
    startX.current = e.clientX;
    startWidth.current = latestWidth.current;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [defaultWidth, resolvedKey, setSidebarResizing]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = side === 'left'
        ? e.clientX - startX.current
        : startX.current - e.clientX;
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth.current + delta));
      setWidth(newWidth);
    };

    const handleMouseUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      setIsDragging(false);
      setSidebarResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(resolvedKey, String(latestWidth.current));
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [side, minWidth, maxWidth, resolvedKey, setSidebarResizing]);

  return { width, isDragging, handleMouseDown };
}

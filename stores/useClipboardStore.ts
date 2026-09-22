'use client';

/**
 * Clipboard Store
 * 
 * Global clipboard state for layer operations (cut, copy, paste)
 * Works across different pages
 */

import { create } from 'zustand';
import type { Layer, LayerInteraction } from '../types';
import { writeYcodeClipboard } from '@/lib/import/ycode/bundle';

/**
 * Legacy marker for an internal copy/cut. Kept for backward compatibility: a
 * copy now writes a full serialized bundle to the OS clipboard (so paste works
 * across tabs/browsers), but when the bundle can't be written (too large, or
 * clipboard write denied) we fall back to this marker plus the in-memory layer,
 * which keeps same-tab paste working and clears any stale Webflow/Figma payload.
 */
export const YCODE_LAYER_CLIPBOARD_SIGNATURE = '__ycode-internal-clipboard__';

/**
 * Best-effort: serialize the copied layers + their dependencies onto the OS
 * clipboard so another tab/browser/project can paste them. The in-memory state
 * below remains the fallback when the write is denied or the bundle is too big.
 */
function claimSystemClipboard(layers: Layer[]): void {
  void writeYcodeClipboard(layers);
}

interface CopiedStyle {
  classes: string;
  design?: Layer['design'];
  styleId?: string;
  styleIds?: string[];
  styleOverrides?: Layer['styleOverrides'];
}

interface CopiedInteractions {
  interactions: LayerInteraction[];
  sourceLayerId: string;
}

interface ClipboardState {
  clipboardLayer: Layer | null;
  /** Full in-memory selection (fallback for multi-select when the OS clipboard write is denied). */
  clipboardLayers: Layer[];
  clipboardMode: 'copy' | 'cut' | null;
  sourcePageId: string | null;
  copiedStyle: CopiedStyle | null;
  copiedInteractions: CopiedInteractions | null;
}

interface ClipboardActions {
  copyLayer: (layer: Layer, pageId: string) => void;
  cutLayer: (layer: Layer, pageId: string) => void;
  copyLayers: (layers: Layer[], pageId: string) => void;
  cutLayers: (layers: Layer[], pageId: string) => void;
  clearClipboard: () => void;
  copyStyle: (classes: string, design?: Layer['design'], styleId?: string, styleOverrides?: Layer['styleOverrides'], styleIds?: string[]) => void;
  pasteStyle: () => CopiedStyle | null;
  clearStyle: () => void;
  copyInteractions: (interactions: LayerInteraction[], sourceLayerId: string) => void;
  pasteInteractions: () => CopiedInteractions | null;
  clearInteractions: () => void;
}

type ClipboardStore = ClipboardState & ClipboardActions;

export const useClipboardStore = create<ClipboardStore>((set, get) => ({
  clipboardLayer: null,
  clipboardLayers: [],
  clipboardMode: null,
  sourcePageId: null,
  copiedStyle: null,
  copiedInteractions: null,

  copyLayer: (layer, pageId) => get().copyLayers([layer], pageId),
  cutLayer: (layer, pageId) => get().cutLayers([layer], pageId),

  copyLayers: (layers, pageId) => {
    claimSystemClipboard(layers);
    set({
      clipboardLayer: layers[0] ?? null,
      clipboardLayers: layers,
      clipboardMode: 'copy',
      sourcePageId: pageId,
    });
  },

  cutLayers: (layers, pageId) => {
    claimSystemClipboard(layers);
    set({
      clipboardLayer: layers[0] ?? null,
      clipboardLayers: layers,
      clipboardMode: 'cut',
      sourcePageId: pageId,
    });
  },

  clearClipboard: () => {
    set({
      clipboardLayer: null,
      clipboardLayers: [],
      clipboardMode: null,
      sourcePageId: null,
    });
  },

  copyStyle: (classes, design, styleId, styleOverrides, styleIds) => {
    set({
      copiedStyle: {
        classes,
        design,
        styleId,
        styleIds,
        styleOverrides,
      },
    });
  },

  pasteStyle: () => {
    return get().copiedStyle;
  },

  clearStyle: () => {
    set({
      copiedStyle: null,
    });
  },

  copyInteractions: (interactions, sourceLayerId) => {
    set({
      copiedInteractions: {
        interactions: JSON.parse(JSON.stringify(interactions)),
        sourceLayerId,
      },
    });
  },

  pasteInteractions: () => {
    return get().copiedInteractions;
  },

  clearInteractions: () => {
    set({
      copiedInteractions: null,
    });
  },
}));

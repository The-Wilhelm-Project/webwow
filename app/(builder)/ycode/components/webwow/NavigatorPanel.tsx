'use client';

import React, { useCallback, useEffect, useMemo, useRef, startTransition } from 'react';
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import ComponentVariantsSection from '../ComponentVariantsSection';
import LayersTree from '../LayersTree';
import { useEditorStore } from '@/stores/useEditorStore';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { usePagesStore } from '@/stores/usePagesStore';
import { resetBindingsAfterMove } from '@/lib/layer-utils';
import { useLayerLocks } from '@/hooks/use-layer-locks';
import type { Layer } from '@/types';
import type { UseLiveLayerUpdatesReturn } from '@/hooks/use-live-layer-updates';
import type { UseLiveComponentUpdatesReturn } from '@/hooks/use-live-component-updates';
import { PanelControls } from './RailPanel';

export interface NavigatorPanelProps {
  onLayerSelect: (layerId: string | null) => void;
  currentPageId: string | null;
  liveLayerUpdates?: UseLiveLayerUpdatesReturn | null;
  liveComponentUpdates?: UseLiveComponentUpdatesReturn | null;
  readOnly?: boolean;
  /**
   * Visible width of the panel (pinned width or flyout width) for `--tree-available-width` and
   * the tree's row width (`LayersTree` prop `availableWidth`; the store's `leftSidebarWidth`
   * is the whole left stack and would make the rows overflow the panel).
   */
  panelWidth: number;
  /** Whether the Add flyout is open (rotates the `+`). */
  addOpen: boolean;
  onToggleAdd: () => void;
  /** Pin / close buttons in the header row (primitives so the memoized panel stays stable). */
  pinned: boolean;
  onPin: () => void;
  onClose: () => void;
  closeLabel: string;
}

/**
 * Layer tree of the current page or component variant. Logic mirrors the Layers tab of the
 * upstream `LeftSidebar.tsx` (lock-aware select, reorder with binding reset, draft loading,
 * adjacent-page preload, component variants).
 */
function NavigatorPanel({
  onLayerSelect,
  currentPageId,
  liveLayerUpdates,
  liveComponentUpdates,
  readOnly = false,
  panelWidth,
  addOpen,
  onToggleAdd,
  pinned,
  onPin,
  onClose,
  closeLabel,
}: NavigatorPanelProps) {
  const currentDraft = usePagesStore((state) => currentPageId ? state.draftsByPageId[currentPageId] : null);
  const loadDraft = usePagesStore((state) => state.loadDraft);
  const setDraftLayers = usePagesStore((state) => state.setDraftLayers);
  const pages = usePagesStore((state) => state.pages);

  const editingComponentId = useEditorStore((state) => state.editingComponentId);
  const editingComponentVariantId = useEditorStore((state) => state.editingComponentVariantId);
  const setEditingComponentVariantId = useEditorStore((state) => state.setEditingComponentVariantId);

  const componentDrafts = useComponentsStore((state) => state.componentDrafts);
  const updateComponentDraft = useComponentsStore((state) => state.updateComponentDraft);
  const addVariant = useComponentsStore((state) => state.addVariant);
  const renameVariant = useComponentsStore((state) => state.renameVariant);
  const duplicateVariant = useComponentsStore((state) => state.duplicateVariant);
  const deleteVariant = useComponentsStore((state) => state.deleteVariant);
  const reorderVariants = useComponentsStore((state) => state.reorderVariants);

  const editingComponent = useComponentsStore((state) =>
    editingComponentId ? state.components.find((c) => c.id === editingComponentId) ?? null : null
  );

  const layerLocks = useLayerLocks();
  const layerLocksRef = useRef(layerLocks);
  layerLocksRef.current = layerLocks;

  const handleLayerSelect = useCallback((layerId: string) => {
    const locks = layerLocksRef.current;
    if (locks.isLayerLocked(layerId) && !locks.canEditLayer(layerId)) {
      console.warn(`Layer ${layerId} is locked by another user - cannot select`);
      return;
    }
    onLayerSelect(layerId);
  }, [onLayerSelect]);

  const activeComponentVariantId = useMemo(() => {
    if (!editingComponentId) return null;
    const drafts = componentDrafts[editingComponentId];
    if (!drafts) return editingComponentVariantId || null;
    if (editingComponentVariantId && drafts[editingComponentVariantId]) return editingComponentVariantId;
    return Object.keys(drafts)[0] || null;
  }, [editingComponentId, editingComponentVariantId, componentDrafts]);

  const layersForCurrentPage = useMemo(() => {
    if (editingComponentId && activeComponentVariantId) {
      return componentDrafts[editingComponentId]?.[activeComponentVariantId] || [];
    }
    if (!currentPageId) return [];
    return currentDraft ? currentDraft.layers : [];
  }, [editingComponentId, activeComponentVariantId, componentDrafts, currentPageId, currentDraft]);

  const handleLayersReorder = useCallback((newLayers: Layer[], movedLayerId?: string) => {
    let layers = newLayers;
    if (movedLayerId) layers = resetBindingsAfterMove(layers, movedLayerId);
    if (editingComponentId && activeComponentVariantId) {
      updateComponentDraft(editingComponentId, activeComponentVariantId, layers);
      return;
    }
    if (!currentPageId) return;
    setDraftLayers(currentPageId, layers);
  }, [editingComponentId, activeComponentVariantId, updateComponentDraft, currentPageId, setDraftLayers]);

  // Load the draft when the page changes (only if not already in the store).
  useEffect(() => {
    if (currentPageId && !currentDraft) {
      startTransition(() => {
        loadDraft(currentPageId);
      });
    }
  }, [currentPageId, loadDraft, currentDraft]);

  // Preload adjacent page drafts in the background for instant navigation.
  useEffect(() => {
    if (!currentPageId || pages.length === 0) return;
    const currentIndex = pages.findIndex((p) => p.id === currentPageId);
    if (currentIndex === -1) return;
    const adjacentPages = pages
      .slice(Math.max(0, currentIndex - 2), Math.min(pages.length, currentIndex + 3))
      .filter((p) => p.id !== currentPageId);

    const preloadDrafts = () => {
      const allDrafts = usePagesStore.getState().draftsByPageId;
      adjacentPages.filter((p) => !allDrafts[p.id]).forEach((page, index) => {
        setTimeout(() => {
          if (!usePagesStore.getState().draftsByPageId[page.id]) loadDraft(page.id);
        }, index * 100);
      });
    };

    if ('requestIdleCallback' in window) {
      const idleCallbackId = requestIdleCallback(preloadDrafts, { timeout: 2000 });
      return () => cancelIdleCallback(idleCallbackId);
    }
    const timeoutId = setTimeout(preloadDrafts, 500);
    return () => clearTimeout(timeoutId);
  }, [currentPageId, pages, loadDraft]);

  const title = editingComponentId && editingComponent ? editingComponent.name : 'Layers';

  return (
    <div className="flex flex-col flex-1 min-h-0 px-4">
      {editingComponentId && editingComponent && (
        <ComponentVariantsSection
          component={editingComponent}
          activeVariantId={activeComponentVariantId}
          onSelectVariant={(variantId) => {
            if (variantId === activeComponentVariantId) return;
            setEditingComponentVariantId(variantId);
            const drafts = componentDrafts[editingComponentId];
            const layersForVariant = drafts?.[variantId]
              ?? editingComponent.variants?.find((v) => v.id === variantId)?.layers
              ?? [];
            onLayerSelect(layersForVariant[0]?.id ?? null);
          }}
          onAddVariant={async () => {
            const newId = await addVariant(editingComponentId, activeComponentVariantId);
            if (newId) setEditingComponentVariantId(newId);
          }}
          onRenameVariant={(variantId, name) => renameVariant(editingComponentId, variantId, name)}
          onDuplicateVariant={async (variantId) => {
            const newId = await duplicateVariant(editingComponentId, variantId);
            if (newId) setEditingComponentVariantId(newId);
          }}
          onReorderVariants={(orderedIds) => reorderVariants(editingComponentId, orderedIds)}
          onDeleteVariant={async (variantId) => {
            const wasActive = variantId === activeComponentVariantId;
            await deleteVariant(editingComponentId, variantId);
            const updated = useComponentsStore.getState().getComponentById(editingComponentId);
            const stillExists = updated?.variants?.some((v) => v.id === variantId);
            if (wasActive && !stillExists) {
              const fallback = updated?.variants?.[0]?.id ?? null;
              setEditingComponentVariantId(fallback);
              const drafts = useComponentsStore.getState().componentDrafts[editingComponentId];
              const fallbackLayers = fallback && drafts?.[fallback]
                ? drafts[fallback]
                : updated?.variants?.[0]?.layers ?? [];
              onLayerSelect(fallbackLayers[0]?.id ?? null);
            }
          }}
        />
      )}
      <header className="py-5 flex justify-between items-center shrink-0 z-20">
        <span
          tabIndex={-1} data-panel-title
          className="font-medium truncate outline-none"
        >{title}</span>
        <div className="flex items-center gap-1">
          {!readOnly && (
            <div className="-my-1">
              <Button
                size="xs" variant="secondary"
                aria-label="Add element (A)" aria-pressed={addOpen}
                onClick={onToggleAdd}
              >
                <Icon name="plus" className={`${addOpen ? 'rotate-45' : 'rotate-0'} transition-transform duration-100`} />
              </Button>
            </div>
          )}
          <PanelControls
            pinnable
            pinned={pinned}
            onPin={onPin}
            onClose={onClose}
            closeLabel={closeLabel}
          />
        </div>
      </header>

      <div
        className="flex flex-col flex-1 min-h-0 overflow-y-auto overflow-x-auto no-scrollbar"
        style={{ '--tree-available-width': `${panelWidth - 33}px` } as React.CSSProperties}
      >
        {!currentPageId && !editingComponentId ? (
          <Empty>
            <EmptyTitle>No page selected</EmptyTitle>
            <EmptyDescription>Select a page from the Pages panel to start building</EmptyDescription>
          </Empty>
        ) : layersForCurrentPage.length === 0 ? (
          <Empty>
            <EmptyTitle>No layers yet</EmptyTitle>
            <EmptyDescription>Click the + button above to add your first block</EmptyDescription>
          </Empty>
        ) : (
          <LayersTree
            layers={layersForCurrentPage}
            onLayerSelect={handleLayerSelect}
            onReorder={handleLayersReorder}
            pageId={currentPageId || ''}
            liveLayerUpdates={liveLayerUpdates}
            liveComponentUpdates={liveComponentUpdates}
            readOnly={readOnly}
            availableWidth={panelWidth}
          />
        )}
      </div>
    </div>
  );
}

export default React.memo(NavigatorPanel);

'use client';

import React, { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import ComponentCard from '../ComponentCard';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { usePagesStore } from '@/stores/usePagesStore';
import { canHaveChildren } from '@/lib/layer-utils';
import { checkCircularReference, isCircularComponentReference } from '@/lib/component-utils';
import { generateId } from '@/lib/utils';
import type { Layer } from '@/types';
import type { UseLiveLayerUpdatesReturn } from '@/hooks/use-live-layer-updates';

export interface ComponentsPanelProps {
  search: string;
  currentPageId: string | null;
  liveLayerUpdates?: UseLiveLayerUpdatesReturn | null;
  /** False off design routes and for read-only roles: rows then only open the editor. */
  canInsert: boolean;
  onOpenComponent: (componentId: string) => void;
  /** Called after an instance was inserted or a canvas drag started (closes the flyout). */
  onInserted: () => void;
}

type LayerWithParent = { layer: Layer; parent: Layer | null };

function findLayerWithParent(tree: Layer[], id: string, parent: Layer | null = null): LayerWithParent | null {
  for (const node of tree) {
    if (node.id === id) return { layer: node, parent };
    if (node.children) {
      const found = findLayerWithParent(node.children, id, node);
      if (found) return found;
    }
  }
  return null;
}

function updateLayerInTree(tree: Layer[], layerId: string, updater: (layer: Layer) => Layer): Layer[] {
  return tree.map((node) => {
    if (node.id === layerId) return updater(node);
    if (node.children && node.children.length > 0) {
      return { ...node, children: updateLayerInTree(node.children, layerId, updater) };
    }
    return node;
  });
}

/**
 * Inserts `instance` relative to `parentId`: as the last child when the target can hold
 * children, otherwise right after it. Same rules as the Components tab of the upstream
 * ElementLibrary.
 */
function insertInstance(layers: Layer[], parentId: string, instance: Layer): { layers: Layer[]; parentToExpand: string | null } {
  const result = findLayerWithParent(layers, parentId);
  if (!result) return { layers: [...layers, instance], parentToExpand: null };
  if (canHaveChildren(result.layer)) {
    return {
      layers: updateLayerInTree(layers, parentId, (parent) => ({ ...parent, children: [...(parent.children || []), instance] })),
      parentToExpand: parentId,
    };
  }
  if (result.parent) {
    return {
      layers: updateLayerInTree(layers, result.parent.id, (grandparent) => {
        const children = grandparent.children || [];
        const selectedIndex = children.findIndex((c) => c.id === parentId);
        const newChildren = [...children];
        newChildren.splice(selectedIndex + 1, 0, instance);
        return { ...grandparent, children: newChildren };
      }),
      parentToExpand: result.parent.id,
    };
  }
  const selectedIndex = layers.findIndex((l) => l.id === parentId);
  const newLayers = [...layers];
  newLayers.splice(selectedIndex + 1, 0, instance);
  return { layers: newLayers, parentToExpand: null };
}

/**
 * All components. Click (or drag onto the canvas) inserts an instance where the
 * ElementLibrary would; the pencil opens the component editor.
 */
function ComponentsPanel({
  search,
  currentPageId,
  liveLayerUpdates,
  canInsert,
  onOpenComponent,
  onInserted,
}: ComponentsPanelProps) {
  const components = useComponentsStore((state) => state.components);
  const editingComponentId = useEditorStore((state) => state.editingComponentId);
  const editingComponentVariantId = useEditorStore((state) => state.editingComponentVariantId);
  const startCanvasDrag = useEditorStore((state) => state.startCanvasDrag);

  const query = search.trim().toLowerCase();
  const visible = useMemo(
    () => components.filter((c) => !query || c.name.toLowerCase().includes(query)),
    [components, query],
  );

  // Components that would nest the component being edited inside itself.
  const circularIds = useMemo(() => {
    if (!editingComponentId) return new Set<string>();
    return new Set(components.filter((c) => isCircularComponentReference(editingComponentId, c.id, components)).map((c) => c.id));
  }, [editingComponentId, components]);

  const resolveVariantId = useCallback((): string | null => {
    if (!editingComponentId) return null;
    const drafts = useComponentsStore.getState().componentDrafts[editingComponentId];
    if (!drafts) return editingComponentVariantId || null;
    if (editingComponentVariantId && drafts[editingComponentVariantId]) return editingComponentVariantId;
    return Object.keys(drafts)[0] || null;
  }, [editingComponentId, editingComponentVariantId]);

  const handleAddComponent = useCallback((componentId: string) => {
    if (!canInsert) {
      onOpenComponent(componentId);
      return;
    }
    const editor = useEditorStore.getState();
    const selectedLayerId = editor.selectedLayerId;
    const allComponents = useComponentsStore.getState().components;
    const component = allComponents.find((c) => c.id === componentId);
    if (!component) return;

    const instance: Layer = {
      id: generateId('lyr'),
      name: 'div',
      customName: component.name,
      componentId: component.id,
      classes: ['block'],
      children: [],
    };

    // Component-edit mode: insert into the active variant's draft.
    const activeVariantId = resolveVariantId();
    if (editingComponentId && activeVariantId) {
      const circularError = checkCircularReference(editingComponentId, instance, allComponents);
      if (circularError) {
        toast.error('Infinite component loop detected', { description: circularError });
        return;
      }
      const layers = useComponentsStore.getState().componentDrafts[editingComponentId]?.[activeVariantId] || [];
      const parentId = selectedLayerId || layers[0]?.id;
      if (!parentId) return;
      const { layers: newLayers, parentToExpand } = insertInstance(layers, parentId, instance);
      useComponentsStore.getState().updateComponentDraft(editingComponentId, activeVariantId, newLayers);
      editor.setSelectedLayerId(instance.id);
      if (parentToExpand) window.dispatchEvent(new CustomEvent('expandLayer', { detail: { layerId: parentToExpand } }));
      onInserted();
      return;
    }

    // Page mode.
    if (!currentPageId) return;
    const draft = usePagesStore.getState().draftsByPageId[currentPageId];
    if (!draft) return;
    const parentId = selectedLayerId || 'body';
    const { layers: newLayers, parentToExpand } = insertInstance(draft.layers, parentId, instance);
    usePagesStore.getState().setDraftLayers(currentPageId, newLayers);
    if (liveLayerUpdates) {
      const found = findLayerWithParent(newLayers, instance.id);
      liveLayerUpdates.broadcastLayerAdd(currentPageId, found?.parent?.id || null, `component:${componentId}`, instance);
    }
    editor.setSelectedLayerId(instance.id);
    if (parentToExpand) window.dispatchEvent(new CustomEvent('expandLayer', { detail: { layerId: parentToExpand } }));
    onInserted();
  }, [canInsert, onOpenComponent, editingComponentId, resolveVariantId, currentPageId, liveLayerUpdates, onInserted]);

  // Mouse down: moving past 5 px starts a canvas drag (dropped by CenterCanvas), a plain click inserts.
  const handleMouseDown = useCallback((e: React.MouseEvent, componentId: string, name: string) => {
    if (e.button !== 0) return;
    if (circularIds.has(componentId)) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!dragging && Math.sqrt(dx * dx + dy * dy) > 5) {
        dragging = true;
        startCanvasDrag(componentId, 'components', name, { x: moveEvent.clientX, y: moveEvent.clientY });
        onInserted();
      }
    };
    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (!dragging) handleAddComponent(componentId);
      dragging = false;
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [circularIds, startCanvasDrag, onInserted, handleAddComponent]);

  if (components.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-4">
        <Empty>
          <EmptyTitle>No components yet</EmptyTitle>
          <EmptyDescription>Right-click a layer and select &quot;Create component&quot; to make it reusable</EmptyDescription>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-4 py-3" data-webwow-components-panel>
      <p className="text-[11px] text-muted-foreground pb-3">
        {canInsert
          ? 'Click a component to insert an instance, or drag it onto the canvas.'
          : 'Open a page to insert instances. Click a component to edit it.'}
      </p>
      {visible.length === 0 && (
        <Empty>
          <EmptyMedia variant="icon"><Icon name="component" className="size-4" /></EmptyMedia>
          <EmptyTitle>No matching components</EmptyTitle>
        </Empty>
      )}
      <div className="grid grid-cols-1 gap-1.5 pb-5">
        {visible.map((component) => {
          const circular = circularIds.has(component.id);
          return (
            <ComponentCard
              key={component.id}
              component={component}
              className={circular ? 'opacity-40' : undefined}
              disabled={circular}
              onClick={canInsert ? undefined : () => onOpenComponent(component.id)}
              onMouseDown={canInsert ? (e) => handleMouseDown(e, component.id, component.name) : undefined}
              actions={(
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Edit ${component.name}`}
                      data-webwow-edit-component={component.id}
                      className="shrink-0 opacity-60 hover:opacity-100"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onOpenComponent(component.id); }}
                    >
                      <Icon name="pencil" className="size-3!" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">Edit component</TooltipContent>
                </Tooltip>
              )}
            />
          );
        })}
      </div>
    </div>
  );
}

export default React.memo(ComponentsPanel);

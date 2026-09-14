'use client';

/**
 * Select Options Settings Component
 *
 * Settings panel for managing <select> element options.
 * Options can come from a static list (manually defined) or from a collection
 * (each item becomes an option with value=itemId, label=displayField).
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';

import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger, PopoverAnchor } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import Icon from '@/components/ui/icon';
import { Empty, EmptyDescription } from '@/components/ui/empty';
import SettingsPanel from './SettingsPanel';
import ToggleGroup from './ToggleGroup';

import { generateId } from '@/lib/utils';
import { useCollectionsStore } from '@/stores/useCollectionsStore';
import { collectionsApi } from '@/lib/api';
import { findDisplayField, getItemDisplayName } from '@/lib/collection-field-utils';
import { toast } from 'sonner';

import type { Layer, CollectionItemWithValues } from '@/types';

function isCheckboxWrapperLayer(layer: Layer | null): boolean {
  if (!layer || layer.name !== 'div') return false;
  return !!layer.children?.some(
    (c) => c.name === 'input' && c.attributes?.type === 'checkbox'
  );
}

function isRadioWrapperLayer(layer: Layer | null): boolean {
  if (!layer || layer.name !== 'div') return false;
  return !!layer.children?.some(
    (c) => c.name === 'input' && c.attributes?.type === 'radio'
  );
}

interface SelectOptionsSettingsProps {
  layer: Layer | null;
  onLayerUpdate: (layerId: string, updates: Partial<Layer>) => void;
}

interface OptionData {
  id: string;
  label: string;
  value: string;
}

const SOURCE_SORT_BY = '__source_sort_by__';
const SOURCE_SORT_ORDER = '__source_sort_order__';

const SORT_ORDER_PRESET_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'Ascending', value: 'asc' },
  { label: 'Descending', value: 'desc' },
];

const EMPTY_FIELDS: never[] = [];

/**
 * Check if an option child is the placeholder option
 */
function isPlaceholderOption(child: Layer): boolean {
  return !!child.settings?.isPlaceholder;
}

/**
 * Extract the placeholder text from a select layer's placeholder option child
 */
function getPlaceholderText(layer: Layer): string {
  const placeholder = layer.children?.find(
    (child) => child.name === 'option' && isPlaceholderOption(child)
  );
  if (!placeholder) return '';
  const textVar = placeholder.variables?.text;
  if (textVar?.type === 'dynamic_text' && textVar.data?.content) {
    return String(textVar.data.content);
  }
  return '';
}

/**
 * Extract option data from select layer children (excludes placeholder)
 */
function getOptionsFromLayer(layer: Layer): OptionData[] {
  if (!layer.children || layer.children.length === 0) return [];

  return layer.children
    .filter((child) => child.name === 'option' && !isPlaceholderOption(child))
    .map((child) => {
      const textVar = child.variables?.text;
      let label = '';

      if (textVar?.type === 'dynamic_text' && textVar.data?.content) {
        label = String(textVar.data.content);
      } else if (textVar?.type === 'dynamic_rich_text' && textVar.data?.content) {
        label = String(textVar.data.content);
      }

      return {
        id: child.id,
        label,
        value: child.attributes?.value || '',
      };
    });
}

function isSortOrderPreset(options: OptionData[]): boolean {
  if (options.length !== SORT_ORDER_PRESET_OPTIONS.length) return false;
  const values = options.map((o) => o.value);
  return SORT_ORDER_PRESET_OPTIONS.every((preset) => values.includes(preset.value));
}

/**
 * Build an option layer from label and value
 */
function buildOptionLayer(id: string, label: string, value: string): Layer {
  return {
    id,
    name: 'option',
    classes: '',
    attributes: { value },
    variables: {
      text: {
        type: 'dynamic_text',
        data: {
          content: label,
        },
      },
    },
  };
}

/**
 * Build a placeholder option layer (value="", selectable to clear selection)
 */
function buildPlaceholderOption(id: string, text: string): Layer {
  return {
    id,
    name: 'option',
    classes: '',
    attributes: { value: '' },
    settings: { isPlaceholder: true },
    variables: {
      text: {
        type: 'dynamic_text',
        data: { content: text },
      },
    },
  };
}

/**
 * Dropdown menu + edit popover for a single option row.
 * DropdownMenu for quick actions, Popover for the edit form.
 * Uses PopoverAnchor (not PopoverTrigger) to avoid Radix focus/click conflicts
 * when the dropdown closes and restores focus to the trigger area.
 */
function OptionActions({
  option,
  onEdit,
  onRemove,
}: {
  option: OptionData;
  onEdit: (id: string, label: string, value: string) => void;
  onRemove: (id: string) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [editLabel, setEditLabel] = useState('');
  const [editValue, setEditValue] = useState('');

  const handleStartEdit = () => {
    setEditLabel(option.label);
    setEditValue(option.value);
    // Delay opening the popover until the dropdown has fully closed
    setTimeout(() => setEditOpen(true), 150);
  };

  const handleSave = () => {
    if (!editLabel.trim()) return;
    onEdit(option.id, editLabel.trim(), editValue);
    setEditOpen(false);
  };

  return (
    <>
      <Popover
        open={editOpen}
        onOpenChange={(open) => {
          if (!open) {
            setEditOpen(false);
            setEditLabel('');
            setEditValue('');
          }
        }}
      >
        <PopoverAnchor asChild>
          <div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                >
                  <Icon name="more" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={handleStartEdit}>
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onRemove(option.id)}>
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </PopoverAnchor>
        <PopoverContent
          className="w-64"
          align="end"
          onFocusOutside={(e) => {
            // Prevent Radix from closing the popover when focus is outside
            // (e.g., focus still on the ... button when popover first opens).
            // Clicking outside still closes via onPointerDownOutside.
            e.preventDefault();
          }}
        >
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-3">
              <Label variant="muted">Label</Label>
              <div className="col-span-2 *:w-full">
                <Input
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  placeholder="Option label"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleSave();
                    }
                  }}
                />
              </div>
            </div>

            <div className="grid grid-cols-3">
              <Label>Value</Label>
              <div className="col-span-2 *:w-full">
                <Input
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  placeholder="Option value"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleSave();
                    }
                  }}
                />
              </div>
            </div>

            <Button
              onClick={handleSave}
              disabled={!editLabel.trim()}
              size="sm"
              variant="secondary"
            >
              Save option
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

/**
 * Sortable option row with drag handle, label/value display, and actions menu.
 * Only the grip icon is the drag handle to avoid conflicts with interactive elements.
 */
function SortableOptionItem({
  option,
  onEdit,
  onRemove,
}: {
  option: OptionData;
  onEdit: (id: string, label: string, value: string) => void;
  onRemove: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: option.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center justify-between pr-1 h-8 bg-muted text-muted-foreground rounded-lg"
    >
      <div className="flex items-center gap-1 min-w-0 flex-1">
        <button
          type="button"
          className="flex items-center justify-center shrink-0 w-6 h-8 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground"
          {...attributes}
          {...listeners}
        >
          <Icon
            name="grip-vertical"
            className="size-3"
          />
        </button>
        <span className="truncate text-xs">
          {option.label}
          {option.value && (
            <span className="opacity-50"> = &quot;{option.value}&quot;</span>
          )}
        </span>
      </div>

      <OptionActions
        option={option}
        onEdit={onEdit}
        onRemove={onRemove}
      />
    </div>
  );
}

export default function SelectOptionsSettings({
  layer,
  onLayerUpdate,
}: SelectOptionsSettingsProps) {
  const SOURCE_ITEMS_PAGE_SIZE = 200;
  const [isOpen, setIsOpen] = useState(true);
  const [showAddPopover, setShowAddPopover] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newValue, setNewValue] = useState('');

  const { collections, fields, loadFields } = useCollectionsStore();

  const isSelectLayer = layer?.name === 'select';
  const isCheckboxWrapper = isCheckboxWrapperLayer(layer);
  const isRadioWrapper = isRadioWrapperLayer(layer);
  const optionsSource = layer?.settings?.optionsSource;
  const isCollectionSource = !!optionsSource?.collectionId;
  const explicitOptionsMode = layer?.settings?.selectOptionsMode;
  const sourceCollectionFields = isCollectionSource
    ? (fields[optionsSource!.collectionId] || [])
    : [];

  const options = isSelectLayer && layer && !isCollectionSource ? getOptionsFromLayer(layer) : [];
  const sourceValue = isCollectionSource
    ? optionsSource!.collectionId
    : explicitOptionsMode === 'sort_by'
      ? SOURCE_SORT_BY
      : explicitOptionsMode === 'sort_order'
        ? SOURCE_SORT_ORDER
        : isSortOrderPreset(options)
          ? SOURCE_SORT_ORDER
          : options.length > 0
            ? 'list'
            : 'none';
  const isSortOrderMode = sourceValue === SOURCE_SORT_ORDER;
  const isSortByMode = sourceValue === SOURCE_SORT_BY;

  const placeholderText = isSelectLayer && layer ? getPlaceholderText(layer) : '';

  const sortByCollectionId = layer?.settings?.sortByCollectionId;
  const rawSortByFieldIds = layer?.settings?.sortByFieldIds;
  const sortByFieldIds = useMemo(() => rawSortByFieldIds || [], [rawSortByFieldIds]);
  const rawSortByFields = sortByCollectionId ? fields[sortByCollectionId] : undefined;
  const sortByCollectionFields = useMemo(() => rawSortByFields || EMPTY_FIELDS, [rawSortByFields]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    })
  );

  const handleSourceChange = useCallback((value: string) => {
    if (!layer) return;

    if (value === 'none' && (isCheckboxWrapper || isRadioWrapper)) {
      autoBindAppliedForRef.current = null;
      const { optionsSource: _, sortByCollectionId: _sb, sortByFieldIds: _sf, selectOptionsMode: _sm, ...restSettings } = layer.settings || {};
      const textChild = layer.children?.find(c => c.name === 'text');
      if (textChild) {
        onLayerUpdate(textChild.id, {
          variables: { ...textChild.variables, text: { type: 'dynamic_text' as const, data: { content: isRadioWrapper ? 'Radio label' : 'Checkbox label' } } },
        });
      }
      onLayerUpdate(layer.id, {
        settings: { ...restSettings, tag: 'label' },
        variables: { ...layer.variables, collection: undefined },
      });
      return;
    }

    if (value === 'none' || value === 'list') {
      const { optionsSource: _, sortByCollectionId: _sb, sortByFieldIds: _sf, ...restSettings } = layer.settings || {};
      onLayerUpdate(layer.id, {
        settings: {
          ...restSettings,
          selectOptionsMode: value === 'list' ? 'list' : undefined,
        },
      });
    } else if (value === SOURCE_SORT_BY) {
      const { optionsSource: _, sortByCollectionId: _sb, sortByFieldIds: _sf, ...restSettings } = layer.settings || {};
      onLayerUpdate(layer.id, {
        settings: {
          ...restSettings,
          selectOptionsMode: 'sort_by',
        },
        children: [buildOptionLayer(generateId('lyr'), 'None', 'none')],
      });
    } else if (value === SOURCE_SORT_ORDER) {
      const { optionsSource: _, sortByCollectionId: _sb, sortByFieldIds: _sf, ...restSettings } = layer.settings || {};
      onLayerUpdate(layer.id, {
        settings: {
          ...restSettings,
          selectOptionsMode: 'sort_order',
        },
        children: SORT_ORDER_PRESET_OPTIONS.map((opt, idx) => buildOptionLayer(`${layer.id}-preset-${idx}-${generateId('opt')}`, opt.label, opt.value)),
      });
    } else if (isCheckboxWrapper || isRadioWrapper) {
      const { sortByCollectionId: _sb, sortByFieldIds: _sf, ...restSettings } = layer.settings || {};
      onLayerUpdate(layer.id, {
        settings: {
          ...restSettings,
          selectOptionsMode: undefined,
          optionsSource: { collectionId: value },
        },
        variables: { ...layer.variables, collection: { id: value } },
      });
    } else {
      const { sortByCollectionId: _sb, sortByFieldIds: _sf, ...restSettings } = layer.settings || {};
      onLayerUpdate(layer.id, {
        settings: {
          ...restSettings,
          selectOptionsMode: undefined,
          optionsSource: { collectionId: value },
        },
      });
    }
  }, [layer, isCheckboxWrapper, isRadioWrapper, onLayerUpdate]);

  const handlePlaceholderChange = useCallback((text: string) => {
    if (!layer) return;
    const currentChildren = layer.children || [];
    const withoutPlaceholder = currentChildren.filter((c) => !isPlaceholderOption(c));

    if (text.trim()) {
      const existing = currentChildren.find((c) => isPlaceholderOption(c));
      const placeholderId = existing?.id || generateId('lyr');
      onLayerUpdate(layer.id, {
        children: [buildPlaceholderOption(placeholderId, text), ...withoutPlaceholder],
      });
    } else {
      onLayerUpdate(layer.id, { children: withoutPlaceholder });
    }
  }, [layer, onLayerUpdate]);

  const handleSortByCollectionChange = useCallback((collectionId: string) => {
    if (!layer) return;
    onLayerUpdate(layer.id, {
      settings: {
        ...layer.settings,
        sortByCollectionId: collectionId === 'none' ? undefined : collectionId,
        sortByFieldIds: undefined,
      },
    });
  }, [layer, onLayerUpdate]);

  const handleToggleSortByField = useCallback((fieldId: string) => {
    if (!layer) return;
    const current = layer.settings?.sortByFieldIds || [];
    const next = current.includes(fieldId)
      ? current.filter((id) => id !== fieldId)
      : [...current, fieldId];
    onLayerUpdate(layer.id, {
      settings: {
        ...layer.settings,
        sortByFieldIds: next.length > 0 ? next : undefined,
      },
    });
  }, [layer, onLayerUpdate]);

  // Load fields for collection-sourced options
  useEffect(() => {
    if (!isCollectionSource || !optionsSource?.collectionId) return;
    if (sourceCollectionFields.length > 0) return;
    let cancelled = false;
    if (!cancelled) loadFields(optionsSource.collectionId);
    return () => { cancelled = true; };
  }, [isCollectionSource, optionsSource?.collectionId, sourceCollectionFields.length, loadFields]);

  // Load fields for sort-by collection
  useEffect(() => {
    if (!isSortByMode || !sortByCollectionId) return;
    if (sortByCollectionFields.length > 0) return;
    let cancelled = false;
    if (!cancelled) loadFields(sortByCollectionId);
    return () => { cancelled = true; };
  }, [isSortByMode, sortByCollectionId, sortByCollectionFields.length, loadFields]);

  const patchOptionsSource = useCallback((patch: Record<string, any>) => {
    if (!layer || !optionsSource?.collectionId) return;
    onLayerUpdate(layer.id, {
      settings: {
        ...layer.settings,
        optionsSource: { ...optionsSource, ...patch },
      },
    });
  }, [layer, onLayerUpdate, optionsSource]);

  const handleDefaultItemChange = useCallback((value: string) => {
    patchOptionsSource({ defaultItemId: value === 'none' ? undefined : value });
  }, [patchOptionsSource]);

  const handleToggleDefaultCheckboxItem = useCallback((itemId: string) => {
    const current = optionsSource?.defaultItemIds || [];
    const updated = current.includes(itemId)
      ? current.filter(id => id !== itemId)
      : [...current, itemId];
    patchOptionsSource({ defaultItemIds: updated.length > 0 ? updated : undefined });
  }, [patchOptionsSource, optionsSource?.defaultItemIds]);

  const handleSortFieldChange = useCallback((value: string) => {
    patchOptionsSource({ sortFieldId: value === 'none' ? undefined : value, sortOrder: value === 'none' ? undefined : (optionsSource?.sortOrder || 'asc') });
  }, [patchOptionsSource, optionsSource?.sortOrder]);

  const handleSortOrderChange = useCallback((value: string | boolean) => {
    patchOptionsSource({ sortOrder: value as 'asc' | 'desc' });
  }, [patchOptionsSource]);

  const handleSortOrderDefaultChange = useCallback((value: string) => {
    if (!layer) return;
    const { value: _omit, ...restAttrs } = layer.attributes || {};
    onLayerUpdate(layer.id, {
      attributes: value === 'none' ? restAttrs : { ...restAttrs, value },
    });
  }, [layer, onLayerUpdate]);

  // Fetch collection items for the Default picker (paged)
  const [sourceItems, setSourceItems] = useState<CollectionItemWithValues[]>([]);
  const [sourceItemsOffset, setSourceItemsOffset] = useState(0);
  const [sourceItemsHasMore, setSourceItemsHasMore] = useState(false);
  const [sourceItemsLoading, setSourceItemsLoading] = useState(false);
  const [sourceItemsLoadingMore, setSourceItemsLoadingMore] = useState(false);

  const fetchSourceItems = useCallback(async (params: { reset: boolean; offset: number }) => {
    if (!isCollectionSource || !optionsSource?.collectionId) return;

    const { reset, offset } = params;
    const requestOffset = reset ? 0 : offset;

    if (reset) {
      setSourceItemsLoading(true);
    } else {
      setSourceItemsLoadingMore(true);
    }

    try {
      const res = await collectionsApi.getItems(optionsSource.collectionId, {
        limit: SOURCE_ITEMS_PAGE_SIZE,
        offset: requestOffset,
      });
      if (res.error) throw new Error(res.error);

      const batch = res.data?.items || [];
      const total = res.data?.total || 0;
      setSourceItems((prev) => {
        const merged = reset
          ? batch
          : [...prev, ...batch.filter(item => !prev.some(existing => existing.id === item.id))];
        setSourceItemsHasMore(merged.length < total);
        return merged;
      });
      setSourceItemsOffset(requestOffset + batch.length);
    } catch (error) {
      console.error('Failed to load source collection items:', error);
      toast.error('Failed to load collection options');
      if (reset) {
        setSourceItems([]);
        setSourceItemsOffset(0);
        setSourceItemsHasMore(false);
      }
    } finally {
      setSourceItemsLoading(false);
      setSourceItemsLoadingMore(false);
    }
  }, [isCollectionSource, optionsSource?.collectionId, SOURCE_ITEMS_PAGE_SIZE]);

  useEffect(() => {
    if (!isCollectionSource || !optionsSource?.collectionId) {
      setSourceItems([]);
      setSourceItemsOffset(0);
      setSourceItemsHasMore(false);
      return;
    }
    fetchSourceItems({ reset: true, offset: 0 });
  }, [isCollectionSource, optionsSource?.collectionId, fetchSourceItems]);

  // Preserve currently selected default item even if it is not in the first page.
  useEffect(() => {
    const collectionId = optionsSource?.collectionId;
    const selectedDefaultId = optionsSource?.defaultItemId;
    if (!isCollectionSource || !collectionId || !selectedDefaultId) return;
    if (sourceItems.some(item => item.id === selectedDefaultId)) return;

    let cancelled = false;
    collectionsApi.getItemById(collectionId, selectedDefaultId)
      .then(res => {
        if (cancelled || res.error || !res.data) return;
        setSourceItems(prev => prev.some(item => item.id === res.data!.id) ? prev : [res.data!, ...prev]);
      })
      .catch((error) => {
        console.error('Failed to load selected default item:', error);
      });
    return () => { cancelled = true; };
  }, [isCollectionSource, optionsSource?.collectionId, optionsSource?.defaultItemId, sourceItems]);

  const displayField = findDisplayField(sourceCollectionFields);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      if (!layer || !over || active.id === over.id) return;

      const currentChildren = layer.children || [];
      const oldIndex = currentChildren.findIndex((child) => child.id === active.id);
      const newIndex = currentChildren.findIndex((child) => child.id === over.id);

      if (oldIndex === -1 || newIndex === -1) return;

      const reorderedChildren = arrayMove(currentChildren, oldIndex, newIndex);
      onLayerUpdate(layer.id, { children: reorderedChildren });
    },
    [layer, onLayerUpdate]
  );

  const handleAddOption = useCallback(() => {
    if (!layer || !newLabel.trim()) return;

    const newOption = buildOptionLayer(
      generateId('lyr'),
      newLabel.trim(),
      newValue
    );

    const currentChildren = layer.children || [];
    onLayerUpdate(layer.id, {
      children: [...currentChildren, newOption],
    });

    // Reset form and close popover
    setNewLabel('');
    setNewValue('');
    setShowAddPopover(false);
  }, [layer, newLabel, newValue, onLayerUpdate]);

  const handleEditOption = useCallback(
    (optionId: string, label: string, value: string) => {
      if (!layer) return;

      const currentChildren = layer.children || [];
      const updatedChildren = currentChildren.map((child) => {
        if (child.id === optionId) {
          return buildOptionLayer(child.id, label, value);
        }
        return child;
      });

      onLayerUpdate(layer.id, { children: updatedChildren });
    },
    [layer, onLayerUpdate]
  );

  const handleRemoveOption = useCallback(
    (optionId: string) => {
      if (!layer) return;

      const currentChildren = layer.children || [];
      const updatedChildren = currentChildren.filter(
        (child) => child.id !== optionId
      );

      onLayerUpdate(layer.id, { children: updatedChildren });
    },
    [layer, onLayerUpdate]
  );

  const handleSortOrderLabelChange = useCallback((sortValue: 'asc' | 'desc', label: string) => {
    if (!layer) return;
    const currentChildren = (layer.children || []).filter((child) => child.name === 'option');
    const byValue = new Map<string, Layer>();
    for (const child of currentChildren) {
      byValue.set(String(child.attributes?.value || ''), child);
    }

    const ascLayer = byValue.get('asc') || buildOptionLayer(generateId('lyr'), 'Ascending', 'asc');
    const descLayer = byValue.get('desc') || buildOptionLayer(generateId('lyr'), 'Descending', 'desc');

    const nextAscLabel = sortValue === 'asc' ? label : getOptionsFromLayer({ ...layer, children: [ascLayer] } as Layer)[0]?.label || 'Ascending';
    const nextDescLabel = sortValue === 'desc' ? label : getOptionsFromLayer({ ...layer, children: [descLayer] } as Layer)[0]?.label || 'Descending';

    onLayerUpdate(layer.id, {
      children: [
        buildOptionLayer(ascLayer.id, nextAscLabel, 'asc'),
        buildOptionLayer(descLayer.id, nextDescLabel, 'desc'),
      ],
    });
  }, [layer, onLayerUpdate]);

  // Stable signature of current option children values — used by effects below
  // to avoid re-running on every unrelated layer mutation.
  const currentOptionSignature = useMemo(() => {
    if (!layer) return '';
    return (layer.children || [])
      .filter((c) => c.name === 'option')
      .map((c) => String(c.attributes?.value || ''))
      .join(',');
  }, [layer]);

  // Keep sort-order options structurally fixed: two options with immutable values.
  useEffect(() => {
    if (!layer || !isSortOrderMode) return;
    const optionChildren = (layer.children || []).filter((child) => child.name === 'option');
    const current = optionChildren.map((child) => ({
      id: child.id,
      value: String(child.attributes?.value || ''),
      label: child.variables?.text?.type === 'dynamic_text'
        ? String(child.variables.text.data.content || '')
        : '',
    }));
    const ascExisting = current.find((opt) => opt.value === 'asc');
    const descExisting = current.find((opt) => opt.value === 'desc');
    const needsNormalize =
      current.length !== 2 ||
      !ascExisting ||
      !descExisting ||
      ascExisting.value !== 'asc' ||
      descExisting.value !== 'desc';

    if (!needsNormalize) return;

    onLayerUpdate(layer.id, {
      children: [
        buildOptionLayer(ascExisting?.id || generateId('lyr'), ascExisting?.label || 'Ascending', 'asc'),
        buildOptionLayer(descExisting?.id || generateId('lyr'), descExisting?.label || 'Descending', 'desc'),
      ],
    });
  }, [layer?.id, isSortOrderMode, currentOptionSignature, onLayerUpdate]);

  // Regenerate sort-by option children when field selection or field data changes.
  useEffect(() => {
    if (!layer || !isSortByMode) return;

    const existingValues = currentOptionSignature.split(',');
    const desiredValues = ['none'];
    if (sortByCollectionId && sortByFieldIds.length > 0 && sortByCollectionFields.length > 0) {
      for (const fid of sortByFieldIds) {
        if (sortByCollectionFields.some((f) => f.id === fid)) {
          desiredValues.push(fid);
        }
      }
    }

    if (existingValues.join(',') === desiredValues.join(',')) return;

    const noneChild = buildOptionLayer(`${layer.id}-sort-none`, 'None', 'none');
    const fieldChildren = sortByFieldIds
      .map((fid) => sortByCollectionFields.find((f) => f.id === fid))
      .filter(Boolean)
      .map((field) => buildOptionLayer(`${layer.id}-sbf-${field!.id}`, field!.name, field!.id));

    onLayerUpdate(layer.id, { children: [noneChild, ...fieldChildren] });
  }, [layer?.id, isSortByMode, sortByCollectionId, sortByFieldIds, sortByCollectionFields, currentOptionSignature, onLayerUpdate]);

  // Track which collection has already had its text child auto-bound to prevent re-binding
  const autoBindAppliedForRef = useRef<string | null>(null);

  // Checkbox/radio wrapper: auto-bind text child to the display field once when a collection is first assigned
  const isInputGroupWrapper = isCheckboxWrapper || isRadioWrapper;
  useEffect(() => {
    if (!layer || !isInputGroupWrapper || !isCollectionSource || !displayField) return;
    const collectionId = layer.settings?.optionsSource?.collectionId;
    if (!collectionId || autoBindAppliedForRef.current === collectionId) return;
    const textChild = layer.children?.find(c => c.name === 'text');
    if (!textChild) return;
    if (textChild.variables?.text?.type === 'dynamic_rich_text') {
      autoBindAppliedForRef.current = collectionId;
      return;
    }
    onLayerUpdate(textChild.id, {
      variables: {
        ...textChild.variables,
        text: {
          type: 'dynamic_rich_text' as const,
          data: {
            content: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{
                type: 'dynamicVariable',
                attrs: {
                  variable: { type: 'field', data: { field_id: displayField.id, field_type: displayField.type, relationships: [], source: 'collection', collection_layer_id: layer.id } },
                  label: displayField.name || 'Name',
                },
              }] }],
            },
          },
        },
      },
    });
    autoBindAppliedForRef.current = collectionId;
  }, [layer?.id, isInputGroupWrapper, isCollectionSource, displayField, layer?.children, onLayerUpdate]);

  if (!layer || (!isSelectLayer && !isCheckboxWrapper && !isRadioWrapper)) {
    return null;
  }

  return (
    <SettingsPanel
      title="Options"
      collapsible
      isOpen={isOpen}
      onToggle={() => setIsOpen(!isOpen)}
      action={
        isSelectLayer && !isCollectionSource && !isSortOrderMode && !isSortByMode ? (
          <Popover open={showAddPopover} onOpenChange={setShowAddPopover}>
            <PopoverTrigger asChild>
              <Button
                variant="secondary"
                size="xs"
              >
                <Icon name="plus" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64" align="end">
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-3">
                  <Label variant="muted">Label</Label>
                  <div className="col-span-2 *:w-full">
                    <Input
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                      placeholder="e.g., Option 1"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleAddOption();
                        }
                      }}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3">
                  <Label>Value</Label>
                  <div className="col-span-2 *:w-full">
                    <Input
                      value={newValue}
                      onChange={(e) => setNewValue(e.target.value)}
                      placeholder="e.g., option1"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleAddOption();
                        }
                      }}
                    />
                  </div>
                </div>

                <Button
                  onClick={handleAddOption}
                  disabled={!newLabel.trim()}
                  size="sm"
                  variant="secondary"
                >
                  Add option
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {/* Options source selector */}
        <div className="grid grid-cols-3 items-center">
          <Label variant="muted">Options</Label>
          <div className="col-span-2">
            <Select
              value={sourceValue}
              onValueChange={handleSourceChange}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {isSelectLayer && (
                  <>
                    <SelectItem value="list">
                      <span className="flex items-center gap-2">
                        <Icon name="listUnordered" className="size-3 opacity-60" />
                        List
                      </span>
                    </SelectItem>
                    <SelectGroup>
                      <SelectLabel>Sorting options</SelectLabel>
                      <SelectItem value={SOURCE_SORT_BY}>Sort by</SelectItem>
                      <SelectItem value={SOURCE_SORT_ORDER}>Sort order</SelectItem>
                    </SelectGroup>
                  </>
                )}
                {collections.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Collections</SelectLabel>
                    {collections.map((collection) => (
                      <SelectItem key={collection.id} value={collection.id}>
                        <span className="flex items-center gap-2">
                          <Icon name="database" className="size-3 opacity-60" />
                          {collection.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Placeholder (select only) */}
        {isSelectLayer && (
          <div className="grid grid-cols-3 items-center">
            <Label variant="muted">Placeholder</Label>
            <div className="col-span-2 *:w-full">
              <Input
                value={placeholderText}
                onChange={(e) => handlePlaceholderChange(e.target.value)}
                placeholder="Select an option..."
              />
            </div>
          </div>
        )}

        {/* Collection source settings */}
        {isCollectionSource && (
          <>
            {/* Default item selector */}
            <div className="grid grid-cols-3 items-center">
              <Label variant="muted">Default</Label>
              <div className="col-span-2">
                {isCheckboxWrapper ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline" size="sm"
                        className="w-full justify-between font-normal"
                      >
                        <span className="truncate">
                          {(optionsSource?.defaultItemIds?.length || 0) > 0
                            ? `${optionsSource!.defaultItemIds!.length} selected`
                            : 'None'}
                        </span>
                        <Icon
                          name="chevronDown"
                          className="size-3.5 shrink-0 opacity-50"
                        />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[var(--radix-dropdown-menu-trigger-width)]">
                      {sourceItems.map((item) => (
                        <DropdownMenuCheckboxItem
                          key={item.id}
                          checked={(optionsSource?.defaultItemIds || []).includes(item.id)}
                          onCheckedChange={() => handleToggleDefaultCheckboxItem(item.id)}
                          onSelect={(e) => e.preventDefault()}
                        >
                          {getItemDisplayName(item, displayField)}
                        </DropdownMenuCheckboxItem>
                      ))}
                      {sourceItemsLoading && (
                        <div className="px-2 py-2 text-xs text-muted-foreground">Loading options...</div>
                      )}
                      {!sourceItemsLoading && sourceItems.length === 0 && (
                        <div className="px-2 py-2 text-xs text-muted-foreground">No items found</div>
                      )}
                      {sourceItemsHasMore && (
                        <div className="px-1 py-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="w-full justify-center text-xs"
                            disabled={sourceItemsLoadingMore}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              fetchSourceItems({ reset: false, offset: sourceItemsOffset });
                            }}
                          >
                            {sourceItemsLoadingMore ? 'Loading...' : 'Load more'}
                          </Button>
                        </div>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <Select
                    value={optionsSource?.defaultItemId || 'none'}
                    onValueChange={handleDefaultItemChange}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="none">None</SelectItem>
                      {sourceItems.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {getItemDisplayName(item, displayField)}
                        </SelectItem>
                      ))}
                      {sourceItemsLoading && (
                        <div className="px-2 py-2 text-xs text-muted-foreground">Loading options...</div>
                      )}
                      {!sourceItemsLoading && sourceItems.length === 0 && (
                        <div className="px-2 py-2 text-xs text-muted-foreground">No items found</div>
                      )}
                      {sourceItemsHasMore && (
                        <div className="px-1 py-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="w-full justify-center text-xs"
                            disabled={sourceItemsLoadingMore}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              fetchSourceItems({ reset: false, offset: sourceItemsOffset });
                            }}
                          >
                            {sourceItemsLoadingMore ? 'Loading...' : 'Load more'}
                          </Button>
                        </div>
                      )}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>

            {/* Sorting section divider */}
            <div className="flex items-center gap-2 pt-2">
              <span className="text-xs text-muted-foreground whitespace-nowrap">Sorting</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <div className="grid grid-cols-3 items-center">
              <Label variant="muted">Sort by</Label>
              <div className="col-span-2">
                <Select
                  value={optionsSource?.sortFieldId || 'none'}
                  onValueChange={handleSortFieldChange}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {sourceCollectionFields.map((field) => (
                      <SelectItem key={field.id} value={field.id}>
                        {field.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-3 items-center">
              <Label variant="muted">Order</Label>
              <div className="col-span-2 *:w-full">
                <ToggleGroup
                  options={[
                    { label: 'Ascending', value: 'asc' },
                    { label: 'Descending', value: 'desc' },
                  ]}
                  value={optionsSource?.sortOrder || 'asc'}
                  onChange={handleSortOrderChange}
                />
              </div>
            </div>

          </>
        )}

        {/* Sort-by mode: collection picker + field checklist */}
        {isSortByMode && (
          <>
            <div className="grid grid-cols-3 items-center">
              <Label variant="muted">Collection</Label>
              <div className="col-span-2">
                <Select
                  value={sortByCollectionId || 'none'}
                  onValueChange={handleSortByCollectionChange}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {collections.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        <span className="flex items-center gap-2">
                          <Icon name="database" className="size-3 opacity-60" />
                          {c.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {!sortByCollectionId && (
              <p className="text-[10px] text-muted-foreground leading-tight">
                Choose the collection this select will control sorting for.
              </p>
            )}

            {sortByCollectionId && (
              <>
                <div className="grid grid-cols-3 items-center">

                  <Label variant="muted">Fields</Label>

                  {sortByCollectionFields.length === 0 ? (
                    <div className="text-xs text-muted-foreground px-1 col-span-2">Loading fields...</div>
                  ) : (
                    <div className="col-span-2">
                      <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="input"
                          size="sm"
                          className="w-full justify-between font-normal"
                        >
                          <span className="truncate">
                            {sortByFieldIds.length === 0
                              ? 'Select fields...'
                              : `${sortByFieldIds.length} field${sortByFieldIds.length > 1 ? 's' : ''} selected`}
                          </span>
                          <div className="ml-2">
                            <Icon name="chevronDown" className="size-2.5 opacity-50" />
                          </div>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="w-[var(--radix-dropdown-menu-trigger-width)]">
                        {sortByCollectionFields.map((field) => (
                          <DropdownMenuCheckboxItem
                            key={field.id}
                            checked={sortByFieldIds.includes(field.id)}
                            onCheckedChange={() => handleToggleSortByField(field.id)}
                            onSelect={(e) => e.preventDefault()}
                          >
                            {field.name}
                          </DropdownMenuCheckboxItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    </div>
                  )}

                </div>
              </>
            )}
          </>
        )}

        {/* Static options editor (select only, not when using collection source) */}
        {isSelectLayer && !isCollectionSource && !isSortByMode && (
          <>
            {isSortOrderMode ? (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-3 items-center">
                  <Label variant="muted">Default</Label>
                  <div className="col-span-2">
                    <Select
                      value={(layer?.attributes?.value as string) || 'none'}
                      onValueChange={handleSortOrderDefaultChange}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="asc">
                          {options.find((opt) => opt.value === 'asc')?.label || 'Ascending'}
                        </SelectItem>
                        <SelectItem value="desc">
                          {options.find((opt) => opt.value === 'desc')?.label || 'Descending'}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-3 items-center">
                  <Label variant="muted">Ascending</Label>
                  <div className="col-span-2 *:w-full">
                    <Input
                      value={options.find((opt) => opt.value === 'asc')?.label || 'Ascending'}
                      onChange={(e) => handleSortOrderLabelChange('asc', e.target.value)}
                      placeholder="Ascending"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 items-center">
                  <Label variant="muted">Descending</Label>
                  <div className="col-span-2 *:w-full">
                    <Input
                      value={options.find((opt) => opt.value === 'desc')?.label || 'Descending'}
                      onChange={(e) => handleSortOrderLabelChange('desc', e.target.value)}
                      placeholder="Descending"
                    />
                  </div>
                </div>
              </div>
            ) : options.length > 0 ? (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={options.map((opt) => opt.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="flex flex-col gap-1">
                    {options.map((option) => (
                      <SortableOptionItem
                        key={option.id}
                        option={option}
                        onEdit={handleEditOption}
                        onRemove={handleRemoveOption}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            ) : (
              <Empty>
                <EmptyDescription>Add options for this select element.</EmptyDescription>
              </Empty>
            )}
          </>
        )}
      </div>
    </SettingsPanel>
  );
}

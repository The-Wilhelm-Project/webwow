/**
 * ReferenceFieldCombobox Component
 *
 * A searchable combobox for selecting referenced collection items.
 * Supports both single reference and multi-reference selection.
 */
'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import Icon from '@/components/ui/icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useDebounce } from '@/hooks/use-debounce';
import { collectionsApi } from '@/lib/api';
import { findDisplayField, getItemDisplayName } from '@/lib/collection-field-utils';
import { parseMultiReferenceValue } from '@/lib/collection-utils';
import { useCollectionsStore } from '@/stores/useCollectionsStore';
import { cn } from '@/lib/utils';
import type { CollectionItemWithValues } from '@/types';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';

interface ReferenceFieldComboboxProps {
  /** The collection ID to fetch items from */
  collectionId: string;
  /** Current value - single ID for reference, JSON array string or array for multi_reference */
  value: string | string[];
  /** Callback when value changes */
  onChange: (value: string) => void;
  /** Whether this is a multi-reference field */
  isMulti?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Disabled state */
  disabled?: boolean;
}

export default function ReferenceFieldCombobox({
  collectionId,
  value,
  onChange,
  isMulti = false,
  placeholder = 'Select...',
  disabled = false,
}: ReferenceFieldComboboxProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebounce(searchQuery, 300);
  const [items, setItems] = useState<CollectionItemWithValues[]>([]);
  // Selected items resolved by ID, so their labels render even when they fall
  // outside the current search results or the first page of items.
  const [selectedItemsCache, setSelectedItemsCache] = useState<Record<string, CollectionItemWithValues>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Get the collection info and fields from the store
  const { collections, fields } = useCollectionsStore();
  const collection = collections.find(c => c.id === collectionId);
  /* eslint-disable-next-line react-hooks/exhaustive-deps -- collectionFields derived from store */
  const collectionFields = fields[collectionId] || [];

  // Find the title/name field for display
  const displayField = useMemo(() => findDisplayField(collectionFields), [collectionFields]);

  // Parse value based on isMulti
  const selectedIds = useMemo(() => {
    if (!value) return [];
    if (isMulti) {
      return parseMultiReferenceValue(value);
    }
    return Array.isArray(value) ? value : [value];
  }, [value, isMulti]);

  // Get display name for an item
  const getDisplayName = useCallback(
    (item: CollectionItemWithValues) => getItemDisplayName(item, displayField),
    [displayField]
  );

  // Resolve an item by ID from the current results or the selected cache
  const resolveItem = useCallback(
    (id: string) => items.find(item => item.id === id) || selectedItemsCache[id],
    [items, selectedItemsCache]
  );

  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  // Load items eagerly on mount and refresh when the dropdown opens or the
  // (debounced) search changes. Search is pushed to the server so collections
  // larger than the page limit still surface matches beyond the first page.
  useEffect(() => {
    if (!collectionId) return;
    if (hasLoadedOnce && !open) return;

    const fetchItems = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await collectionsApi.getItems(collectionId, {
          limit: 100,
          search: debouncedSearch.trim() || undefined,
        });
        if (response.error) {
          throw new Error(response.error);
        }
        setItems(response.data?.items || []);
        setHasLoadedOnce(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load items');
      } finally {
        setLoading(false);
      }
    };
    fetchItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, collectionId, debouncedSearch]);

  // Fetch labels for selected items missing from the current results
  const fetchingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const missing = selectedIds.filter(
      id => id
        && !items.some(item => item.id === id)
        && !selectedItemsCache[id]
        && !fetchingRef.current.has(id)
    );
    if (missing.length === 0) return;

    missing.forEach(id => fetchingRef.current.add(id));
    Promise.all(missing.map(id => collectionsApi.getItemById(collectionId, id)))
      .then(responses => {
        const resolved: Record<string, CollectionItemWithValues> = {};
        responses.forEach(res => {
          if (res.data) resolved[res.data.id] = res.data;
        });
        if (Object.keys(resolved).length > 0) {
          setSelectedItemsCache(prev => ({ ...prev, ...resolved }));
        }
      })
      .finally(() => {
        missing.forEach(id => fetchingRef.current.delete(id));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, items, collectionId]);

  // Handle single selection with toggle (can deselect)
  const handleSingleSelect = (itemId: string) => {
    // If clicking the same item, deselect it
    if (selectedIds.includes(itemId)) {
      onChange('');
    } else {
      onChange(itemId);
    }
    setOpen(false);
    setSearchQuery('');
  };

  // Handle multi selection toggle
  const handleMultiToggle = (itemId: string) => {
    const newSelectedIds = selectedIds.includes(itemId)
      ? selectedIds.filter(id => id !== itemId)
      : [...selectedIds, itemId];
    onChange(JSON.stringify(newSelectedIds));
  };

  // Clear selection
  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(isMulti ? '[]' : '');
  };

  // Get display text for trigger button
  const getDisplayText = () => {
    if (selectedIds.length === 0) return placeholder;

    if (isMulti) {
      const names = selectedIds
        .map((id) => resolveItem(id))
        .filter((item): item is CollectionItemWithValues => !!item)
        .map((item) => getDisplayName(item));

      if (names.length > 0) return names.join(', ');
      if (!hasLoadedOnce) return 'Loading data...';
      return placeholder;
    }

    // For single reference, find the item name
    const selectedItem = resolveItem(selectedIds[0]);
    if (selectedItem) {
      return getDisplayName(selectedItem);
    }

    if (!hasLoadedOnce) return 'Loading data...';
  };

  return (
    <div className="flex items-center gap-1">

      <div className="flex-1">
        <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="input"
            role="combobox"
            size="sm"
            aria-expanded={open}
            disabled={disabled}
            className={cn(
              'w-full justify-between font-normal',
              !selectedIds.length && 'text-muted-foreground'
            )}
          >
            <span className="truncate">{getDisplayText()}</span>
            <Icon
              name="chevronDown"
              className={cn('size-2.5 opacity-50 ml-2', open && '')}
            />
          </Button>
        </DropdownMenuTrigger>

      <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-50" align="start">
        {/* Search Input */}
        <div className="mb-2">
          <Input
            placeholder={`Search ${collection?.name || 'items'}...`}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            // Stop keystrokes from reaching the menu's typeahead, which would
            // otherwise focus matching options and steal focus from the input.
            onKeyDown={(e) => e.stopPropagation()}
            size="xs"
            autoFocus
          />
        </div>

        {/* Items List */}
        <div className="max-h-60 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Spinner />
            </div>
          ) : error ? (
            <div className="text-center py-4 text-sm text-destructive">
              {error}
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-4 text-sm text-muted-foreground">
              <Empty>
                <EmptyTitle>{searchQuery ? 'No items found' : 'No items in this collection'}</EmptyTitle>
              </Empty>
            </div>
          ) : (
            items.map((item) => {
              const isSelected = selectedIds.includes(item.id);
              const displayName = getDisplayName(item);

              return (
                <DropdownMenuCheckboxItem
                  key={item.id}
                  checked={isSelected}
                  onCheckedChange={() => isMulti ? handleMultiToggle(item.id) : handleSingleSelect(item.id)}
                  onSelect={(e) => {
                    e.preventDefault();
                  }}
                >
                  {displayName}
                </DropdownMenuCheckboxItem>
              );
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
      </div>

      {selectedIds.length > 0 && (
        <Button
          variant="secondary"
          size="sm"
          onClick={handleClear}
        >
          <Icon name="x" />
        </Button>
      )}

  </div>
  );
}

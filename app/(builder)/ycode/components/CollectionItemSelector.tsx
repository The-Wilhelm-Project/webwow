'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import Icon from '@/components/ui/icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { FilterCombobox } from './filter-combobox';

import { useDebounce } from '@/hooks/use-debounce';
import { useCollectionsStore } from '@/stores/useCollectionsStore';
import { cn } from '@/lib/utils';

interface CollectionItemSelectorProps {
  collectionId: string;
  value: string | null;
  onValueChange: (id: string) => void;
}

const SEARCH_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Top-bar picker for the active collection item on dynamic pages.
 *
 * The trigger is the filter field (same UX as PageSelector). Items come from
 * the preloaded store cache; typing triggers a debounced server search that
 * merges results into the cache so the canvas can resolve items beyond the
 * initial preload window.
 */
export default function CollectionItemSelector({
  collectionId,
  value,
  onValueChange,
}: CollectionItemSelectorProps) {
  const itemsByCollection = useCollectionsStore((s) => s.items);
  const fieldsByCollection = useCollectionsStore((s) => s.fields);
  const searchAndMergeItems = useCollectionsStore((s) => s.searchAndMergeItems);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, SEARCH_DEBOUNCE_MS);
  const [isLoading, setIsLoading] = useState(false);

  const dropdownItems = useMemo(() => {
    const items = itemsByCollection[collectionId] || [];
    const fields = fieldsByCollection[collectionId] || [];
    const nameField = fields.find((f) => f.key === 'name');
    return items.map((item) => {
      let label = `Item ${item.id.slice(0, 8)}`;
      if (nameField) {
        const nameValue = item.values?.[nameField.id];
        if (nameValue !== null && nameValue !== undefined && String(nameValue).trim() !== '') {
          label = String(nameValue);
        }
      }
      return { id: item.id, label };
    });
  }, [collectionId, itemsByCollection, fieldsByCollection]);

  const trimmedSearch = debouncedSearch.trim();

  useEffect(() => {
    if (!trimmedSearch) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    searchAndMergeItems(collectionId, trimmedSearch, SEARCH_LIMIT)
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [collectionId, trimmedSearch, searchAndMergeItems]);

  useEffect(() => {
    if (!value && dropdownItems.length > 0) {
      onValueChange(dropdownItems[0].id);
    }
  }, [value, dropdownItems, onValueChange]);

  const selectedLabel = dropdownItems.find((item) => item.id === value)?.label || '';

  const handleEnter = useCallback((query: string) => {
    if (!query.trim()) return;
    const needle = query.toLowerCase();
    const first = dropdownItems.find((item) => item.label.toLowerCase().includes(needle));
    if (first) onValueChange(first.id);
  }, [dropdownItems, onValueChange]);

  return (
    <FilterCombobox
      displayValue={selectedLabel}
      placeholder="Select item"
      searchPlaceholder="Search items..."
      ariaLabel="Select collection item"
      className="w-24"
      align="start"
      popoverClassName="min-w-72 max-w-96"
      isLoading={isLoading}
      leading={(
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0">
              <Icon name="database" className="size-3 opacity-50" />
            </span>
          </TooltipTrigger>
          <TooltipContent>Collection item</TooltipContent>
        </Tooltip>
      )}
      onSearchChange={setSearch}
      onEnter={handleEnter}
    >
      {({ search: query, hasQuery, close }) => {
        const needle = query.trim().toLowerCase();
        const visibleItems = needle
          ? dropdownItems.filter((item) => item.label.toLowerCase().includes(needle))
          : dropdownItems;

        if (visibleItems.length === 0) {
          return (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              {hasQuery ? (isLoading ? 'Searching...' : 'No items found') : 'No items available'}
            </div>
          );
        }

        return visibleItems.map((item) => {
          const isSelected = item.id === value;
          return (
            <div
              key={item.id}
              role="option"
              aria-selected={isSelected}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onValueChange(item.id);
                close();
              }}
              className={cn(
                'hover:bg-accent hover:text-accent-foreground text-muted-foreground relative flex w-full cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-xs outline-hidden select-none',
                isSelected && 'bg-secondary/50'
              )}
            >
              <span className="min-w-0 truncate">{item.label}</span>
              {isSelected && (
                <span className="absolute right-2 flex size-3 items-center justify-center">
                  <Icon name="check" className="size-3 opacity-50" />
                </span>
              )}
            </div>
          );
        });
      }}
    </FilterCombobox>
  );
}

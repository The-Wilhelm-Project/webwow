'use client';

/**
 * FilterLayerBehavior
 *
 * Runtime behavior for `filter` layers on published & preview pages:
 *   - Reads URL params on mount and applies them to nested input/select/textarea elements.
 *   - Builds a name map (inputLayerId → URL key) so the filter store can sync values to the URL.
 *   - Listens for clicks (Apply button), Enter keypresses, and (when `filterOnChange`) input/change
 *     events to push collected values into `useFilterStore` for `FilterableCollection` to read.
 *
 * Lives in its own module so the `useFilterStore` import (Zustand) and the ~180 lines of
 * DOM-scanning code only ship in pages that actually render a filter layer. Loaded lazily
 * via `next/dynamic` from `LayerRendererPublic`.
 */

import React, { useEffect } from 'react';
import { useFilterStore } from '@/stores/useFilterStore';

interface FilterLayerBehaviorProps {
  /** The filter container element. We attach listeners here and query its descendants. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  filterLayerId: string;
  /** When true, value changes in any nested input trigger a debounced collection. */
  filterOnChange: boolean;
}

const FilterLayerBehavior: React.FC<FilterLayerBehaviorProps> = ({
  containerRef,
  filterLayerId,
  filterOnChange,
}) => {
  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const store = useFilterStore.getState();

    const nameMap: Record<string, string> = {};
    const reverseMap: Record<string, string> = {};
    const checkboxGroupNames: Record<string, string> = {};
    const inputs = container.querySelectorAll('input, select, textarea');
    inputs.forEach(el => {
      const inputEl = el as HTMLInputElement;
      const inputLayerId = inputEl.closest('[data-layer-id]')?.getAttribute('data-layer-id');
      if (!inputLayerId) return;
      const nameAttr = inputEl.getAttribute('name');
      const paramName = nameAttr || (inputLayerId.startsWith('lyr-') ? inputLayerId.slice(4) : inputLayerId);
      nameMap[inputLayerId] = paramName;
      reverseMap[paramName] = inputLayerId;
      if (inputEl.type === 'checkbox' || inputEl.type === 'radio') {
        const cbMatch = inputLayerId.match(/^(.+)-(?:cb|rb)-.+-input$/);
        if (cbMatch) {
          checkboxGroupNames[cbMatch[1]] = (nameAttr || '').replace(/\[\]$/, '') || cbMatch[1];
        }
      }
    });
    for (const [baseId, baseName] of Object.entries(checkboxGroupNames)) {
      nameMap[baseId] = baseName;
      reverseMap[baseName] = baseId;
    }
    const inputLayerIds = Object.keys(nameMap);
    store.setNameMap(nameMap);

    const url = new URL(window.location.href);
    url.searchParams.forEach((value, key) => {
      if (!value) return;
      const inputLayerId = reverseMap[key]
        || (key.startsWith('filter_') ? key.slice('filter_'.length) : null);
      if (!inputLayerId) return;
      let inputEl = container.querySelector(`[data-layer-id="${inputLayerId}"] input, [data-layer-id="${inputLayerId}"] select, [data-layer-id="${inputLayerId}"] textarea`) as HTMLInputElement | null;
      if (!inputEl) {
        const directEl = container.querySelector(`input[data-layer-id="${inputLayerId}"], select[data-layer-id="${inputLayerId}"], textarea[data-layer-id="${inputLayerId}"]`) as HTMLInputElement | null;
        inputEl = directEl;
      }
      if (!inputEl) {
        const cbInputs = container.querySelectorAll(
          `[data-layer-id^="${inputLayerId}-cb-"] input[type="checkbox"], [data-layer-id^="${inputLayerId}-rb-"] input[type="radio"]`
        );
        if (cbInputs.length > 0) {
          const checkedSet = new Set(value.split(','));
          cbInputs.forEach(cb => {
            (cb as HTMLInputElement).checked = checkedSet.has((cb as HTMLInputElement).value);
          });
        }
        return;
      }
      if (inputEl.type === 'checkbox') {
        inputEl.checked = value === inputEl.value || value === 'true';
      } else {
        inputEl.value = value;
      }
    });

    setTimeout(() => store.loadFromUrl(), 0);

    return () => {
      const state = useFilterStore.getState();
      state.removeNameMapEntries(inputLayerIds);
    };
  }, [containerRef]);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const { setFilterValues } = useFilterStore.getState();

    const collectInputValues = () => {
      const nameMap: Record<string, string> = {};
      const inputValues: Record<string, string> = {};
      const checkboxGroups: Record<string, string[]> = {};
      const inputs = container.querySelectorAll('input, select, textarea');
      inputs.forEach(el => {
        const inputEl = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const inputLayerId = inputEl.closest('[data-layer-id]')?.getAttribute('data-layer-id');
        if (!inputLayerId) return;
        const nameAttr = inputEl.getAttribute('name');
        if (nameAttr) nameMap[inputLayerId] = nameAttr;
        if (inputEl.type === 'checkbox' || inputEl.type === 'radio') {
          const checked = (inputEl as HTMLInputElement).checked;
          const val = checked ? ((inputEl as HTMLInputElement).value || 'true') : '';
          inputValues[inputLayerId] = val;
          const cbMatch = inputLayerId.match(/^(.+)-(?:cb|rb)-.+-input$/);
          if (cbMatch) {
            const baseId = cbMatch[1];
            if (!checkboxGroups[baseId]) checkboxGroups[baseId] = [];
            if (val) checkboxGroups[baseId].push(val);
            if (nameAttr) nameMap[baseId] = nameAttr.replace(/\[\]$/, '');
          }
        } else {
          inputValues[inputLayerId] = inputEl.value;
        }
      });
      for (const [baseId, values] of Object.entries(checkboxGroups)) {
        inputValues[baseId] = values.join(',');
      }
      setFilterValues(filterLayerId, inputValues);
      if (Object.keys(nameMap).length > 0) {
        useFilterStore.getState().setNameMap(nameMap);
      }
    };

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedCollect = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(collectInputValues, 750);
    };

    const handleButtonClick = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.closest('button') || target.tagName === 'BUTTON') {
        e.preventDefault();
        collectInputValues();
      }
    };

    const handleKeyDown = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== 'Enter') return;
      const target = ke.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT') {
        ke.preventDefault();
        collectInputValues();
      }
    };

    container.addEventListener('click', handleButtonClick);
    container.addEventListener('keydown', handleKeyDown);

    if (filterOnChange) {
      const handleInputChange = () => debouncedCollect();
      container.addEventListener('input', handleInputChange);
      container.addEventListener('change', handleInputChange);

      collectInputValues();

      return () => {
        container.removeEventListener('click', handleButtonClick);
        container.removeEventListener('keydown', handleKeyDown);
        container.removeEventListener('input', handleInputChange);
        container.removeEventListener('change', handleInputChange);
        useFilterStore.getState().clearFilter(filterLayerId);
        if (debounceTimer) clearTimeout(debounceTimer);
      };
    }

    collectInputValues();

    return () => {
      container.removeEventListener('click', handleButtonClick);
      container.removeEventListener('keydown', handleKeyDown);
      useFilterStore.getState().clearFilter(filterLayerId);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [containerRef, filterLayerId, filterOnChange]);

  return null;
};

export default FilterLayerBehavior;

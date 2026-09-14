import { create } from 'zustand';

/**
 * Filter Store
 *
 * Manages runtime filter input values for the published site.
 * Tracks current values from filter layer inputs and provides
 * them to collection layers for dynamic filtering.
 *
 * Structure: filterLayerId -> inputLayerId -> currentValue
 *
 * URL sync: filter values are synced to URL params using the input's
 * `name` attribute (if set) or a stripped layer ID as the key.
 * Example: `?search=Emily` if the input's name is "search",
 * or `?mm1ue1e3iktexa=Emily` as fallback.
 */

/**
 * Maps inputLayerId → URL param name.
 * Built from input elements' `name` attributes or stripped layer IDs.
 */
type NameMap = Record<string, string>;

interface FilterStoreState {
  values: Record<string, Record<string, string>>;
  /** Maps inputLayerId → URL param name */
  nameMap: NameMap;
  setFilterValue: (filterLayerId: string, inputLayerId: string, value: string) => void;
  setFilterValues: (filterLayerId: string, inputValues: Record<string, string>) => void;
  clearFilter: (filterLayerId: string) => void;
  getFilterValues: (filterLayerId: string) => Record<string, string>;
  getAllFilterValues: () => Record<string, Record<string, string>>;
  setNameMap: (map: NameMap) => void;
  removeNameMapEntries: (inputLayerIds: string[]) => void;
  syncToUrl: () => void;
  loadFromUrl: () => void;
  reset: () => void;
}

function stripLayerPrefix(layerId: string): string {
  return layerId.startsWith('lyr-') ? layerId.slice(4) : layerId;
}

function getUrlParamName(inputLayerId: string, nameMap: NameMap): string {
  return nameMap[inputLayerId] || stripLayerPrefix(inputLayerId);
}

function buildReverseMap(nameMap: NameMap): Record<string, string> {
  const reverse: Record<string, string> = {};
  for (const [layerId, paramName] of Object.entries(nameMap)) {
    reverse[paramName] = layerId;
  }
  return reverse;
}

export const useFilterStore = create<FilterStoreState>((set, get) => ({
  values: {},
  nameMap: {},

  setFilterValue: (filterLayerId, inputLayerId, value) => {
    set(state => {
      const newValues = { ...state.values };

      // Remove stale _url entry for this input so buildApiFilters
      // doesn't find the old URL-loaded value before the new one
      if (newValues['_url'] && inputLayerId in newValues['_url']) {
        const { [inputLayerId]: _, ...restUrl } = newValues['_url'];
        if (Object.keys(restUrl).length === 0) {
          delete newValues['_url'];
        } else {
          newValues['_url'] = restUrl;
        }
      }

      newValues[filterLayerId] = {
        ...(newValues[filterLayerId] || {}),
        [inputLayerId]: value,
      };

      return { values: newValues };
    });
    setTimeout(() => get().syncToUrl(), 0);
  },

  setFilterValues: (filterLayerId, inputValues) => {
    set(state => {
      const newValues = { ...state.values };
      let changed = false;

      // Remove stale _url entries for these inputs so buildApiFilters
      // doesn't keep URL-loaded values after real input interaction.
      if (newValues['_url']) {
        let urlChanged = false;
        const nextUrl = { ...newValues['_url'] };
        for (const inputLayerId of Object.keys(inputValues)) {
          if (inputLayerId in nextUrl) {
            delete nextUrl[inputLayerId];
            urlChanged = true;
          }
        }
        if (urlChanged) {
          changed = true;
          if (Object.keys(nextUrl).length === 0) {
            delete newValues['_url'];
          } else {
            newValues['_url'] = nextUrl;
          }
        }
      }

      const currentLayerValues = newValues[filterLayerId] || {};
      const nextLayerValues = { ...currentLayerValues };
      for (const [inputLayerId, value] of Object.entries(inputValues)) {
        if (nextLayerValues[inputLayerId] !== value) {
          nextLayerValues[inputLayerId] = value;
          changed = true;
        }
      }

      if (!changed) return state;

      newValues[filterLayerId] = nextLayerValues;
      return { values: newValues };
    });
    setTimeout(() => get().syncToUrl(), 0);
  },

  clearFilter: (filterLayerId) => {
    set(state => {
      const { [filterLayerId]: _, ...rest } = state.values;
      return { values: rest };
    });
    setTimeout(() => get().syncToUrl(), 0);
  },

  getFilterValues: (filterLayerId) => {
    return get().values[filterLayerId] || {};
  },

  getAllFilterValues: () => {
    return get().values;
  },

  setNameMap: (map) => {
    set(state => ({ nameMap: { ...state.nameMap, ...map } }));
  },

  removeNameMapEntries: (inputLayerIds) => {
    if (inputLayerIds.length === 0) return;
    set(state => {
      const nextMap = { ...state.nameMap };
      for (const inputLayerId of inputLayerIds) {
        delete nextMap[inputLayerId];
      }
      return { nameMap: nextMap };
    });
  },

  syncToUrl: () => {
    if (typeof window === 'undefined') return;
    const { values, nameMap } = get();
    const url = new URL(window.location.href);

    // Build set of current param names we manage (to know which to remove)
    const managedParams = new Set<string>();
    for (const filterLayerValues of Object.values(values)) {
      for (const inputLayerId of Object.keys(filterLayerValues)) {
        managedParams.add(getUrlParamName(inputLayerId, nameMap));
      }
    }

    // Also remove any params that match known name map entries or stripped IDs
    const allKnownParams = new Set<string>(managedParams);
    for (const [layerId, paramName] of Object.entries(nameMap)) {
      allKnownParams.add(paramName);
      allKnownParams.add(stripLayerPrefix(layerId));
    }

    // Remove old filter params (both old filter_ format and new name format)
    const keysToRemove: string[] = [];
    url.searchParams.forEach((_, key) => {
      if (key.startsWith('filter_') || allKnownParams.has(key)) {
        keysToRemove.push(key);
      }
    });
    keysToRemove.forEach(key => url.searchParams.delete(key));

    // Add current filter values with friendly names
    for (const filterLayerValues of Object.values(values)) {
      for (const [inputLayerId, value] of Object.entries(filterLayerValues)) {
        if (!value) continue;
        if (/-(cb|rb)-.+-input$/.test(inputLayerId)) continue;
        url.searchParams.set(getUrlParamName(inputLayerId, nameMap), value);
      }
    }

    window.history.replaceState({}, '', url.toString());
  },

  loadFromUrl: () => {
    if (typeof window === 'undefined') return;
    const { nameMap } = get();
    const reverseMap = buildReverseMap(nameMap);
    const url = new URL(window.location.href);
    const urlValues: Record<string, string> = {};

    const knownStrippedIds = new Set<string>();
    for (const layerId of Object.keys(nameMap)) {
      knownStrippedIds.add(stripLayerPrefix(layerId));
    }

    url.searchParams.forEach((value, key) => {
      if (!value) return;

      let inputLayerId: string | null = null;

      if (reverseMap[key]) {
        inputLayerId = reverseMap[key];
      } else if (knownStrippedIds.has(key)) {
        inputLayerId = `lyr-${key}`;
      } else if (key.startsWith('filter_')) {
        inputLayerId = key.slice('filter_'.length);
      }

      if (inputLayerId) {
        urlValues[inputLayerId] = value;
      }
    });

    if (Object.keys(urlValues).length > 0) {
      set(state => {
        const merged = { ...state.values };
        merged['_url'] = { ...(merged['_url'] || {}), ...urlValues };
        return { values: merged };
      });
    }
  },

  reset: () => {
    set({ values: {}, nameMap: {} });
  },
}));

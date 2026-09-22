/**
 * Layer Display Utilities
 *
 * Builder-only helpers for showing a friendly icon/label for a layer in the
 * layers panel, link pickers, etc. These pull in `lib/templates/blocks` (and
 * therefore the entire ~1.5 MB template tree) for the icon/name fallback,
 * so they live in their own module to keep `lib/layer-utils.ts` — which is
 * imported by the public renderer — template-free.
 */

import type { IconProps } from '@/components/ui/icon';
import type { Layer, Breakpoint } from '@/types';
import { getCollectionVariable, getLayoutTypeForBreakpoint, getLayoutTypeName } from '@/lib/layer-utils';
import { getBlockIcon, getBlockName } from '@/lib/templates/blocks';

// Layout custom names that should use breakpoint-aware icons/names
const LAYOUT_CUSTOM_NAMES = ['Columns', 'Rows', 'Grid'];

/**
 * Get the icon name (for `components/ui/Icon.tsx`) for a layer
 *
 * @param layer - The layer to get the icon for
 * @param defaultIcon - Fallback icon (default: 'box')
 * @param breakpoint - Optional breakpoint for layout-aware icons
 */
export function getLayerIcon(
  layer: Layer,
  defaultIcon: IconProps['name'] = 'box',
  breakpoint?: Breakpoint
): IconProps['name'] {
  // Body layers
  if (layer.id === 'body') return 'layout';

  // Component layers
  if (layer.componentId) return 'component';

  // Collection layers (skip when optionsSource manages the binding, e.g. checkbox groups)
  if (getCollectionVariable(layer) && !layer.settings?.optionsSource) {
    return 'database';
  }

  // Heading layers
  if (layer.name === 'heading') return 'heading';

  // Rich text layers
  if (layer.name === 'richText') return 'rich-text';

  // Text layers (backward compat: text with h1-h6 tag still shows heading icon)
  if (layer.name === 'text') {
    return ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(layer.settings?.tag || '') ? 'heading' : 'text';
  }

  // Layout layers (Columns, Rows, Grid) - breakpoint-aware icons
  if (layer.customName && LAYOUT_CUSTOM_NAMES.includes(layer.customName)) {
    if (breakpoint) {
      const layoutType = getLayoutTypeForBreakpoint(layer, breakpoint);
      if (layoutType === 'columns') return 'columns';
      if (layoutType === 'rows') return 'rows';
      if (layoutType === 'grid') return 'grid';
      if (layoutType === 'hidden') return 'eye-off';
    }
    // Fallback to custom name when no breakpoint
    if (layer.customName === 'Columns') return 'columns';
    if (layer.customName === 'Rows') return 'rows';
    if (layer.customName === 'Grid') return 'grid';
  }

  // Other named layers
  if (layer.customName === 'Container') return 'container';

  // Checkbox wrapper div (contains a checkbox input child)
  if (layer.name === 'div' && layer.children?.some(c => c.name === 'input' && c.attributes?.type === 'checkbox')) {
    return 'checkbox';
  }

  // Radio wrapper div (contains a radio input child)
  if (layer.name === 'div' && layer.children?.some(c => c.name === 'input' && c.attributes?.type === 'radio')) {
    return 'radio';
  }

  // Fallback to block icon (based on name)
  return getBlockIcon(layer.name, defaultIcon);
}

/**
 * Get the label for a layer (for display in the UI)
 *
 * @param layer - The layer to get the name for
 * @param context - Optional context (component_name, collection_name, source_field_name)
 * @param breakpoint - Optional breakpoint for layout-aware names
 */
export function getLayerName(
  layer: Layer,
  context?: {
    component_name?: string | undefined | null;
    collection_name?: string | undefined | null;
    /** When collection is bound to a field (reference/multi-reference/multi-asset), the field name */
    source_field_name?: string | undefined | null;
  },
  breakpoint?: Breakpoint
): string {
  // Special case for Body layer
  if (layer.id === 'body') {
    return 'Body';
  }

  // Use component name if this is a component instance
  if (layer.componentId) {
    return context?.component_name || 'Component';
  }

  // Use field name or collection name in parentheses after "Collection" (skip when optionsSource manages the binding)
  if (getCollectionVariable(layer) && !layer.settings?.optionsSource) {
    const label = context?.source_field_name ?? context?.collection_name;
    return label ? `Collection (${label})` : 'Collection';
  }

  // Layout layers (Columns, Rows, Grid) - breakpoint-aware names
  if (breakpoint && layer.customName && LAYOUT_CUSTOM_NAMES.includes(layer.customName)) {
    const layoutType = getLayoutTypeForBreakpoint(layer, breakpoint);
    const layoutName = getLayoutTypeName(layoutType);
    if (layoutName) {
      return layoutName;
    }
  }

  // Use custom name if available
  if (layer.customName) {
    return layer.customName;
  }

  // Checkbox wrapper div (contains a checkbox input child)
  if (layer.name === 'div' && layer.children?.some(c => c.name === 'input' && c.attributes?.type === 'checkbox')) {
    return 'Checkbox';
  }

  // Radio wrapper div (contains a radio input child)
  if (layer.name === 'div' && layer.children?.some(c => c.name === 'input' && c.attributes?.type === 'radio')) {
    return 'Radio';
  }

  return getBlockName(layer.name) || 'Layer';
}

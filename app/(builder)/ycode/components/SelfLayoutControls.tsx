'use client';

import { memo } from 'react';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import Icon from '@/components/ui/icon';
import { useDesignSync } from '@/hooks/use-design-sync';
import { useEditorStore } from '@/stores/useEditorStore';
import type { Layer } from '@/types';

interface SelfLayoutControlsProps {
  layer: Layer | null;
  parentLayer?: Layer | null;
  onLayerUpdate: (layerId: string, updates: Partial<Layer>) => void;
}

const noop = () => {};

/**
 * Child-in-parent layout controls (align-self). Rendered for any layer whose
 * parent is a flex/grid container, independent of the layer's own layout panel.
 */
const SelfLayoutControls = memo(function SelfLayoutControls({ layer, parentLayer = null, onLayerUpdate }: SelfLayoutControlsProps) {
  const activeBreakpoint = useEditorStore((s) => s.activeBreakpoint);
  const activeUIState = useEditorStore((s) => s.activeUIState);

  const { updateDesignProperty, getDesignProperty } = useDesignSync({
    layer,
    onLayerUpdate,
    activeBreakpoint,
    activeUIState,
  });

  // Read-only sync for the parent to resolve its layout (align-self axis and
  // visibility depend on the parent's flex/grid direction, not this layer's)
  const { getDesignProperty: getParentDesignProperty } = useDesignSync({
    layer: parentLayer,
    onLayerUpdate: noop,
    activeBreakpoint,
    activeUIState,
  });

  const alignSelf = getDesignProperty('layout', 'alignSelf') || 'auto';

  const parentDisplay = parentLayer ? (getParentDesignProperty('layout', 'display') || '') : '';
  const parentFlexDirection = getParentDesignProperty('layout', 'flexDirection') || 'row';
  const isParentFlex = parentDisplay === 'flex' || parentDisplay === 'inline-flex';
  const isParentGrid = parentDisplay === 'grid' || parentDisplay === 'inline-grid';
  const isParentColumnAxis = isParentFlex && (parentFlexDirection === 'column' || parentFlexDirection === 'column-reverse');

  if (!isParentFlex && !isParentGrid) return null;

  // 'auto' clears the override to keep classes clean
  const handleAlignSelfChange = (value: string) => {
    updateDesignProperty('layout', 'alignSelf', value === 'auto' ? null : value);
  };

  return (
    <div className="py-5">
      <header className="py-4 -mt-4 flex items-center gap-1.5">
        <Label>Self layout</Label>
        <Label variant="muted">{isParentGrid ? 'Grid container' : 'Flex container'}</Label>
      </header>

      <div className="grid grid-cols-3">
          <Label variant="muted">Self align</Label>
          <div className="col-span-2">
              <Tabs
                value={alignSelf}
                onValueChange={handleAlignSelfChange}
                className="w-full"
              >
                  <TabsList className="w-full">
                      <TabsTrigger value="auto">Auto</TabsTrigger>
                      <TabsTrigger value="start">
                          <Icon name="alignStart" className={isParentColumnAxis ? '-rotate-90' : ''} />
                      </TabsTrigger>
                      <TabsTrigger value="center">
                          <Icon name="alignCenter" className={isParentColumnAxis ? '-rotate-90' : ''} />
                      </TabsTrigger>
                      <TabsTrigger value="end">
                          <Icon name="alignEnd" className={isParentColumnAxis ? '-rotate-90' : ''} />
                      </TabsTrigger>
                      <TabsTrigger value="stretch">
                          <Icon name="alignStretch" className={isParentColumnAxis ? '-rotate-90' : ''} />
                      </TabsTrigger>
                  </TabsList>
              </Tabs>
          </div>
      </div>
    </div>
  );
});
export default SelfLayoutControls;

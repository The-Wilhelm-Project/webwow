'use client';

import { useCallback, memo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import Icon from '@/components/ui/icon';
import { useDesignSync } from '@/hooks/use-design-sync';
import { useControlledInputs } from '@/hooks/use-controlled-input';
import { useEditorStore } from '@/stores/useEditorStore';
import { extractMeasurementValue } from '@/lib/measurement-utils';
import { removeSpaces } from '@/lib/utils';
import type { Layer } from '@/types';
import MarginPadding from './MarginPadding';
import SettingsPanel from './SettingsPanel';

interface SpacingControlsProps {
  layer: Layer | null;
  onLayerUpdate: (layerId: string, updates: Partial<Layer>) => void;
  activeTextStyleKey?: string | null;
}

const SpacingControls = memo(function SpacingControls({ layer, onLayerUpdate, activeTextStyleKey }: SpacingControlsProps) {
  const [isOpen, setIsOpen] = useState(true);
  const activeBreakpoint = useEditorStore((s) => s.activeBreakpoint);
  const activeUIState = useEditorStore((s) => s.activeUIState);
  const { debouncedUpdateDesignProperty, getDesignProperty } = useDesignSync({
    layer,
    onLayerUpdate,
    activeBreakpoint,
    activeUIState,
    activeTextStyleKey,
  });

  const marginTop = getDesignProperty('spacing', 'marginTop') || '';
  const marginRight = getDesignProperty('spacing', 'marginRight') || '';
  const marginBottom = getDesignProperty('spacing', 'marginBottom') || '';
  const marginLeft = getDesignProperty('spacing', 'marginLeft') || '';
  const paddingTop = getDesignProperty('spacing', 'paddingTop') || '';
  const paddingRight = getDesignProperty('spacing', 'paddingRight') || '';
  const paddingBottom = getDesignProperty('spacing', 'paddingBottom') || '';
  const paddingLeft = getDesignProperty('spacing', 'paddingLeft') || '';

  const inputs = useControlledInputs({
    marginTop,
    marginRight,
    marginBottom,
    marginLeft,
    paddingTop,
    paddingRight,
    paddingBottom,
    paddingLeft,
  }, extractMeasurementValue);

  const [marginTopInput, setMarginTopInput] = inputs.marginTop;
  const [marginRightInput, setMarginRightInput] = inputs.marginRight;
  const [marginBottomInput, setMarginBottomInput] = inputs.marginBottom;
  const [marginLeftInput, setMarginLeftInput] = inputs.marginLeft;
  const [paddingTopInput, setPaddingTopInput] = inputs.paddingTop;
  const [paddingRightInput, setPaddingRightInput] = inputs.paddingRight;
  const [paddingBottomInput, setPaddingBottomInput] = inputs.paddingBottom;
  const [paddingLeftInput, setPaddingLeftInput] = inputs.paddingLeft;

  type SpacingProperty = 'marginTop' | 'marginRight' | 'marginBottom' | 'marginLeft' | 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft';

  const setters: Record<SpacingProperty, (v: string) => void> = {
    marginTop: setMarginTopInput,
    marginRight: setMarginRightInput,
    marginBottom: setMarginBottomInput,
    marginLeft: setMarginLeftInput,
    paddingTop: setPaddingTopInput,
    paddingRight: setPaddingRightInput,
    paddingBottom: setPaddingBottomInput,
    paddingLeft: setPaddingLeftInput,
  };

  const handleChange = useCallback((property: SpacingProperty, value: string) => {
    setters[property](value);
    if (value === 'auto') {
      debouncedUpdateDesignProperty('spacing', property, 'auto');
    } else {
      const sanitized = removeSpaces(value);
      debouncedUpdateDesignProperty('spacing', property, sanitized || null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedUpdateDesignProperty]);

  const handleMarginAuto = useCallback(() => {
    handleChange('marginLeft', 'auto');
    handleChange('marginRight', 'auto');
  }, [handleChange]);

  return (
    <SettingsPanel
      title="Spacing"
      isOpen={isOpen}
      onToggle={() => setIsOpen(!isOpen)}
      action={
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              onClick={handleMarginAuto}
              variant="ghost"
              size="xs"
            >
              <Icon name="center-block" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Center element horizontally.
          </TooltipContent>
        </Tooltip>
      }
    >
      <MarginPadding
        values={{
          marginTop: marginTopInput,
          marginRight: marginRightInput,
          marginBottom: marginBottomInput,
          marginLeft: marginLeftInput,
          paddingTop: paddingTopInput,
          paddingRight: paddingRightInput,
          paddingBottom: paddingBottomInput,
          paddingLeft: paddingLeftInput,
        }}
        onChange={handleChange}
      />
    </SettingsPanel>
  );
});
export default SpacingControls;

'use client';

/**
 * Format selector for date and number inline variables.
 *
 * Two modes:
 * - Default (no children): renders a chevron button that opens the popover
 * - Wrapper (with children): wraps children as the popover trigger
 */

import React, { useState, useCallback } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import {
  getFormatSectionsForFieldType,
  getDateFormatPreview,
  getNumberFormatPreview,
  type DateFormatPreset,
  type NumberFormatPreset,
} from '@/lib/variable-format-utils';

function getDetail(preset: DateFormatPreset | NumberFormatPreset): string | undefined {
  return 'detail' in preset ? (preset as DateFormatPreset).detail : undefined;
}

interface VariableFormatSelectorProps {
  fieldType: string | null | undefined;
  currentFormat?: string;
  onFormatChange: (formatId: string) => void;
  /** Visual variant for different editor contexts */
  variant?: 'sidebar' | 'canvas';
  /** When provided, children become the popover trigger instead of the chevron button */
  children?: React.ReactNode;
}

function getPreview(preset: DateFormatPreset | NumberFormatPreset): string {
  if ('sample' in preset) {
    return getNumberFormatPreview(preset);
  }
  return getDateFormatPreview(preset);
}

export default function VariableFormatSelector({
  fieldType,
  currentFormat,
  onFormatChange,
  variant = 'sidebar',
  children,
}: VariableFormatSelectorProps) {
  const [open, setOpen] = useState(false);
  const sections = getFormatSectionsForFieldType(fieldType);

  const handleSelect = useCallback((formatId: string) => {
    onFormatChange(formatId);
    setOpen(false);
  }, [onFormatChange]);

  if (sections.length === 0) {
    return children ? <>{children}</> : null;
  }

  const trigger = children ? (
    <PopoverTrigger asChild>
      <span
        className="cursor-pointer"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </span>
    </PopoverTrigger>
  ) : (
    <PopoverTrigger asChild>
      <Button
        variant={variant === 'canvas' ? 'inline_variable_canvas' : 'outline'}
        className={cn(
          'size-4! p-0!',
          variant === 'canvas' && '-mr-0.5',
        )}
        onClick={(e) => {
          e.stopPropagation();
        }}
        aria-label="Change format"
      >
        <Icon
          name="chevronDown"
          className="size-2"
        />
      </Button>
    </PopoverTrigger>
  );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
    >
      {trigger}
      <PopoverContent
        className="w-52 p-1"
        align="end"
        sideOffset={4}
        onClick={(e) => e.stopPropagation()}
        onPointerDownOutside={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col max-h-[min(60vh)] overflow-y-auto">
          {sections.map((section) => (
            <div key={section.title}>
              <p className="text-[10px] font-medium text-muted-foreground px-2 py-1.5 uppercase tracking-wider">
                {section.title}
              </p>
              {section.presets.map((preset) => (
                <button
                  key={preset.id}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 text-xs rounded-sm hover:bg-accent hover:text-accent-foreground cursor-pointer text-left w-full',
                    currentFormat === preset.id && 'bg-accent text-accent-foreground',
                  )}
                  onClick={() => handleSelect(preset.id)}
                >
                  <span className="flex-1 truncate">
                    {getPreview(preset)}
                    {getDetail(preset) && (
                      <span className="text-muted-foreground ml-1.5">{getDetail(preset)}</span>
                    )}
                  </span>
                  {currentFormat === preset.id && (
                    <Icon
                      name="check"
                      className="size-3 shrink-0"
                    />
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

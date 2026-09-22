'use client';

/**
 * Node view for the richTextComponent Tiptap block.
 * Renders a collapsible panel with the component name, and override
 * controls for each variable the component exposes.
 */

import React, { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { isCircularComponentReference } from '@/lib/component-utils';
import ComponentVariableOverrides from './ComponentVariableOverrides';
import RichTextEditor from './RichTextEditor';
import ExpandableRichTextEditor from './ExpandableRichTextEditor';
import { SIMPLE_TEXT_FIELD_TYPES } from '@/lib/collection-field-utils';
import type { CollectionField, Collection } from '@/types';
import type { RichTextComponentOverrides } from '@/lib/tiptap-extensions/rich-text-component';
import type { FieldGroup } from '@/lib/collection-field-utils';

interface RichTextComponentBlockProps {
  componentId: string;
  componentOverrides: RichTextComponentOverrides;
  onOverridesChange: (overrides: RichTextComponentOverrides) => void;
  onDelete: () => void;
  isEditable: boolean;
  fieldGroups?: FieldGroup[];
  allFields?: Record<string, CollectionField[]>;
  collections?: Collection[];
  isInsideCollectionLayer?: boolean;
}

export default function RichTextComponentBlock({
  componentId,
  componentOverrides,
  onOverridesChange,
  onDelete,
  isEditable,
  fieldGroups,
  allFields,
  collections,
  isInsideCollectionLayer,
}: RichTextComponentBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const getComponentById = useComponentsStore(state => state.getComponentById);
  const components = useComponentsStore(state => state.components);
  const editingComponentId = useEditorStore(state => state.editingComponentId);
  const component = getComponentById(componentId);
  const variables = useMemo(() => component?.variables ?? [], [component?.variables]);
  const hasVariables = variables.length > 0;

  // Detect infinite loops when this component would reference the component being edited
  const isCircular = useMemo(() => {
    if (!editingComponentId || !componentId) return false;
    return isCircularComponentReference(editingComponentId, componentId, components);
  }, [editingComponentId, componentId, components]);

  if (isCircular) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-orange-400/40 bg-orange-500/5 px-3 py-2 text-xs text-orange-600 dark:text-orange-300">
        <Icon name="component" className="size-3.5 shrink-0" />
        <span>Circular reference — {component?.name ?? 'component'} cannot embed itself</span>
        {isEditable && (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto size-5! p-0!"
            onClick={onDelete}
          >
            <Icon name="x" className="size-3" />
          </Button>
        )}
      </div>
    );
  }

  if (!component) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        <Icon name="component" className="size-3.5 shrink-0" />
        <span>Component not found</span>
        {isEditable && (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto size-5! p-0!"
            onClick={onDelete}
          >
            <Icon name="x" className="size-3" />
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-background text-xs select-none">
      {/* Header */}
      <div className="flex w-full items-center text-left">
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 text-left px-4.5 py-4.5',
            hasVariables && 'cursor-pointer',
          )}
          onClick={() => hasVariables && setIsExpanded(prev => !prev)}
        >
          {hasVariables && (
            <Icon
              name="chevronRight"
              className={cn('size-3 shrink-0 text-muted-foreground transition-transform', isExpanded && 'rotate-90')}
            />
          )}
          <Icon name="component" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{component.name}</span>
        </button>

        {isEditable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="mr-3"
              >
                <Icon name="dotsHorizontal" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {hasVariables && (
                <DropdownMenuItem onClick={() => onOverridesChange(undefined)}>
                  Reset variables
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onDelete}>
                Remove component
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Collapsible override controls */}
      {isExpanded && hasVariables && (
        <div className="border-t border-border px-4 py-5">
          <ComponentVariableOverrides
            variables={variables}
            componentOverrides={componentOverrides}
            onOverridesChange={onOverridesChange}
            fieldGroups={fieldGroups}
            allFields={allFields}
            collections={collections}
            isInsideCollectionLayer={isInsideCollectionLayer}
            columns={2}
            renderTextOverride={(variable, value, onChange, onClear) =>
              variable.type === 'rich_text' ? (
                <ExpandableRichTextEditor
                  sheetDescription={`${component.name} override — ${variable.name}`}
                  value={value}
                  onChange={onChange}
                  onClear={onClear}
                  placeholder={variable.placeholder || 'Enter text...'}
                  fieldGroups={fieldGroups}
                  allFields={allFields}
                  collections={collections}
                />
              ) : (
                <RichTextEditor
                  value={value}
                  onChange={onChange}
                  placeholder={variable.placeholder || 'Enter text...'}
                  fieldGroups={fieldGroups}
                  allFields={allFields}
                  collections={collections}
                  withFormatting
                  showFormattingToolbar={false}
                  allowedFieldTypes={SIMPLE_TEXT_FIELD_TYPES}
                />
              )
            }
          />
        </div>
      )}
    </div>
  );
}

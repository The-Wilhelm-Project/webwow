'use client';

/**
 * Compact rich-text editor with an "Richtext editor" button that opens
 * a RichTextEditorSheet for full-featured editing.
 */

import { useMemo, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import RichTextEditor from './RichTextEditor';
import RichTextEditorSheet from './RichTextEditorSheet';
import VariableFormatSelector from './VariableFormatSelector';
import { CollectionFieldSelector, type FieldSourceType } from './CollectionFieldSelector';
import { hasLinkOrComponent, getSoleCmsFieldBinding } from '@/lib/tiptap-utils';
import { getVariableLabel } from '@/lib/cms-variables-utils';
import { isFormattableFieldType, buildFieldVariableData } from '@/lib/variable-format-utils';
import { flattenFieldGroups, filterFieldGroupsByType, RICH_TEXT_ONLY_FIELD_TYPES } from '@/lib/collection-field-utils';
import type { CollectionField, Collection, CollectionFieldType } from '@/types';
import type { FieldGroup } from '@/lib/collection-field-utils';

interface ExpandableRichTextEditorProps {
  value: any;
  onChange: (val: any) => void;
  /** Called on blur with the current content — use for deferred persistence */
  onBlur?: (val: any) => void;
  placeholder?: string;
  /** Bold title in the sheet header */
  sheetTitle?: string;
  /** Muted description in the sheet header */
  sheetDescription?: string;
  fieldGroups?: FieldGroup[];
  allFields?: Record<string, CollectionField[]>;
  collections?: Collection[];
  disabled?: boolean;
  /** Only show the button, hide the inline editor */
  buttonOnly?: boolean;
  /** Called when the user clears the CMS binding via the X button (falls back to resetting content if not provided) */
  onClear?: () => void;
  /** CMS field types allowed for variable binding (defaults to RICH_TEXT_ONLY_FIELD_TYPES) */
  allowedFieldTypes?: CollectionFieldType[];
}

export default function ExpandableRichTextEditor({
  value,
  onChange,
  onBlur,
  placeholder = 'Enter value...',
  sheetTitle,
  sheetDescription,
  fieldGroups,
  allFields,
  collections,
  disabled = false,
  buttonOnly = true,
  onClear,
  allowedFieldTypes = RICH_TEXT_ONLY_FIELD_TYPES,
}: ExpandableRichTextEditorProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [cmsDropdownOpen, setCmsDropdownOpen] = useState(false);
  const isComplex = useMemo(() => hasLinkOrComponent(value), [value]);

  const soleBinding = useMemo(() => {
    if (!buttonOnly) return null;
    return getSoleCmsFieldBinding(value);
  }, [buttonOnly, value]);

  const richTextBinding = useMemo(() => {
    return soleBinding?.field_type === 'rich_text' ? soleBinding : null;
  }, [soleBinding]);

  const formattableBinding = useMemo(() => {
    return soleBinding && isFormattableFieldType(soleBinding.field_type) ? soleBinding : null;
  }, [soleBinding]);

  const handleFormatChange = useCallback((formatId: string) => {
    if (!value?.content?.[0]?.content?.[0]?.attrs?.variable) return;
    const variable = value.content[0].content[0].attrs.variable;
    const updatedContent = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'dynamicVariable',
          attrs: {
            ...value.content[0].content[0].attrs,
            variable: {
              ...variable,
              data: { ...variable.data, format: formatId },
            },
          },
        }],
      }],
    };
    onChange(updatedContent);
  }, [value, onChange]);

  const textFieldGroups = useMemo(
    () => filterFieldGroupsByType(fieldGroups, allowedFieldTypes),
    [fieldGroups, allowedFieldTypes],
  );
  const canShowVariables = textFieldGroups.length > 0;

  const fields = useMemo(
    () => flattenFieldGroups(fieldGroups),
    [fieldGroups],
  );

  const handleFieldSelect = (fieldId: string, relationshipPath: string[], source?: FieldSourceType, layerId?: string) => {
    const field = fields.find(f => f.id === fieldId);
    const variableData = buildFieldVariableData(fieldId, relationshipPath, field?.type ?? null, source, layerId);
    const label = getVariableLabel(variableData, fields, allFields);

    const newContent = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'dynamicVariable',
          attrs: { variable: variableData, label },
        }],
      }],
    };
    onChange(newContent);
    setCmsDropdownOpen(false);
  };

  if ((richTextBinding || formattableBinding) && !sheetOpen) {
    const activeBinding = richTextBinding || formattableBinding;
    return (
      <>
        <div className="flex items-center gap-1">
          <Button
            asChild
            variant="data"
            className="justify-between! cursor-pointer flex-1"
            onClick={() => setSheetOpen(true)}
          >
            <div>
              <span className="flex items-center gap-1.5 truncate">
                <Icon name="database" className="size-3 opacity-60 shrink-0" />
                <span className="truncate">{activeBinding!.label || 'CMS Field'}</span>
              </span>
              <Button
                className="size-4! p-0! shrink-0"
                variant="outline"
                onClick={(e) => {
                  e.stopPropagation();
                  if (onClear) {
                    onClear();
                  } else {
                    onChange({ type: 'doc', content: [{ type: 'paragraph' }] });
                  }
                }}
              >
                <Icon name="x" className="size-2" />
              </Button>
            </div>
          </Button>
          {formattableBinding && (
            <VariableFormatSelector
              fieldType={formattableBinding.field_type}
              currentFormat={formattableBinding.format}
              onFormatChange={handleFormatChange}
              variant="sidebar"
            />
          )}
        </div>
        <RichTextEditorSheet
          open={sheetOpen}
          onOpenChange={(open) => {
            setSheetOpen(open);
            if (!open) onBlur?.(value);
          }}
          title={sheetTitle}
          description={sheetDescription}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          fieldGroups={fieldGroups}
          allFields={allFields}
          collections={collections}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="flex-1 gap-2.5"
          onClick={() => setSheetOpen(true)}
        >
          Expand
          <span><Icon name="expand" className="size-2.5" /></span>
        </Button>

        {buttonOnly && canShowVariables && (
          <DropdownMenu
            open={cmsDropdownOpen}
            onOpenChange={setCmsDropdownOpen}
          >
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                title="Insert CMS Variable"
              >
                <Icon name="database" className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            {fieldGroups && (
              <DropdownMenuContent
                className="w-56 py-1 px-1"
                align="end"
                sideOffset={4}
              >
                <CollectionFieldSelector
                  fieldGroups={textFieldGroups}
                  allFields={allFields || {}}
                  collections={collections || []}
                  onSelect={handleFieldSelect}
                />
              </DropdownMenuContent>
            )}
          </DropdownMenu>
        )}
      </div>

      {!buttonOnly && !isComplex && (
        <RichTextEditor
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          placeholder={placeholder}
          fieldGroups={fieldGroups}
          allFields={allFields}
          collections={collections}
          withFormatting={true}
          showFormattingToolbar={false}
          disabled={disabled}
          allowedFieldTypes={allowedFieldTypes}
        />
      )}

      <RichTextEditorSheet
        open={sheetOpen}
        onOpenChange={(open) => {
          setSheetOpen(open);
          if (!open) onBlur?.(value);
        }}
        title={sheetTitle}
        description={sheetDescription}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        fieldGroups={fieldGroups}
        allFields={allFields}
        collections={collections}
      />
    </div>
  );
}

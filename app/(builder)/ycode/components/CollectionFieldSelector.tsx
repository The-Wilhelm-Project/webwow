'use client';

/**
 * Collection Field Selector
 *
 * Recursive component for selecting fields from a collection with nested reference support.
 * Reference fields appear as collapsible group headers, and their linked collection's fields
 * appear nested underneath. Multi-reference fields are excluded.
 */

import React, { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import Icon from '@/components/ui/icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { selectVariants } from '@/components/ui/select';
import type { CollectionField, Collection, CollectionFieldType } from '@/types';
import { getFieldIcon, filterFieldGroupsByType, flattenFieldGroups, DISPLAYABLE_FIELD_TYPES } from '@/lib/collection-field-utils';

// Import and re-export from centralized location for backwards compatibility
import type { FieldSourceType, FieldGroup } from '@/lib/collection-field-utils';
export type { FieldSourceType, FieldGroup } from '@/lib/collection-field-utils';

/**
 * Derives the effective allowed types from pre-filtered field groups by collecting
 * all non-reference field types present. Used to constrain reference sub-options
 * to the same types that were used to filter the root level.
 */
function deriveAllowedTypesFromGroups(fieldGroups: FieldGroup[]): CollectionFieldType[] {
  const types = new Set<CollectionFieldType>();
  for (const group of fieldGroups) {
    for (const field of group.fields) {
      if (field.type !== 'reference' && field.type !== 'multi_reference') {
        types.add(field.type as CollectionFieldType);
      }
    }
  }
  return Array.from(types);
}

interface CollectionFieldListProps {
  /** Fields to display at the current level */
  fields: CollectionField[];
  /** All fields keyed by collection ID for resolving nested references */
  allFields: Record<string, CollectionField[]>;
  /** All collections for looking up collection names */
  collections: Collection[];
  /** Callback when a field is selected */
  onSelect: (fieldId: string, relationshipPath: string[], source?: FieldSourceType, layerId?: string) => void;
  /** Current relationship path (used internally for recursion) */
  relationshipPath?: string[];
  /** Source type for these fields (used internally for recursion) */
  source?: FieldSourceType;
  /** ID of the collection layer these fields belong to */
  layerId?: string;
  /** Depth level for indentation (used internally) */
  depth?: number;
  /** Allowed field types for filtering sub-options */
  allowedTypes?: CollectionFieldType[];
}

/**
 * Single field item (selectable)
 */
function FieldItem({
  field,
  onSelect,
  depth = 0,
}: {
  field: CollectionField;
  onSelect: () => void;
  depth?: number;
}) {
  const iconName = getFieldIcon(field.type);

  return (
    <DropdownMenuItem
      onClick={onSelect}
      className="gap-2"
      style={{ paddingLeft: `${8 + depth * 16}px` }}
    >
      <Icon name={iconName} className="size-3 text-muted-foreground shrink-0" />
      <span className="truncate">{field.name}</span>
    </DropdownMenuItem>
  );
}

/**
 * Reference field group (submenu)
 */
function ReferenceFieldGroup({
  field,
  allFields,
  collections,
  onSelect,
  relationshipPath,
  source,
  layerId,
  depth = 0,
  allowedTypes,
}: {
  field: CollectionField;
  allFields: Record<string, CollectionField[]>;
  collections: Collection[];
  onSelect: (fieldId: string, relationshipPath: string[], source?: FieldSourceType, layerId?: string) => void;
  relationshipPath: string[];
  source?: FieldSourceType;
  layerId?: string;
  depth?: number;
  allowedTypes?: CollectionFieldType[];
}) {
  const referencedCollectionId = field.reference_collection_id;
  const referencedFields = referencedCollectionId ? allFields[referencedCollectionId] || [] : [];
  const referencedCollection = collections.find((c) => c.id === referencedCollectionId);

  // Filter sub-fields: exclude multi_reference, apply allowedTypes if provided (keeping reference for deep nesting)
  const displayableFields = referencedFields.filter((f) => {
    if (f.type === 'multi_reference') return false;
    if (allowedTypes && allowedTypes.length > 0 && f.type !== 'reference') {
      return allowedTypes.includes(f.type);
    }
    return true;
  });
  if (displayableFields.length === 0) return null;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className="gap-2"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        <Icon name="database" className="size-3 text-muted-foreground shrink-0" />
        <span className="truncate">{field.name}</span>
      </DropdownMenuSubTrigger>

      {(
        <DropdownMenuSubContent className="min-w-45">
          {referencedCollection && (
            <DropdownMenuLabel className="text-xs text-foreground/80 flex items-center justify-between gap-2">
              <span>{referencedCollection.name}</span>
              <DropdownMenuShortcut className="tracking-normal">Ref. field</DropdownMenuShortcut>
            </DropdownMenuLabel>
          )}
          <CollectionFieldSelectorInner
            fields={displayableFields}
            allFields={allFields}
            collections={collections}
            onSelect={onSelect}
            relationshipPath={[...relationshipPath, field.id]}
            source={source}
            layerId={layerId}
            depth={0}
            allowedTypes={allowedTypes}
          />
        </DropdownMenuSubContent>
      )}
    </DropdownMenuSub>
  );
}

/**
 * Inner recursive component
 */
function CollectionFieldSelectorInner({
  fields,
  allFields,
  collections,
  onSelect,
  relationshipPath = [],
  source,
  layerId,
  depth = 0,
  allowedTypes,
}: CollectionFieldListProps) {
  // Filter out multi-reference fields
  const displayableFields = fields.filter((f) => f.type !== 'multi_reference');

  return (
    <div className="flex flex-col">
      {displayableFields.map((field) => {
        // Reference fields become collapsible groups
        if (field.type === 'reference' && field.reference_collection_id) {
          return (
            <ReferenceFieldGroup
              key={field.id}
              field={field}
              allFields={allFields}
              collections={collections}
              onSelect={onSelect}
              relationshipPath={relationshipPath}
              source={source}
              layerId={layerId}
              depth={depth}
              allowedTypes={allowedTypes}
            />
          );
        }

        // Regular fields are selectable
        return (
          <FieldItem
            key={field.id}
            field={field}
            depth={depth}
            onSelect={() => {
              if (relationshipPath.length > 0) {
                // Nested field: include relationship path
                onSelect(relationshipPath[0], [...relationshipPath.slice(1), field.id], source, layerId);
              } else {
                // Root field: no relationship path
                onSelect(field.id, [], source, layerId);
              }
            }}
          />
        );
      })}
    </div>
  );
}

interface CollectionFieldSelectorProps {
  /** Field groups to display, each with their own source and label */
  fieldGroups: FieldGroup[];
  /** All fields keyed by collection ID for resolving nested references */
  allFields: Record<string, CollectionField[]>;
  /** All collections for looking up collection names */
  collections: Collection[];
  /** Callback when a field is selected */
  onSelect: (fieldId: string, relationshipPath: string[], source?: FieldSourceType, layerId?: string) => void;
  /** Allowed field types for filtering sub-options in reference fields */
  allowedTypes?: CollectionFieldType[];
}

/**
 * Collection Field Selector
 *
 * Renders multiple field groups (e.g. collection layer + page collection) with labels.
 * Reference fields use submenus for their nested fields.
 */
export function CollectionFieldSelector({
  fieldGroups,
  allFields,
  collections,
  onSelect,
  allowedTypes,
}: CollectionFieldSelectorProps) {
  // Derive effective types from the incoming groups when not explicitly provided.
  // Call sites already pre-filter groups to specific types, so the non-reference
  // types present in the groups reflect the intended constraint.
  const effectiveAllowedTypes = allowedTypes ?? deriveAllowedTypesFromGroups(fieldGroups);

  // Single filter pass: keeps only matching fields and excludes reference fields
  // whose referenced collections have no matching sub-fields (via allFields check).
  const nonEmptyGroups = filterFieldGroupsByType(
    fieldGroups,
    effectiveAllowedTypes.length > 0 ? effectiveAllowedTypes : DISPLAYABLE_FIELD_TYPES,
    { allFields },
  );

  if (nonEmptyGroups.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-zinc-500">
        No fields available
      </div>
    );
  }

  return (
    <div>
      {nonEmptyGroups.map((group, index) => {
        const displayableFields = group.fields.filter((f) => f.type !== 'multi_reference');
        if (displayableFields.length === 0) return null;

        const groupKey = `${group.source || 'default'}-${group.layerId || index}`;
        return (
          <div key={groupKey}>
            {/* Add separator between groups (not before first) */}
            {index > 0 && <DropdownMenuSeparator />}
            {(group.label || group.detail) && (
              <DropdownMenuLabel className="text-xs text-foreground/80 flex items-center justify-between gap-2">
                <span>{group.label}</span>
                {group.detail && (
                  <DropdownMenuShortcut className="tracking-normal">
                    {group.detail}
                  </DropdownMenuShortcut>
                )}
              </DropdownMenuLabel>
            )}
            <CollectionFieldSelectorInner
              fields={displayableFields}
              allFields={allFields}
              collections={collections}
              onSelect={onSelect}
              relationshipPath={[]}
              source={group.source}
              layerId={group.layerId}
              depth={0}
              allowedTypes={effectiveAllowedTypes}
            />
          </div>
        );
      })}
    </div>
  );
}

export default CollectionFieldSelector;

interface FieldSelectDropdownProps {
  /** Field groups with labels and sources */
  fieldGroups: FieldGroup[];
  /** All fields keyed by collection ID for resolving nested references */
  allFields: Record<string, CollectionField[]>;
  /** All collections for looking up collection names */
  collections: Collection[];
  /** Currently selected field ID */
  value?: string | null;
  /** Callback when a field is selected - receives encoded value with source/layerId */
  onSelect: (fieldId: string, relationshipPath: string[], source?: FieldSourceType, layerId?: string) => void;
  /** Placeholder text when no field is selected */
  placeholder?: string;
  /** Whether the dropdown is disabled */
  disabled?: boolean;
  /** Additional class names for the trigger button */
  className?: string;
  /** Field types to filter to (defaults to all displayable types) */
  allowedFieldTypes?: CollectionFieldType[];
}

/**
 * Field Select Dropdown
 *
 * A complete dropdown component for selecting CMS fields with submenu support.
 * Use this as a drop-in replacement for Select-based field selectors.
 */
export function FieldSelectDropdown({
  fieldGroups,
  allFields,
  collections,
  value,
  onSelect,
  placeholder = 'Select...',
  disabled = false,
  className,
  allowedFieldTypes,
}: FieldSelectDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Filter field groups by allowed types
  const filteredGroups = useMemo(() => {
    const types = allowedFieldTypes && allowedFieldTypes.length > 0 ? allowedFieldTypes : DISPLAYABLE_FIELD_TYPES;
    return filterFieldGroupsByType(fieldGroups, types, { allFields });
  }, [fieldGroups, allowedFieldTypes, allFields]);

  // Find the selected field for display
  const selectedField = useMemo(() => {
    if (!value) return null;
    const allFlatFields = flattenFieldGroups(filteredGroups);
    return allFlatFields.find(f => f.id === value) || null;
  }, [value, filteredGroups]);

  const handleSelect = (fieldId: string, relationshipPath: string[], source?: FieldSourceType, layerId?: string) => {
    onSelect(fieldId, relationshipPath, source, layerId);
    setIsOpen(false);
  };

  const hasFields = filteredGroups.length > 0;

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            selectVariants({ variant: 'default', size: 'sm' }),
            'w-full cursor-pointer',
            className
          )}
          disabled={disabled || !hasFields}
        >
          <span className="flex items-center gap-2 truncate">
            {selectedField ? (
              <>
                <Icon name={getFieldIcon(selectedField.type)} className="size-3 text-muted-foreground shrink-0" />
                <span className="truncate">{selectedField.name}</span>
              </>
            ) : (
              <span className="text-muted-foreground">{hasFields ? placeholder : 'No fields available'}</span>
            )}
          </span>
          <Icon name="chevronDown" className="size-2.5 opacity-50 shrink-0" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-56 max-h-none!" align="end">
        <CollectionFieldSelector
          fieldGroups={filteredGroups}
          allFields={allFields}
          collections={collections}
          onSelect={handleSelect}
          allowedTypes={allowedFieldTypes}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

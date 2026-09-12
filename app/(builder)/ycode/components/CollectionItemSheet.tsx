'use client';

/**
 * Collection Item Sheet
 *
 * Reusable sheet for creating/editing collection items.
 * Can be used from CMS page or triggered from builder canvas.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetActions,
} from '@/components/ui/sheet';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import RichTextEditor from './RichTextEditor';
import RichTextEditorSheet from './RichTextEditorSheet';
import { useCollectionsStore } from '@/stores/useCollectionsStore';
import { useCollectionLayerStore } from '@/stores/useCollectionLayerStore';
import { usePagesStore } from '@/stores/usePagesStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { useAssetsStore } from '@/stores/useAssetsStore';
import { useLocalisationStore } from '@/stores/useLocalisationStore';
import { useLocalizationMode } from '@/hooks/use-localization-mode';
import { useLiveCollectionUpdates } from '@/hooks/use-live-collection-updates';
import { useResourceLock } from '@/hooks/use-resource-lock';
import { slugify, normalizeBooleanValue, parseMultiReferenceValue } from '@/lib/collection-utils';
import { sanitizeSlug } from '@/lib/page-utils';
import { isAssetFieldType, isMultipleAssetField, getFileManagerCategory, getAssetFieldLabel, getAssetFieldTypeLabel, isValidAssetForField, findStatusFieldId } from '@/lib/collection-field-utils';
import type { StatusAction } from '@/lib/collection-field-utils';
import { CollectionStatusPill, parseStatusValue } from './CollectionStatusPill';
import { formatDateInTimezone, localDatetimeToUTC, clampDateInputValue } from '@/lib/date-format-utils';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { toast } from 'sonner';
import ReferenceFieldCombobox from './ReferenceFieldCombobox';
import CollectionLinkFieldInput from './CollectionLinkFieldInput';
import ColorFieldInput from './ColorFieldInput';
import AssetFieldCard, { SortableAssetFieldCard } from './AssetFieldCard';
import { DndContext, closestCenter, useSensor, useSensors, PointerSensor } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import type { Asset, CollectionField, CollectionItemWithValues, CreateTranslationData } from '@/types';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { getSyncedFieldIds, fetchCachedConnections } from '@/lib/apps/airtable/client';

interface CollectionItemSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collectionId: string;
  itemId?: string | null; // null = create new, string = edit existing
  onSuccess?: () => void;
}

export default function CollectionItemSheet({
  open,
  onOpenChange,
  collectionId,
  itemId,
  onSuccess,
}: CollectionItemSheetProps) {
  const { collections, fields, items, updateItem, createItem, setItemStatus } = useCollectionsStore();
  const { updateItemInLayerData, invalidateLayerData, refetchLayersForCollection } = useCollectionLayerStore();
  const { updatePageCollectionItem, refetchPageCollectionItem, pages } = usePagesStore();
  const currentPageId = useEditorStore((state) => state.currentPageId);
  const openFileManager = useEditorStore((state) => state.openFileManager);
  const getAsset = useAssetsStore((state) => state.getAsset);
  const timezone = useSettingsStore((state) => state.settingsByKey.timezone as string | null) ?? 'UTC';

  // Localization: when the user is browsing the canvas in a non-default
  // locale, this sheet edits CMS *translations* rather than the canonical
  // collection item values. Reads/writes go through the translations table
  // so canvas + preview pick up the new copy via applyCmsTranslations.
  const { isLocalizing, currentLocale } = useLocalizationMode();
  const selectedLocaleId = useLocalisationStore((state) => state.selectedLocaleId);
  const createTranslation = useLocalisationStore((state) => state.createTranslation);
  const updateTranslation = useLocalisationStore((state) => state.updateTranslation);
  const deleteTranslation = useLocalisationStore((state) => state.deleteTranslation);

  // Collection collaboration sync
  const liveCollectionUpdates = useLiveCollectionUpdates();

  // Item locking for collaboration
  const itemLock = useResourceLock({
    resourceType: 'collection_item',
    channelName: collectionId ? `collection:${collectionId}:item_locks` : '',
  });

  // Stable ref for lock functions to avoid dependency issues in effects
  const itemLockRef = useRef(itemLock);
  useEffect(() => {
    itemLockRef.current = itemLock;
  }, [itemLock]);

  const lockedItemIdRef = useRef<string | null>(null);

  const [editingItem, setEditingItem] = useState<CollectionItemWithValues | null>(null);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [expandedRichTextField, setExpandedRichTextField] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const pendingStatusActionRef = useRef<StatusAction | null>(null);

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const collection = collections.find(c => c.id === collectionId);
  const collectionFields = useMemo(
    () => (collectionId ? (fields[collectionId] || []) : []),
    [collectionId, fields]
  );
  const collectionItems = useMemo(
    () => (collectionId ? (items[collectionId] || []) : []),
    [collectionId, items]
  );
  const statusFieldId = useMemo(
    () => findStatusFieldId(collectionFields),
    [collectionFields]
  );

  // Fields managed by Airtable sync — disabled in the form
  const [syncedFieldIds, setSyncedFieldIds] = useState<Set<string>>(
    () => getSyncedFieldIds(collectionId)
  );

  useEffect(() => {
    setSyncedFieldIds(getSyncedFieldIds(collectionId));
    fetchCachedConnections().then(() => {
      setSyncedFieldIds(getSyncedFieldIds(collectionId));
    });
  }, [collectionId]);

  // Check if the current page is a dynamic page using this collection
  const currentPage = currentPageId ? pages.find(p => p.id === currentPageId) : null;
  const isPageLevelItem = currentPage?.is_dynamic && currentPage?.settings?.cms?.collection_id === collectionId;

  // Find name and slug fields for validation (only if editable in the form)
  const nameField = useMemo(
    () => collectionFields.find(f => f.key === 'name' && f.fillable),
    [collectionFields]
  );

  const slugField = useMemo(
    () => collectionFields.find(f => f.key === 'slug' && f.fillable),
    [collectionFields]
  );

  // Validate slug uniqueness
  const validateSlugUniqueness = useCallback(
    (value: string, fieldId: string) => {
      if (!value) return true; // Allow empty (other validation can handle required)
      // Check if slug exists in other items (exclude current item when editing)
      const existingItem = collectionItems.find(
        item => item.values[fieldId] === value && item.id !== editingItem?.id
      );
      return !existingItem;
    },
    [collectionItems, editingItem?.id]
  );

  const form = useForm();
  // Subscribe to isDirty at render level so react-hook-form tracks it
  const { isDirty } = form.formState;

  // Helper to detect temporary IDs (from optimistic creates)
  const isTempId = (id: string | null | undefined): boolean => {
    return !!id && (id.startsWith('temp-') || id.startsWith('temp-dup-'));
  };

  // Compute status for the current item from the status field value
  const isNewItem = !editingItem || isTempId(editingItem.id);
  const statusValue = (editingItem && statusFieldId) ? parseStatusValue(editingItem.values[statusFieldId]) : null;
  const isPublishable = statusValue?.is_publishable ?? editingItem?.is_publishable ?? true;
  const hasPublishedVersion = statusValue?.is_published ?? false;

  // Load item data when sheet opens with an itemId
  useEffect(() => {
    // Only load item data when sheet is open and we have an itemId
    if (!open) return;

    if (itemId && collectionItems.length > 0) {
      const item = collectionItems.find(i => i.id === itemId);
      // If itemId is a temp ID, also try to find by matching the temp pattern
      // (the item might have been replaced with the real ID)
      if (!item && isTempId(itemId)) {
        // Item with temp ID not found - it may have been replaced with real ID
        // Keep the current editingItem if it exists
        return;
      }
      setEditingItem(item || null);
    } else if (!itemId) {
      setEditingItem(null);
    }
  }, [itemId, open, collectionItems]);

  // Acquire/release item lock when sheet opens/closes
  useEffect(() => {
    const acquireItemLock = async () => {
      if (open && itemId && itemId !== 'new') {
        const acquired = await itemLockRef.current.acquireLock(itemId);
        if (acquired) {
          lockedItemIdRef.current = itemId;
        }
      }
    };

    const releaseItemLock = async () => {
      if (lockedItemIdRef.current) {
        await itemLockRef.current.releaseLock(lockedItemIdRef.current);
        lockedItemIdRef.current = null;
      }
    };

    if (open && itemId && itemId !== 'new') {
      acquireItemLock();
    } else {
      releaseItemLock();
    }

    return () => {
      releaseItemLock();
    };
  }, [open, itemId]);

  // Translatable CMS field types — must match extractCmsTranslatableItems /
  // applyCmsTranslations so the read + write paths agree on which fields are
  // localised vs canonical.
  const isTranslatableField = useCallback((field: CollectionField) => {
    return field.type === 'text' || field.type === 'rich_text';
  }, []);

  const buildCmsContentKey = useCallback((field: CollectionField) => {
    return field.key ? `field:key:${field.key}` : `field:id:${field.id}`;
  }, []);

  // Reset form when editing item changes. In localizing mode, translatable
  // fields seed from the saved translation (parsed for rich text); other
  // fields keep their canonical values for read-only context. We deliberately
  // snapshot translations once on mount/locale switch so a background refresh
  // doesn't clobber the user's in-flight edits.
  useEffect(() => {
    const editableFields = collectionFields.filter(f => f.fillable);

    if (editingItem) {
      const localeTranslations = isLocalizing && selectedLocaleId
        ? useLocalisationStore.getState().translations[selectedLocaleId]
        : undefined;

      const values: Record<string, any> = {};
      editableFields.forEach(field => {
        let value: any;
        if (isLocalizing && localeTranslations && isTranslatableField(field)) {
          const tKey = `cms:${editingItem.id}:${buildCmsContentKey(field)}`;
          const translation = localeTranslations[tKey];
          const stored = translation?.content_value || '';
          if (field.type === 'rich_text') {
            if (stored) {
              try {
                value = JSON.parse(stored);
              } catch {
                value = '';
              }
            } else {
              value = '';
            }
          } else {
            value = stored;
          }
        } else {
          value = editingItem.values[field.id] ?? '';
          if (field.type === 'boolean') {
            value = normalizeBooleanValue(value);
          }
        }
        values[field.id] = value;
      });
      form.reset(values);
    } else {
      const defaultValues: Record<string, any> = {};
      editableFields.forEach(field => {
        let value = field.default || '';
        if (field.type === 'boolean') {
          value = normalizeBooleanValue(value);
        }
        defaultValues[field.id] = value;
      });
      form.reset(defaultValues);
    }
  }, [editingItem, collectionFields, form, isLocalizing, selectedLocaleId, isTranslatableField, buildCmsContentKey]);

  // Handle auto-focus on sheet open
  const handleOpenAutoFocus = useCallback((e: Event) => {
    // Only focus name field when creating a new item
    if (!itemId && nameInputRef.current) {
      e.preventDefault(); // Prevent default focus behavior
      nameInputRef.current.focus();
    }
  }, [itemId]);

  // Auto-fill slug field based on name field (debounced to avoid race conditions)
  useEffect(() => {
    if (!editingItem) {
      const nameField = collectionFields.find(f => f.key === 'name');
      const localSlugField = collectionFields.find(f => f.key === 'slug');

      if (nameField && localSlugField) {
        let timeoutId: NodeJS.Timeout | null = null;

        const subscription = form.watch((value, { name }) => {
          if (name === nameField.id) {
            // Clear any pending timeout
            if (timeoutId) {
              clearTimeout(timeoutId);
            }

            // Debounce the slug update to ensure we have the latest value
            timeoutId = setTimeout(() => {
              const nameValue = form.getValues(nameField.id);
              if (nameValue && typeof nameValue === 'string') {
                const slugValue = slugify(nameValue);
                form.setValue(localSlugField.id, slugValue);
              }
            }, 50);
          }
        });

        return () => {
          subscription.unsubscribe();
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
        };
      }
    }
  }, [form, editingItem, collectionFields]);

  // Save flow for non-default locales. Each translatable text/rich_text
  // field is created/updated/deleted in the translations table; everything
  // else is left untouched. Canvas + preview re-read translations from the
  // store via applyCmsTranslations, so no extra optimistic patching of the
  // canonical item is needed.
  const handleLocalizedSubmit = (values: Record<string, any>) => {
    if (!editingItem || !selectedLocaleId) {
      toast.error('Cannot save translation', {
        description: !editingItem
          ? 'Translations can only be added to existing items.'
          : 'No locale selected.',
      });
      return;
    }

    const localeTranslations = useLocalisationStore.getState().translations[selectedLocaleId] || {};
    const itemId = editingItem.id;
    const promises: Promise<unknown>[] = [];

    for (const field of collectionFields) {
      if (!field.fillable || !isTranslatableField(field)) continue;
      const contentKey = buildCmsContentKey(field);
      const tKey = `cms:${itemId}:${contentKey}`;
      const existing = localeTranslations[tKey];

      const raw = values[field.id];
      let serialized: string;
      if (field.type === 'rich_text') {
        if (raw && typeof raw === 'object') {
          serialized = JSON.stringify(raw);
        } else if (typeof raw === 'string') {
          serialized = raw.trim();
        } else {
          serialized = '';
        }
      } else {
        serialized = typeof raw === 'string' ? raw.trim() : '';
      }

      const previous = existing?.content_value || '';
      if (serialized === previous) continue;

      if (!serialized) {
        if (existing) {
          promises.push(deleteTranslation(existing));
        }
        continue;
      }

      if (existing) {
        promises.push(updateTranslation(existing, { content_value: serialized, is_completed: true }));
      } else {
        const data: CreateTranslationData = {
          locale_id: selectedLocaleId,
          source_type: 'cms',
          source_id: itemId,
          content_key: contentKey,
          content_type: field.type === 'rich_text' ? 'richtext' : 'text',
          content_value: serialized,
          is_completed: true,
        };
        promises.push(createTranslation(data));
      }
    }

    setEditingItem(null);
    form.reset();
    if (onSuccess) {
      onSuccess();
    } else {
      onOpenChange(false);
    }

    if (promises.length === 0) return;

    Promise.all(promises)
      .then(() => {
        if (isPageLevelItem && currentPageId) {
          refetchPageCollectionItem(currentPageId);
        }
      })
      .catch((error) => {
        console.error('Failed to save translations:', error);
        toast.error('Failed to save translations', {
          description: 'Please try again.',
        });
      });
  };

  const handleSubmit = (values: Record<string, any>) => {
    if (!collectionId) return;

    // Localising flow runs entirely against the translations table — see
    // the dedicated branch further down. Skip canonical-field validation
    // (required name / unique slug) since the translation may be empty
    // (= fall back to source) and slug uniqueness is per-locale anyway.
    if (isLocalizing) {
      handleLocalizedSubmit(values);
      return;
    }

    // Normalize boolean values to strings before submitting
    collectionFields.forEach(field => {
      if (field.type === 'boolean' && field.id in values) {
        values[field.id] = normalizeBooleanValue(values[field.id]);
      }
    });

    // Normalize the slug to a valid URL segment before validation/save so a
    // pasted leading slash, spaces or invalid chars can't break routing.
    if (slugField && typeof values[slugField.id] === 'string') {
      values[slugField.id] = slugify(values[slugField.id]);
    }

    let hasErrors = false;

    // Validate required fields
    if (nameField) {
      const nameValue = values[nameField.id]?.trim();
      if (!nameValue) {
        form.setError(nameField.id, {
          type: 'manual',
          message: 'Name is required',
        });
        hasErrors = true;
      }
    }

    if (slugField) {
      const slugValue = values[slugField.id]?.trim();
      if (!slugValue) {
        form.setError(slugField.id, {
          type: 'manual',
          message: 'Slug is required',
        });
        hasErrors = true;
      } else if (!validateSlugUniqueness(slugValue, slugField.id)) {
        // Validate slug uniqueness
        form.setError(slugField.id, {
          type: 'manual',
          message: 'This slug already exists in this collection',
        });
        hasErrors = true;
      }
    }

    if (hasErrors) return;

    // Store editingItem reference before closing (needed for API call below)
    const itemToUpdate = editingItem;

    // Close sheet immediately (optimistic UI) - only use onSuccess to avoid double-close race condition
    setEditingItem(null);
    form.reset();
    if (onSuccess) {
      onSuccess();
    } else {
      onOpenChange(false);
    }

    if (itemToUpdate) {
      // Update existing item

      // 1. Optimistically update in collection layer store (for collection layers)
      updateItemInLayerData(itemToUpdate.id, values);

      // 2. Optimistically update in pages store (for dynamic pages)
      if (isPageLevelItem && currentPageId) {
        updatePageCollectionItem(currentPageId, {
          ...itemToUpdate,
          values,
          updated_at: new Date().toISOString(),
        });
      }

      // 3. Update in main collections store (fire and forget - store handles optimistic update & rollback)
      const itemId = itemToUpdate.id;
      const statusAction = pendingStatusActionRef.current;
      pendingStatusActionRef.current = null;
      updateItem(collectionId, itemId, values)
        .then(() => {
          // Apply status action after save completes
          if (statusAction) {
            setItemStatus(collectionId, itemId, statusAction);
          }
          // Broadcast item update to other collaborators
          if (liveCollectionUpdates) {
            liveCollectionUpdates.broadcastItemUpdate(collectionId, itemId, { values } as any);
          }

          // Invalidate + refetch AFTER the API update completes to avoid
          // stale data overwriting the optimistic update
          invalidateLayerData(collectionId);
          refetchLayersForCollection(collectionId);

          if (isPageLevelItem && currentPageId) {
            refetchPageCollectionItem(currentPageId);
          }
        })
        .catch((error) => {
          console.error('Failed to update item:', error);
          toast.error('Failed to save item', {
            description: 'Changes have been reverted.',
          });
        });
    } else {
      // Create new item (store handles optimistic update & rollback)
      const statusAction = pendingStatusActionRef.current;
      pendingStatusActionRef.current = null;
      createItem(collectionId, values, statusAction ?? undefined)
        .then((newItem) => {
          // Broadcast item creation to other collaborators
          if (liveCollectionUpdates && newItem) {
            liveCollectionUpdates.broadcastItemCreate(collectionId, newItem);
          }

          // Invalidate + refetch to sync collection layers
          invalidateLayerData(collectionId);
          setTimeout(() => {
            refetchLayersForCollection(collectionId);

            // Also refetch page data if on dynamic page
            if (isPageLevelItem && currentPageId) {
              refetchPageCollectionItem(currentPageId);
            }
          }, 100);
        })
        .catch((error) => {
          console.error('Failed to create item:', error);
          toast.error('Failed to create item', {
            description: 'Please try again.',
          });
        });
    }
  };

  // Handle sheet close - check for unsaved changes
  const handleOpenChange = useCallback((isOpen: boolean) => {
    if (!isOpen && isDirty) {
      // Show unsaved changes dialog instead of closing
      setShowUnsavedDialog(true);
      return;
    }
    if (!isOpen) {
      form.clearErrors();
    }
    onOpenChange(isOpen);
  }, [onOpenChange, form, isDirty]);

  // Discard unsaved changes and close sheet
  const handleConfirmDiscard = useCallback(() => {
    setShowUnsavedDialog(false);
    form.clearErrors();
    form.reset();
    setEditingItem(null);
    onOpenChange(false);
  }, [form, onOpenChange]);

  // Cancel discard - keep sheet open
  const handleCancelDiscard = useCallback(() => {
    setShowUnsavedDialog(false);
  }, []);

  // Keep a stable ref to handleSubmit to avoid re-creating handleSaveFromDialog on every render
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  // Save changes from dialog, then close
  const handleSaveFromDialog = useCallback(async () => {
    setShowUnsavedDialog(false);
    // Trigger form submission programmatically
    form.handleSubmit(handleSubmitRef.current)();
  }, [form]);

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent onOpenAutoFocus={handleOpenAutoFocus} aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 flex-wrap">
            {isLocalizing && currentLocale
              ? `Translate ${collection?.name} Item`
              : `${editingItem ? 'Edit' : 'Create'} ${collection?.name} Item`}
            {!isNewItem && statusValue && !isLocalizing && (
              <CollectionStatusPill statusValue={statusValue} />
            )}
            {isLocalizing && currentLocale && (
              <span className="text-xs text-muted-foreground font-normal">
                Translate to {currentLocale.label}
              </span>
            )}
          </SheetTitle>
          <SheetActions>
            {/* More options dropdown — hidden while translating, the only
                action there is Delete which doesn't apply to translations. */}
            {editingItem && !isTempId(editingItem.id) && !isLocalizing && (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="secondary">
                    <Icon name="dotsHorizontal" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => {
                      onOpenChange(false);
                      toast.info('Use the context menu in the CMS table to delete items');
                    }}
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Save button. The status-action dropdown (draft / publish) is
                hidden when translating since those operate at the canonical
                item level — translations are saved as a single unit. */}
            <div className="flex">
              <Button
                size="sm"
                type="submit"
                form="collection-item-form"
                disabled={isTempId(editingItem?.id) || (isLocalizing && !editingItem)}
                className={isLocalizing ? '' : 'rounded-r-none'}
              >
                {isLocalizing
                  ? 'Save translation'
                  : editingItem
                    ? (isTempId(editingItem.id) ? 'Saving...' : 'Save')
                    : 'Create'}
              </Button>
              {!isLocalizing && (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      variant="default"
                      className="rounded-l-none border-l border-primary-foreground/20 px-1.5"
                      disabled={isTempId(editingItem?.id)}
                    >
                      <Icon name="triangle-down" className="w-3 h-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {!isNewItem && (
                      <DropdownMenuItem
                        onClick={() => {
                          pendingStatusActionRef.current = 'stage';
                          form.handleSubmit(handleSubmit)();
                        }}
                      >
                        Save as staged for publish
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      onClick={() => {
                        pendingStatusActionRef.current = 'draft';
                        form.handleSubmit(handleSubmit)();
                      }}
                    >
                      {isNewItem ? 'Create' : 'Save'} as draft
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!collection?.has_published_version}
                      onClick={() => {
                        pendingStatusActionRef.current = 'publish';
                        form.handleSubmit(handleSubmit)();
                      }}
                    >
                      {isNewItem ? 'Create' : 'Save'} and publish
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </SheetActions>
        </SheetHeader>

        <Form {...form}>
          <form
            id="collection-item-form"
            onSubmit={form.handleSubmit(handleSubmit)}
            className="flex flex-col gap-4 flex-1"
          >
            <div className="flex-1 flex flex-col gap-6">
              {collectionFields
                .filter(f => f.fillable)
                .map((field) => {
                  const isSynced = syncedFieldIds.has(field.id);
                  // While translating, lock everything that isn't a
                  // translatable text/rich_text field — the canonical value
                  // is shown read-only so the user has context, but only
                  // translatable fields can be edited per locale.
                  const isLockedForLocale = isLocalizing && !isTranslatableField(field);
                  const isFieldDisabled = isSynced || isLockedForLocale;

                  return (
                  <FormField
                    key={field.id}
                    control={form.control}
                    name={field.id}
                    render={({ field: formField }) => (
                      <FormItem>
                        <div className="flex items-center gap-2">
                          <FormLabel>{field.name}</FormLabel>
                          {(field.type === 'multi_reference') && (() => {
                            const ids = parseMultiReferenceValue(formField.value);
                            return ids.length > 0 ? (
                              <span className="text-[10px] text-muted-foreground leading-none">
                                {ids.length} item{ids.length !== 1 ? 's' : ''} selected
                              </span>
                            ) : null;
                          })()}
                          {isSynced && (
                            <span className="text-[10px] text-muted-foreground leading-none">
                              Synced from Airtable
                            </span>
                          )}
                          {isLockedForLocale && (
                            <span className="text-[10px] text-muted-foreground leading-none">
                              Not translatable
                            </span>
                          )}
                        </div>
                        <FormControl>
                          <div className={cn('min-w-0', isFieldDisabled && 'opacity-50 pointer-events-none')}>
                          {field.type === 'rich_text' ? (
                            <div>
                              <RichTextEditor
                                value={formField.value || ''}
                                onChange={formField.onChange}
                                placeholder={field.default || `Enter ${field.name.toLowerCase()}...`}
                                variant="full"
                                withFormatting={true}
                                excludedLinkTypes={['asset', 'field']}
                                hidePageContextOptions={true}
                                onExpandClick={() => setExpandedRichTextField(field.id)}
                              />
                              <RichTextEditorSheet
                                open={expandedRichTextField === field.id}
                                onOpenChange={(open) => { if (!open) setExpandedRichTextField(null); }}
                                description={`CMS item "${field.name}" field`}
                                value={formField.value || ''}
                                onChange={formField.onChange}
                                placeholder={field.default || `Enter ${field.name.toLowerCase()}...`}
                                hidePageContextOptions={true}
                              />
                            </div>
                          ) : field.type === 'reference' && field.reference_collection_id ? (
                            <ReferenceFieldCombobox
                              collectionId={field.reference_collection_id}
                              value={formField.value || ''}
                              onChange={formField.onChange}
                              isMulti={false}
                              placeholder={`Select ${field.name.toLowerCase()}...`}
                            />
                          ) : field.type === 'multi_reference' && field.reference_collection_id ? (
                            <ReferenceFieldCombobox
                              collectionId={field.reference_collection_id}
                              value={formField.value || '[]'}
                              onChange={formField.onChange}
                              isMulti={true}
                              placeholder={`Select ${field.name.toLowerCase()}...`}
                            />
                          ) : field.type === 'link' ? (
                            <CollectionLinkFieldInput
                              value={formField.value || ''}
                              onChange={formField.onChange}
                            />
                          ) : field.type === 'email' ? (
                            <Input
                              type="email"
                              placeholder={field.default || `Enter ${field.name.toLowerCase()}...`}
                              autoComplete="off"
                              {...formField}
                            />
                          ) : field.type === 'phone' ? (
                            <Input
                              type="tel"
                              placeholder={field.default || `Enter ${field.name.toLowerCase()}...`}
                              autoComplete="off"
                              {...formField}
                            />
                          ) : field.type === 'date' ? (
                            <Input
                              type="datetime-local"
                              autoComplete="off"
                              value={formatDateInTimezone(formField.value, timezone, 'datetime-local')}
                              onChange={(e) => {
                                const clamped = clampDateInputValue(e.target.value);
                                const utcValue = localDatetimeToUTC(clamped, timezone);
                                formField.onChange(utcValue);
                              }}
                            />
                          ) : field.type === 'date_only' ? (
                            <Input
                              type="date"
                              autoComplete="off"
                              value={formField.value?.slice(0, 10) || ''}
                              onChange={(e) => {
                                formField.onChange(clampDateInputValue(e.target.value) || '');
                              }}
                            />
                          ) : field.type === 'color' ? (
                            <ColorFieldInput
                              value={formField.value || ''}
                              onChange={formField.onChange}
                            />
                          ) : isMultipleAssetField(field) ? (
                            /* Multiple Asset Field */
                            (() => {
                              // Handle both array (from castValue) and JSON string formats
                              let assetIds: string[] = [];
                              const rawValue = formField.value;
                              if (Array.isArray(rawValue)) {
                                assetIds = rawValue;
                              } else if (typeof rawValue === 'string' && rawValue) {
                                try {
                                  const parsed = JSON.parse(rawValue);
                                  assetIds = Array.isArray(parsed) ? parsed : [];
                                } catch {
                                  assetIds = [];
                                }
                              }

                              const fieldTypeLabel = getAssetFieldTypeLabel(field.type);
                              const addButtonLabel = getAssetFieldLabel(field.type);

                              const showInvalidTypeError = () => {
                                const article = fieldTypeLabel === 'audio' ? 'an' : 'a';
                                toast.error('Invalid asset type', {
                                  description: `Please select ${article} ${fieldTypeLabel} file.`,
                                });
                              };

                              const handleAddAsset = () => {
                                openFileManager(
                                  (asset) => {
                                    if (!isValidAssetForField(asset, field.type)) {
                                      showInvalidTypeError();
                                      return false;
                                    }
                                    if (!assetIds.includes(asset.id)) {
                                      formField.onChange(JSON.stringify([...assetIds, asset.id]));
                                    }
                                  },
                                  undefined,
                                  getFileManagerCategory(field.type)
                                );
                              };

                              const handleReplaceAsset = (oldAssetId: string) => {
                                openFileManager(
                                  (asset) => {
                                    if (!isValidAssetForField(asset, field.type)) {
                                      showInvalidTypeError();
                                      return false;
                                    }
                                    formField.onChange(JSON.stringify(assetIds.map(id => id === oldAssetId ? asset.id : id)));
                                  },
                                  oldAssetId,
                                  getFileManagerCategory(field.type)
                                );
                              };

                              const handleRemoveAsset = (assetId: string) => {
                                formField.onChange(JSON.stringify(assetIds.filter(id => id !== assetId)));
                              };

                              const handleAssetDragEnd = (event: DragEndEvent) => {
                                const { active, over } = event;
                                if (!over || active.id === over.id) return;
                                const oldIndex = assetIds.indexOf(String(active.id));
                                const newIndex = assetIds.indexOf(String(over.id));
                                if (oldIndex === -1 || newIndex === -1) return;
                                formField.onChange(JSON.stringify(arrayMove(assetIds, oldIndex, newIndex)));
                              };

                              return (
                                <div className="space-y-2">
                                  {assetIds.length > 1 ? (
                                    <DndContext
                                      sensors={dndSensors}
                                      collisionDetection={closestCenter}
                                      onDragEnd={handleAssetDragEnd}
                                    >
                                      <SortableContext
                                        items={assetIds}
                                        strategy={rectSortingStrategy}
                                      >
                                        <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))]">
                                          {assetIds.map((assetId) => (
                                            <SortableAssetFieldCard
                                              key={assetId}
                                              id={assetId}
                                              asset={getAsset(assetId)}
                                              fieldType={field.type}
                                              onChangeFile={() => handleReplaceAsset(assetId)}
                                              onRemove={() => handleRemoveAsset(assetId)}
                                            />
                                          ))}
                                        </div>
                                      </SortableContext>
                                    </DndContext>
                                  ) : assetIds.length === 1 ? (
                                    <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))]">
                                      <AssetFieldCard
                                        asset={getAsset(assetIds[0])}
                                        fieldType={field.type}
                                        onChangeFile={() => handleReplaceAsset(assetIds[0])}
                                        onRemove={() => handleRemoveAsset(assetIds[0])}
                                      />
                                    </div>
                                  ) : null}
                                  <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    onClick={(e) => { e.stopPropagation(); handleAddAsset(); }}
                                  >
                                    <Icon name="plus" className="size-3" />
                                    Add {addButtonLabel}
                                  </Button>
                                </div>
                              );
                            })()
                          ) : isAssetFieldType(field.type) ? (
                            /* Single Asset Field */
                            (() => {
                              const currentAssetId = formField.value || null;
                              const currentAsset = currentAssetId ? getAsset(currentAssetId) : null;
                              const fieldTypeLabel = getAssetFieldTypeLabel(field.type);
                              const addButtonLabel = getAssetFieldLabel(field.type);

                              const handleOpenFileManager = () => {
                                openFileManager(
                                  (asset) => {
                                    if (!isValidAssetForField(asset, field.type)) {
                                      const article = fieldTypeLabel === 'audio' ? 'an' : 'a';
                                      toast.error('Invalid asset type', {
                                        description: `Please select ${article} ${fieldTypeLabel} file.`,
                                      });
                                      return false;
                                    }
                                    formField.onChange(asset.id);
                                  },
                                  currentAssetId,
                                  getFileManagerCategory(field.type)
                                );
                              };

                              if (!currentAsset) {
                                return (
                                  <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    className="w-fit"
                                    onClick={(e) => { e.stopPropagation(); handleOpenFileManager(); }}
                                  >
                                    <Icon name="plus" className="size-3" />
                                    Add {addButtonLabel}
                                  </Button>
                                );
                              }

                              return (
                                <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))]">
                                  <AssetFieldCard
                                    asset={currentAsset}
                                    fieldType={field.type}
                                    onChangeFile={handleOpenFileManager}
                                    onRemove={() => formField.onChange('')}
                                  />
                                </div>
                              );
                            })()
                          ) : field.type === 'boolean' ? (
                            <div className="flex items-center gap-2">
                              <Checkbox
                                id={`${field.id}-boolean`}
                                checked={formField.value === 'true'}
                                onCheckedChange={(checked) => formField.onChange(checked ? 'true' : 'false')}
                              />
                              <Label
                                htmlFor={`${field.id}-boolean`}
                                className="text-xs text-muted-foreground font-normal cursor-pointer gap-1"
                              >
                                Value is set to <span className="text-foreground">{formField.value === 'true' ? 'YES' : 'NO'}</span>
                              </Label>
                            </div>
                          ) : field.type === 'option' ? (
                            (() => {
                              const options = field.data?.options ?? [];
                              const currentValue = formField.value || '';
                              const hasMatchingOption = options.some(o => o.name.trim() === currentValue);
                              return (
                                <Select
                                  value={currentValue || '__none__'}
                                  onValueChange={(value) => {
                                    // Radix Select renders a hidden native <select> for form
                                    // integration that dispatches a spurious change event with
                                    // an empty value when the controlled `value` prop changes
                                    // externally (e.g. via form.reset) before the SelectItem
                                    // for that value has registered (the items live in a
                                    // Portal that mounts only when the select is open).
                                    // Ignore that spurious empty change so it can't clobber
                                    // the loaded form value. SelectItem disallows value="",
                                    // so an empty string is never user-initiated.
                                    if (value === '') return;
                                    formField.onChange(value === '__none__' ? '' : value);
                                  }}
                                  disabled={options.length === 0}
                                >
                                  <SelectTrigger className="w-full">
                                    <SelectValue placeholder={options.length === 0 ? 'No options available' : `Select ${field.name.toLowerCase()}...`} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectGroup>
                                      <SelectItem value="__none__">None</SelectItem>
                                      {options
                                        .filter(o => o.name.trim().length > 0)
                                        .map((option) => (
                                          <SelectItem key={option.id} value={option.name.trim()}>
                                            {option.name.trim()}
                                          </SelectItem>
                                        ))}
                                      {currentValue && !hasMatchingOption && (
                                        <SelectItem value={currentValue} disabled>
                                          {currentValue} (deleted)
                                        </SelectItem>
                                      )}
                                    </SelectGroup>
                                  </SelectContent>
                                </Select>
                              );
                            })()
                          ) : field.key === 'name' ? (
                            <Input
                              ref={nameInputRef}
                              placeholder={field.default || `Enter ${field.name.toLowerCase()}...`}
                              autoComplete="off"
                              name={formField.name}
                              value={formField.value}
                              onChange={formField.onChange}
                              onBlur={formField.onBlur}
                            />
                          ) : field.key === 'slug' ? (
                            <Input
                              placeholder={field.default || `Enter ${field.name.toLowerCase()}...`}
                              autoComplete="off"
                              name={formField.name}
                              value={formField.value}
                              onChange={(e) => formField.onChange(sanitizeSlug(e.target.value, true))}
                              onBlur={(e) => {
                                formField.onChange(sanitizeSlug(e.target.value, false));
                                formField.onBlur();
                              }}
                            />
                          ) : (
                            <Input
                              placeholder={field.default || `Enter ${field.name.toLowerCase()}...`}
                              autoComplete="off"
                              {...formField}
                            />
                          )}
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  );
                })}
            </div>
          </form>
        </Form>
      </SheetContent>

      <ConfirmDialog
        open={showUnsavedDialog}
        onOpenChange={setShowUnsavedDialog}
        title="Unsaved Changes"
        description="You have unsaved changes. Are you sure you want to discard them?"
        confirmLabel="Discard changes"
        cancelLabel="Cancel"
        confirmVariant="destructive"
        onConfirm={handleConfirmDiscard}
        onCancel={handleCancelDiscard}
        saveLabel="Save changes"
        onSave={handleSaveFromDialog}
      />
    </Sheet>
  );
}

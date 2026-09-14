'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import Icon from '@/components/ui/icon';
import { useEditComponent } from '@/hooks/use-edit-component';
import { useEditorActions } from '@/hooks/use-editor-url';
import { useEditorStore } from '@/stores/useEditorStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { cacheApi, publishApi } from '@/lib/api';
import { cn, formatRelativeTime } from '@/lib/utils';
import { toast } from 'sonner';

interface PublishPreviewChange {
  id: string;
  name: string;
  status: 'new' | 'modified' | 'deleted' | 'unpublishing';
}

interface PublishPreviewCounts {
  pages: number;
  collections: number;
  collectionItems: number;
  components: number;
  layerStyles: number;
  assets: number;
  translations: number;
  globalVariables: number;
  changes: {
    pages: PublishPreviewChange[];
    components: PublishPreviewChange[];
  };
  total: number;
}

type ExpandableCategory = keyof PublishPreviewCounts['changes'];

function isExpandableCategory(key: string): key is ExpandableCategory {
  return key === 'pages' || key === 'components';
}

function getChangeTitle(change: PublishPreviewChange): string {
  if (change.status === 'deleted') return `${change.name} (deleted)`;
  if (change.status === 'unpublishing') return `${change.name} (will unpublish)`;
  if (change.status === 'new') return `${change.name} (new)`;
  return change.name;
}

function getChangeHref(category: ExpandableCategory, change: PublishPreviewChange): string | null {
  if (change.status === 'deleted') return null;
  if (category === 'pages') return `/ycode/pages/${change.id}`;
  if (category === 'components') return `/ycode/components/${change.id}`;
  return null;
}

function ChangeCategoryRow({
  icon,
  label,
  count,
  showExpandIcon = false,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  label: string;
  count: number;
  showExpandIcon?: boolean;
}) {
  return (
    <>
      <div className="flex items-center gap-1.5">
        <div className="size-5.5 flex items-center justify-center bg-input rounded-md">
          <Icon name={icon} className="size-2.5" />
        </div>
        {label}
      </div>
      <div className="flex items-center gap-1">
        <div className="tabular-nums">{count}</div>
        <Icon
          name="chevronRight"
          className={cn(
            'size-2',
            showExpandIcon
              ? 'opacity-40 transition-transform group-data-[state=open]:rotate-90'
              : 'invisible'
          )}
        />
      </div>
    </>
  );
}

/** Breakdown row config for rendering */
const BREAKDOWN_ITEMS: { key: keyof Omit<PublishPreviewCounts, 'total' | 'changes'>; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { key: 'pages', label: 'Pages', icon: 'page' },
  { key: 'components', label: 'Components', icon: 'component' },
  { key: 'collections', label: 'Collections', icon: 'database' },
  { key: 'collectionItems', label: 'Collection items', icon: 'database' },
  { key: 'layerStyles', label: 'Layer styles', icon: 'cube' },
  { key: 'assets', label: 'Assets', icon: 'image' },
  { key: 'translations', label: 'Translations', icon: 'globe' },
  { key: 'globalVariables', label: 'Global variables', icon: 'globe' },
];

interface PublishPopoverProps {
  isPublishing: boolean;
  setIsPublishing: (isPublishing: boolean) => void;
  baseUrl: string;
  publishedUrl: string;
  isDisabled?: boolean;
  onPublishSuccess: () => void;
}

export default function PublishPopover({
  isPublishing,
  setIsPublishing,
  baseUrl,
  publishedUrl,
  isDisabled = false,
  onPublishSuccess,
}: PublishPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [changeCounts, setChangeCounts] = useState<PublishPreviewCounts | null>(null);
  const [isLoadingCount, setIsLoadingCount] = useState(false);
  const [publishSuccess, setPublishSuccess] = useState(false);
  const [isReverting, setIsReverting] = useState(false);
  const [isRevertDialogOpen, setIsRevertDialogOpen] = useState(false);
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [clearCacheSuccess, setClearCacheSuccess] = useState(false);
  const [isClearCacheDialogOpen, setIsClearCacheDialogOpen] = useState(false);

  const { getSettingByKey, updateSetting } = useSettingsStore();
  const { openPage } = useEditorActions();
  const editComponent = useEditComponent();
  const setEditingComponentId = useEditorStore((state) => state.setEditingComponentId);
  const publishedAt = getSettingByKey('published_at');

  // Load changes count when popover opens
  useEffect(() => {
    if (isOpen) {
      loadChangesCount();
    }
  }, [isOpen]);

  const loadChangesCount = async () => {
    setIsLoadingCount(true);
    try {
      const response = await publishApi.getPreview();
      setChangeCounts(response.data ?? null);
    } catch (error) {
      console.error('Failed to load changes count:', error);
      setChangeCounts(null);
    } finally {
      setIsLoadingCount(false);
    }
  };

  const handlePublishAll = useCallback(async () => {
    try {
      setIsPublishing(true);

      const result = await publishApi.publish({ publishAll: true });

      if (result.error) {
        throw new Error(result.error);
      }

      // Sync published timestamp to store from response
      if (result.data?.published_at_setting?.value) {
        updateSetting('published_at', result.data.published_at_setting.value);
      }

      toast.success('Website published successfully', {
        action: {
          label: 'Open',
          onClick: () => window.open(baseUrl + publishedUrl, '_blank'),
        },
      });

      setPublishSuccess(true);
      setTimeout(() => setPublishSuccess(false), 3000);

      // Refresh counts in background (non-blocking)
      onPublishSuccess();
      loadChangesCount();
    } catch (error) {
      console.error('Failed to publish all:', error);
    } finally {
      setIsPublishing(false);
    }
  }, [baseUrl, publishedUrl, onPublishSuccess, setIsPublishing, updateSetting]);

  const handleClearCache = useCallback(async () => {
    try {
      setIsClearingCache(true);

      const result = await cacheApi.clearAll();

      if (result.error) {
        throw new Error(result.error);
      }

      toast.success('Cache cleared successfully');

      setClearCacheSuccess(true);
      setTimeout(() => setClearCacheSuccess(false), 3000);
      setIsClearCacheDialogOpen(false);
    } catch (error) {
      console.error('Failed to clear cache:', error);
      toast.error('Failed to clear cache');
    } finally {
      setIsClearingCache(false);
    }
  }, []);

  const handleRevertConfirm = useCallback(async () => {
    try {
      setIsReverting(true);

      const result = await publishApi.revert();

      if (result.error) {
        throw new Error(result.error);
      }

      toast.success('Revert successful, builder is reloading...');

      // Full reload to refresh all editor stores with reverted data
      window.location.reload();
    } catch (error) {
      console.error('Failed to revert:', error);
      toast.error('Failed to revert changes');
      setIsReverting(false);
      setIsRevertDialogOpen(false);
    }
  }, []);

  return (
    <>
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" disabled={isDisabled}>Publish</Button>
      </PopoverTrigger>

      <PopoverContent className="mr-4 mt-0.5 w-64">
        <div>
          <Label>
            <a
              href={baseUrl + publishedUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {baseUrl}
            </a>
          </Label>
          <span className="text-popover-foreground text-[10px]">
            {publishedAt ? `Published ${formatRelativeTime(publishedAt, false)}` : 'Never published'}
          </span>
        </div>

        <hr className="my-3" />

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="flex-1"
            onClick={handlePublishAll}
            disabled={isPublishing || publishSuccess}
          >
            {isPublishing ? (
              <Spinner />
            ) : publishSuccess ? (
              <Icon name="check" />
            ) : (
              publishedAt ? 'Update' : 'Publish'
            )}
          </Button>

          {publishedAt && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setIsClearCacheDialogOpen(true)}
                  disabled={isClearingCache || clearCacheSuccess}
                  aria-label="Clear cache"
                >
                  {isClearingCache ? (
                    <Spinner />
                  ) : clearCacheSuccess ? (
                    <Icon name="check" />
                  ) : (
                    <Icon name="refresh" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Clear cache</TooltipContent>
            </Tooltip>
          )}
        </div>

        <hr className="my-3" />

        {isLoadingCount ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Calculating changes...
          </div>
        ) : changeCounts ? (
          changeCounts.total > 0 ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between w-full">
                <div className="text-xs text-muted-foreground">
                  {changeCounts.total} {changeCounts.total === 1 ? 'Change' : 'Changes'}
                </div>
                {publishedAt && (
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => setIsRevertDialogOpen(true)}
                    disabled={isReverting || isPublishing}
                  >
                    Revert
                  </Button>
                )}
              </div>
              {BREAKDOWN_ITEMS.map(({ key, label, icon }) => {
                if (changeCounts[key] <= 0) return null;

                const details = isExpandableCategory(key)
                  ? changeCounts.changes?.[key] ?? []
                  : [];

                if (details.length === 0) {
                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between text-xs text-muted-foreground"
                    >
                      <ChangeCategoryRow
                        icon={icon}
                        label={label}
                        count={changeCounts[key]}
                      />
                    </div>
                  );
                }

                return (
                  <Collapsible key={key}>
                    <CollapsibleTrigger className="flex items-center justify-between w-full text-xs text-muted-foreground hover:text-foreground transition-colors group">
                      <ChangeCategoryRow
                        icon={icon}
                        label={label}
                        count={changeCounts[key]}
                        showExpandIcon
                      />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <ul
                        role="list"
                        className="max-h-32 overflow-y-auto pt-1 pl-7 text-xs text-muted-foreground"
                      >
                        {details.map((change) => {
                          const href = isExpandableCategory(key)
                            ? getChangeHref(key, change)
                            : null;

                          if (!href) {
                            return (
                              <li
                                key={change.id}
                                title={getChangeTitle(change)}
                                className={cn(
                                  'truncate py-1 leading-4',
                                  change.status === 'deleted' && 'line-through'
                                )}
                              >
                                {change.name}
                              </li>
                            );
                          }

                          return (
                            <li key={change.id} className="truncate py-1 leading-4">
                              <a
                                href={href}
                                title={getChangeTitle(change)}
                                className="block truncate hover:text-foreground"
                                onClick={(event) => {
                                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                                    return;
                                  }

                                  event.preventDefault();
                                  if (key === 'pages') {
                                    if (useEditorStore.getState().editingComponentId) {
                                      setEditingComponentId(null, null);
                                    }
                                    openPage(change.id);
                                    return;
                                  }

                                  void editComponent(change.id);
                                }}
                              >
                                {change.name}
                              </a>
                            </li>
                          );
                        })}
                      </ul>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">Everything is up to date</span>
          )
        ) : null}
      </PopoverContent>
    </Popover>

    <Dialog
      open={isRevertDialogOpen}
      onOpenChange={(open) => { if (!isReverting) setIsRevertDialogOpen(open); }}
    >
      <DialogContent
        showCloseButton={false}
        onPointerDownOutside={(e) => { if (isReverting) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (isReverting) e.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle>Revert to published version</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <DialogDescription>
            All unpublished changes will be discarded and replaced with the last
            published version. The builder will reload after this operation.
          </DialogDescription>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsRevertDialogOpen(false)}
            disabled={isReverting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleRevertConfirm}
            disabled={isReverting}
          >
            {isReverting ? <><Spinner /> Reverting...</> : 'Revert'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog
      open={isClearCacheDialogOpen}
      onOpenChange={(open) => { if (!isClearingCache) setIsClearCacheDialogOpen(open); }}
    >
      <DialogContent
        showCloseButton={false}
        onPointerDownOutside={(e) => { if (isClearingCache) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (isClearingCache) e.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle>Clear cache for all pages</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <DialogDescription>
            Published pages are cached so they load quickly for your visitors.
            You normally don&apos;t need to clear the cache, publishing already
            refreshes the pages that changed.
          </DialogDescription>
          <DialogDescription>
            This action would immediately clear the cache of all pages, which is
            only useful for websites with many pages. Once cleared, the first
            visit to each page will be slower as it has to be cached again, after
            which every following visit loads quickly.
          </DialogDescription>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsClearCacheDialogOpen(false)}
            disabled={isClearingCache}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleClearCache}
            disabled={isClearingCache}
          >
            {isClearingCache ? <><Spinner /> Clearing...</> : 'Clear cache'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

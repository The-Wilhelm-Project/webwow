'use client';

import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import Icon, { type IconProps } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAssetsStore } from '@/stores/useAssetsStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { usePagesStore } from '@/stores/usePagesStore';
import { assetFoldersApi, uploadFileApi } from '@/lib/api';
import { ASSET_CATEGORIES } from '@/lib/asset-constants';
import { getAssetIcon, getOptimizedImageUrl, isAssetOfType } from '@/lib/asset-utils';
import { createAssetVariable, createDynamicTextVariable } from '@/lib/variable-utils';
import { findLayerById, folderPath, formatBytes } from '@/lib/webwow/builder/panel-utils';
import { cn } from '@/lib/utils';
import type { Asset, Layer } from '@/types';
import type { UseLiveLayerUpdatesReturn } from '@/hooks/use-live-layer-updates';

const AssetFolderDialog = lazy(() => import('../AssetFolderDialog'));

const ASSETS_PER_PAGE = 40;

export interface AssetsPanelProps {
  search: string;
  currentPageId: string | null;
  liveLayerUpdates?: UseLiveLayerUpdatesReturn | null;
  /** True on design routes: clicking an asset sets it on the selected image layer. */
  canvasEditable: boolean;
  /** False while the panel is hidden: the selection subscription (hint text) is paused. */
  active: boolean;
}

/** Applies a partial layer update the way `YCodeBuilderMain.handleLayerUpdate` does (component-aware). */
function applyLayerUpdate(layerId: string, updates: Partial<Layer>, liveLayerUpdates?: UseLiveLayerUpdatesReturn | null) {
  const { editingComponentId: compId, editingComponentVariantId: variantId } = useEditorStore.getState();
  if (compId) {
    const { componentDrafts, updateComponentDraft } = useComponentsStore.getState();
    const variantDrafts = componentDrafts[compId];
    const targetVariantId = (variantId && variantDrafts?.[variantId])
      ? variantId
      : (variantDrafts ? Object.keys(variantDrafts)[0] : null);
    if (!targetVariantId || !variantDrafts) return false;
    const layers = variantDrafts[targetVariantId] || [];
    const updateTree = (tree: Layer[]): Layer[] =>
      tree.map((l) => {
        if (l.id === layerId) return { ...l, ...updates };
        if (l.children) return { ...l, children: updateTree(l.children) };
        return l;
      });
    updateComponentDraft(compId, targetVariantId, updateTree(layers));
    return true;
  }
  const pageId = useEditorStore.getState().currentPageId;
  if (!pageId) return false;
  usePagesStore.getState().updateLayer(pageId, layerId, updates);
  liveLayerUpdates?.broadcastLayerUpdate(layerId, updates);
  return true;
}

/** Layers of the current page draft or the component variant being edited. */
function currentLayers(): Layer[] {
  const { editingComponentId, editingComponentVariantId, currentPageId } = useEditorStore.getState();
  if (editingComponentId) {
    const drafts = useComponentsStore.getState().componentDrafts[editingComponentId];
    if (!drafts) return [];
    const variantId = editingComponentVariantId && drafts[editingComponentVariantId] ? editingComponentVariantId : Object.keys(drafts)[0];
    return variantId ? drafts[variantId] || [] : [];
  }
  if (!currentPageId) return [];
  return usePagesStore.getState().draftsByPageId[currentPageId]?.layers || [];
}

const AssetThumb = React.memo(function AssetThumb({ asset }: { asset: Asset }) {
  const isIcon = Boolean(asset.content) || isAssetOfType(asset.mime_type, ASSET_CATEGORIES.ICONS);
  if (asset.content) {
    return (
      <div
        className="relative w-full h-full flex items-center justify-center p-4 pointer-events-none text-foreground [&>svg]:max-w-full [&>svg]:max-h-full"
        dangerouslySetInnerHTML={{ __html: asset.content }}
      />
    );
  }
  if ((isIcon || asset.mime_type?.startsWith('image/')) && asset.public_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={getOptimizedImageUrl(asset.public_url, 200)}
        alt={asset.filename}
        loading="lazy"
        className="relative max-w-full max-h-full object-contain pointer-events-none"
      />
    );
  }
  return <Icon name={getAssetIcon(asset.mime_type) as IconProps['name']} className="size-6 opacity-50" />;
});

interface AssetTileProps {
  asset: Asset;
  /** Highlights usable assets while an image layer is selected. */
  highlight: boolean;
  onSelect: (asset: Asset) => void;
}

/** One grid cell (thumbnail + tooltip + caption); memoized so a selection change re-renders only the tiles. */
const AssetTile = React.memo(function AssetTile({ asset, highlight, onSelect }: AssetTileProps) {
  const usable = isAssetOfType(asset.mime_type, ASSET_CATEGORIES.IMAGES) || isAssetOfType(asset.mime_type, ASSET_CATEGORIES.ICONS);
  return (
    <div role="listitem" className="flex flex-col gap-1 min-w-0">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-webwow-asset={asset.id}
            aria-label={asset.filename}
            onClick={() => onSelect(asset)}
            className={cn(
              'relative aspect-square w-full rounded-md border border-border bg-secondary/40 flex items-center justify-center overflow-hidden p-1 cursor-pointer',
              'hover:border-primary/60 outline-none focus-visible:ring-2 focus-visible:ring-ring',
              highlight && usable && 'hover:ring-2 hover:ring-primary/40',
            )}
          >
            <AssetThumb asset={asset} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-56">
          <span className="truncate">{asset.filename}</span>
          {asset.file_size > 0 && <span className="opacity-70"> · {formatBytes(asset.file_size)}</span>}
        </TooltipContent>
      </Tooltip>
      <span className="text-[10px] text-muted-foreground truncate px-0.5" title={asset.filename}>{asset.filename}</span>
    </div>
  );
});

/**
 * Asset browser next to the rail: folders, thumbnail grid, upload, new folder and the full
 * file manager. Clicking an asset sets it on the selected image layer (the classic sidebar's
 * `handleAssetSelect`, made component-aware).
 */
function AssetsPanel({ search, currentPageId, liveLayerUpdates, canvasEditable, active }: AssetsPanelProps) {
  const folders = useAssetsStore((state) => state.folders);
  const fetchAssets = useAssetsStore((state) => state.fetchAssets);
  const addAsset = useAssetsStore((state) => state.addAsset);
  const addFolder = useAssetsStore((state) => state.addFolder);
  const openFileManager = useEditorStore((state) => state.openFileManager);
  const selectedLayerId = useEditorStore((state) => (active ? state.selectedLayerId : null));

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState<{ current: number; total: number } | null>(null);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState(search.trim());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  const childFolders = useMemo(
    () => folders.filter((f) => f.asset_folder_id === selectedFolderId).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    [folders, selectedFolderId],
  );
  const breadcrumb = useMemo(() => folderPath(folders, selectedFolderId), [folders, selectedFolderId]);

  const descendantIds = useCallback((folderId: string | null): string[] => {
    const ids: string[] = [];
    const walk = (parentId: string | null) => {
      for (const f of folders) {
        if (f.asset_folder_id === parentId) {
          ids.push(f.id);
          walk(f.id);
        }
      }
    };
    walk(folderId);
    return ids;
  }, [folders]);

  const load = useCallback(async (nextPage: number, reset: boolean) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const searching = debouncedSearch.length > 0;
      const result = await fetchAssets({
        folderId: searching ? undefined : selectedFolderId,
        folderIds: searching ? [...(selectedFolderId ? [selectedFolderId] : []), ...descendantIds(selectedFolderId)] : undefined,
        search: searching ? debouncedSearch : undefined,
        page: nextPage,
        limit: ASSETS_PER_PAGE,
      });
      if (requestId !== requestRef.current) return;
      setAssets((prev) => {
        if (reset) return result.assets;
        const seen = new Set(prev.map((a) => a.id));
        return [...prev, ...result.assets.filter((a) => !seen.has(a.id))];
      });
      setTotal(result.total);
      setHasMore(result.hasMore);
      setPage(nextPage);
    } catch (error) {
      console.error('Failed to load assets:', error);
      toast.error('Failed to load assets');
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [fetchAssets, selectedFolderId, debouncedSearch, descendantIds]);

  useEffect(() => {
    void load(1, true);
  }, [load]);

  // ---- select: set on the selected image layer -----------------------------------------------
  const selectedLayer = useMemo(() => {
    if (!selectedLayerId) return null;
    return findLayerById(currentLayers(), selectedLayerId);
    // `currentPageId` keeps the memo fresh after page switches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLayerId, currentPageId]);
  const targetIsImage = canvasEditable && selectedLayer?.name === 'image';

  const handleAssetSelect = useCallback((asset: Asset) => {
    if (!canvasEditable) {
      toast.info('Open a page to set assets on layers');
      return;
    }
    const editor = useEditorStore.getState();
    const layerId = editor.selectedLayerId;
    if (!layerId) {
      toast.error('Select an image layer first');
      return;
    }
    const layer = findLayerById(currentLayers(), layerId);
    if (!layer) {
      toast.error('Selected layer not found');
      return;
    }
    if (layer.name !== 'image') {
      toast.error('Please select an image layer');
      return;
    }
    const isImage = isAssetOfType(asset.mime_type, ASSET_CATEGORIES.IMAGES);
    const isSvg = isAssetOfType(asset.mime_type, ASSET_CATEGORIES.ICONS);
    if (!isImage && !isSvg) {
      toast.error('Invalid asset type', { description: 'Only images and SVG icons can be used as an image source' });
      return;
    }
    const updates: Partial<Layer> = {
      variables: {
        ...layer.variables,
        image: {
          src: createAssetVariable(asset.id),
          alt: layer.variables?.image?.alt || createDynamicTextVariable(asset.filename),
        },
      },
    };
    if (applyLayerUpdate(layerId, updates, liveLayerUpdates)) {
      toast.success('Image updated', { description: asset.filename });
    }
  }, [canvasEditable, liveLayerUpdates]);

  // ---- upload / folders -----------------------------------------------------------------------
  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    if (files.length === 0) return;
    setUploading({ current: 0, total: files.length });
    let done = 0;
    try {
      await Promise.all(files.map(async (file) => {
        try {
          const asset = await uploadFileApi(file, 'file-manager', null, undefined, selectedFolderId);
          if (asset) {
            addAsset(asset);
            setAssets((prev) => (prev.some((a) => a.id === asset.id) ? prev : [asset, ...prev]));
            setTotal((prev) => prev + 1);
          }
        } catch (error) {
          console.error(`Failed to upload ${file.name}:`, error);
          toast.error(`Failed to upload ${file.name}`);
        } finally {
          done++;
          setUploading({ current: done, total: files.length });
        }
      }));
    } finally {
      setUploading(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleCreateFolder = async (folderName: string, parentFolderId: string | null) => {
    try {
      const depth = folderPath(folders, parentFolderId).length;
      const order = folders.filter((f) => f.asset_folder_id === parentFolderId).length;
      const response = await assetFoldersApi.create({ name: folderName, asset_folder_id: parentFolderId, depth, order, is_published: false });
      if (response.error || !response.data) {
        console.error('Failed to create folder:', response.error);
        toast.error('Failed to create folder');
        return;
      }
      addFolder(response.data);
      setSelectedFolderId(response.data.id);
    } catch (error) {
      console.error('Failed to create folder:', error);
      toast.error('Failed to create folder');
    }
  };

  const hint = !canvasEditable
    ? 'Open a page to set assets on an image layer.'
    : targetIsImage
      ? `Click an asset to set it on "${selectedLayer?.customName || 'Image'}".`
      : 'Select an image layer on the canvas, then click an asset.';

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-webwow-assets-panel>
      <div className="px-3 pt-3 pb-2 flex items-center gap-1.5 border-b">
        <Button
          size="sm" variant="secondary"
          className="flex-1" disabled={uploading !== null}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? <Spinner /> : <Icon name="upload" />}
          {uploading ? `Uploading ${uploading.current}/${uploading.total}` : 'Upload'}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm" variant="secondary"
              aria-label="New folder" onClick={() => setFolderDialogOpen(true)}
            >
              <Icon name="folder" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">New folder</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm" variant="secondary"
              aria-label="Open file manager" onClick={() => openFileManager()}
            >
              <Icon name="expand" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Open file manager</TooltipContent>
        </Tooltip>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileChange}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-3 pb-3">
        <p className="text-[11px] text-muted-foreground py-2" data-webwow-assets-hint>{hint}</p>

        {/* Breadcrumb */}
        <nav aria-label="Asset folders" className="flex items-center gap-1 text-xs pb-2 flex-wrap">
          <button
            type="button"
            onClick={() => setSelectedFolderId(null)}
            aria-current={selectedFolderId === null ? 'page' : undefined}
            className="hover:underline aria-[current=page]:font-medium cursor-pointer"
          >
            All files
          </button>
          {breadcrumb.map((folder) => (
            <React.Fragment key={folder.id}>
              <Icon name="chevronRight" className="size-3 text-muted-foreground" />
              <button
                type="button"
                onClick={() => setSelectedFolderId(folder.id)}
                aria-current={selectedFolderId === folder.id ? 'page' : undefined}
                className="hover:underline aria-[current=page]:font-medium truncate max-w-32 cursor-pointer"
              >
                {folder.name}
              </button>
            </React.Fragment>
          ))}
        </nav>

        {/* Child folders */}
        {childFolders.length > 0 && !debouncedSearch && (
          <ul role="list" className="flex flex-col gap-0.5 pb-2">
            {childFolders.map((folder) => (
              <li key={folder.id}>
                <button
                  type="button"
                  data-webwow-asset-folder={folder.id}
                  onClick={() => setSelectedFolderId(folder.id)}
                  className="w-full h-7 px-2 rounded-md flex items-center gap-2 text-xs text-left hover:bg-secondary/70 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon name="folder" className="size-3 text-muted-foreground shrink-0" />
                  <span className="truncate">{folder.name}</span>
                  <Icon name="chevronRight" className="size-3 text-muted-foreground ml-auto" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Grid */}
        {assets.length === 0 && !loading && (
          <p className="text-xs text-muted-foreground py-6 text-center">
            {debouncedSearch ? 'No assets match' : 'No files in this folder'}
          </p>
        )}
        <div
          className="grid grid-cols-3 gap-2" role="list"
          aria-label="Assets"
        >
          {assets.map((asset) => (
            <AssetTile
              key={asset.id} asset={asset}
              highlight={targetIsImage} onSelect={handleAssetSelect}
            />
          ))}
        </div>

        {loading && (
          <div className="flex justify-center py-4"><Spinner /></div>
        )}
        {!loading && hasMore && (
          <Button
            size="sm" variant="ghost"
            className="w-full mt-2" onClick={() => { void load(page + 1, false); }}
          >
            Load more ({assets.length} of {total})
          </Button>
        )}
      </div>

      {folderDialogOpen && (
        <Suspense fallback={null}>
          <AssetFolderDialog
            open={folderDialogOpen}
            onOpenChange={setFolderDialogOpen}
            onConfirm={(name, parentId) => { void handleCreateFolder(name, parentId); }}
            mode="create"
            initialParentFolderId={selectedFolderId}
            folders={folders}
            currentFolderId={selectedFolderId}
          />
        </Suspense>
      )}
    </div>
  );
}

export default React.memo(AssetsPanel);

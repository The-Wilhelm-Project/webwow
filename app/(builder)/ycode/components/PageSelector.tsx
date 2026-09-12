'use client';

/**
 * PageSelector - Reusable page selector with folder tree
 *
 * Renders a combobox: the trigger is the filter input, and the popover
 * lists pages in a folder tree. Used in link settings, rich text link
 * settings, collection link fields, and the center canvas page navigation.
 */

// 1. React
import React, { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

// 3. ShadCN UI
import Icon from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';

// 4. Internal components
import { FilterCombobox } from './filter-combobox';

// 5. Stores
import { usePagesStore } from '@/stores/usePagesStore';

// 6. Utils
import { buildPageTree, filterPageTree, getNodeIcon, getPageIcon } from '@/lib/page-utils';
import { cn } from '@/lib/utils';

// 7. Types
import type { Page, PageFolder } from '@/types';
import type { PageTreeNode } from '@/lib/page-utils';

interface PageSelectorProps {
  value: string | null;
  onValueChange: (pageId: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Show error pages in a separate "Error pages" folder. Default: false */
  includeErrorPages?: boolean;
  /** Custom class for the trigger */
  className?: string;
  /** Popover alignment relative to trigger. Default: "end" (right-aligned) */
  align?: 'start' | 'center' | 'end';
  /** Custom class for the popover content */
  popoverClassName?: string;
}

/**
 * Context used by TreeRow children so toggling a single folder's collapse
 * state doesn't have to pass the (changing) `collapsedFolderIds` Set down
 * through every node's props — which would defeat React.memo on each row.
 */
interface TreeContextValue {
  collapsedFolderIds: Set<string>;
  selectedValue: string | null;
  isSearching: boolean;
  onToggleFolder: (folderId: string) => void;
  onPageSelect: (pageId: string) => void;
}

const TreeContext = React.createContext<TreeContextValue | null>(null);

interface TreeRowProps {
  node: PageTreeNode;
  depth: number;
  /**
   * Pre-computed boolean so a parent state change that doesn't affect this
   * row (e.g. toggling a sibling's collapse) cannot trigger a re-render here.
   */
  isCollapsed: boolean;
  isSelected: boolean;
}

const TreeRow = memo(function TreeRow({ node, depth, isCollapsed, isSelected }: TreeRowProps) {
  const ctx = useContext(TreeContext);
  const isFolder = node.type === 'folder';
  const hasChildren = !!(node.children && node.children.length > 0);

  const handleRowClick = useCallback(() => {
    if (!ctx) return;
    if (isFolder) {
      if (ctx.isSearching) return;
      ctx.onToggleFolder(node.id);
    } else {
      ctx.onPageSelect(node.id);
    }
  }, [ctx, isFolder, node.id]);

  const handleChevronClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (isFolder && ctx && !ctx.isSearching) {
      ctx.onToggleFolder(node.id);
    }
  }, [ctx, isFolder, node.id]);

  return (
    <div>
      <div
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleRowClick}
        className={cn(
          "hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-pointer items-center gap-1.25 rounded-sm py-1.5 pr-8 pl-2 text-xs outline-hidden select-none data-disabled:opacity-50 data-disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
          isSelected && 'bg-secondary/50'
        )}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={handleChevronClick}
            className={cn(
              'size-3 flex items-center justify-center shrink-0',
              isCollapsed ? '' : 'rotate-90'
            )}
          >
            <Icon
              name="chevronRight"
              className={cn('size-2.5 opacity-50', isSelected && 'opacity-80')}
            />
          </button>
        ) : (
          <div className="size-3 shrink-0 flex items-center justify-center">
            <div className={cn('ml-px w-1.5 h-px bg-white opacity-0', isSelected && 'opacity-0')} />
          </div>
        )}

        <Icon
          name={getNodeIcon(node)}
          className={cn('size-3 mr-0.5', isSelected ? 'opacity-90' : 'opacity-50')}
        />

        <span className="grow flex items-center gap-2 min-w-0 pr-4 pointer-events-none">
          <span className="text-xs font-medium overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
            {isFolder ? (node.data as PageFolder).name : (node.data as Page).name}
          </span>
          {!isFolder && (node.data as Page).is_publishable === false && (
            <Icon name="eye-off" className="size-3.5 shrink-0 opacity-70" />
          )}
        </span>

        {isSelected && (
          <span className="absolute right-2 flex size-3 items-center justify-center">
            <Icon name="check" className="size-3 opacity-50" />
          </span>
        )}
      </div>

      {isFolder && !isCollapsed && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <TreeRowConnector
              key={child.id} node={child}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
});

/**
 * Thin wrapper that reads collapse/selection/search state from context and
 * forwards only primitive props to the memoized `TreeRow`. This keeps
 * `TreeRow` insulated from Set/object identity changes higher up the tree —
 * a toggle on folder A only re-renders A's row (and its child connectors
 * for unmount), not unrelated rows.
 */
function TreeRowConnector({ node, depth }: { node: PageTreeNode; depth: number }) {
  const ctx = useContext(TreeContext);
  const isCollapsed = !!ctx && !ctx.isSearching && node.type === 'folder' && ctx.collapsedFolderIds.has(node.id);
  const isSelected = !!ctx && node.type === 'page' && node.id === ctx.selectedValue;
  return <TreeRow
    node={node} depth={depth}
    isCollapsed={isCollapsed} isSelected={isSelected}
         />;
}

/**
 * Stable key derived from folder IDs so we can resync `collapsedFolderIds`
 * only when the folder set actually changes — not on every fresh array
 * reference from the store.
 */
function getFolderIdKey(folders: PageFolder[]): string {
  if (folders.length === 0) return '';
  const ids = folders.map((f) => f.id);
  ids.sort();
  return ids.join('|');
}

function findFirstPageId(nodes: PageTreeNode[]): string | null {
  for (const node of nodes) {
    if (node.type === 'page') return node.id;
    if (node.children) {
      const childId = findFirstPageId(node.children);
      if (childId) return childId;
    }
  }
  return null;
}

/**
 * Reusable page selector with folder tree dropdown
 */
function PageSelectorImpl({
  value,
  onValueChange,
  placeholder = 'Select...',
  disabled = false,
  includeErrorPages = false,
  className,
  align = 'end',
  popoverClassName,
}: PageSelectorProps) {

  const pages = usePagesStore((state) => state.pages);
  const folders = usePagesStore((state) => state.folders);

  // O(1) lookups instead of repeated `.find()` walks over the arrays.
  const pagesById = useMemo(() => {
    const map = new Map<string, Page>();
    for (const page of pages) map.set(page.id, page);
    return map;
  }, [pages]);

  const foldersById = useMemo(() => {
    const map = new Map<string, PageFolder>();
    for (const folder of folders) map.set(folder.id, folder);
    return map;
  }, [folders]);

  // Separate regular pages from error pages
  const { regularPages, errorPages } = useMemo(() => {
    const regular: Page[] = [];
    const errors: Page[] = [];
    for (const page of pages) {
      if (page.error_page === null) regular.push(page);
      else errors.push(page);
    }
    errors.sort((a, b) => (a.error_page || 0) - (b.error_page || 0));
    return { regularPages: regular, errorPages: errors };
  }, [pages]);

  const pageTree = useMemo(
    () => buildPageTree(regularPages, folders),
    [regularPages, folders]
  );

  // Virtual "Error pages" folder node
  const errorPagesNode: PageTreeNode | null = useMemo(() => {
    if (!includeErrorPages || errorPages.length === 0) return null;

    const virtualFolder: PageFolder = {
      id: 'virtual-error-pages-folder',
      name: 'Error pages',
      slug: 'error-pages',
      page_folder_id: null,
      depth: 0,
      order: 999999,
      settings: {},
      is_published: false,
      deleted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const errorPageNodes: PageTreeNode[] = errorPages.map(page => ({
      id: page.id,
      type: 'page',
      data: page,
      children: [],
    }));

    return {
      id: virtualFolder.id,
      type: 'folder',
      data: virtualFolder,
      children: errorPageNodes,
    };
  }, [includeErrorPages, errorPages]);

  // Initialize the collapsed set lazily on mount so a parent re-render that
  // hands us a fresh `folders` reference (same content) doesn't blow away the
  // user's expansion state.
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(() => {
    const ids = new Set<string>(folders.map((f) => f.id));
    if (includeErrorPages) ids.add('virtual-error-pages-folder');
    return ids;
  });

  // Tracks which folder IDs we've ever seen, used to detect "new" folders that
  // should default to collapsed without clobbering the user's existing expand
  // choices.
  const knownFolderIdsRef = useRef<Set<string>>(new Set(folders.map((f) => f.id)));

  // Only resync when the folder ID set actually changes (folder added or
  // deleted) or `includeErrorPages` toggles. Editing a folder's name/order
  // keeps the same IDs → no resync, no re-render, user expansion preserved.
  const folderIdKey = useMemo(() => getFolderIdKey(folders), [folders]);
  const prevFolderIdKeyRef = useRef(folderIdKey);
  const prevIncludeErrorPagesRef = useRef(includeErrorPages);
  useEffect(() => {
    if (prevFolderIdKeyRef.current === folderIdKey && prevIncludeErrorPagesRef.current === includeErrorPages) {
      return;
    }
    const wasIncludeErrorPages = prevIncludeErrorPagesRef.current;
    prevFolderIdKeyRef.current = folderIdKey;
    prevIncludeErrorPagesRef.current = includeErrorPages;
    setCollapsedFolderIds((prev) => {
      const known = knownFolderIdsRef.current;
      const next = new Set<string>();
      for (const folder of folders) {
        if (!known.has(folder.id) || prev.has(folder.id)) {
          // New folder → collapse by default; or previously collapsed → keep.
          next.add(folder.id);
        }
        // Otherwise was expanded → keep expanded (omitted from `next`).
      }
      if (includeErrorPages && (!wasIncludeErrorPages || prev.has('virtual-error-pages-folder'))) {
        next.add('virtual-error-pages-folder');
      }
      knownFolderIdsRef.current = new Set(folders.map((f) => f.id));
      return next;
    });
  }, [folderIdKey, includeErrorPages, folders]);

  const getAncestorFolderIds = useCallback((pageId: string): string[] => {
    const page = pagesById.get(pageId);
    if (!page?.page_folder_id) return [];
    const ancestors: string[] = [];
    let currentFolderId: string | null = page.page_folder_id;
    while (currentFolderId) {
      ancestors.push(currentFolderId);
      const folder = foldersById.get(currentFolderId);
      currentFolderId = folder?.page_folder_id ?? null;
    }
    return ancestors;
  }, [pagesById, foldersById]);

  const expandSelectedAncestors = useCallback(() => {
    if (!value) return;
    const ancestorIds = getAncestorFolderIds(value);
    if (ancestorIds.length === 0) return;
    setCollapsedFolderIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of ancestorIds) {
        if (next.delete(id)) changed = true;
      }
      return changed ? next : prev;
    });
  }, [value, getAncestorFolderIds]);

  const toggleFolder = useCallback((folderId: string) => {
    setCollapsedFolderIds(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }, []);

  const selectedPage = useMemo(() => {
    if (!value) return null;
    return pagesById.get(value) ?? null;
  }, [value, pagesById]);

  const handleEnter = useCallback((query: string) => {
    const filtered = filterPageTree(pageTree, query);
    const errorFiltered = errorPagesNode
      ? filterPageTree([errorPagesNode], query)[0] ?? null
      : null;
    const firstPageId = findFirstPageId(filtered)
      ?? (errorFiltered ? findFirstPageId([errorFiltered]) : null);
    if (firstPageId) onValueChange(firstPageId);
  }, [pageTree, errorPagesNode, onValueChange]);

  return (
    <FilterCombobox
      displayValue={selectedPage?.name ?? ''}
      placeholder={placeholder}
      searchPlaceholder="Search pages..."
      ariaLabel="Select page"
      disabled={disabled}
      className={cn(selectedPage && 'text-foreground', className)}
      align={align}
      popoverClassName={popoverClassName}
      leading={selectedPage ? (
        <Icon
          name={getPageIcon(selectedPage)}
          className="size-3 opacity-50 shrink-0"
        />
      ) : null}
      trailing={selectedPage?.is_publishable === false ? (
        <Icon name="eye-off" className="size-3.5 shrink-0 opacity-70" />
      ) : null}
      onOpen={expandSelectedAncestors}
      onEnter={handleEnter}
    >
      {({ search, hasQuery, close }) => {
        const filteredPageTree = filterPageTree(pageTree, search);
        const filteredErrorPagesNode = !errorPagesNode
          ? null
          : hasQuery
            ? filterPageTree([errorPagesNode], search)[0] ?? null
            : errorPagesNode;
        const hasResults = filteredPageTree.length > 0 || !!filteredErrorPagesNode;

        return (
          <TreeContext.Provider
            value={{
              collapsedFolderIds,
              selectedValue: value,
              isSearching: hasQuery,
              onToggleFolder: toggleFolder,
              onPageSelect: (pageId) => {
                onValueChange(pageId);
                close();
              },
            }}
          >
            {filteredPageTree.length > 0 && filteredPageTree.map((node) => (
              <TreeRowConnector
                key={node.id} node={node}
                depth={0}
              />
            ))}

            {filteredErrorPagesNode && (
              <>
                {filteredPageTree.length > 0 && <Separator className="my-1" />}
                <TreeRowConnector node={filteredErrorPagesNode} depth={0} />
              </>
            )}

            {!hasResults && (
              <div className="text-xs text-muted-foreground text-center py-4">
                No pages found
              </div>
            )}
          </TreeContext.Provider>
        );
      }}
    </FilterCombobox>
  );
}

export default memo(PageSelectorImpl);

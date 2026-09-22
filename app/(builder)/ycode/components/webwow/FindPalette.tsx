'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import Icon, { type IconProps } from '@/components/ui/icon';
import { Kbd } from '@/components/ui/kbd';
import { usePagesStore } from '@/stores/usePagesStore';
import { useCollectionsStore } from '@/stores/useCollectionsStore';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { getBlockName } from '@/lib/templates/blocks';
import { flattenLayers, rankEntries } from '@/lib/webwow/builder/panel-utils';
import { cn } from '@/lib/utils';
import type { Layer } from '@/types';

export type FindGroup = 'Pages' | 'Layers' | 'Collections' | 'Components' | 'Actions';

export interface FindEntry {
  id: string;
  group: FindGroup;
  label: string;
  hint?: string;
  icon: IconProps['name'];
  run: () => void;
}

export interface FindAction {
  id: string;
  label: string;
  hint?: string;
  icon?: IconProps['name'];
  run: () => void;
}

export interface FindPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentPageId: string | null;
  onOpenPage: (pageId: string) => void;
  onOpenLayer: (layerId: string) => void;
  onOpenCollection: (collectionId: string) => void;
  onOpenComponent: (componentId: string) => void;
  actions: FindAction[];
}

const GROUP_ORDER: readonly FindGroup[] = ['Pages', 'Layers', 'Collections', 'Components', 'Actions'];
const NO_LAYERS: Layer[] = [];
const NO_PAGES: ReturnType<typeof usePagesStore.getState>['pages'] = [];
const NO_FOLDERS: ReturnType<typeof usePagesStore.getState>['folders'] = [];
const NO_COLLECTIONS: ReturnType<typeof useCollectionsStore.getState>['collections'] = [];
const NO_COMPONENTS: ReturnType<typeof useComponentsStore.getState>['components'] = [];
const GROUP_HINT: Record<FindGroup, string> = {
  Pages: 'Open page',
  Layers: 'Select layer',
  Collections: 'Open collection',
  Components: 'Edit component',
  Actions: '',
};

/**
 * Cmd/Ctrl+K palette: pages, layers of the current page, collections, components and
 * actions (Publish, Preview, Settings, ...). Hand-rolled on `Dialog` + `Input` + a listbox
 * (the repo has no cmdk). Store subscriptions (pages, layers, ...) are active only while
 * the palette is open, so draft edits never re-render the closed palette.
 */
function FindPalette({
  open,
  onOpenChange,
  currentPageId,
  onOpenPage,
  onOpenLayer,
  onOpenCollection,
  onOpenComponent,
  actions,
}: FindPaletteProps) {
  const pages = usePagesStore((state) => (open ? state.pages : NO_PAGES));
  const folders = usePagesStore((state) => (open ? state.folders : NO_FOLDERS));
  const collections = useCollectionsStore((state) => (open ? state.collections : NO_COLLECTIONS));
  const components = useComponentsStore((state) => (open ? state.components : NO_COMPONENTS));
  const editingComponentId = useEditorStore((state) => (open ? state.editingComponentId : null));
  const editingComponentVariantId = useEditorStore((state) => (open ? state.editingComponentVariantId : null));
  const pageLayers = usePagesStore((state) => (open && currentPageId ? state.draftsByPageId[currentPageId]?.layers : undefined));
  const variantDrafts = useComponentsStore((state) => (open && editingComponentId ? state.componentDrafts[editingComponentId] : undefined));

  /** Layers of the current page or of the component variant being edited. */
  const layers = useMemo<Layer[]>(() => {
    if (editingComponentId) {
      if (!variantDrafts) return NO_LAYERS;
      const variantId = editingComponentVariantId && variantDrafts[editingComponentVariantId]
        ? editingComponentVariantId
        : Object.keys(variantDrafts)[0];
      return variantId ? variantDrafts[variantId] || NO_LAYERS : NO_LAYERS;
    }
    return pageLayers || NO_LAYERS;
  }, [editingComponentId, editingComponentVariantId, variantDrafts, pageLayers]);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
    }
  }, [open]);

  const all = useMemo<FindEntry[]>(() => {
    if (!open) return [];
    const close = () => onOpenChange(false);
    const folderName = (folderId: string | null | undefined) => (folderId ? folders.find((f) => f.id === folderId)?.name : undefined);
    const pageEntries = pages.map<FindEntry>((p) => ({
      id: `page:${p.id}`,
      group: 'Pages',
      label: p.name,
      hint: [folderName(p.page_folder_id), p.slug ? `/${p.slug}` : undefined].filter(Boolean).join(' · ') || undefined,
      icon: p.is_index ? 'homepage' : p.is_dynamic ? 'dynamicPage' : 'page',
      run: () => { close(); onOpenPage(p.id); },
    }));
    const layerEntries = flattenLayers(layers, getBlockName).map<FindEntry>((l) => ({
      id: `layer:${l.id}`,
      group: 'Layers',
      label: l.label,
      hint: l.path || undefined,
      icon: 'layers',
      run: () => { close(); onOpenLayer(l.id); },
    }));
    const collectionEntries = collections.map<FindEntry>((c) => ({
      id: `collection:${c.id}`,
      group: 'Collections',
      label: c.name,
      hint: typeof c.draft_items_count === 'number' ? `${c.draft_items_count} items` : undefined,
      icon: 'database',
      run: () => { close(); onOpenCollection(c.id); },
    }));
    const componentEntries = components.map<FindEntry>((c) => ({
      id: `component:${c.id}`,
      group: 'Components',
      label: c.name,
      icon: 'component',
      run: () => { close(); onOpenComponent(c.id); },
    }));
    const actionEntries = actions.map<FindEntry>((a) => ({
      id: `action:${a.id}`,
      group: 'Actions',
      label: a.label,
      hint: a.hint,
      icon: a.icon ?? 'zap',
      run: () => { close(); a.run(); },
    }));
    return [...pageEntries, ...layerEntries, ...collectionEntries, ...componentEntries, ...actionEntries];
  }, [open, pages, folders, layers, collections, components, actions, onOpenChange, onOpenPage, onOpenLayer, onOpenCollection, onOpenComponent]);

  const entries = useMemo<FindEntry[]>(() => {
    const q = query.trim();
    if (!q) {
      // Current page first, then a few pages and every action.
      const pageEntries = all.filter((e) => e.group === 'Pages');
      const current = pageEntries.find((e) => e.id === `page:${currentPageId}`);
      const rest = pageEntries.filter((e) => e !== current).slice(0, current ? 4 : 5);
      return [...(current ? [current] : []), ...rest, ...all.filter((e) => e.group === 'Actions')];
    }
    return rankEntries(all, q, GROUP_ORDER, 8, 40);
  }, [all, query, currentPageId]);

  const safeIndex = Math.min(index, Math.max(0, entries.length - 1));

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${safeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [safeIndex, entries]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex(entries.length ? (safeIndex + 1) % entries.length : 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex(entries.length ? (safeIndex - 1 + entries.length) % entries.length : 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      entries[safeIndex]?.run();
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  };

  let lastGroup: string | null = null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="p-0 gap-0 sm:max-w-lg top-[18%] translate-y-0 overflow-hidden"
        onKeyDown={handleKeyDown}
        aria-label="Find"
        data-webwow-find
      >
        <DialogTitle className="sr-only">Find</DialogTitle>
        <div className="relative border-b">
          <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <Input
            autoFocus
            data-autofocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
            placeholder="Search pages, layers, collections, components, actions…"
            aria-label="Search"
            role="combobox"
            aria-expanded
            aria-controls="webwow-find-list"
            aria-activedescendant={entries[safeIndex] ? `find-${entries[safeIndex].id}` : undefined}
            className="h-10 text-sm pl-9 border-0 rounded-none bg-transparent focus-visible:ring-0"
          />
        </div>
        <ul
          id="webwow-find-list" role="listbox"
          ref={listRef} className="max-h-80 overflow-y-auto p-2"
        >
          {entries.length === 0 && <li className="px-3 py-6 text-xs text-muted-foreground text-center">No results</li>}
          {entries.map((entry, i) => {
            const heading = entry.group !== lastGroup ? entry.group : null;
            lastGroup = entry.group;
            return (
              <React.Fragment key={entry.id}>
                {heading && <li role="presentation" className="text-[11px] uppercase text-muted-foreground px-3 pt-2 pb-1">{heading}</li>}
                <li
                  id={`find-${entry.id}`}
                  role="option"
                  aria-selected={i === safeIndex}
                  data-index={i}
                  data-find-entry={entry.id}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => entry.run()}
                  className={cn('h-8 px-3 flex items-center gap-2 text-xs rounded-md cursor-pointer', i === safeIndex && 'bg-secondary')}
                >
                  <Icon name={entry.icon} className="size-3 text-muted-foreground shrink-0" />
                  <span className="truncate">{entry.label}</span>
                  {entry.hint && <span className="ml-auto text-muted-foreground truncate max-w-[45%]">{entry.hint}</span>}
                  {i === safeIndex && (
                    <span className={cn('text-[10px] text-muted-foreground shrink-0', !entry.hint && 'ml-auto')}>
                      {entry.group === 'Actions' ? 'Run' : GROUP_HINT[entry.group]}
                    </span>
                  )}
                </li>
              </React.Fragment>
            );
          })}
        </ul>
        <div className="h-8 px-3 flex items-center gap-3 border-t text-[11px] text-muted-foreground">
          <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate</span>
          <span><Kbd>↵</Kbd> open</span>
          <span><Kbd>esc</Kbd> close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default React.memo(FindPalette);

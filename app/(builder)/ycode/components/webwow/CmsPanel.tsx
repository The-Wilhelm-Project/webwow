'use client';

import React, { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { useCollectionsStore } from '@/stores/useCollectionsStore';
import { uniqueName } from '@/lib/webwow/builder/panel-utils';
import PanelLinkList, { PanelSectionTitle } from './PanelLinkList';

export interface CmsPanelProps {
  search: string;
  currentCollectionId: string | null;
  /** Structure roles may create collections (`canEditStructure`); editors only browse. */
  canCreate: boolean;
  onOpenCollection: (collectionId: string) => void;
  onOpenGlobals: () => void;
}

/**
 * Collections list. A row opens `/ycode/collections/<id>`; "New collection" follows the
 * CMS sidebar's routine (unique name, create, open) so the new collection can be renamed there.
 */
function CmsPanel({ search, currentCollectionId, canCreate, onOpenCollection, onOpenGlobals }: CmsPanelProps) {
  const collections = useCollectionsStore((state) => state.collections);
  const createCollection = useCollectionsStore((state) => state.createCollection);
  const [creating, setCreating] = useState(false);

  const query = search.trim().toLowerCase();
  const links = useMemo(() => collections
    .filter((c) => !query || c.name.toLowerCase().includes(query))
    .map((c) => ({
      id: c.id,
      label: c.name,
      icon: 'database',
      hint: typeof c.draft_items_count === 'number' ? String(c.draft_items_count) : undefined,
      current: c.id === currentCollectionId,
      onSelect: () => onOpenCollection(c.id),
    })), [collections, query, currentCollectionId, onOpenCollection]);

  const handleCreate = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const existing = useCollectionsStore.getState().collections;
      const created = await createCollection({
        name: uniqueName('Collection', existing.map((c) => c.name)),
        sorting: null,
        order: existing.length,
      });
      onOpenCollection(created.id);
    } catch (error) {
      console.error('Failed to create collection:', error);
      toast.error('Failed to create collection');
    } finally {
      setCreating(false);
    }
  }, [creating, createCollection, onOpenCollection]);

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-webwow-cms-panel>
      {canCreate && (
        <div className="px-3 pt-3 pb-2 border-b">
          <Button
            size="sm" variant="secondary"
            className="w-full" disabled={creating}
            onClick={() => { void handleCreate(); }}
          >
            {creating ? <Spinner /> : <Icon name="plus" />}
            New collection
          </Button>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
        <PanelLinkList
          links={[{ id: '__globals', label: 'Global variables', icon: 'globe', onSelect: onOpenGlobals }]}
          className="pb-0"
        />
        <PanelSectionTitle>Collections</PanelSectionTitle>
        <PanelLinkList
          links={links}
          emptyText={query ? 'No collections match' : 'No collections yet'}
        />
      </div>
    </div>
  );
}

export default React.memo(CmsPanel);

'use client';

import React, { Suspense, lazy } from 'react';
import type { UseLiveLayerUpdatesReturn } from '@/hooks/use-live-layer-updates';

const ElementLibrary = lazy(() => import('../ElementLibrary'));

export interface AddPanelProps {
  open: boolean;
  onClose: () => void;
  liveLayerUpdates?: UseLiveLayerUpdatesReturn | null;
}

/**
 * The Add flyout body: the upstream `ElementLibrary` (Elements / Layouts / Components tabs)
 * rendered inline. `ElementLibrary` positions itself `fixed` next to the classic sidebar; the
 * wrapper below turns that root static so it fills the panel instead. It stays mounted so its
 * `toggleElementLibrary` tab listener and session state keep working.
 */
function AddPanel({ open, onClose, liveLayerUpdates }: AddPanelProps) {
  return (
    <div
      data-webwow-add-panel
      className="relative flex-1 min-h-0 flex flex-col [&>div.fixed]:static! [&>div.fixed]:inset-auto! [&>div.fixed]:w-full! [&>div.fixed]:h-full! [&>div.fixed]:min-h-0! [&>div.fixed]:border-r-0! [&>div.fixed]:z-auto!"
    >
      <Suspense fallback={null}>
        <ElementLibrary
          isOpen={open} onClose={onClose}
          liveLayerUpdates={liveLayerUpdates}
        />
      </Suspense>
    </div>
  );
}

export default React.memo(AddPanel);

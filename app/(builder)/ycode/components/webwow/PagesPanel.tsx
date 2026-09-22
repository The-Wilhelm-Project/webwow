'use client';

import React, { forwardRef } from 'react';
import LeftSidebarPages, { type LeftSidebarPagesHandle } from '../LeftSidebarPages';
import { usePagesStore } from '@/stores/usePagesStore';
import { useEditorStore } from '@/stores/useEditorStore';

export type PagesPanelHandle = LeftSidebarPagesHandle;

export interface PagesPanelProps {
  currentPageId: string | null;
  onPageSelect: (pageId: string) => void;
  readOnly?: boolean;
}

/**
 * Page tree (folders, settings, context menu) - the upstream `LeftSidebarPages` inside a
 * scroll container. The handle exposes `checkAndCloseSettings()` so the container can ask
 * before hiding the panel.
 */
const PagesPanel = React.memo(forwardRef<PagesPanelHandle, PagesPanelProps>(function PagesPanel(
  { currentPageId, onPageSelect, readOnly = false },
  ref,
) {
  const pages = usePagesStore((state) => state.pages);
  const folders = usePagesStore((state) => state.folders);
  const setCurrentPageId = useEditorStore((state) => state.setCurrentPageId);

  return (
    // `[&>header]:pr-14` moves the upstream `+` menu left of the pin/close overlay that
    // RailPanel renders over this 56 px header row (native header mode).
    // The upstream list has no search field or focusable title, so the scroll container is
    // the panel's focus target on open (`data-panel-title`, see RailPanel): Tab then reaches
    // the `+` menu and the page rows without passing through the pinned Navigator first.
    <div
      tabIndex={-1} data-panel-title
      className="flex flex-col flex-1 min-h-0 overflow-y-auto no-scrollbar outline-none [&>header]:pr-14"
    >
      <LeftSidebarPages
        ref={ref}
        pages={pages}
        folders={folders}
        currentPageId={currentPageId}
        onPageSelect={onPageSelect}
        setCurrentPageId={setCurrentPageId}
        readOnly={readOnly}
      />
    </div>
  );
}));

export default PagesPanel;

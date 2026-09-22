'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useEditorUrl, type EditorTab } from '@/hooks/use-editor-url';
import { useEditComponent } from '@/hooks/use-edit-component';
import { useRole } from '@/hooks/use-role';
import { useEditorStore } from '@/stores/useEditorStore';
import { usePagesStore } from '@/stores/usePagesStore';
import { useCollectionsStore } from '@/stores/useCollectionsStore';
import { useAuthStore } from '@/stores/useAuthStore';
import { SETTINGS_NAV_ITEMS } from '@/lib/settings-nav-items';
import type { UseLiveLayerUpdatesReturn } from '@/hooks/use-live-layer-updates';
import type { UseLiveComponentUpdatesReturn } from '@/hooks/use-live-component-updates';

import Rail, { type RailButtonState, type RailProfileSlotProps } from './Rail';
import RailPanel, { type RailPanelMode } from './RailPanel';
import NavigatorPanel from './NavigatorPanel';
import PagesPanel, { type PagesPanelHandle } from './PagesPanel';
import AddPanel from './AddPanel';
import ComponentsPanel from './ComponentsPanel';
import AssetsPanel from './AssetsPanel';
import CmsPanel from './CmsPanel';
import FormsPanel from './FormsPanel';
import LocalizationPanel from './LocalizationPanel';
import AppsPanel from './AppsPanel';
import SettingsPanel from './SettingsPanel';
import HelpPanel from './HelpPanel';
import FindPalette, { type FindAction } from './FindPalette';
import ProfileMenu from './ProfileMenu';
import ThemeMenu from './ThemeMenu';
import { readRailStorage, useRailResize, useRailState } from './useRailState';
import {
  OPEN_POPUP_SELECTOR,
  RAIL_FLYOUT_WIDTH,
  RAIL_WIDTH,
  activeRouteItem,
  getRailItem,
  isRailItemVisible,
  isRouteEnabled,
  isTypingTarget,
  resolveRailShortcut,
  routeKindFor,
  visibleRailItems,
  type RailItemId,
} from './railItems';

export interface WebwowLeftSidebarProps {
  onLayerSelect: (layerId: string | null) => void;
  currentPageId: string | null;
  onPageSelect: (pageId: string) => void;
  liveLayerUpdates?: UseLiveLayerUpdatesReturn | null;
  liveComponentUpdates?: UseLiveComponentUpdatesReturn | null;
  readOnly?: boolean;
}

const OUTSIDE_CLICK_ALLOWLIST = [
  '[data-webwow-rail]',
  '[data-webwow-rail-panel]',
  '[data-radix-popper-content-wrapper]',
  '[role="dialog"]',
  '[data-slot="dialog-overlay"]',
  '[data-slot="tooltip-content"]',
  '[data-sonner-toaster]',
].join(', ');

const PANEL_TITLES: Record<RailItemId, string> = {
  add: 'Add',
  pages: 'Pages',
  navigator: 'Navigator',
  components: 'Components',
  assets: 'Assets',
  cms: 'CMS',
  forms: 'Forms',
  localization: 'Localization',
  apps: 'Apps',
  settings: 'Settings',
  find: 'Find',
  help: 'Help',
  theme: 'Theme',
  profile: 'Profile',
};

const LAZY_PANELS: readonly RailItemId[] = ['components', 'assets', 'cms', 'forms', 'localization', 'apps', 'settings', 'help'];

/**
 * Webflow-style left side of the builder: a 48 px icon rail plus one pinned panel
 * (Navigator or Pages, pushes the canvas) and at most one flyout panel (overlays the canvas).
 * Same props as the upstream `LeftSidebar`.
 */
const WebwowLeftSidebar = React.memo(function WebwowLeftSidebar({
  onLayerSelect,
  currentPageId,
  onPageSelect,
  liveLayerUpdates,
  liveComponentUpdates,
  readOnly = false,
}: WebwowLeftSidebarProps) {
  const router = useRouter();
  const { routeType, resourceId, sidebarTab, navigateToLayers, navigateToCollection, navigateToCollections } = useEditorUrl();
  const editComponent = useEditComponent();
  const { role, isEditor, canManageMembers } = useRole();

  const storeSidebarTab = useEditorStore((state) => state.activeSidebarTab);
  const setActiveSidebarTab = useEditorStore((state) => state.setActiveSidebarTab);
  const setLeftSidebarWidth = useEditorStore((state) => state.setLeftSidebarWidth);
  const setLastDesignUrl = useEditorStore((state) => state.setLastDesignUrl);
  const isPreviewMode = useEditorStore((state) => state.isPreviewMode);
  const setSelectedCollectionId = useCollectionsStore((state) => state.setSelectedCollectionId);
  const selectedCollectionId = useCollectionsStore((state) => state.selectedCollectionId);

  const activeTab = storeSidebarTab || sidebarTab;
  const routeKind = routeKindFor(routeType, activeTab);
  const isDesign = routeKind === 'design';

  // ---- persisted state + width -------------------------------------------------------------
  // `readRailStorage` / `writeRailStorage` guard every localStorage access (blocked storage
  // must never break the builder); the width is persisted only through them.
  const [stored] = useState(() => readRailStorage());
  const { width, isDragging, handleMouseDown: handleResizeMouseDown } = useRailResize(stored.width);

  const rail = useRailState({
    stored,
    // A `/ycode/pages/<id>` link shows the Pages panel even when it is not the pinned one.
    initialFlyout: routeType === 'page' && stored.pinned !== 'pages' ? 'pages' : null,
    width,
    widthSettled: !isDragging,
  });
  const { state, stateRef, toggle, openFlyout, closeFlyout, pin, unpin } = rail;
  const { pinned, collapsed, flyout } = state;

  const pinnedVisible = pinned !== null && !collapsed && isDesign;
  const pinnedWidth = pinnedVisible ? width : 0;
  const flyoutLeft = RAIL_WIDTH + pinnedWidth;

  const modeFor = useCallback((id: RailItemId): RailPanelMode => {
    if (flyout === id) return 'flyout';
    if (pinnedVisible && pinned === id) return 'pinned';
    return 'hidden';
  }, [flyout, pinnedVisible, pinned]);

  const modeForRef = useRef(modeFor);
  modeForRef.current = modeFor;

  const pagesShowing = modeFor('pages') !== 'hidden';

  // Store width = viewport x of the right edge of the left stack (rail + pinned + flyout).
  useEffect(() => {
    setLeftSidebarWidth(RAIL_WIDTH + pinnedWidth + (flyout ? RAIL_FLYOUT_WIDTH : 0));
  }, [width, pinnedWidth, flyout, setLeftSidebarWidth]);

  // ---- refs --------------------------------------------------------------------------------
  const pagesRef = useRef<PagesPanelHandle>(null);
  const railButtons = useRef<Partial<Record<RailItemId, HTMLButtonElement | null>>>({});
  const registerButton = useCallback((id: RailItemId, el: HTMLButtonElement | null) => {
    railButtons.current[id] = el;
  }, []);
  const registerProfileButton = useCallback((el: HTMLButtonElement | null) => registerButton('profile', el), [registerButton]);
  const registerThemeButton = useCallback((el: HTMLButtonElement | null) => registerButton('theme', el), [registerButton]);
  const [findOpen, setFindOpen] = useState(false);
  const findOpenRef = useRef(findOpen);
  const routeKindRef = useRef(routeKind);
  const roleRef = useRef(role);
  const readOnlyRef = useRef(readOnly);
  const previewRef = useRef(isPreviewMode);
  useEffect(() => {
    findOpenRef.current = findOpen;
    routeKindRef.current = routeKind;
    roleRef.current = role;
    readOnlyRef.current = readOnly;
    previewRef.current = isPreviewMode;
  }, [findOpen, routeKind, role, readOnly, isPreviewMode]);

  const [opened, setOpened] = useState<Set<RailItemId>>(() => new Set());
  useEffect(() => {
    if (flyout && LAZY_PANELS.includes(flyout) && !opened.has(flyout)) {
      setOpened((prev) => new Set(prev).add(flyout));
    }
  }, [flyout, opened]);

  const [searches, setSearches] = useState<Partial<Record<RailItemId, string>>>({});
  const searchFor = (id: RailItemId) => ({
    value: searches[id] ?? '',
    onChange: (value: string) => setSearches((prev) => ({ ...prev, [id]: value })),
  });
  const componentsSearch = searches.components ?? '';
  const assetsSearch = searches.assets ?? '';
  const cmsSearch = searches.cms ?? '';

  // ---- store tab ---------------------------------------------------------------------------
  // The rail records every `activeSidebarTab` it writes so the sync effects can tell its own
  // writes from external ones (HeaderBar, canvas), see the URL <-> store section.
  const lastWrittenTabRef = useRef<EditorTab | null>(storeSidebarTab || null);
  const writeSidebarTab = useCallback((tab: EditorTab) => {
    lastWrittenTabRef.current = tab;
    if (useEditorStore.getState().activeSidebarTab !== tab) setActiveSidebarTab(tab);
  }, [setActiveSidebarTab]);

  // ---- guards ------------------------------------------------------------------------------
  /** Pages settings may hold unsaved changes: ask before hiding a visible Pages panel. */
  const guardPages = useCallback(async (): Promise<boolean> => {
    if (!pagesRef.current) return true;
    return pagesRef.current.checkAndCloseSettings();
  }, []);

  const requestCloseFlyout = useCallback(async () => {
    const current = stateRef.current.flyout;
    if (!current) return;
    if (current === 'pages' && !(await guardPages())) return;
    closeFlyout();
  }, [stateRef, guardPages, closeFlyout]);
  /** Sync wrapper for event props of memoized children. */
  const closeFlyoutRequested = useCallback(() => { void requestCloseFlyout(); }, [requestCloseFlyout]);

  const isEnabled = useCallback((id: RailItemId) => {
    if (!isRailItemVisible(id, roleRef.current)) return false;
    if (!isRouteEnabled(id, routeKindRef.current)) return false;
    if (id === 'add' && readOnlyRef.current) return false;
    return true;
  }, []);

  const activate = useCallback(async (id: RailItemId) => {
    // Preview mode covers the rail (fixed overlay in CenterCanvas): nothing opens behind it.
    if (previewRef.current) return;
    if (getRailItem(id).kind === 'menu') return;
    if (id === 'find') {
      setFindOpen((open) => !open);
      return;
    }
    if (!isEnabled(id)) return;
    const st = stateRef.current;
    const pinnedUsable = routeKindRef.current === 'design';
    const pagesVisible = st.flyout === 'pages' || (st.pinned === 'pages' && !st.collapsed && pinnedUsable);
    // Toggling Pages hides it; opening another flyout replaces a Pages flyout.
    const hidesPages = pagesVisible && (id === 'pages' || st.flyout === 'pages');
    if (hidesPages && !(await guardPages())) return;
    toggle(id, pinnedUsable);
  }, [isEnabled, stateRef, guardPages, toggle]);
  const handleActivate = useCallback((id: RailItemId) => { void activate(id); }, [activate]);
  const toggleAdd = useCallback(() => { void activate('add'); }, [activate]);

  const closeAndRefocus = useCallback(async () => {
    const current = stateRef.current.flyout;
    if (!current) return;
    if (current === 'pages' && !(await guardPages())) return;
    closeFlyout();
    railButtons.current[current]?.focus();
  }, [stateRef, guardPages, closeFlyout]);

  const togglePin = useCallback(async (id: 'navigator' | 'pages') => {
    const st = stateRef.current;
    if (st.pinned === id) {
      unpin(id);
      return;
    }
    const pagesVisible = st.flyout === 'pages' || (st.pinned === 'pages' && !st.collapsed);
    if (id === 'navigator' && pagesVisible && st.pinned === 'pages' && !(await guardPages())) return;
    pin(id);
  }, [stateRef, unpin, pin, guardPages]);
  const pinNavigator = useCallback(() => { void togglePin('navigator'); }, [togglePin]);
  const pinPages = useCallback(() => { void togglePin('pages'); }, [togglePin]);

  /** Pins `id` (no-op when already pinned) - used by the palette's "Pin ..." actions. */
  const togglePinTo = useCallback(async (id: 'navigator' | 'pages') => {
    if (stateRef.current.pinned === id) return;
    await togglePin(id);
  }, [stateRef, togglePin]);

  const goTo = useCallback((path: string) => {
    if (routeKindRef.current === 'design' && typeof window !== 'undefined') {
      setLastDesignUrl(window.location.pathname + window.location.search);
    }
    closeFlyout();
    router.push(path);
  }, [setLastDesignUrl, closeFlyout, router]);

  const openCollection = useCallback((collectionId: string) => {
    if (routeKindRef.current === 'design' && typeof window !== 'undefined') {
      setLastDesignUrl(window.location.pathname + window.location.search);
    }
    closeFlyout();
    writeSidebarTab('cms');
    setSelectedCollectionId(collectionId);
    navigateToCollection(collectionId);
  }, [setLastDesignUrl, closeFlyout, writeSidebarTab, setSelectedCollectionId, navigateToCollection]);

  const openCollectionsBase = useCallback(() => {
    if (routeKindRef.current === 'design' && typeof window !== 'undefined') {
      setLastDesignUrl(window.location.pathname + window.location.search);
    }
    closeFlyout();
    writeSidebarTab('cms');
    navigateToCollections();
  }, [setLastDesignUrl, closeFlyout, writeSidebarTab, navigateToCollections]);

  const openPage = useCallback((pageId: string) => {
    closeFlyout();
    useEditorStore.getState().setCurrentPageId(pageId);
    navigateToLayers(pageId);
  }, [closeFlyout, navigateToLayers]);

  /** Selects a layer from the palette and makes sure the Navigator shows it. */
  const openLayer = useCallback((layerId: string) => {
    onLayerSelect(layerId);
    const st = stateRef.current;
    const pinnedUsable = routeKindRef.current === 'design';
    const navigatorShowing = st.flyout === 'navigator' || (st.pinned === 'navigator' && !st.collapsed && pinnedUsable);
    if (!navigatorShowing) {
      openFlyout('navigator', pinnedUsable);
    } else if (st.flyout === 'pages') {
      // A Pages flyout would cover the canvas (and keep the store tab on 'pages').
      void requestCloseFlyout();
    }
  }, [onLayerSelect, stateRef, openFlyout, requestCloseFlyout]);

  /**
   * Opens the component editor (Components panel pencil, palette) through the upstream
   * `useEditComponent` hook - the same path as the right sidebar's "Edit component" and the
   * canvas double-click. The hook selects a layer inside the component while the route is
   * still pending; YCodeBuilderMain holds the `?layer=` URL mirror back during that window
   * (a `replaceState` there would make the App Router restore the previous route).
   */
  const openComponentEditor = useCallback((componentId: string) => {
    closeFlyout();
    const selectedLayerId = useEditorStore.getState().selectedLayerId;
    void editComponent(componentId, { returnToLayerId: selectedLayerId ?? undefined });
  }, [closeFlyout, editComponent]);

  // ---- URL <-> store tab sync (design routes only) ------------------------------------------
  // One-time URL -> store sync, as the upstream sidebar does on mount.
  const hasInitializedTabRef = useRef(false);
  useEffect(() => {
    if (hasInitializedTabRef.current) return;
    hasInitializedTabRef.current = true;
    writeSidebarTab(sidebarTab);
  }, [sidebarTab, writeSidebarTab]);

  // Store tab on design routes: 'pages' only while the Pages *flyout* covers the canvas (the
  // upstream "Pages tab" state: layer shortcuts and canvas selection overlays off), 'layers'
  // otherwise. A pinned Pages panel sits next to a usable canvas / Navigator flyout and is not
  // a mode - it never gates the upstream layer shortcuts (YCodeBuilderMain) or the canvas
  // overlays (CenterCanvas). The URL still shows `/ycode/pages/<id>` while any Pages panel is
  // showing, so the URL segment and the store tab are derived separately.
  const designTab: EditorTab = flyout === 'pages' ? 'pages' : 'layers';
  const urlSegment = pagesShowing ? 'pages' : 'layers';
  useEffect(() => {
    if (routeType !== 'layers' && routeType !== 'page' && routeType !== 'component') return;
    // A store tab the rail did not write itself comes from outside - the HeaderBar's "Pages" /
    // "Content editor" buttons (editor role), the canvas, the preview toggle - and is applied
    // to the panels first; the re-render then re-runs this effect with the settled rail state
    // and re-derives the tab, so an external write never sticks. Compare against the live store
    // value: the render value can lag behind a write made earlier in the same commit (the mount
    // sync above writes the URL tab, e.g. 'pages' for a `/ycode/pages/<id>` link, while this
    // render still holds the store default 'layers').
    const liveTab = useEditorStore.getState().activeSidebarTab;
    if (storeSidebarTab && storeSidebarTab === liveTab && storeSidebarTab !== lastWrittenTabRef.current) {
      lastWrittenTabRef.current = storeSidebarTab;
      const pinnedUsable = routeKindRef.current === 'design';
      if (storeSidebarTab === 'pages' && modeForRef.current('pages') === 'hidden') {
        // Opens the Pages flyout, or expands a collapsed pinned Pages panel.
        openFlyout('pages', pinnedUsable);
        return;
      }
      if (storeSidebarTab === 'layers' && stateRef.current.flyout === 'pages') {
        // "Layers" means the canvas / Navigator: drop a Pages flyout, keep a pinned Pages panel.
        closeFlyout();
        return;
      }
      // Other tabs (CMS, ...) belong to a route change in flight: leave them alone.
      if (storeSidebarTab !== 'pages' && storeSidebarTab !== 'layers') return;
    }
    writeSidebarTab(designTab);
    if (routeType === 'component') return;
    const currentSegment = routeType === 'layers' ? 'layers' : 'pages';
    if (currentSegment === urlSegment) return;
    const targetPageId = currentPageId || resourceId || usePagesStore.getState().pages[0]?.id;
    if (!targetPageId) return;
    window.history.replaceState(null, '', `/ycode/${urlSegment}/${targetPageId}${window.location.search}`);
  }, [storeSidebarTab, designTab, urlSegment, routeType, currentPageId, resourceId, stateRef, openFlyout, closeFlyout, writeSidebarTab]);

  // Preview mode covers the rail with a fixed overlay: close what is open and keep it closed.
  useEffect(() => {
    if (!isPreviewMode) return;
    closeFlyout();
    setFindOpen(false);
  }, [isPreviewMode, closeFlyout]);

  // Flyouts that need a design route close when the route changes.
  useEffect(() => {
    if (flyout && !isRouteEnabled(flyout, routeKind)) closeFlyout();
  }, [flyout, routeKind, closeFlyout]);

  // ---- global listeners --------------------------------------------------------------------
  // Keyboard (capture so the upstream `A` / `Escape` handlers never double-handle a match).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (findOpenRef.current || previewRef.current) return;
      // Dialogs, menus, open Selects and popovers own the keyboard (Radix typeahead etc.).
      const dialogOpen = document.querySelector(OPEN_POPUP_SELECTOR) !== null;
      const result = resolveRailShortcut(e, {
        typing: isTypingTarget(e.target),
        dialogOpen,
        flyoutOpen: stateRef.current.flyout !== null,
        role: roleRef.current,
        routeKind: routeKindRef.current,
      });
      if (!result) return;
      if (result === 'add' && readOnlyRef.current) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (result === 'escape') {
        void closeAndRefocus();
      } else {
        void activate(result);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [stateRef, closeAndRefocus, activate]);

  // Cmd/Ctrl+K also toggles the palette while it is open.
  useEffect(() => {
    if (!findOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === 'KeyK') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setFindOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [findOpen]);

  // Element library events (shortcut `A` in the upstream handler, "Add layout" on an empty canvas).
  useEffect(() => {
    const handleToggle = (event: Event) => {
      if (previewRef.current || !isEnabled('add')) return;
      const tab = (event as CustomEvent<{ tab?: string }>).detail?.tab;
      if (tab) {
        openFlyout('add', routeKindRef.current === 'design');
        return;
      }
      // Without `detail.tab` the event comes from the upstream `A` keydown handler, whose own
      // guard misses open Selects / popovers: apply the rail's shortcut guard here as well.
      if (isTypingTarget(document.activeElement) || document.querySelector(OPEN_POPUP_SELECTOR) !== null) return;
      void activate('add');
    };
    const handleClose = () => {
      void requestCloseFlyout();
    };
    window.addEventListener('toggleElementLibrary', handleToggle);
    window.addEventListener('closeElementLibrary', handleClose);
    return () => {
      window.removeEventListener('toggleElementLibrary', handleToggle);
      window.removeEventListener('closeElementLibrary', handleClose);
    };
  }, [isEnabled, openFlyout, activate, requestCloseFlyout]);

  // Click outside rail + panels, and focus moving into the canvas iframe, close the flyout.
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (!stateRef.current.flyout) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest(OUTSIDE_CLICK_ALLOWLIST)) return;
      void requestCloseFlyout();
    };
    const handleBlur = () => {
      if (!stateRef.current.flyout) return;
      if (document.activeElement instanceof HTMLIFrameElement) void requestCloseFlyout();
    };
    document.addEventListener('mousedown', handleMouseDown, true);
    window.addEventListener('blur', handleBlur);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown, true);
      window.removeEventListener('blur', handleBlur);
    };
  }, [stateRef, requestCloseFlyout]);

  // ---- rail --------------------------------------------------------------------------------
  const items = useMemo(() => visibleRailItems(role), [role]);
  const currentRouteItem = activeRouteItem(routeType);

  const stateFor = useCallback((id: RailItemId): RailButtonState => {
    const item = getRailItem(id);
    const open = flyout === id || (pinnedVisible && pinned === id);
    const current = currentRouteItem === id;
    const disabled = !isRouteEnabled(id, routeKind) || (id === 'add' && readOnly);
    return {
      active: open || current || (id === 'find' && findOpen),
      pressed: item.kind === 'flyout' || item.kind === 'pinnable' ? open : item.kind === 'action' ? findOpen : undefined,
      current,
      disabled,
      disabledHint: disabled && item.designOnly ? 'open a page' : undefined,
    };
  }, [flyout, pinnedVisible, pinned, currentRouteItem, routeKind, readOnly, findOpen]);

  // One stable close handler per panel (memoized panel bodies receive it as a prop).
  const onCloseFor = useMemo(() => {
    const handlers = {} as Record<RailItemId, () => void>;
    for (const id of Object.keys(PANEL_TITLES) as RailItemId[]) {
      handlers[id] = () => {
        if (modeForRef.current(id) === 'pinned') void activate(id);
        else void requestCloseFlyout();
      };
    }
    return handlers;
  }, [activate, requestCloseFlyout]);

  // Esc inside a panel (search field): same as the global Esc shortcut, i.e. the focus goes
  // back to the rail icon. The global handler never sees that keydown (typing target).
  const onEscapeFor = useMemo(() => {
    const handlers = {} as Record<RailItemId, () => void>;
    for (const id of Object.keys(PANEL_TITLES) as RailItemId[]) {
      handlers[id] = () => {
        if (modeForRef.current(id) === 'pinned') {
          void activate(id).then(() => railButtons.current[id]?.focus());
        } else {
          void closeAndRefocus();
        }
      };
    }
    return handlers;
  }, [activate, closeAndRefocus]);

  const closeLabelFor = (id: RailItemId) =>
    (modeFor(id) === 'pinned' ? `Collapse panel (${id === 'navigator' ? 'Z' : 'P'})` : 'Close panel (Esc)');

  const panelProps = (id: RailItemId) => ({
    id,
    title: PANEL_TITLES[id],
    mode: modeFor(id),
    width,
    flyoutLeft,
    onClose: onCloseFor[id],
    onEscape: onEscapeFor[id],
    closeLabel: closeLabelFor(id),
  });

  const pinnableProps = (id: 'navigator' | 'pages') => ({
    ...panelProps(id),
    pinnable: true,
    pinned: pinned === id,
    onPin: id === 'navigator' ? pinNavigator : pinPages,
    onResizeMouseDown: handleResizeMouseDown,
    isResizing: isDragging,
  });

  const renderMenu = useCallback((id: RailItemId, slot: RailProfileSlotProps) => {
    if (id === 'theme') {
      return (
        <ThemeMenu
          registerButton={registerThemeButton}
          tabIndex={slot.tabIndex} onFocus={slot.onFocus}
        />
      );
    }
    if (id === 'profile') {
      return (
        <ProfileMenu
          isEditor={isEditor} goTo={goTo}
          registerButton={registerProfileButton}
          tabIndex={slot.tabIndex} onFocus={slot.onFocus}
        />
      );
    }
    return null;
  }, [isEditor, goTo, registerProfileButton, registerThemeButton]);

  const showFind = !isEditor && isRailItemVisible('find', role);
  const findActions = useMemo<FindAction[]>(() => [
    // The HeaderBar listens for `webwow:publish` and opens its Publish popover. Deferred a
    // tick so the palette dialog has released focus before the popover trigger is clicked.
    { id: 'publish', label: 'Publish', hint: 'Open the publish menu', icon: 'zap', run: () => { window.setTimeout(() => window.dispatchEvent(new CustomEvent('webwow:publish')), 80); } },
    { id: 'preview', label: 'Preview', hint: 'Toggle preview mode', icon: 'preview', run: () => window.dispatchEvent(new CustomEvent('togglePreview')) },
    { id: 'pages', label: 'Open Pages', icon: 'page', run: () => { void activate('pages'); } },
    { id: 'navigator', label: 'Open Navigator', icon: 'layers', run: () => { void activate('navigator'); } },
    { id: 'components', label: 'Open Components', icon: 'component', run: () => { void activate('components'); } },
    { id: 'assets', label: 'Open Assets', icon: 'image', run: () => { void activate('assets'); } },
    { id: 'file-manager', label: 'File manager', icon: 'folder', run: () => useEditorStore.getState().openFileManager() },
    { id: 'pin-navigator', label: 'Pin Navigator', icon: 'layers', run: () => { void togglePinTo('navigator'); } },
    { id: 'pin-pages', label: 'Pin Pages', icon: 'page', run: () => { void togglePinTo('pages'); } },
    ...SETTINGS_NAV_ITEMS
      .filter((item) => item.id !== 'users' || canManageMembers)
      .map<FindAction>((item) => ({ id: `settings-${item.id}`, label: `Settings › ${item.label}`, icon: 'settings', run: () => goTo(item.path) })),
    { id: 'forms', label: 'Forms', icon: 'form', run: () => goTo('/ycode/forms') },
    { id: 'localization', label: 'Localization', icon: 'globe', run: () => goTo('/ycode/localization') },
    { id: 'apps', label: 'Apps', icon: 'cube', run: () => goTo('/ycode/integrations/apps') },
    { id: 'webhooks', label: 'Webhooks', icon: 'zap', run: () => goTo('/ycode/integrations/webhooks') },
    { id: 'mcp', label: 'MCP', icon: 'sparkles', run: () => goTo('/ycode/integrations/mcp') },
    { id: 'profile', label: 'My profile', icon: 'settings', run: () => goTo('/ycode/profile') },
    { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'info', run: () => useEditorStore.getState().setKeyboardShortcutsOpen(true) },
    { id: 'sign-out', label: 'Sign out', icon: 'arrow-right', run: () => { void useAuthStore.getState().signOut(); } },
  ], [activate, goTo, canManageMembers, togglePinTo]);

  const navigatorMode = modeFor('navigator');

  return (
    <>
      <Rail
        items={items}
        stateFor={stateFor}
        onActivate={handleActivate}
        registerButton={registerButton}
        renderMenu={renderMenu}
      />

      {/* Navigator - always mounted (instant switch, like the upstream forceMount tabs) */}
      <RailPanel {...pinnableProps('navigator')} header="none">
        <NavigatorPanel
          onLayerSelect={onLayerSelect}
          currentPageId={currentPageId}
          liveLayerUpdates={liveLayerUpdates}
          liveComponentUpdates={liveComponentUpdates}
          readOnly={readOnly}
          panelWidth={navigatorMode === 'pinned' ? width : RAIL_FLYOUT_WIDTH}
          addOpen={flyout === 'add'}
          onToggleAdd={toggleAdd}
          pinned={pinned === 'navigator'}
          onPin={pinNavigator}
          onClose={onCloseFor.navigator}
          closeLabel={closeLabelFor('navigator')}
        />
      </RailPanel>

      {/* Pages - always mounted */}
      <RailPanel {...pinnableProps('pages')} header="native">
        <PagesPanel
          ref={pagesRef} currentPageId={currentPageId}
          onPageSelect={onPageSelect} readOnly={readOnly}
        />
      </RailPanel>

      {/* Add - the upstream ElementLibrary, always mounted for structure roles */}
      {isRailItemVisible('add', role) && (
        <RailPanel {...panelProps('add')} header="toolbar">
          <AddPanel
            open={flyout === 'add'} onClose={closeFlyoutRequested}
            liveLayerUpdates={liveLayerUpdates}
          />
        </RailPanel>
      )}

      {opened.has('components') && (
        <RailPanel {...panelProps('components')} search={{ ...searchFor('components'), placeholder: 'Search components…' }}>
          <ComponentsPanel
            search={componentsSearch}
            currentPageId={currentPageId}
            liveLayerUpdates={liveLayerUpdates}
            canInsert={isDesign && !readOnly}
            onOpenComponent={openComponentEditor}
            onInserted={closeFlyout}
          />
        </RailPanel>
      )}
      {opened.has('assets') && (
        <RailPanel {...panelProps('assets')} search={{ ...searchFor('assets'), placeholder: 'Search assets…' }}>
          <AssetsPanel
            search={assetsSearch}
            currentPageId={currentPageId}
            liveLayerUpdates={liveLayerUpdates}
            canvasEditable={isDesign}
            active={flyout === 'assets'}
          />
        </RailPanel>
      )}
      {opened.has('cms') && (
        <RailPanel {...panelProps('cms')} search={{ ...searchFor('cms'), placeholder: 'Search collections…' }}>
          <CmsPanel
            search={cmsSearch}
            currentCollectionId={routeType === 'collection' ? resourceId : selectedCollectionId}
            canCreate={!readOnly}
            onOpenCollection={openCollection}
            onOpenGlobals={openCollectionsBase}
          />
        </RailPanel>
      )}
      {opened.has('forms') && (
        <RailPanel {...panelProps('forms')}>
          <FormsPanel goTo={goTo} />
        </RailPanel>
      )}
      {opened.has('localization') && (
        <RailPanel {...panelProps('localization')}>
          <LocalizationPanel goTo={goTo} />
        </RailPanel>
      )}
      {opened.has('apps') && (
        <RailPanel {...panelProps('apps')}>
          <AppsPanel goTo={goTo} />
        </RailPanel>
      )}
      {opened.has('settings') && (
        <RailPanel {...panelProps('settings')}>
          <SettingsPanel goTo={goTo} canManageMembers={canManageMembers} />
        </RailPanel>
      )}
      {opened.has('help') && (
        <RailPanel {...panelProps('help')}>
          <HelpPanel role={role} goTo={goTo} />
        </RailPanel>
      )}

      {showFind && (
        <FindPalette
          open={findOpen}
          onOpenChange={setFindOpen}
          currentPageId={currentPageId}
          onOpenPage={openPage}
          onOpenLayer={openLayer}
          onOpenCollection={openCollection}
          onOpenComponent={openComponentEditor}
          actions={findActions}
        />
      )}
    </>
  );
});

export default WebwowLeftSidebar;

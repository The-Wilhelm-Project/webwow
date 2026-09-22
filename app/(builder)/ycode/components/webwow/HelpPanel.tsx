'use client';

import React, { useEffect, useState } from 'react';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import Icon from '@/components/ui/icon';
import { useEditorStore } from '@/stores/useEditorStore';
import PanelLinkList, { PanelSectionTitle } from './PanelLinkList';
import { detectPlatform, metaKeyLabel, shortcutLabel, type Platform } from './railItems';
import type { UserRole } from '@/lib/roles';

export interface HelpPanelProps {
  role: UserRole;
  goTo: (path: string) => void;
}

const DOCS_URL = 'https://docs.ycode.com/docs';

interface ShortcutRow {
  label: string;
  /**
   * Keys. Cmd combos with a Ctrl fallback in the upstream handlers render as Ctrl on non-Mac
   * platforms; Meta-only combos render the platform's Meta key (Win / Meta) instead.
   */
  keys: string[];
  /** Hidden for the editor role (structural shortcuts). */
  structural?: boolean;
}

interface ShortcutGroup {
  name: string;
  rows: ShortcutRow[];
}

function buildGroups(platform: Platform): ShortcutGroup[] {
  const isMac = platform === 'mac';
  // Cmd combos render as one key ("⌘C") on Mac and as two ("Ctrl", "C") elsewhere - only for
  // rows whose upstream handler accepts `e.metaKey || e.ctrlKey`.
  const mod = (key: string): string[] => (isMac ? [`⌘${key}`] : ['Ctrl', key]);
  // Upstream handlers that check `e.metaKey` only (no Ctrl branch): show the real Meta key so
  // the panel never advertises a Ctrl combo that does nothing on Windows / Linux.
  const meta = (key: string): string[] => (isMac ? [`⌘${key}`] : [metaKeyLabel(platform), key]);
  const alt = isMac ? '⌥' : 'Alt';
  return [
    {
      name: 'Panels',
      rows: [
        { label: 'Add', keys: [shortcutLabel('add', isMac) ?? 'A'], structural: true },
        { label: 'Pages', keys: [shortcutLabel('pages', isMac) ?? 'P'] },
        { label: 'Navigator', keys: [shortcutLabel('navigator', isMac) ?? 'Z'] },
        { label: 'Components', keys: [shortcutLabel('components', isMac) ?? '⇧A'], structural: true },
        { label: 'Assets', keys: [shortcutLabel('assets', isMac) ?? 'J'] },
        { label: 'Find', keys: [shortcutLabel('find', isMac) ?? '⌘K'], structural: true },
        { label: 'Close panel', keys: ['Esc'] },
        { label: 'All shortcuts', keys: ['⇧', '/'] },
      ],
    },
    {
      name: 'Edit',
      rows: [
        { label: 'Copy', keys: mod('C'), structural: true },
        { label: 'Paste', keys: mod('V'), structural: true },
        { label: 'Cut', keys: mod('X'), structural: true },
        { label: 'Duplicate', keys: mod('D'), structural: true },
        { label: 'Undo', keys: mod('Z') },
        { label: 'Redo', keys: ['⇧', ...mod('Z')] },
        { label: 'Copy style', keys: [alt, ...meta('C')], structural: true },
        { label: 'Paste style', keys: [alt, ...meta('V')], structural: true },
        { label: 'Rename', keys: ['F2'], structural: true },
        { label: 'Delete', keys: ['⌫'], structural: true },
        { label: 'Select parent', keys: ['Esc'] },
      ],
    },
    {
      name: 'Component',
      rows: [
        { label: 'Create component', keys: [alt, ...meta('K')], structural: true },
        { label: 'Detach instance', keys: [alt, ...meta('B')], structural: true },
      ],
    },
    {
      name: 'View',
      rows: [
        { label: 'Collapse layers', keys: [alt, 'L'] },
        { label: 'Show / hide element', keys: ['⇧', ...meta('H')], structural: true },
        { label: 'Zoom in', keys: mod('+') },
        { label: 'Zoom out', keys: mod('-') },
        { label: 'Zoom to 100 %', keys: mod('0') },
        { label: 'Zoom to fit', keys: mod('1') },
        { label: 'Autofit', keys: mod('2') },
        { label: 'Pan', keys: ['Space', 'Drag'] },
      ],
    },
    {
      name: 'Publish',
      rows: [
        { label: 'Save', keys: mod('S') },
        { label: 'Preview', keys: mod('P') },
      ],
    },
  ];
}

/** Shortcut reference (rail + builder) and documentation links. */
function HelpPanel({ role, goTo }: HelpPanelProps) {
  const setKeyboardShortcutsOpen = useEditorStore((state) => state.setKeyboardShortcutsOpen);
  const [platform, setPlatform] = useState<Platform>('other');
  useEffect(() => {
    if (typeof navigator !== 'undefined') setPlatform(detectPlatform(navigator.platform, navigator.userAgent));
  }, []);

  const isEditor = role === 'editor';
  const metaLabel = metaKeyLabel(platform);
  const groups = buildGroups(platform)
    .map((group) => ({ ...group, rows: group.rows.filter((row) => !isEditor || !row.structural) }))
    .filter((group) => group.rows.length > 0);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar text-xs pb-3" data-webwow-help-panel>
      <PanelSectionTitle>Resources</PanelSectionTitle>
      <PanelLinkList
        links={[
          { id: 'docs', label: 'Documentation', description: 'Guides for the builder, CMS and publishing', icon: 'external-link', onSelect: () => window.open(DOCS_URL, '_blank', 'noopener,noreferrer') },
          { id: 'shortcuts', label: 'All keyboard shortcuts', description: 'Open the shortcut dialog', icon: 'keyboard', onSelect: () => setKeyboardShortcutsOpen(true) },
          ...(isEditor ? [] : [
            { id: 'updates', label: 'Updates', description: 'Release notes and version', icon: 'refresh', onSelect: () => goTo('/ycode/settings/updates') },
            { id: 'mcp', label: 'MCP & API', description: 'Connect agents and tools', icon: 'sparkles', onSelect: () => goTo('/ycode/integrations/mcp') },
          ]),
        ]}
      />
      {groups.map((group) => (
        <section key={group.name} aria-label={`${group.name} shortcuts`}>
          <PanelSectionTitle>{group.name}</PanelSectionTitle>
          <ul role="list" className="px-4 pb-1">
            {group.rows.map((row) => (
              <li key={row.label} className="flex items-center justify-between h-7 gap-2">
                <span className="truncate">{row.label}</span>
                <KbdGroup className="shrink-0">
                  {row.keys.map((key, i) => (
                    <Kbd key={`${key}-${i}`}>{key}</Kbd>
                  ))}
                </KbdGroup>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="px-4 pt-3 text-[11px] text-muted-foreground flex items-start gap-1">
        <Icon name="info" className="size-3 shrink-0 mt-0.5" />
        <span>
          Letter shortcuts work while nothing is focused.
          {platform !== 'mac' && !isEditor && ` ${metaLabel} is the Meta key (⌘ on Mac); those combos have no Ctrl variant.`}
        </span>
      </p>
    </div>
  );
}

export default React.memo(HelpPanel);

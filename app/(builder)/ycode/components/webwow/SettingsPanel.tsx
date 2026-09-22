'use client';

import React, { lazy, Suspense, useState } from 'react';
import { usePathname } from 'next/navigation';
import { SETTINGS_NAV_ITEMS } from '@/lib/settings-nav-items';
import { useEditorStore } from '@/stores/useEditorStore';
import PanelLinkList, { PanelSectionTitle } from './PanelLinkList';
import type { RoutePanelProps } from './FormsPanel';

const BackupRestoreDialog = lazy(() =>
  import('@/components/project/BackupRestoreDialog').then((m) => ({ default: m.BackupRestoreDialog })),
);

export interface SettingsPanelProps extends RoutePanelProps {
  canManageMembers: boolean;
}

/**
 * Site settings sections (`SETTINGS_NAV_ITEMS`), tools from the header's logo menu
 * (File manager, Backup & Restore) and the account links (My profile, Sites dashboard).
 */
function SettingsPanel({ goTo, canManageMembers }: SettingsPanelProps) {
  const currentPath = usePathname();
  const openFileManager = useEditorStore((state) => state.openFileManager);
  const [backupOpen, setBackupOpen] = useState(false);
  const items = SETTINGS_NAV_ITEMS.filter((item) => item.id !== 'users' || canManageMembers);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar" data-webwow-settings-panel>
      <PanelSectionTitle>Site settings</PanelSectionTitle>
      <PanelLinkList
        links={items.map((item) => ({
          id: item.id,
          label: item.label,
          icon: item.id === 'users' ? 'user' : item.id === 'updates' ? 'refresh' : item.id === 'email' ? 'email' : item.id === 'security' ? 'eye-off' : item.id === 'redirects' ? 'link' : item.id === 'templates' ? 'layout' : item.id === 'agent' ? 'sparkles' : 'settings',
          current: currentPath === item.path,
          onSelect: () => goTo(item.path),
        }))}
      />
      <PanelSectionTitle>Tools</PanelSectionTitle>
      <PanelLinkList
        links={[
          { id: 'file-manager', label: 'File manager', description: 'Browse, upload and organize assets', icon: 'folder', onSelect: () => openFileManager() },
          { id: 'backup', label: 'Backup and Restore', description: 'Export or import the whole site', icon: 'upload', onSelect: () => setBackupOpen(true) },
        ]}
      />
      <PanelSectionTitle>Account</PanelSectionTitle>
      <PanelLinkList
        links={[
          { id: 'profile', label: 'My profile', icon: 'user', current: currentPath?.startsWith('/ycode/profile') ?? false, onSelect: () => goTo('/ycode/profile') },
          { id: 'sites', label: 'Sites dashboard', description: 'All sites of this installation', icon: 'apps', onSelect: () => goTo('/webwow') },
        ]}
      />
      {backupOpen && (
        <Suspense fallback={null}>
          <BackupRestoreDialog open={backupOpen} onOpenChange={setBackupOpen} />
        </Suspense>
      )}
    </div>
  );
}

export default React.memo(SettingsPanel);

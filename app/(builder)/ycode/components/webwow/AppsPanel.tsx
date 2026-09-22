'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import PanelLinkList, { PanelSectionTitle } from './PanelLinkList';
import type { RoutePanelProps } from './FormsPanel';

const APP_LINKS = [
  { id: 'apps', label: 'Apps', description: 'Connect third-party services to forms and content', path: '/ycode/integrations/apps', icon: 'apps' },
  { id: 'webhooks', label: 'Webhooks', description: 'Notify external URLs on form submissions and publishes', path: '/ycode/integrations/webhooks', icon: 'zap' },
  { id: 'mcp', label: 'MCP', description: 'Let AI agents work with this site', path: '/ycode/integrations/mcp', icon: 'sparkles' },
  { id: 'api', label: 'Webwow API', description: 'API keys for the public API', path: '/ycode/integrations/api', icon: 'code' },
];

/** Integrations: apps, webhooks, MCP and the API. */
function AppsPanel({ goTo }: RoutePanelProps) {
  const currentPath = usePathname();
  return (
    <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar" data-webwow-apps-panel>
      <PanelSectionTitle>Integrations</PanelSectionTitle>
      <PanelLinkList
        links={APP_LINKS.map((link) => ({
          id: link.id,
          label: link.label,
          description: link.description,
          icon: link.icon,
          current: currentPath === link.path,
          onSelect: () => goTo(link.path),
        }))}
      />
    </div>
  );
}

export default React.memo(AppsPanel);

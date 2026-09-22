'use client';

import React from 'react';
import Icon, { type IconProps } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { RailIcon, isRailIconName } from './rail-icons';

export interface PanelLink {
  id: string;
  label: string;
  /** Muted text at the right edge (count, shortcut). */
  hint?: string;
  /** Second line under the label. */
  description?: string;
  icon?: string;
  /** Marks the current route. */
  current?: boolean;
  onSelect: () => void;
  /** Optional trailing action (e.g. an edit button). */
  action?: React.ReactNode;
}

export interface PanelLinkListProps {
  links: PanelLink[];
  emptyText?: string;
  className?: string;
}

function LinkGlyph({ icon }: { icon: string }) {
  if (isRailIconName(icon)) return <RailIcon name={icon} className="size-3.5 shrink-0" />;
  return <Icon name={icon as IconProps['name']} className="size-3 shrink-0" />;
}

/** List of navigation rows used by the link-style panels (Apps, Settings, CMS, Forms, Help). */
export default function PanelLinkList({ links, emptyText = 'Nothing here yet', className }: PanelLinkListProps) {
  if (links.length === 0) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">{emptyText}</p>;
  }
  return (
    <ul role="list" className={cn('flex flex-col gap-0.5 p-2', className)}>
      {links.map((link) => (
        <li key={link.id} className="flex items-center gap-1">
          <button
            type="button"
            data-webwow-link={link.id}
            onClick={link.onSelect}
            aria-current={link.current ? 'page' : undefined}
            className={cn(
              'flex-1 min-w-0 px-2 rounded-md flex items-center gap-2 text-xs text-left cursor-pointer',
              link.description ? 'py-1.5' : 'h-8',
              'text-foreground hover:bg-secondary/70 aria-[current=page]:bg-secondary',
              'outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            {link.icon && <span className="text-muted-foreground shrink-0"><LinkGlyph icon={link.icon} /></span>}
            <span className="flex-1 min-w-0 flex flex-col">
              <span className="truncate">{link.label}</span>
              {link.description && <span className="truncate text-[11px] text-muted-foreground">{link.description}</span>}
            </span>
            {link.hint && <span className="ml-auto text-muted-foreground shrink-0 text-[11px]">{link.hint}</span>}
          </button>
          {link.action}
        </li>
      ))}
    </ul>
  );
}

export function PanelSectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{children}</p>;
}

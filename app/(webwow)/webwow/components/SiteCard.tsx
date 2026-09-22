'use client';

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { hueFromId, initialsOf, relativeTime, type SiteJson } from './sites-api';

export interface SiteCardProps {
  site: SiteJson;
  /** The site the builder is currently pinned to (cookie). */
  isCurrent: boolean;
  /** owner|admin: Settings, Delete, Export, Import */
  canAdmin: boolean;
  /** owner: Duplicate */
  isOwner: boolean;
  /** Label of the action running on this card (disables the menu). */
  busy?: string | null;
  onOpen: (site: SiteJson) => void;
  onView: (site: SiteJson) => void;
  onDuplicate: (site: SiteJson) => void;
  onExport: (site: SiteJson) => void;
  onSettings: (site: SiteJson) => void;
  onDelete: (site: SiteJson) => void;
}

/** Host line under the name: first domain, else the preview host (without scheme). */
function hostLine(site: SiteJson): string {
  if (site.domains.length > 0) return site.domains[0];
  return site.previewUrl.replace(/^https?:\/\//, '');
}

/** Webflow-style site card: thumbnail area, name, host, "Updated …", card menu. */
export function SiteCard({ site, isCurrent, canAdmin, isOwner, busy, onOpen, onView, onDuplicate, onExport, onSettings, onDelete }: SiteCardProps) {
  const hue = hueFromId(site.id);
  const open = () => {
    if (!busy) onOpen(site);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${site.name} in the builder`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      className={cn(
        'group relative flex flex-col bg-card border border-border rounded-xl overflow-hidden text-left',
        'transition-[border-color,box-shadow] hover:border-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        busy ? 'cursor-progress' : 'cursor-pointer',
        isCurrent && 'border-blue-500/40',
      )}
      data-site-id={site.id}
    >
      {/* Thumbnail */}
      <div
        className="relative aspect-[16/10] w-full overflow-hidden bg-neutral-900"
        style={site.thumbnail_url
          ? { backgroundImage: `url("${site.thumbnail_url}")`, backgroundSize: 'cover', backgroundPosition: 'top center' }
          : { background: `linear-gradient(135deg, hsl(${hue} 55% 34%), hsl(${(hue + 40) % 360} 65% 18%))` }}
      >
        {!site.thumbnail_url && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-3xl font-semibold tracking-wide text-white/80 select-none">{initialsOf(site.name)}</span>
          </div>
        )}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/25 transition-colors flex items-center justify-center">
          <span className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1.5 rounded-lg bg-white/90 text-neutral-900 px-3 h-8 text-xs font-medium">
            {busy ? <Spinner className="size-3" /> : <Icon name="layers" className="size-3" />}
            {busy ?? 'Open builder'}
          </span>
        </div>
        {isCurrent && (
          <Badge
            variant="default"
            className="absolute top-2 left-2"
          >
            Current
          </Badge>
        )}
      </div>

      {/* Body */}
      <div className="flex items-start gap-2 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className="font-medium truncate"
              title={site.name}
            >
              {site.name}
            </span>
            {site.is_default && (
              <Badge
                variant="secondary"
                className="shrink-0"
              >
                Default
              </Badge>
            )}
            {site.editorPasswordSet && (
              <Badge
                variant="green"
                className="shrink-0"
                title="Editor access enabled (?edit)"
              >
                Editor access
              </Badge>
            )}
          </div>
          <div
            className="text-muted-foreground truncate mt-0.5"
            title={hostLine(site)}
          >
            {hostLine(site)}
          </div>
          <div className="text-muted-foreground/70 mt-1">
            Updated {relativeTime(site.updated_at)}
          </div>
        </div>

        <div onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Actions for ${site.name}`}
                disabled={!!busy}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <Icon name="dotsHorizontal" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="min-w-[10rem]"
            >
              <DropdownMenuItem onSelect={() => onOpen(site)}>
                <Icon name="layers" />
                Open
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onView(site)}>
                <Icon name="external-link" />
                View site
              </DropdownMenuItem>
              {(isOwner || canAdmin) && <DropdownMenuSeparator />}
              {isOwner && (
                <DropdownMenuItem onSelect={() => onDuplicate(site)}>
                  <Icon name="copy" />
                  Duplicate
                </DropdownMenuItem>
              )}
              {canAdmin && (
                <DropdownMenuItem onSelect={() => onExport(site)}>
                  <Icon name="upload" />
                  Export (.ycode)
                </DropdownMenuItem>
              )}
              {canAdmin && (
                <DropdownMenuItem onSelect={() => onSettings(site)}>
                  <Icon name="settings" />
                  Settings
                </DropdownMenuItem>
              )}
              {canAdmin && !site.is_default && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => onDelete(site)}
                  >
                    <Icon name="trash" />
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

export default SiteCard;

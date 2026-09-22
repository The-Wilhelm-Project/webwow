'use client';

import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuthStore } from '@/stores/useAuthStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { yieldArrowKeysToRail } from './Rail';
import { RailIcon } from './rail-icons';
import { cn } from '@/lib/utils';

export interface ProfileMenuProps {
  isEditor: boolean;
  goTo: (path: string) => void;
  registerButton: (el: HTMLButtonElement | null) => void;
  /** Roving tabindex slot from the rail (0 for the current item, otherwise -1). */
  tabIndex: number;
  onFocus: () => void;
}

/** Avatar at the bottom of the rail with the profile dropdown. */
function ProfileMenu({ isEditor, goTo, registerButton, tabIndex, onFocus }: ProfileMenuProps) {
  const user = useAuthStore((state) => state.user);
  const signOut = useAuthStore((state) => state.signOut);
  const setKeyboardShortcutsOpen = useEditorStore((state) => state.setKeyboardShortcutsOpen);

  const name = (user?.user_metadata?.full_name as string | undefined) || user?.email || '';
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              ref={registerButton}
              data-rail-item="profile"
              tabIndex={tabIndex}
              onFocus={onFocus}
              onKeyDown={yieldArrowKeysToRail}
              aria-label={name ? `Profile: ${name}` : 'Profile'}
              className={cn(
                'size-8 rounded-full bg-neutral-700 text-white text-xs font-medium flex items-center justify-center cursor-pointer',
                'outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:ring-2 data-[state=open]:ring-ring',
              )}
            >
              {initial}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>{name || 'Profile'}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="right" align="end"
        sideOffset={8} className="w-48"
      >
        {name && <div className="px-2 py-1.5 text-xs text-muted-foreground truncate">{name}</div>}
        {!isEditor && (
          <DropdownMenuItem onClick={() => goTo('/ycode/profile')}>
            <RailIcon name="user" className="size-3.5" />
            My profile
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => setKeyboardShortcutsOpen(true)}>
          <RailIcon name="keyboard" className="size-3.5" />
          Keyboard shortcuts
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => { void signOut(); }}>
          <RailIcon name="sign-out" className="size-3.5" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default React.memo(ProfileMenu);

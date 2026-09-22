'use client';

/**
 * Keyboard Shortcuts Dialog
 *
 * Displays all available keyboard shortcuts organized by category.
 * Can be opened via the settings dropdown or with Shift+/
 */

import React, { useEffect, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon, type IconProps } from '@/components/ui/icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useEditorStore } from '@/stores/useEditorStore';
import { useRole } from '@/hooks/use-role';

interface ShortcutKey {
  name: string;
  /** Force the following keys onto a new line (wraps in the flex container) */
  isBreak?: boolean;
  /** Render an icon inside the key box instead of the name text */
  icon?: IconProps['name'];
}

interface Shortcut {
  name: string;
  keys: ShortcutKey[];
}

interface ShortcutCategory {
  name: string;
  shortcuts: Shortcut[];
}

const shortcutCategories: { left: ShortcutCategory[]; right: ShortcutCategory[] } = {
  left: [
    {
      name: 'Edit',
      shortcuts: [
        { name: 'Copy', keys: [{ name: '⌘' }, { name: 'C' }] },
        { name: 'Paste', keys: [{ name: '⌘' }, { name: 'V' }] },
        { name: 'Cut', keys: [{ name: '⌘' }, { name: 'X' }] },
        { name: 'Duplicate', keys: [{ name: '⌘' }, { name: 'D' }] },
        { name: 'Undo', keys: [{ name: '⌘' }, { name: 'Z' }] },
        { name: 'Redo', keys: [{ name: '⇧' }, { name: '⌘' }, { name: 'Z' }] },
        { name: 'Copy style', keys: [{ name: '⌥' }, { name: '⌘' }, { name: 'C' }] },
        { name: 'Paste style', keys: [{ name: '⌥' }, { name: '⌘' }, { name: 'V' }] },
        { name: 'Rename', keys: [{ name: 'F2' }] },
        { name: 'Delete', keys: [{ name: '⌫' }] },
        { name: 'Select parent', keys: [{ name: 'Esc' }] },
      ],
    },
    {
      name: 'Component',
      shortcuts: [
        { name: 'Create component', keys: [{ name: '⌥' }, { name: '⌘' }, { name: 'K' }] },
        { name: 'Detach instance', keys: [{ name: '⌥' }, { name: '⌘' }, { name: 'B' }] },
      ],
    },
    {
      name: 'Publish',
      shortcuts: [
        { name: 'Save', keys: [{ name: '⌘' }, { name: 'S' }] },
        { name: 'Open preview', keys: [{ name: '⌘' }, { name: 'P' }] },
      ],
    },
  ],
  right: [
    {
      name: 'View',
      shortcuts: [
        { name: 'Collapse layers', keys: [{ name: '⌥' }, { name: 'L' }] },
        { name: 'Show/Hide element', keys: [{ name: '⇧' }, { name: '⌘' }, { name: 'H' }] },
        { name: 'Open add elements', keys: [{ name: 'A' }] },
      ],
    },
    {
      name: 'Canvas',
      shortcuts: [
        { name: 'Zoom in', keys: [{ name: '⌘' }, { name: '+' }] },
        { name: 'Zoom out', keys: [{ name: '⌘' }, { name: '-' }] },
        { name: 'Zoom to 100%', keys: [{ name: '⌘' }, { name: '0' }] },
        { name: 'Zoom to Fit', keys: [{ name: '⌘' }, { name: '1' }] },
        { name: 'Autofit', keys: [{ name: '⌘' }, { name: '2' }] },
        { name: 'Pan', keys: [{ name: 'Space', icon: 'space' }, { name: 'Drag (left-click)' }, { name: '', isBreak: true }, { name: 'Drag (middle-click)' }] },
      ],
    },
    {
      name: 'Other',
      shortcuts: [
        { name: 'Open keyboard shortcuts', keys: [{ name: '⇧' }, { name: '/' }] },
      ],
    },
  ],
};

// Human-readable labels for modifier/symbol keys, shown in a tooltip on hover
const KEY_LABELS: Record<string, string> = {
  '⌘': 'Command',
  '⇧': 'Shift',
  '⌥': 'Option',
  '⌫': 'Delete',
  '⌃': 'Control',
};

function ShortcutCategory({ category }: { category: ShortcutCategory }) {
  return (
    <div>
      <div className="py-3 text-xs font-medium border-b border-border mb-3">
        {category.name}
      </div>
      <ul className="space-y-2">
        {category.shortcuts.map((shortcut, shortcutIndex) => (
          <li key={`${shortcut.name}-${shortcutIndex}`} className="flex items-start justify-between">
            <span className="text-xs text-muted-foreground whitespace-nowrap">{shortcut.name}</span>
            <div className="flex flex-wrap items-center justify-end gap-x-0.5 gap-y-1">
              {shortcut.keys.map((key, index) => {
                if (key.isBreak) {
                  return <div key={index} className="basis-full h-0" />;
                }

                const keyCap = (
                  <div
                    className="px-1.5 py-0.75 leading-none rounded flex items-center justify-center bg-muted text-[10px] min-w-4.5"
                    aria-label={key.icon ? key.name : undefined}
                  >
                    {key.icon ? <Icon name={key.icon} className="w-2.5 h-2.5" /> : key.name}
                  </div>
                );

                // Tooltip for modifier symbols and icon-only keys (no visible text)
                const label = KEY_LABELS[key.name] ?? (key.icon ? key.name : undefined);
                if (!label) return <div key={index}>{keyCap}</div>;

                return (
                  <Tooltip key={index} disableHoverableContent>
                    <TooltipTrigger asChild>{keyCap}</TooltipTrigger>
                    <TooltipContent>{label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const STRUCTURAL_SHORTCUTS = new Set([
  'Copy', 'Paste', 'Cut', 'Duplicate', 'Copy style', 'Paste style',
  'Rename', 'Delete', 'Create component', 'Detach instance',
  'Show/Hide element', 'Open add elements',
]);

export default function KeyboardShortcutsDialog() {
  const isOpen = useEditorStore((state) => state.keyboardShortcutsOpen);
  const setKeyboardShortcutsOpen = useEditorStore((state) => state.setKeyboardShortcutsOpen);
  const { isEditor } = useRole();

  const filteredCategories = useMemo(() => {
    if (!isEditor) return shortcutCategories;

    const filterCategory = (cat: ShortcutCategory): ShortcutCategory => ({
      ...cat,
      shortcuts: cat.shortcuts.filter(s => !STRUCTURAL_SHORTCUTS.has(s.name)),
    });

    return {
      left: shortcutCategories.left.map(filterCategory).filter(c => c.shortcuts.length > 0),
      right: shortcutCategories.right.map(filterCategory).filter(c => c.shortcuts.length > 0),
    };
  }, [isEditor]);

  // Handle Shift+/ keyboard shortcut (Shift+/ produces '?' on most keyboards)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && (e.key === '?' || e.code === 'Slash')) {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
          return;
        }
        e.preventDefault();
        setKeyboardShortcutsOpen(!isOpen);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, setKeyboardShortcutsOpen]);

  return (
    <Dialog open={isOpen} onOpenChange={setKeyboardShortcutsOpen}>
      <DialogContent width="640px">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-8">
          {/* Left column */}
          <div className="space-y-6">
            {filteredCategories.left.map((category) => (
              <ShortcutCategory key={category.name} category={category} />
            ))}
          </div>

          {/* Right column */}
          <div className="space-y-6">
            {filteredCategories.right.map((category) => (
              <ShortcutCategory key={category.name} category={category} />
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

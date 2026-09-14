'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Editor } from '@tiptap/core';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import SettingsPanel from './SettingsPanel';

export interface RichTextImagePopoverProps {
  editor: Editor;
  trigger: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
}

export default function RichTextImagePopover({
  editor,
  trigger,
  open,
  onOpenChange,
  disabled = false,
}: RichTextImagePopoverProps) {
  const [altText, setAltText] = useState('');
  const [savedPos, setSavedPos] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Refs for mutable values needed in the selectionUpdate listener
  const altTextRef = useRef(altText);
  const savedPosRef = useRef(savedPos);
  altTextRef.current = altText;
  savedPosRef.current = savedPos;

  const saveAltAtPos = useCallback((pos: number, alt: string) => {
    const node = editor.state.doc.nodeAt(pos);
    if (node?.type.name === 'richTextImage' && node.attrs.alt !== alt) {
      const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        alt,
      });
      editor.view.dispatch(tr);
    }
  }, [editor]);

  const saveAlt = useCallback(() => {
    if (savedPosRef.current !== null) {
      saveAltAtPos(savedPosRef.current, altTextRef.current);
    }
  }, [saveAltAtPos]);

  const handleOpenChange = useCallback((newOpen: boolean) => {
    if (newOpen && disabled) return;
    if (!newOpen) saveAlt();
    onOpenChange(newOpen);
  }, [onOpenChange, disabled, saveAlt]);

  // Sync alt text from the currently selected image whenever the popover opens.
  // This covers both the initial open AND re-opens after clicking a different image
  // (where the popover closes on outside-click, selection changes, then reopens).
  useEffect(() => {
    if (!open) return;

    const { selection } = editor.state;
    const node = editor.state.doc.nodeAt(selection.from);
    if (node?.type.name === 'richTextImage') {
      setAltText(node.attrs.alt || '');
      setSavedPos(selection.from);
    }
  }, [open, editor]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [open]);

  return (
    <Popover
      open={open}
      onOpenChange={handleOpenChange}
    >
      <PopoverTrigger asChild>
        {trigger}
      </PopoverTrigger>

      <PopoverContent
        className="w-64 px-4 py-0"
        align="start"
        side="bottom"
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <SettingsPanel
          title="Image"
          isOpen={true}
          onToggle={() => {}}
        >
          <div className="grid grid-cols-3">
            <Label variant="muted">ALT</Label>
            <div className="col-span-2 *:w-full">
              <Input
                ref={inputRef}
                value={altText}
                onChange={(e) => setAltText(e.target.value)}
                placeholder="Image description"
              />
            </div>
          </div>
        </SettingsPanel>
      </PopoverContent>
    </Popover>
  );
}

'use client';

/**
 * Rich Text Link Popover Component
 *
 * Popover for editing links in TipTap rich text editors.
 * Wraps RichTextLinkSettings and provides apply/remove actions.
 */

import React, { useState, useCallback } from 'react';
import { Editor } from '@tiptap/core';

import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import RichTextLinkSettings from './RichTextLinkSettings';
import SettingsPanel from './SettingsPanel';
import { getLinkSettingsFromMark } from '@/lib/tiptap-extensions/rich-text-link';
import type { Layer, CollectionField, Collection, LinkSettings, LinkType } from '@/types';
import type { FieldGroup } from './CollectionFieldSelector';

export interface RichTextLinkPopoverProps {
  /** TipTap editor instance */
  editor: Editor;
  /** Field groups with labels and sources for inline variable selection */
  fieldGroups?: FieldGroup[];
  /** All fields by collection ID */
  allFields?: Record<string, CollectionField[]>;
  /** Available collections */
  collections?: Collection[];
  /** Whether inside a collection layer */
  isInsideCollectionLayer?: boolean;
  /** Current layer (for context) */
  layer?: Layer | null;
  /** Custom trigger button (optional) */
  trigger?: React.ReactNode;
  /** Whether popover is open (controlled) */
  open?: boolean;
  /** Callback when open state changes (controlled) */
  onOpenChange?: (open: boolean) => void;
  /** Whether the link button is disabled */
  disabled?: boolean;
  /** Link types to exclude from the dropdown */
  excludedLinkTypes?: LinkType[];
  /** Hide "Current page item" and "Reference field" options (e.g. when editing CMS item content) */
  hidePageContextOptions?: boolean;
}

/**
 * Popover for managing rich text links
 */
export default function RichTextLinkPopover({
  editor,
  fieldGroups,
  allFields,
  collections,
  isInsideCollectionLayer = false,
  layer,
  trigger,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  disabled = false,
  excludedLinkTypes = [],
  hidePageContextOptions = false,
}: RichTextLinkPopoverProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const [linkSettings, setLinkSettings] = useState<LinkSettings | null>(null);

  const [savedSelection, setSavedSelection] = useState<{ from: number; to: number } | null>(null);
  const [hadLinkOnOpen, setHadLinkOnOpen] = useState(false);
  // When editing a link on a richTextImage node, store its position
  const [imageNodePos, setImageNodePos] = useState<number | null>(null);

  const hasLink = editor.isActive('richTextLink');

  const handleOpenChange = useCallback((newOpen: boolean) => {
    if (newOpen && disabled) {
      return;
    }

    if (newOpen) {
      let { from, to } = editor.state.selection;

      // Check if the selection is on an image node
      const nodeAtSelection = editor.state.doc.nodeAt(from);
      if (nodeAtSelection?.type.name === 'richTextImage') {
        setImageNodePos(from);
        setSavedSelection({ from, to });

        const storedLink = nodeAtSelection.attrs.link as LinkSettings | null;
        if (storedLink) {
          setLinkSettings(storedLink);
          setHadLinkOnOpen(true);
        } else {
          setLinkSettings(null);
          setHadLinkOnOpen(false);
        }
      } else {
        setImageNodePos(null);
        const currentHasLink = editor.isActive('richTextLink');
        setHadLinkOnOpen(currentHasLink);

        // If cursor is on a link but no text is selected, extend to full mark range
        if (currentHasLink && from === to) {
          const markType = editor.schema.marks.richTextLink;
          if (markType) {
            const $pos = editor.state.doc.resolve(from);
            const start = $pos.parent.childAfter($pos.parentOffset);

            if (start.node) {
              const mark = start.node.marks.find(m => m.type === markType);
              if (mark) {
                let markStart = $pos.start();
                let markEnd = $pos.start();
                let foundStart = false;

                $pos.parent.forEach((node, offset) => {
                  const hasMark = node.marks.some(m => m.type === markType && m.eq(mark));
                  if (hasMark) {
                    if (!foundStart) {
                      markStart = $pos.start() + offset;
                      foundStart = true;
                    }
                    markEnd = $pos.start() + offset + node.nodeSize;
                  } else if (foundStart) {
                    return false;
                  }
                });

                from = markStart;
                to = markEnd;
              }
            }
          }
        }

        setSavedSelection({ from, to });

        if (currentHasLink) {
          const attrs = editor.getAttributes('richTextLink');
          setLinkSettings(getLinkSettingsFromMark(attrs));
        } else {
          setLinkSettings(null);
        }
      }
    }

    if (isControlled) {
      controlledOnOpenChange!(newOpen);
    } else {
      setInternalOpen(newOpen);
    }
  }, [editor, isControlled, controlledOnOpenChange, disabled]);

  const closePopover = useCallback(() => {
    if (isControlled) {
      controlledOnOpenChange!(false);
    } else {
      setInternalOpen(false);
    }
  }, [isControlled, controlledOnOpenChange]);

  /** Write full LinkSettings to image node's `link` attribute. */
  const applyToImageNode = useCallback((pos: number, settings: LinkSettings | null) => {
    const node = editor.state.doc.nodeAt(pos);
    if (node?.type.name !== 'richTextImage') return;

    const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      link: settings,
    });
    editor.view.dispatch(tr);
  }, [editor]);

  /** Apply link settings to a text selection via marks. */
  const applyToTextSelection = useCallback((settings: LinkSettings | null, selection: { from: number; to: number } | null) => {
    if (!selection) return;

    const { from, to } = selection;
    const markType = editor.schema.marks.richTextLink;
    if (!markType) return;

    if (!settings) {
      editor.chain()
        .focus()
        .setTextSelection({ from, to })
        .unsetRichTextLink()
        .run();
      return;
    }

    const { state } = editor;
    const tr = state.tr;
    tr.removeMark(from, to, markType);
    tr.addMark(from, to, markType.create(settings as unknown as Record<string, unknown>));
    editor.view.dispatch(tr);
  }, [editor]);

  const handleSettingsChange = useCallback((settings: LinkSettings | null) => {
    setLinkSettings(settings);
    if (imageNodePos !== null) {
      applyToImageNode(imageNodePos, settings);
    } else {
      applyToTextSelection(settings, savedSelection);
    }
  }, [imageNodePos, applyToImageNode, applyToTextSelection, savedSelection]);

  const handleRemove = useCallback(() => {
    if (imageNodePos !== null) {
      applyToImageNode(imageNodePos, null);
      closePopover();
      return;
    }

    if (!savedSelection) {
      editor.chain().focus().unsetRichTextLink().run();
      closePopover();
      return;
    }

    const { from, to } = savedSelection;
    editor.chain()
      .focus()
      .setTextSelection({ from, to })
      .unsetRichTextLink()
      .run();
    closePopover();
  }, [editor, imageNodePos, savedSelection, closePopover, applyToImageNode]);

  // Default trigger button
  const defaultTrigger = (
    <Button
      variant={hasLink ? 'default' : 'ghost'}
      size="icon"
      className="size-7"
      title={disabled ? 'Links cannot be nested' : 'Link'}
      disabled={disabled}
    >
      <Icon name="link" className="size-3.5" />
    </Button>
  );

  return (
    <Popover
      open={open}
      onOpenChange={handleOpenChange}
    >
      <PopoverTrigger asChild>
        {trigger || defaultTrigger}
      </PopoverTrigger>

      <PopoverContent
        className="w-64 px-4 py-0"
        align="start"
        side="bottom"
        sideOffset={8}
      >
        <SettingsPanel
          title="Link"
          isOpen={true}
          onToggle={() => {}}
        >

          <RichTextLinkSettings
            value={linkSettings}
            onChange={handleSettingsChange}
            fieldGroups={fieldGroups}
            allFields={allFields}
            collections={collections}
            isInsideCollectionLayer={isInsideCollectionLayer}
            layer={layer}
            excludedLinkTypes={excludedLinkTypes}
            hidePageContextOptions={hidePageContextOptions}
          />
        </SettingsPanel>
      </PopoverContent>
    </Popover>
  );
}

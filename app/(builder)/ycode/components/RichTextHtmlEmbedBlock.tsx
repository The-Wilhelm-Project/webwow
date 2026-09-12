'use client';

import React from 'react';
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import { cn } from '@/lib/utils';

interface RichTextHtmlEmbedBlockProps {
  code: string;
  isEditable: boolean;
  isSelected: boolean;
  onEditClick: () => void;
  onDelete: () => void;
}

export default function RichTextHtmlEmbedBlock({
  code,
  isEditable,
  isSelected,
  onEditClick,
  onDelete,
}: RichTextHtmlEmbedBlockProps) {
  const hasCode = code.trim().length > 0;
  const preview = hasCode
    ? code.trim().split('\n')[0].slice(0, 60) + (code.trim().length > 60 ? '...' : '')
    : 'No code added';

  return (
    <div
      className={cn(
        'rounded-md border border-border bg-background text-xs select-none',
        isSelected && 'ring-2 ring-ring',
      )}
    >
      <div className="flex w-full items-center text-left">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-4.5 py-4.5">
          <Icon name="code" className="size-3.5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-medium text-foreground">HTML Embed</span>
            <span className="truncate text-muted-foreground">
              {hasCode
                ? preview
                : 'Your embedded code won\u2019t display here, it will be visible on published site'}
            </span>
          </div>
        </div>

        {isEditable && (
          <div className="flex items-center gap-1 mr-3">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="size-6! p-0!"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onEditClick();
              }}
              title="Edit code"
            >
              <Icon name="pencil" className="size-3" />
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="size-6! p-0!"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              title="Remove embed"
            >
              <Icon name="x" className="size-3" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

'use client';

import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { CodeEditor } from '@/components/ui/code-editor';
import { toast } from 'sonner';

interface ExportHtmlDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  html: string;
}

export default function ExportHtmlDialog({
  open,
  onOpenChange,
  html,
}: ExportHtmlDialogProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(html);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy — please select the code and copy manually');
    }
  };

  const handleClose = () => {
    setCopied(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        width="640px"
        className="gap-0"
      >
        <DialogHeader>
          <DialogTitle>Export layer as HTML</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4.5">
          <CodeEditor
            value={html}
            readOnly
            className="min-h-72 max-h-[60vh]"
          />

          <DialogFooter className="grid grid-cols-2 mt-1">
            <Button variant="secondary" onClick={handleClose}>
              Close
            </Button>
            <Button onClick={handleCopy}>
              {copied ? (
                <>
                  <Icon name="check" className="size-3.5" />
                  Copied
                </>
              ) : (
                <>
                  <Icon name="copy" className="size-3.5" />
                  Copy to clipboard
                </>
              )}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

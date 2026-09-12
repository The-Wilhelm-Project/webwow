'use client';

import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CodeEditor } from '@/components/ui/code-editor';

interface ImportHtmlDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (html: string) => void;
}

export default function ImportHtmlDialog({
  open,
  onOpenChange,
  onImport,
}: ImportHtmlDialogProps) {
  const [html, setHtml] = useState('');

  const handleImport = () => {
    if (!html.trim()) return;
    onImport(html.trim());
    setHtml('');
    onOpenChange(false);
  };

  const handleCancel = () => {
    setHtml('');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        width="640px"
        className="gap-0"
      >
        <DialogHeader>
          <DialogTitle>Convert HTML to layers</DialogTitle>
          <DialogDescription>
            If you use Tailwind CSS, classes will be converted to design settings in Ycode. &apos;Script&apos; and &apos;Style&apos; tags will be ignored.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4.5">
          <CodeEditor
            value={html}
            onValueChange={setHtml}
            placeholder="Enter your HTML code here..."
            className="min-h-72 max-h-[60vh]"
            autoFocus
          />

          <DialogFooter className="grid grid-cols-2 mt-1">
            <Button variant="secondary" onClick={handleCancel}>
              Cancel
            </Button>
            <Button onClick={handleImport} disabled={!html.trim()}>
              Import
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

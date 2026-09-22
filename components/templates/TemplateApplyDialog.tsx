'use client';

/**
 * TemplateApplyDialog Component
 *
 * Confirmation dialog for applying a template.
 * Shows warnings about data being replaced and handles the apply process.
 */

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
import { Spinner } from '@/components/ui/spinner';
import Icon from '@/components/ui/icon';

interface Template {
  id: string;
  name: string;
  description: string;
}

interface TemplateApplyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: Template | null;
  onSuccess?: () => void;
}

export function TemplateApplyDialog({
  open,
  onOpenChange,
  template,
  onSuccess,
}: TemplateApplyDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleApply = async () => {
    if (!template) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/templates/${template.id}/apply`, {
        method: 'POST',
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to apply template');
      }

      // Success - close dialog and trigger callback
      onOpenChange(false);
      onSuccess?.();

      // Navigate to /ycode to refresh the whole app with new content
      window.location.href = '/ycode';
    } catch (err) {
      console.error('[TemplateApplyDialog] Error:', err);
      setError(err instanceof Error ? err.message : 'Failed to apply template');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    if (loading) return;
    setError(null);
    onOpenChange(false);
  };

  if (!template) return null;

  return (
    <Dialog open={open} onOpenChange={loading ? undefined : onOpenChange}>
      <DialogContent
        showCloseButton={!loading}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>
            Apply {template.name} template
          </DialogTitle>
          <DialogDescription>
            You are about to apply the <span className="font-medium">{template.name}</span>{' '}
            template to your project.
          </DialogDescription>
        </DialogHeader>

        <div>

          {/* Warning Box */}
          <div className="-mt-3 text-muted-foreground">
            <div className="mb-3">
              This action will:
            </div>
            <ul className="flex flex-col gap-2.5 text-xs ">
              <li className="flex items-start gap-2">
                <div className="size-4 bg-destructive/10 flex items-center justify-center rounded-full">
                  <Icon name="check" className="size-3.5 text-destructive" />
                </div>
                Replace all your pages, collections, and components
              </li>
              <li className="flex items-start gap-2">
                <div className="size-4 bg-destructive/10 flex items-center justify-center rounded-full">
                  <Icon name="check" className="size-3.5 text-destructive" />
                </div>
                Remove any existing template assets
              </li>
              <li className="flex items-start gap-2">
                <div className="size-4 bg-green-500/20 flex items-center justify-center rounded-full">
                  <Icon name="check" className="size-3.5" />
                </div>
                Keep your uploaded assets and settings
              </li>
            </ul>
          </div>

          {/* Error Message */}
          {error && (
            <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCancel}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleApply}
            disabled={loading}
          >
            {loading && <Spinner />}
            {loading ? null : 'Apply template'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default TemplateApplyDialog;

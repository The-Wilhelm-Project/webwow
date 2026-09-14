'use client';

/**
 * TemplateGallery Component
 *
 * Displays a grid of available templates for selection.
 */

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { TemplateCard } from './TemplateCard';
import { TemplateApplyDialog } from './TemplateApplyDialog';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import Icon from '@/components/ui/icon';
import { Label } from '@/components/ui/label';
import BuilderLoading from '@/components/BuilderLoading';
interface Template {
  id: string;
  name: string;
  description: string;
  preview: string;
  categoryId: string | null;
  livePreviewUrl: string | null;
}

interface TemplateGalleryProps {
  onApplySuccess?: () => void;
  className?: string;
  startFromScratchHref?: string;
  applyImmediately?: boolean;
}

export function TemplateGallery({
  onApplySuccess,
  className,
  startFromScratchHref,
  applyImmediately,
}: TemplateGalleryProps) {
  const router = useRouter();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(
    null
  );
  const [showApplyDialog, setShowApplyDialog] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Fetch templates and categories on mount
  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        setError(null);

        const response = await fetch('/api/templates');

        if (!response.ok) {
          throw new Error('Failed to fetch templates');
        }

        const data = await response.json();
        setTemplates(data.templates || []);
      } catch (err) {
        console.error('[TemplateGallery] Error fetching data:', err);
        setError(
          err instanceof Error ? err.message : 'Failed to load templates'
        );
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, []);

  const handleApplyImmediately = async (template: Template) => {
    setApplying(true);
    setApplyError(null);
    setSelectedTemplate(template);

    try {
      const response = await fetch(`/api/templates/${template.id}/apply`, {
        method: 'POST',
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to apply template');
      }

      onApplySuccess?.();
      window.location.href = '/ycode';
    } catch (err) {
      console.error('[TemplateGallery] Apply error:', err);
      setApplyError(
        err instanceof Error ? err.message : 'Failed to apply template'
      );
      setApplying(false);
    }
  };

  const handleTemplateClick = (template: Template) => {
    if (applyImmediately) {
      handleApplyImmediately(template);
      return;
    }
    setSelectedTemplate(template);
    setShowApplyDialog(true);
  };

  const handleApplySuccess = () => {
    setShowApplyDialog(false);
    setSelectedTemplate(null);
    onApplySuccess?.();
  };

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <EmptyState
        icon="alert-circle"
        title="Failed to load templates"
        description={error}
        actionLabel="Try again"
        onAction={() => window.location.reload()}
      />
    );
  }

  // Empty state
  if (templates.length === 0) {
    return (
      <EmptyState
        icon="layout-template"
        title="No templates available"
        description="Templates will appear here once they are added to the template service."
      />
    );
  }

  if (applying) {
    return (
      <BuilderLoading
        title="Please wait"
        message={`Applying ${selectedTemplate?.name ?? 'template'}...`}
      />
    );
  }

  return (
    <div className={className}>
      {/* Apply error */}
      {applyError && (
        <div className="mb-6 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {applyError}
        </div>
      )}

      {/* Template Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {startFromScratchHref && (
          <button
            type="button"
            onClick={() => router.push(startFromScratchHref)}
            className="group flex flex-col gap-3"
          >
            <div className="rounded-lg bg-muted/50 p-8 flex items-center justify-center text-center transition-colors hover:bg-muted aspect-[72/85]">
              <Icon name="plus" className="size-3.5 opacity-75" />
            </div>
            <Label>Start from scratch</Label>
          </button>
        )}
        {templates.map((template) => (
          <TemplateCard
            key={template.id}
            name={template.name}
            description={template.description}
            preview={template.preview}
            livePreviewUrl={template.livePreviewUrl}
            onClick={() => handleTemplateClick(template)}
          />
        ))}
      </div>

      {/* Apply Confirmation Dialog (only when not in immediate mode) */}
      {!applyImmediately && (
        <TemplateApplyDialog
          open={showApplyDialog}
          onOpenChange={setShowApplyDialog}
          template={selectedTemplate}
          onSuccess={handleApplySuccess}
        />
      )}
    </div>
  );
}

export default TemplateGallery;

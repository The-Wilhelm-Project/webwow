'use client';

/**
 * TemplateCard Component
 *
 * Displays a single template with preview image, name, and description.
 */

import React from 'react';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

export interface TemplateCardProps {
  name: string;
  description: string;
  preview?: string;
  livePreviewUrl?: string | null;
  selected?: boolean;
  onClick?: () => void;
}

export function TemplateCard({
  name,
  description,
  preview,
  livePreviewUrl,
  selected,
  onClick,
}: TemplateCardProps) {
  return (
    <div
      className={cn(
        'group relative flex flex-col overflow-hidden',
      )}
    >
      {/* Preview Image */}

      <div className="relative w-full overflow-hidden bg-muted rounded-lg">

        <div className="absolute inset-0 z-10 opacity-0 group-hover:opacity-100 bg-black/80 flex flex-col items-stretch p-4 gap-2 justify-center transition ease-in-out">

          <Button onClick={onClick} variant="white">Use template</Button>

          {/* Live Preview Link */}
          {livePreviewUrl && (
            <Button asChild variant="secondary">
              <a
                href={livePreviewUrl} target="_blank"
                rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
              >
                Preview
              </a>
            </Button>
          )}
        </div>

        {preview ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={preview}
            alt={`${name} preview`}
            className="aspect-[72/85] object-cover object-top transition-transform group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-900">
            <span className="text-4xl font-bold text-gray-300 dark:text-gray-700">
              {name.charAt(0).toUpperCase()}
            </span>
          </div>
        )}

        {/* Selected indicator */}
        {selected && (
          <div className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-blue-500 text-white">
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col py-4">
        <Label>{name}</Label>
      </div>
    </div>
  );
}

export default TemplateCard;

'use client';

/**
 * Code Embed Settings Component
 *
 * Settings panel for custom code layers with code editor
 */

import React, { useState, useCallback } from 'react';

import { CodeEditor } from '@/components/ui/code-editor';
import SettingsPanel from './SettingsPanel';
import type { Layer } from '@/types';

interface HTMLEmbedSettingsProps {
  layer: Layer | null;
  onLayerUpdate: (layerId: string, updates: Partial<Layer>) => void;
}

export default function HTMLEmbedSettings({ layer, onLayerUpdate }: HTMLEmbedSettingsProps) {
  const [isOpen, setIsOpen] = useState(true);

  // Get current code from settings
  const currentCode = layer?.settings?.htmlEmbed?.code || '';

  const handleCodeChange = useCallback((value: string) => {
    if (!layer) return;

    onLayerUpdate(layer.id, {
      settings: {
        ...layer.settings,
        htmlEmbed: {
          code: value,
        },
      },
    });
  }, [layer, onLayerUpdate]);

  // Only show for htmlEmbed layers
  if (!layer || layer.name !== 'htmlEmbed') {
    return null;
  }

  return (
    <SettingsPanel
      title="Code"
      isOpen={isOpen}
      onToggle={() => setIsOpen(!isOpen)}
    >
      <div className="flex flex-col gap-3">
        <CodeEditor
          value={currentCode}
          onValueChange={handleCodeChange}
          placeholder="<div>Add your custom code here</div>"
          className="min-h-50 max-h-[20vh]"
        />
      </div>
    </SettingsPanel>
  );
}

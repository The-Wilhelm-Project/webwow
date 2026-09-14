'use client';

/**
 * Audio Settings Component
 *
 * Settings panel for audio layers with file manager integration
 */

import React, { useState, useCallback, useMemo } from 'react';

import { Label } from '@/components/ui/label';
import SettingsPanel from './SettingsPanel';
import RichTextEditor from './RichTextEditor';
import { FieldSelectDropdown, type FieldGroup, type FieldSourceType } from './CollectionFieldSelector';
import type { Layer, CollectionField, Collection, FieldVariable, AudioSettingsValue } from '@/types';
import { createAssetVariable, createDynamicTextVariable, getDynamicTextContent, isAssetVariable, getAssetId, isFieldVariable, isDynamicTextVariable } from '@/lib/variable-utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useEditorStore } from '@/stores/useEditorStore';
import { useAssetsStore } from '@/stores/useAssetsStore';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { ASSET_CATEGORIES, isAssetOfType } from '@/lib/asset-utils';
import { AUDIO_FIELD_TYPES, filterFieldGroupsByType, flattenFieldGroups } from '@/lib/collection-field-utils';
import { toast } from 'sonner';
import Icon from '@/components/ui/icon';
import { Slider } from '@/components/ui/slider';
import ComponentVariableLabel, { VARIABLE_TYPE_ICONS } from './ComponentVariableLabel';

// Re-export AudioSettingsValue from types for convenience
export type { AudioSettingsValue } from '@/types';

// Layer mode props - for editing audio layers
interface LayerModeProps {
  mode?: 'layer';
  layer: Layer | null;
  onLayerUpdate: (layerId: string, updates: Partial<Layer>) => void;
  value?: never;
  onChange?: never;
}

// Standalone mode props - for component variable overrides
interface StandaloneModeProps {
  mode: 'standalone';
  value: AudioSettingsValue | undefined;
  onChange: (value: AudioSettingsValue) => void;
  layer?: never;
  onLayerUpdate?: never;
}

// Common props for both modes
interface CommonProps {
  fieldGroups?: FieldGroup[];
  allFields?: Record<string, CollectionField[]>;
  collections?: Collection[];
  onOpenVariablesDialog?: (variableId?: string) => void;
}

type AudioSettingsProps = (LayerModeProps | StandaloneModeProps) & CommonProps;

export default function AudioSettings(props: AudioSettingsProps) {
  const { fieldGroups, allFields, collections, onOpenVariablesDialog } = props;
  const isStandaloneMode = props.mode === 'standalone';

  // Layer mode props
  const layer = isStandaloneMode ? null : props.layer;
  const onLayerUpdate = isStandaloneMode ? undefined : props.onLayerUpdate;

  // Standalone mode props
  const standaloneValue = isStandaloneMode ? props.value : undefined;
  const standaloneOnChange = isStandaloneMode ? props.onChange : undefined;
  const [isOpen, setIsOpen] = useState(true);

  const openFileManager = useEditorStore((state) => state.openFileManager);
  const editingComponentId = useEditorStore((state) => state.editingComponentId);
  const getAsset = useAssetsStore((state) => state.getAsset);
  const getComponentById = useComponentsStore((state) => state.getComponentById);
  const addAudioVariable = useComponentsStore((state) => state.addAudioVariable);
  const updateTextVariable = useComponentsStore((state) => state.updateTextVariable);

  // Get component variables for audio linking (when editing a component in layer mode)
  const editingComponent = !isStandaloneMode && editingComponentId ? getComponentById(editingComponentId) : undefined;
  const componentVariables = editingComponent?.variables || [];
  const audioComponentVariables = componentVariables.filter(v => v.type === 'audio');

  // Get audio source variable - from layer or standalone value
  const audioSrc = isStandaloneMode ? standaloneValue?.src : layer?.variables?.audio?.src;

  // Get linked audio variable ID from layer (stored in src.id)
  const linkedAudioVariableId = !isStandaloneMode && audioSrc ? (audioSrc as any).id : undefined;
  const linkedAudioVariable = audioComponentVariables.find(v => v.id === linkedAudioVariableId);

  // Initialize selectedField from current field variable if it exists
  const initialFieldId = audioSrc && isFieldVariable(audioSrc) && 'data' in audioSrc && 'field_id' in audioSrc.data
    ? audioSrc.data.field_id
    : null;
  const [selectedField, setSelectedField] = useState<string | null>(initialFieldId);

  // Filter field groups to only show audio-bindable field types
  const audioFieldGroups = useMemo(() => {
    return filterFieldGroupsByType(fieldGroups, AUDIO_FIELD_TYPES, { excludeMultipleAsset: true });
  }, [fieldGroups]);

  // Flatten for internal lookups
  const audioFields = useMemo(() => {
    return flattenFieldGroups(audioFieldGroups);
  }, [audioFieldGroups]);

  // Detect current field ID if using FieldVariable
  const currentFieldId = useMemo(() => {
    if (audioSrc && isFieldVariable(audioSrc)) {
      return audioSrc.data.field_id;
    }
    return null;
  }, [audioSrc]);

  // Detect current audio type from src variable
  const audioType = useMemo((): 'upload' | 'custom_url' | 'cms' => {
    if (!audioSrc) return 'upload';
    if (audioSrc.type === 'field') return 'cms';
    if (isDynamicTextVariable(audioSrc)) return 'custom_url';
    return 'upload';
  }, [audioSrc]);

  // Get custom URL value from DynamicTextVariable
  const customUrlValue = useMemo(() => {
    if (audioSrc && isDynamicTextVariable(audioSrc)) {
      return getDynamicTextContent(audioSrc);
    }
    return '';
  }, [audioSrc]);

  // Get current asset ID and asset for display
  const currentAssetId = useMemo(() => {
    if (isAssetVariable(audioSrc)) {
      return getAssetId(audioSrc);
    }
    return null;
  }, [audioSrc]);

  const currentAsset = useMemo(() => {
    return currentAssetId ? getAsset(currentAssetId) : null;
  }, [currentAssetId, getAsset]);

  const assetFilename = useMemo(() => {
    return currentAsset?.filename || null;
  }, [currentAsset]);

  const handleAudioChange = useCallback((assetId: string) => {
    const assetVariable = createAssetVariable(assetId);

    if (isStandaloneMode && standaloneOnChange) {
      standaloneOnChange({ src: assetVariable });
      return;
    }

    if (!layer || !onLayerUpdate) return;
    onLayerUpdate(layer.id, {
      variables: {
        ...layer.variables,
        audio: { src: assetVariable },
      },
    });
  }, [isStandaloneMode, standaloneOnChange, layer, onLayerUpdate]);

  const handleFieldSelect = useCallback((
    fieldId: string,
    relationshipPath: string[],
    source?: FieldSourceType,
    layerId?: string
  ) => {
    const field = audioFields.find(f => f.id === fieldId);
    const fieldVariable: FieldVariable = {
      type: 'field',
      data: {
        field_id: fieldId,
        relationships: relationshipPath,
        field_type: field?.type || null,
        source,
        collection_layer_id: layerId,
      },
    };

    if (isStandaloneMode && standaloneOnChange) {
      standaloneOnChange({ src: fieldVariable });
      setSelectedField(fieldId);
      return;
    }

    if (!layer || !onLayerUpdate) return;
    onLayerUpdate(layer.id, {
      variables: {
        ...layer.variables,
        audio: { src: fieldVariable },
      },
    });
    setSelectedField(fieldId);
  }, [isStandaloneMode, standaloneOnChange, layer, onLayerUpdate, audioFields]);

  const handleTypeChange = useCallback((type: 'upload' | 'custom_url' | 'cms') => {
    if (type === 'custom_url') {
      const urlVariable = createDynamicTextVariable('');
      if (isStandaloneMode && standaloneOnChange) {
        standaloneOnChange({ src: urlVariable });
        return;
      }
      if (!layer || !onLayerUpdate) return;
      onLayerUpdate(layer.id, {
        variables: { ...layer.variables, audio: { src: urlVariable } },
      });
    } else if (type === 'cms') {
      const fieldVariable: FieldVariable = {
        type: 'field',
        data: { field_id: null, relationships: [], field_type: null },
      };
      if (isStandaloneMode && standaloneOnChange) {
        standaloneOnChange({ src: fieldVariable as any });
        setSelectedField(null);
        return;
      }
      if (!layer || !onLayerUpdate) return;
      onLayerUpdate(layer.id, {
        variables: { ...layer.variables, audio: { src: fieldVariable as any } },
      });
      setSelectedField(null);
    } else {
      const placeholderVariable = createAssetVariable('');
      if (isStandaloneMode && standaloneOnChange) {
        standaloneOnChange({ src: placeholderVariable });
        setSelectedField(null);
        return;
      }
      if (!layer || !onLayerUpdate) return;
      onLayerUpdate(layer.id, {
        variables: { ...layer.variables, audio: { src: placeholderVariable } },
      });
      setSelectedField(null);
    }
  }, [isStandaloneMode, standaloneOnChange, layer, onLayerUpdate]);

  const handleUrlChange = useCallback((value: string) => {
    const srcVariable = createDynamicTextVariable(value);

    if (isStandaloneMode && standaloneOnChange) {
      standaloneOnChange({ src: srcVariable });
      return;
    }

    if (!layer || !onLayerUpdate) return;
    onLayerUpdate(layer.id, {
      variables: { ...layer.variables, audio: { src: srcVariable } },
    });
  }, [isStandaloneMode, standaloneOnChange, layer, onLayerUpdate]);

  const handleBrowseAudio = useCallback(() => {
    openFileManager(
      (asset) => {
        if (!isStandaloneMode && !layer) return false;

        if (!asset.mime_type || !isAssetOfType(asset.mime_type, ASSET_CATEGORIES.AUDIO)) {
          toast.error('Invalid asset type', {
            description: 'Please select an audio file.',
          });
          return false;
        }

        handleAudioChange(asset.id);
      },
      currentAssetId,
      ASSET_CATEGORIES.AUDIO
    );
  }, [openFileManager, handleAudioChange, isStandaloneMode, layer, currentAssetId]);

  const handleLinkAudioVariable = useCallback((variableId: string) => {
    if (!layer || !onLayerUpdate) return;
    const currentSrc = layer.variables?.audio?.src;
    onLayerUpdate(layer.id, {
      variables: {
        ...layer.variables,
        audio: {
          ...layer.variables?.audio,
          src: currentSrc
            ? { ...currentSrc, id: variableId } as any
            : { type: 'asset', id: variableId, data: { asset_id: null } } as any,
        },
      },
    });
  }, [layer, onLayerUpdate]);

  const handleUnlinkAudioVariable = useCallback(() => {
    if (!layer || !onLayerUpdate) return;
    const currentSrc = layer.variables?.audio?.src;
    if (currentSrc) {
      const { id: _, ...srcWithoutId } = currentSrc as any;
      onLayerUpdate(layer.id, {
        variables: {
          ...layer.variables,
          audio: { ...layer.variables?.audio, src: srcWithoutId },
        },
      });
    }
  }, [layer, onLayerUpdate]);

  // Get current volume value (0-100)
  const volumeSource = isStandaloneMode
    ? (standaloneValue?.volume ?? 100)
    : (layer?.attributes?.volume ? parseInt(layer.attributes.volume) : 100);

  const [localVolume, setLocalVolume] = useState(volumeSource);

  // Sync local volume when external value changes
  React.useEffect(() => {
    setLocalVolume(volumeSource);
  }, [volumeSource]);

  const handleVolumeCommit = useCallback((value: number[]) => {
    if (isStandaloneMode && standaloneOnChange) {
      standaloneOnChange({ ...standaloneValue, volume: value[0] });
      return;
    }
    if (!layer || !onLayerUpdate) return;
    onLayerUpdate(layer.id, { attributes: { ...layer.attributes, volume: value[0].toString() } });
  }, [isStandaloneMode, standaloneOnChange, standaloneValue, layer, onLayerUpdate]);

  const isMuted = isStandaloneMode ? standaloneValue?.muted === true : layer?.attributes?.muted === true;

  const handleMutedChange = useCallback((checked: boolean) => {
    if (isStandaloneMode && standaloneOnChange) {
      standaloneOnChange({ ...standaloneValue, muted: checked || undefined });
      return;
    }
    if (!layer || !onLayerUpdate) return;
    onLayerUpdate(layer.id, { attributes: { ...layer.attributes, muted: checked } });
  }, [isStandaloneMode, standaloneOnChange, standaloneValue, layer, onLayerUpdate]);

  const hasControls = isStandaloneMode ? (standaloneValue?.controls ?? true) : layer?.attributes?.controls === true;

  const handleControlsChange = useCallback((checked: boolean) => {
    if (isStandaloneMode && standaloneOnChange) {
      standaloneOnChange({ ...standaloneValue, controls: checked || undefined });
      return;
    }
    if (!layer || !onLayerUpdate) return;
    onLayerUpdate(layer.id, { attributes: { ...layer.attributes, controls: checked } });
  }, [isStandaloneMode, standaloneOnChange, standaloneValue, layer, onLayerUpdate]);

  const isLoop = isStandaloneMode ? standaloneValue?.loop === true : layer?.attributes?.loop === true;

  const handleLoopChange = useCallback((checked: boolean) => {
    if (isStandaloneMode && standaloneOnChange) {
      standaloneOnChange({ ...standaloneValue, loop: checked || undefined });
      return;
    }
    if (!layer || !onLayerUpdate) return;
    onLayerUpdate(layer.id, { attributes: { ...layer.attributes, loop: checked } });
  }, [isStandaloneMode, standaloneOnChange, standaloneValue, layer, onLayerUpdate]);

  // In layer mode, only show for audio layers
  if (!isStandaloneMode && (!layer || layer.name !== 'audio')) {
    return null;
  }

  // Source selection content (shared between modes)
  const sourceContent = (
    <div className="flex flex-col gap-3">
      {/* Source Section */}
      <div className={isStandaloneMode ? 'flex flex-col gap-2' : 'grid grid-cols-3 items-center'}>
        {!isStandaloneMode && (
          <div className="flex items-start gap-1 py-1">
            <ComponentVariableLabel
              label="Source"
              isEditingComponent={!!editingComponentId}
              variables={audioComponentVariables}
              linkedVariableId={linkedAudioVariableId}
              onLinkVariable={handleLinkAudioVariable}
              onManageVariables={() => onOpenVariablesDialog?.()}
              onCreateVariable={editingComponentId ? async () => {
                const newId = await addAudioVariable(editingComponentId, 'Audio');
                if (newId) {
                  const currentValue: AudioSettingsValue = {
                    src: layer?.variables?.audio?.src,
                  };
                  await updateTextVariable(editingComponentId, newId, { default_value: currentValue });
                  handleLinkAudioVariable(newId);
                  onOpenVariablesDialog?.(newId);
                }
              } : undefined}
            />
          </div>
        )}

        <div className={isStandaloneMode ? '' : 'col-span-2'}>
          {linkedAudioVariable ? (
            <Button
              asChild
              variant="purple"
              className="justify-between! w-full"
              onClick={() => onOpenVariablesDialog?.(linkedAudioVariable.id)}
            >
              <div>
                <span className="flex items-center gap-1.5">
                  {linkedAudioVariable.type && VARIABLE_TYPE_ICONS[linkedAudioVariable.type] && (
                    <Icon name={VARIABLE_TYPE_ICONS[linkedAudioVariable.type]} className="size-3 opacity-60" />
                  )}
                  {linkedAudioVariable.name}
                </span>
                <Button
                  className="size-4! p-0!"
                  variant="outline"
                  onClick={(e) => { e.stopPropagation(); handleUnlinkAudioVariable(); }}
                >
                  <Icon name="x" className="size-2" />
                </Button>
              </div>
            </Button>
          ) : (
            <Select value={audioType} onValueChange={handleTypeChange}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="upload"><Icon name="folder" className="size-3" /> File manager</SelectItem>
                <SelectItem value="custom_url"><Icon name="link" className="size-3" /> Custom URL</SelectItem>
                <SelectItem value="cms" disabled={audioFields.length === 0}><Icon name="database" className="size-3" /> CMS field</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {/* File Manager Upload - hidden when linked to variable */}
      {!linkedAudioVariable && audioType === 'upload' && (
        <div className={isStandaloneMode ? '' : 'grid grid-cols-3 items-center'}>
          {!isStandaloneMode && <Label variant="muted">File</Label>}

          <div className={isStandaloneMode ? 'flex gap-2' : 'col-span-2 flex gap-2'}>
            <div className="bg-input rounded-md h-8 aspect-3/2 flex items-center justify-center">
              <Icon name="audio" className="size-4 text-muted-foreground" />
            </div>

            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="flex-1 justify-start min-w-0"
              onClick={handleBrowseAudio}
            >
              <span className="truncate">{assetFilename || 'Choose file'}</span>
              {assetFilename && (
                <span
                  role="button"
                  className="ml-auto shrink-0 -mr-1 p-1 rounded hover:bg-background/60"
                  onClick={(e) => { e.stopPropagation(); handleAudioChange(''); }}
                >
                  <Icon name="x" className="size-3" />
                </span>
              )}
            </Button>
          </div>
        </div>
      )}

      {/* Custom URL Section */}
      {!linkedAudioVariable && audioType === 'custom_url' && (
        <div className={isStandaloneMode ? '' : 'grid grid-cols-3 items-start'}>
          {!isStandaloneMode && <Label variant="muted" className="pt-2">URL</Label>}

          <div className={isStandaloneMode ? '' : 'col-span-2'}>
            <RichTextEditor
              value={customUrlValue}
              onChange={handleUrlChange}
              placeholder="https://example.com/audio.mp3"
              fieldGroups={fieldGroups}
              allFields={allFields}
              collections={collections}
            />
          </div>
        </div>
      )}

      {/* CMS Field Section */}
      {!linkedAudioVariable && audioType === 'cms' && (
        <div className={isStandaloneMode ? '' : 'grid grid-cols-3 items-center'}>
          {!isStandaloneMode && <Label variant="muted">Field</Label>}

          <div className={isStandaloneMode ? 'w-full' : 'col-span-2 w-full'}>
            <FieldSelectDropdown
              fieldGroups={audioFieldGroups}
              allFields={allFields || {}}
              collections={collections || []}
              value={selectedField || currentFieldId}
              onSelect={handleFieldSelect}
              placeholder="Select..."
              allowedFieldTypes={AUDIO_FIELD_TYPES}
            />
          </div>
        </div>
      )}
    </div>
  );

  // Standalone mode - all settings
  if (isStandaloneMode) {
    return (
      <div className="flex flex-col gap-3">
        {sourceContent}

        {/* Behavior */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Checkbox
              id="sa-audio-controls" checked={hasControls}
              onCheckedChange={handleControlsChange}
            />
            <Label
              variant="muted" htmlFor="sa-audio-controls"
              className="cursor-pointer"
            >Display controls</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="sa-audio-muted" checked={isMuted}
              onCheckedChange={handleMutedChange}
            />
            <Label
              variant="muted" htmlFor="sa-audio-muted"
              className="cursor-pointer"
            >Mute sound</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="sa-audio-loop" checked={isLoop}
              onCheckedChange={handleLoopChange}
            />
            <Label
              variant="muted" htmlFor="sa-audio-loop"
              className="cursor-pointer"
            >Loop audio</Label>
          </div>
        </div>

        {/* Volume */}
        <div className="flex items-center gap-3">
          <Label variant="muted" className="shrink-0">Volume</Label>
          <Slider
            value={[localVolume]}
            onValueChange={(v) => setLocalVolume(v[0])}
            onValueCommit={handleVolumeCommit}
            max={100}
            min={0}
            step={1}
          />
          <span className="text-xs text-muted-foreground w-8 text-right">{localVolume}%</span>
        </div>
      </div>
    );
  }

  return (
    <SettingsPanel
      title="Audio"
      isOpen={isOpen}
      onToggle={() => setIsOpen(!isOpen)}
    >
      <div className="flex flex-col gap-3">
        {sourceContent}

        {/* Volume & Behavior - hidden when linked to variable */}
        {!linkedAudioVariable && (
          <>
            <div className="grid grid-cols-3 gap-2 h-7">
              <div className="flex items-center">
                <Label variant="muted">Volume</Label>
              </div>

              <div className="col-span-2 flex items-center gap-3">
                <Slider
                  value={[localVolume]}
                  onValueChange={(v) => setLocalVolume(v[0])}
                  onValueCommit={handleVolumeCommit}
                  min={0}
                  max={100}
                  step={1}
                  className="flex-1"
                />
              </div>
            </div>

            {/* Behavior Section */}
            <div className="grid grid-cols-3 items-start gap-2">
              <div className="pt-0.5">
                <Label variant="muted">Behavior</Label>
              </div>

              <div className="col-span-2 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="audio-controls"
                    checked={hasControls}
                    onCheckedChange={handleControlsChange}
                  />
                  <Label
                    variant="muted"
                    htmlFor="audio-controls"
                    className="cursor-pointer"
                  >
                    Display controls
                  </Label>
                </div>

                <div className="flex items-center gap-2">
                  <Checkbox
                    id="audio-loop"
                    checked={isLoop}
                    onCheckedChange={handleLoopChange}
                  />
                  <Label
                    variant="muted"
                    htmlFor="audio-loop"
                    className="cursor-pointer"
                  >
                    Loop audio
                  </Label>
                </div>

                <div className="flex items-center gap-2">
                  <Checkbox
                    id="audio-muted"
                    checked={isMuted}
                    onCheckedChange={handleMutedChange}
                  />
                  <Label
                    variant="muted"
                    htmlFor="audio-muted"
                    className="cursor-pointer"
                  >
                    Mute sound
                  </Label>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </SettingsPanel>
  );
}

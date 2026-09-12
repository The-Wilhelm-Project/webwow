/* eslint-disable @next/next/no-img-element */
'use client';

/**
 * Video Settings Component
 *
 * Settings panel for video layers with file manager integration
 */

import React, { useState, useCallback, useMemo } from 'react';

import { Label } from '@/components/ui/label';
import SettingsPanel from './SettingsPanel';
import RichTextEditor from './RichTextEditor';
import { FieldSelectDropdown, type FieldGroup, type FieldSourceType } from './CollectionFieldSelector';
import type { Layer, CollectionField, Collection, VideoVariable, FieldVariable, VideoSettingsValue } from '@/types';
import { createAssetVariable, createDynamicTextVariable, getDynamicTextContent, isAssetVariable, getAssetId, isFieldVariable, isDynamicTextVariable } from '@/lib/variable-utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useEditorStore } from '@/stores/useEditorStore';
import { useAssetsStore } from '@/stores/useAssetsStore';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { ASSET_CATEGORIES, isAssetOfType, DEFAULT_ASSETS } from '@/lib/asset-utils';
import { VIDEO_FIELD_TYPES, VIDEO_ID_FIELD_TYPES, filterFieldGroupsByType, flattenFieldGroups } from '@/lib/collection-field-utils';
import { toast } from 'sonner';
import Icon from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import ComponentVariableLabel, { VARIABLE_TYPE_ICONS } from './ComponentVariableLabel';

// Re-export VideoSettingsValue from types for convenience
export type { VideoSettingsValue } from '@/types';

// Layer mode props - for editing video layers
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
  value: VideoSettingsValue | undefined;
  onChange: (value: VideoSettingsValue) => void;
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

type VideoSettingsProps = (LayerModeProps | StandaloneModeProps) & CommonProps;

export default function VideoSettings(props: VideoSettingsProps) {
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
  const addVideoVariable = useComponentsStore((state) => state.addVideoVariable);
  const updateTextVariable = useComponentsStore((state) => state.updateTextVariable);

  // Get component variables for video linking (when editing a component in layer mode)
  const editingComponent = !isStandaloneMode && editingComponentId ? getComponentById(editingComponentId) : undefined;
  const componentVariablesAll = editingComponent?.variables || [];
  const videoComponentVariables = componentVariablesAll.filter(v => v.type === 'video');

  // Get video source variable - from layer or standalone value
  const videoSrc = isStandaloneMode ? standaloneValue?.src : layer?.variables?.video?.src;

  // Get linked video variable ID from layer (stored in src.id)
  const linkedVideoVariableId = !isStandaloneMode && videoSrc ? (videoSrc as any).id : undefined;
  const linkedVideoVariable = videoComponentVariables.find(v => v.id === linkedVideoVariableId);

  const initialFieldId = videoSrc && isFieldVariable(videoSrc) && 'data' in videoSrc && 'field_id' in videoSrc.data
    ? videoSrc.data.field_id
    : null;
  const [selectedField, setSelectedField] = useState<string | null>(initialFieldId);

  // Detect current video type from src variable
  const videoType = useMemo((): 'upload' | 'youtube' | 'custom_url' | 'cms' => {
    if (!videoSrc) return 'upload';
    if (videoSrc.type === 'video') return 'youtube';
    if (videoSrc.type === 'field') return 'cms';
    if (isDynamicTextVariable(videoSrc)) return 'custom_url';
    return 'upload';
  }, [videoSrc]);

  // Get YouTube video ID and privacy mode if video type is YouTube
  const youtubeVideoId = useMemo(() => {
    if (videoSrc && videoSrc.type === 'video') {
      return (videoSrc as VideoVariable).data.video_id || '';
    }
    return '';
  }, [videoSrc]);

  const youtubePrivacyMode = useMemo(() => {
    if (isStandaloneMode) return standaloneValue?.youtubePrivacyMode === true;
    return layer?.attributes?.youtubePrivacyMode === true;
  }, [isStandaloneMode, standaloneValue?.youtubePrivacyMode, layer?.attributes?.youtubePrivacyMode]);

  // Get custom URL value from DynamicTextVariable
  const customUrlValue = useMemo(() => {
    if (videoSrc && isDynamicTextVariable(videoSrc)) {
      return getDynamicTextContent(videoSrc);
    }
    return '';
  }, [videoSrc]);

  // Get current asset ID and asset for display
  const currentAssetId = useMemo(() => {
    if (isAssetVariable(videoSrc)) {
      return getAssetId(videoSrc);
    }
    return null;
  }, [videoSrc]);

  const currentAsset = useMemo(() => {
    return currentAssetId ? getAsset(currentAssetId) : null;
  }, [currentAssetId, getAsset]);

  const assetFilename = useMemo(() => {
    return currentAsset?.filename || null;
  }, [currentAsset]);

  // Get current poster asset ID and asset for display
  const standalonePoster = isStandaloneMode ? standaloneValue?.poster : layer?.variables?.video?.poster;
  const currentPosterAssetId = useMemo(() => {
    if (isAssetVariable(standalonePoster)) {
      return getAssetId(standalonePoster);
    }
    return null;
  }, [standalonePoster]);

  const currentPosterAsset = useMemo(() => {
    return currentPosterAssetId ? getAsset(currentPosterAssetId) : null;
  }, [currentPosterAssetId, getAsset]);

  const posterAssetFilename = useMemo(() => {
    return currentPosterAsset?.filename || null;
  }, [currentPosterAsset]);

  // Get current poster URL from variables.video.poster
  const posterUrl = useMemo(() => {
    if (currentPosterAsset?.public_url) {
      return currentPosterAsset.public_url;
    }
    return DEFAULT_ASSETS.IMAGE;
  }, [currentPosterAsset]);

  const handleVideoChange = useCallback((assetId: string) => {
    const assetVariable = createAssetVariable(assetId);

    if (isStandaloneMode && standaloneOnChange) {
      standaloneOnChange({ src: assetVariable, poster: standaloneValue?.poster });
      return;
    }

    if (!layer || !onLayerUpdate) return;
    onLayerUpdate(layer.id, {
      variables: {
        ...layer.variables,
        video: { src: assetVariable, poster: layer.variables?.video?.poster },
      },
    });
  }, [isStandaloneMode, standaloneOnChange, standaloneValue, layer, onLayerUpdate]);

  // Filter field groups to only show video-bindable field types
  const videoFieldGroups = useMemo(() => {
    return filterFieldGroupsByType(fieldGroups, VIDEO_FIELD_TYPES, { excludeMultipleAsset: true });
  }, [fieldGroups]);

  // Flatten for internal lookups
  const videoFields = useMemo(() => {
    return flattenFieldGroups(videoFieldGroups);
  }, [videoFieldGroups]);

  // Filter field groups to only show text fields (for YouTube Video ID)
  const textFieldGroups = useMemo(() => {
    return filterFieldGroupsByType(fieldGroups, VIDEO_ID_FIELD_TYPES);
  }, [fieldGroups]);

  const handleFieldSelect = useCallback((
    fieldId: string,
    relationshipPath: string[],
    source?: FieldSourceType,
    layerId?: string
  ) => {
    const field = videoFields.find(f => f.id === fieldId);
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
      standaloneOnChange({ src: fieldVariable, poster: standaloneValue?.poster });
      setSelectedField(fieldId);
      return;
    }

    if (!layer || !onLayerUpdate) return;
    onLayerUpdate(layer.id, {
      variables: {
        ...layer.variables,
        video: { src: fieldVariable, poster: layer.variables?.video?.poster },
      },
    });
    setSelectedField(fieldId);
  }, [isStandaloneMode, standaloneOnChange, standaloneValue, layer, onLayerUpdate, videoFields]);

  const handlePosterChange = useCallback((assetId: string) => {
    const assetVariable = createAssetVariable(assetId);

    if (isStandaloneMode && standaloneOnChange) {
      standaloneOnChange({ ...standaloneValue, src: standaloneValue?.src, poster: assetVariable });
      return;
    }

    if (!layer || !onLayerUpdate) return;
    onLayerUpdate(layer.id, {
      variables: {
        ...layer.variables,
        video: {
          ...(layer.variables?.video || {}),
          src: layer.variables?.video?.src,
          poster: assetVariable,
        },
      },
    });
  }, [isStandaloneMode, standaloneOnChange, standaloneValue, layer, onLayerUpdate]);

  const handleMutedChange = useCallback((checked: boolean) => {
    if (isStandaloneMode && standaloneOnChange) {
      standaloneOnChange({ ...standaloneValue, muted: checked || undefined, autoplay: checked ? standaloneValue?.autoplay : undefined });
      return;
    }
    if (!layer || !onLayerUpdate) return;
    const newAttributes = { ...layer.attributes };
    if (checked) { newAttributes.muted = true; } else { delete newAttributes.muted; delete newAttributes.autoplay; }
    onLayerUpdate(layer.id, { attributes: newAttributes });
  }, [isStandaloneMode, standaloneOnChange, standaloneValue, layer, onLayerUpdate]);

  const handleControlsChange = useCallback((checked: boolean) => {
    if (isStandaloneMode && standaloneOnChange) {
      standaloneOnChange({ ...standaloneValue, controls: checked || undefined });
      return;
    }
    if (!layer || !onLayerUpdate) return;
    const newAttributes = { ...layer.attributes };
    if (checked) { newAttributes.controls = true; } else { delete newAttributes.controls; }
    onLayerUpdate(layer.id, { attributes: newAttributes });
  }, [isStandaloneMode, standaloneOnChange, standaloneValue, layer, onLayerUpdate]);

  const handleLoopChange = useCallback((checked: boolean) => {
    if (isStandaloneMode && standaloneOnChange) {
      standaloneOnChange({ ...standaloneValue, loop: checked || undefined });
      return;
    }
    if (!layer || !onLayerUpdate) return;
    const newAttributes = { ...layer.attributes };
    if (checked) { newAttributes.loop = true; } else { delete newAttributes.loop; }
    onLayerUpdate(layer.id, { attributes: newAttributes });
  }, [isStandaloneMode, standaloneOnChange, standaloneValue, layer, onLayerUpdate]);

  const handleAutoplayChange = useCallback((checked: boolean) => {
    if (isStandaloneMode && standaloneOnChange) {
      standaloneOnChange({ ...standaloneValue, autoplay: checked || undefined, muted: checked ? true : standaloneValue?.muted });
      return;
    }
    if (!layer || !onLayerUpdate) return;
    const newAttributes = { ...layer.attributes };
    if (checked) { newAttributes.autoplay = true; newAttributes.muted = true; } else { delete newAttributes.autoplay; }
    onLayerUpdate(layer.id, { attributes: newAttributes });
  }, [isStandaloneMode, standaloneOnChange, standaloneValue, layer, onLayerUpdate]);

  const handleTypeChange = useCallback((type: 'upload' | 'youtube' | 'custom_url' | 'cms') => {
    if (type === 'youtube') {
      const videoVariable: VideoVariable = {
        type: 'video',
        data: { provider: 'youtube', video_id: '' },
      };
      if (isStandaloneMode && standaloneOnChange) {
        standaloneOnChange({ src: videoVariable, poster: undefined });
        return;
      }
      if (!layer || !onLayerUpdate) return;
      onLayerUpdate(layer.id, {
        variables: { ...layer.variables, video: { src: videoVariable, poster: undefined } },
      });
    } else if (type === 'custom_url') {
      const urlVariable = createDynamicTextVariable('');
      if (isStandaloneMode && standaloneOnChange) {
        standaloneOnChange({ src: urlVariable, poster: undefined });
        return;
      }
      if (!layer || !onLayerUpdate) return;
      onLayerUpdate(layer.id, {
        variables: { ...layer.variables, video: { src: urlVariable, poster: undefined } },
      });
    } else if (type === 'cms') {
      const fieldVariable: FieldVariable = {
        type: 'field',
        data: { field_id: null, relationships: [], field_type: null },
      };
      if (isStandaloneMode && standaloneOnChange) {
        standaloneOnChange({ src: fieldVariable as any, poster: standaloneValue?.poster });
        setSelectedField(null);
        return;
      }
      if (!layer || !onLayerUpdate) return;
      onLayerUpdate(layer.id, {
        variables: { ...layer.variables, video: { src: fieldVariable as any, poster: layer.variables?.video?.poster } },
      });
      setSelectedField(null);
    } else {
      if (isStandaloneMode && standaloneOnChange) {
        standaloneOnChange({ src: undefined, poster: standaloneValue?.poster });
        setSelectedField(null);
        return;
      }
      if (!layer || !onLayerUpdate) return;
      onLayerUpdate(layer.id, {
        variables: { ...layer.variables, video: { src: undefined, poster: layer.variables?.video?.poster } },
      });
      setSelectedField(null);
    }
  }, [isStandaloneMode, standaloneOnChange, standaloneValue, layer, onLayerUpdate]);

  const handleYoutubeVideoIdChange = useCallback((videoId: string) => {
    const videoVariable: VideoVariable = {
      type: 'video',
      data: { provider: 'youtube', video_id: videoId },
    };

    if (isStandaloneMode && standaloneOnChange) {
      standaloneOnChange({ src: videoVariable, poster: undefined });
      return;
    }

    if (!layer || !onLayerUpdate) return;
    onLayerUpdate(layer.id, {
      variables: { ...layer.variables, video: { src: videoVariable, poster: undefined } },
    });
  }, [isStandaloneMode, standaloneOnChange, layer, onLayerUpdate]);

  const handleYoutubePrivacyModeChange = useCallback((checked: boolean) => {
    if (isStandaloneMode && standaloneOnChange) {
      standaloneOnChange({ ...standaloneValue, youtubePrivacyMode: checked || undefined });
      return;
    }
    if (!layer || !onLayerUpdate) return;
    const newAttributes = { ...layer.attributes };
    if (checked) { newAttributes.youtubePrivacyMode = true; } else { delete newAttributes.youtubePrivacyMode; }
    onLayerUpdate(layer.id, { attributes: newAttributes });
  }, [isStandaloneMode, standaloneOnChange, standaloneValue, layer, onLayerUpdate]);

  const handleCustomUrlChange = useCallback((value: string) => {
    const urlVariable = createDynamicTextVariable(value);

    if (isStandaloneMode && standaloneOnChange) {
      standaloneOnChange({ src: urlVariable, poster: standaloneValue?.poster });
      return;
    }

    if (!layer || !onLayerUpdate) return;
    onLayerUpdate(layer.id, {
      variables: { ...layer.variables, video: { src: urlVariable, poster: layer.variables?.video?.poster } },
    });
  }, [isStandaloneMode, standaloneOnChange, standaloneValue, layer, onLayerUpdate]);

  const handleLinkVideoVariable = useCallback((variableId: string) => {
    if (!layer || !onLayerUpdate) return;
    const currentSrc = layer.variables?.video?.src;
    onLayerUpdate(layer.id, {
      variables: {
        ...layer.variables,
        video: {
          ...layer.variables?.video,
          src: currentSrc
            ? { ...currentSrc, id: variableId } as any
            : { type: 'asset', id: variableId, data: { asset_id: null } } as any,
        },
      },
    });
  }, [layer, onLayerUpdate]);

  const handleUnlinkVideoVariable = useCallback(() => {
    if (!layer || !onLayerUpdate) return;
    const currentSrc = layer.variables?.video?.src;
    if (currentSrc) {
      const { id: _, ...srcWithoutId } = currentSrc as any;
      onLayerUpdate(layer.id, {
        variables: {
          ...layer.variables,
          video: { ...layer.variables?.video, src: srcWithoutId },
        },
      });
    }
  }, [layer, onLayerUpdate]);

  // In layer mode, only show for video layers
  if (!isStandaloneMode && (!layer || layer.name !== 'video')) {
    return null;
  }

  // Check if current src is a field variable
  const isFieldVariableSrc = videoSrc ? isFieldVariable(videoSrc) : false;
  const currentFieldId = isFieldVariableSrc && videoSrc && 'data' in videoSrc && 'field_id' in videoSrc.data
    ? videoSrc.data.field_id
    : null;

  // Get current behavior values from attributes (layer mode) or value (standalone mode)
  // Defaults match the video template: controls=true, rest=false
  const hasControls = isStandaloneMode ? (standaloneValue?.controls ?? true) : layer?.attributes?.controls === true;
  const isMuted = isStandaloneMode ? standaloneValue?.muted === true : layer?.attributes?.muted === true;
  const isLoop = isStandaloneMode ? standaloneValue?.loop === true : layer?.attributes?.loop === true;
  const isAutoplay = isStandaloneMode ? standaloneValue?.autoplay === true : layer?.attributes?.autoplay === true;

  // Source selection content (shared between modes)
  const sourceContent = (
    <>
      {/* Source Section */}
      <div className={isStandaloneMode ? 'flex flex-col gap-2' : 'grid grid-cols-3 items-center'}>
        {!isStandaloneMode && (
          <div className="flex items-start gap-1 py-1">
            <ComponentVariableLabel
              label="Source"
              isEditingComponent={!!editingComponentId}
              variables={videoComponentVariables}
              linkedVariableId={linkedVideoVariableId}
              onLinkVariable={handleLinkVideoVariable}
              onManageVariables={() => onOpenVariablesDialog?.()}
              onCreateVariable={editingComponentId ? async () => {
                const newId = await addVideoVariable(editingComponentId, 'Video');
                if (newId) {
                  const currentValue: VideoSettingsValue = {
                    src: layer?.variables?.video?.src,
                    poster: layer?.variables?.video?.poster,
                  };
                  await updateTextVariable(editingComponentId, newId, { default_value: currentValue });
                  handleLinkVideoVariable(newId);
                  onOpenVariablesDialog?.(newId);
                }
              } : undefined}
            />
          </div>
        )}

        <div className={isStandaloneMode ? 'flex gap-2' : 'col-span-2 flex gap-2'}>
          {linkedVideoVariable ? (
            <Button
              asChild
              variant="purple"
              className="justify-between! w-full"
              onClick={() => onOpenVariablesDialog?.(linkedVideoVariable.id)}
            >
              <div>
                <span className="flex items-center gap-1.5">
                  {linkedVideoVariable.type && VARIABLE_TYPE_ICONS[linkedVideoVariable.type] && (
                    <Icon name={VARIABLE_TYPE_ICONS[linkedVideoVariable.type]} className="size-3 opacity-60" />
                  )}
                  {linkedVideoVariable.name}
                </span>
                <Button
                  className="size-4! p-0!"
                  variant="outline"
                  onClick={(e) => { e.stopPropagation(); handleUnlinkVideoVariable(); }}
                >
                  <Icon name="x" className="size-2" />
                </Button>
              </div>
            </Button>
          ) : (
            <Select value={videoType} onValueChange={handleTypeChange}>
              <SelectTrigger className="flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="upload"><Icon name="folder" className="size-3" /> File manager</SelectItem>
                <SelectItem value="custom_url"><Icon name="link" className="size-3" /> Custom URL</SelectItem>
                <SelectItem value="cms" disabled={videoFields.length === 0}><Icon name="database" className="size-3" /> CMS field</SelectItem>
                <SelectSeparator />
                <SelectItem value="youtube"><Icon name="video" className="size-3" /> YouTube</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {/* File / URL / Field / YouTube ID - Based on source, hidden when linked to variable */}
      {!linkedVideoVariable && videoType === 'upload' && (
        <div className={isStandaloneMode ? '' : 'grid grid-cols-3 items-center'}>
          {!isStandaloneMode && <Label variant="muted">File</Label>}

          <div className={isStandaloneMode ? 'flex gap-2' : 'col-span-2 flex gap-2'}>
            {!selectedField && !currentFieldId && (
              <>
                <div className="bg-input rounded-md h-8 aspect-3/2 flex items-center justify-center">
                  <Icon name="video" className="size-4 text-muted-foreground" />
                </div>

                <Button
                  type="button"
                  variant="secondary"
                  className="flex-1 justify-start min-w-0"
                  size="sm"
                  onClick={() => {
                    openFileManager(
                      (asset) => {
                        if (!isStandaloneMode && !layer) return false;

                        if (!asset.mime_type || !isAssetOfType(asset.mime_type, ASSET_CATEGORIES.VIDEOS)) {
                          toast.error('Invalid asset type', {
                            description: 'Please select a video file.',
                          });
                          return false;
                        }

                        handleVideoChange(asset.id);
                      },
                      currentAssetId,
                      ASSET_CATEGORIES.VIDEOS
                    );
                  }}
                >
                  <span className="truncate">{assetFilename || 'Choose file'}</span>
                  {assetFilename && (
                    <span
                      role="button"
                      className="ml-auto shrink-0 -mr-1 p-1 rounded hover:bg-background/60"
                      onClick={(e) => { e.stopPropagation(); handleVideoChange(''); }}
                    >
                      <Icon name="x" className="size-3" />
                    </span>
                  )}
                </Button>
              </>
            )}

            {(selectedField || currentFieldId) && (
              <Button
                size="sm"
                variant="secondary"
                className="flex-1 justify-start"
              >
                <Icon name="database" />
                <span>
                  {videoFields.find(f => f.id === (selectedField || currentFieldId))?.name || 'Field'}
                </span>
                <Button
                  className="size-5! p-0! -mr-1 ml-auto"
                  variant="outline"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedField(null);
                    if (isStandaloneMode && standaloneOnChange) {
                      standaloneOnChange({ src: undefined, poster: standaloneValue?.poster });
                    } else if (layer && onLayerUpdate) {
                      onLayerUpdate(layer.id, {
                        variables: {
                          ...layer.variables,
                          video: { src: undefined, poster: layer.variables?.video?.poster },
                        },
                      });
                    }
                  }}
                >
                  <Icon name="x" className="size-2.5" />
                </Button>
              </Button>
            )}
          </div>
        </div>
      )}

      {/* YouTube Video ID Section */}
      {!linkedVideoVariable && videoType === 'youtube' && (
        <div className={isStandaloneMode ? '' : 'grid grid-cols-3 items-start'}>
          {!isStandaloneMode && <Label variant="muted" className="pt-2">Video ID</Label>}

          <div className={isStandaloneMode ? '' : 'col-span-2'}>
            <RichTextEditor
              value={youtubeVideoId}
              onChange={handleYoutubeVideoIdChange}
              placeholder="i.e. dQw4w9WgXcQ"
              fieldGroups={textFieldGroups}
              allFields={allFields}
              collections={collections}
              allowedFieldTypes={VIDEO_ID_FIELD_TYPES}
            />
          </div>
        </div>
      )}

      {/* Custom URL Section */}
      {!linkedVideoVariable && videoType === 'custom_url' && (
        <div className={isStandaloneMode ? '' : 'grid grid-cols-3 items-start'}>
          {!isStandaloneMode && <Label variant="muted" className="pt-2">URL</Label>}

          <div className={isStandaloneMode ? '' : 'col-span-2'}>
            <RichTextEditor
              value={customUrlValue}
              onChange={handleCustomUrlChange}
              placeholder="https://example.com/video.mp4"
              fieldGroups={fieldGroups}
              allFields={allFields}
              collections={collections}
            />
          </div>
        </div>
      )}

      {/* CMS Field Section */}
      {!linkedVideoVariable && videoType === 'cms' && (
        <div className={isStandaloneMode ? '' : 'grid grid-cols-3 items-center'}>
          {!isStandaloneMode && <Label variant="muted">Field</Label>}

          <div className={isStandaloneMode ? 'w-full' : 'col-span-2 w-full'}>
            <FieldSelectDropdown
              fieldGroups={videoFieldGroups}
              allFields={allFields || {}}
              collections={collections || []}
              value={selectedField || currentFieldId}
              onSelect={handleFieldSelect}
              placeholder="Select..."
              allowedFieldTypes={VIDEO_FIELD_TYPES}
            />
          </div>
        </div>
      )}
    </>
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
              id="sa-video-controls" checked={hasControls}
              onCheckedChange={handleControlsChange}
            />
            <Label
              variant="muted" htmlFor="sa-video-controls"
              className="cursor-pointer"
            >Display controls</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="sa-video-muted" checked={isMuted}
              onCheckedChange={handleMutedChange}
            />
            <Label
              variant="muted" htmlFor="sa-video-muted"
              className="cursor-pointer"
            >Mute sound</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="sa-video-loop" checked={isLoop}
              onCheckedChange={handleLoopChange}
            />
            <Label
              variant="muted" htmlFor="sa-video-loop"
              className="cursor-pointer"
            >Loop video</Label>
          </div>
          {videoType === 'youtube' && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="sa-youtube-privacy" checked={youtubePrivacyMode}
                onCheckedChange={handleYoutubePrivacyModeChange}
              />
              <Label
                variant="muted" htmlFor="sa-youtube-privacy"
                className="cursor-pointer"
              >Privacy mode</Label>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Checkbox
              id="sa-video-autoplay" checked={isAutoplay}
              onCheckedChange={handleAutoplayChange} disabled={!isMuted}
            />
            <Label
              variant="muted" htmlFor="sa-video-autoplay"
              className={!isMuted ? 'opacity-60 cursor-pointer' : 'cursor-pointer'}
            >Autoplay</Label>
          </div>
        </div>

        {/* Poster - for non-YouTube sources */}
        {(videoType === 'upload' || videoType === 'custom_url' || videoType === 'cms') && (
          <div>
            <div
              className="relative group bg-secondary/30 hover:bg-secondary/60 rounded-md w-full aspect-3/2 overflow-hidden cursor-pointer"
              onClick={() => {
                openFileManager(
                  (asset) => {
                    if (!asset.mime_type || !isAssetOfType(asset.mime_type, ASSET_CATEGORIES.IMAGES)) {
                      toast.error('Invalid asset type', { description: 'Please select an image file.' });
                      return false;
                    }
                    handlePosterChange(asset.id);
                  },
                  currentPosterAssetId,
                  ASSET_CATEGORIES.IMAGES
                );
              }}
            >
              <div className="absolute inset-0 opacity-10 bg-checkerboard" />
              <img
                src={posterUrl}
                className="relative w-full h-full object-contain z-10"
                alt="Video poster"
              />
              <div className="absolute inset-0 bg-black/50 text-white text-xs flex flex-col gap-3 items-center justify-center px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                <Button variant="overlay" size="sm">{posterAssetFilename ? 'Change poster' : 'Choose poster'}</Button>
                {posterAssetFilename && <div className="max-w-full truncate text-center">{posterAssetFilename}</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <SettingsPanel
        title="Video"
        isOpen={isOpen}
        onToggle={() => setIsOpen(!isOpen)}
      >
        <div className="flex flex-col gap-3">
          {sourceContent}

          {/* Behavior & Poster - hidden when linked to variable */}
          {!linkedVideoVariable && (
            <>
              {/* Behavior Section */}
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label variant="muted">Behavior</Label>
                </div>

                <div className="col-span-2 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="video-controls"
                      checked={hasControls}
                      onCheckedChange={handleControlsChange}
                    />
                    <Label
                      variant="muted"
                      htmlFor="video-controls"
                      className="cursor-pointer"
                    >
                      Display controls
                    </Label>
                  </div>

                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="video-muted"
                      checked={isMuted}
                      onCheckedChange={handleMutedChange}
                    />
                    <Label
                      variant="muted"
                      htmlFor="video-muted"
                      className="cursor-pointer"
                    >
                      Mute sound
                    </Label>
                  </div>

                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="video-loop"
                      checked={isLoop}
                      onCheckedChange={handleLoopChange}
                    />
                    <Label
                      variant="muted"
                      htmlFor="video-loop"
                      className="cursor-pointer"
                    >
                      Loop video
                    </Label>
                  </div>

                  {/* YouTube Privacy Mode */}
                  {videoType === 'youtube' && (
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="youtube-privacy"
                        checked={youtubePrivacyMode}
                        onCheckedChange={handleYoutubePrivacyModeChange}
                      />
                      <Label
                        variant="muted"
                        htmlFor="youtube-privacy"
                        className="cursor-pointer"
                      >
                        Privacy mode
                      </Label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Icon name="info" className="size-3 opacity-70" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Prevents usage of tracking cookies</p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="video-autoplay"
                      checked={isAutoplay}
                      onCheckedChange={handleAutoplayChange}
                      disabled={!isMuted}
                    />
                    <Label
                      variant="muted"
                      htmlFor="video-autoplay"
                      className={!isMuted ? 'opacity-60 cursor-pointer' : 'cursor-pointer'}
                    >
                      Autoplay
                    </Label>
                    {!isMuted && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Icon name="info" className="size-3 opacity-70" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Only available when video sound is muted</p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Poster Section - show for Upload, Custom URL, and CMS types (not YouTube), hidden when linked to variable */}
          {!linkedVideoVariable && (videoType === 'upload' || videoType === 'custom_url' || videoType === 'cms') && (
            <div className="grid grid-cols-3 items-start">
              <Label variant="muted" className="pt-2">Poster</Label>

              <div className="col-span-2">
                <div className="relative group bg-secondary/30 hover:bg-secondary/60 rounded-md w-full aspect-3/2 overflow-hidden">
                  <div className="absolute inset-0 opacity-10 bg-checkerboard" />
                  <img
                    src={posterUrl}
                    className="relative w-full h-full object-contain z-10"
                    alt="Video poster"
                  />

                  <div className="absolute inset-0 bg-black/50 text-white text-xs flex flex-col gap-3 items-center justify-center px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                    <div className="flex items-center gap-2">
                      <Button
                        variant="overlay"
                        size="sm"
                        onClick={() => {
                          openFileManager(
                            (asset) => {
                              if (!layer) return false;

                              if (!asset.mime_type || !isAssetOfType(asset.mime_type, ASSET_CATEGORIES.IMAGES)) {
                                toast.error('Invalid asset type', {
                                  description: 'Please select an image file.',
                                });
                                return false;
                              }

                              handlePosterChange(asset.id);
                            },
                            currentPosterAssetId,
                            ASSET_CATEGORIES.IMAGES
                          );
                        }}
                      >
                        {posterAssetFilename ? 'Change' : 'Choose file'}
                      </Button>
                      {posterAssetFilename && (
                        <Button
                          variant="overlay"
                          size="sm"
                          onClick={() => {
                            if (!layer) return;

                            onLayerUpdate!(layer.id, {
                              variables: {
                                ...layer.variables,
                                video: {
                                  ...layer.variables?.video,
                                  src: layer.variables?.video?.src,
                                  poster: undefined,
                                },
                              },
                            });
                          }}
                        >
                          <Icon name="trash" />
                        </Button>
                      )}
                    </div>
                    {posterAssetFilename && <div className="max-w-full truncate text-center">{posterAssetFilename}</div>}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </SettingsPanel>
    </>
  );
}

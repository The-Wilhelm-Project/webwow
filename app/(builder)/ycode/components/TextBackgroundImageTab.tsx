'use client';

import React, { useCallback, useMemo, useImperativeHandle, forwardRef } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { useDesignSync } from '@/hooks/use-design-sync';
import { useEditorStore } from '@/stores/useEditorStore';
import { removeSpaces } from '@/lib/utils';
import { setBreakpointClass, propertyToClass, buildBgImgVarName, buildBgImgClass } from '@/lib/tailwind-class-mapper';
import { ASSET_CATEGORIES, isAssetOfType, DEFAULT_ASSETS } from '@/lib/asset-utils';
import { IMAGE_FIELD_TYPES, filterFieldGroupsByType, flattenFieldGroups } from '@/lib/collection-field-utils';
import { getCollectionVariable } from '@/lib/layer-utils';
import { createAssetVariable, createDynamicTextVariable } from '@/lib/variable-utils';
import { buildStyledUpdate } from '@/lib/layer-style-utils';
import { toast } from 'sonner';
import { FieldSelectDropdown } from './CollectionFieldSelector';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Collection, CollectionField, FieldVariable, Layer } from '@/types';
import type { FieldGroup, FieldSourceType } from '@/lib/collection-field-utils';
import type { BackgroundImageSourceType } from './BackgroundImageSettings';

interface TextBackgroundImageTabProps {
  layer: Layer | null;
  onLayerUpdate: (layerId: string, updates: Partial<Layer>) => void;
  activeTextStyleKey?: string | null;
  fieldGroups?: FieldGroup[];
  allFields?: Record<string, CollectionField[]>;
  collections?: Collection[];
}

export interface TextBackgroundImageTabHandle {
  activate: () => void;
  deactivate: (solidColor?: string) => void;
}

function getClassesArray(layer: Layer): string[] {
  return Array.isArray(layer.classes)
    ? [...layer.classes]
    : (layer.classes || '').split(' ').filter(Boolean);
}

function removeVarEntry(vars: Record<string, string> | undefined, key: string): Record<string, string> | undefined {
  if (!vars) return undefined;
  const updated = { ...vars };
  delete updated[key];
  return Object.keys(updated).length > 0 ? updated : undefined;
}

function extractImageUrl(raw: string): string {
  if (!raw) return '';
  if (raw.startsWith('url(')) return raw.slice(4, -1).replace(/['"]/g, '');
  return raw;
}

function wrapCssUrl(value: string): string {
  if (!value) return '';
  return value.startsWith('url(') ? value : `url(${value})`;
}

const BG_IMAGE_PROPS = ['backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat'] as const;

const TextBackgroundImageTab = forwardRef<TextBackgroundImageTabHandle, TextBackgroundImageTabProps>(
  function TextBackgroundImageTab({
    layer,
    onLayerUpdate,
    activeTextStyleKey,
    fieldGroups,
    allFields,
    collections,
  }, ref) {
    const activeBreakpoint = useEditorStore((s) => s.activeBreakpoint);
    const activeUIState = useEditorStore((s) => s.activeUIState);
    const openFileManager = useEditorStore((state) => state.openFileManager);
    const { updateDesignProperty, getDesignProperty } = useDesignSync({
      layer,
      onLayerUpdate,
      activeBreakpoint,
      activeUIState,
      activeTextStyleKey,
    });

    const backgroundSize = getDesignProperty('backgrounds', 'backgroundSize') || 'cover';
    const backgroundPosition = getDesignProperty('backgrounds', 'backgroundPosition') || 'center';
    const backgroundRepeat = getDesignProperty('backgrounds', 'backgroundRepeat') || 'no-repeat';

    const bgImgVarName = buildBgImgVarName(activeBreakpoint, activeUIState);
    const bgImageVars = layer?.design?.backgrounds?.bgImageVars;
    const backgroundImage = bgImageVars?.[bgImgVarName] || '';
    const bgImageUrl = useMemo(() => extractImageUrl(backgroundImage), [backgroundImage]);
    const displayUrl = bgImageUrl || DEFAULT_ASSETS.IMAGE;

    const bgImageVariable = layer?.variables?.backgroundImage?.src;
    const sourceType = useMemo((): BackgroundImageSourceType => {
      if (!bgImageVariable) return 'none';
      if (bgImageVariable.type === 'field') return 'cms';
      if (bgImageVariable.type === 'dynamic_text') return 'custom_url';
      if (bgImageVariable.type === 'asset') return 'file_manager';
      return 'none';
    }, [bgImageVariable]);

    const isActive = sourceType !== 'none';

    const effectiveFieldGroups = useMemo((): FieldGroup[] | undefined => {
      const groups: FieldGroup[] = [...(fieldGroups || [])];
      const collectionVar = layer ? getCollectionVariable(layer) : null;
      if (collectionVar?.id && allFields) {
        const ownFields = allFields[collectionVar.id] || [];
        const alreadyIncluded = groups.some(g =>
          g.fields.length > 0 && ownFields.length > 0 && g.fields[0]?.id === ownFields[0]?.id
        );
        if (ownFields.length > 0 && !alreadyIncluded) {
          groups.unshift({ fields: ownFields, label: 'Collection fields', source: 'collection', layerId: layer!.id });
        }
      }
      return groups.length > 0 ? groups : undefined;
    }, [fieldGroups, layer, allFields]);

    const imageFieldGroups = useMemo(() =>
      filterFieldGroupsByType(effectiveFieldGroups, IMAGE_FIELD_TYPES, { excludeMultipleAsset: true }),
    [effectiveFieldGroups]);
    const imageFields = useMemo(() => flattenFieldGroups(imageFieldGroups), [imageFieldGroups]);
    const hasCmsFields = imageFields.length > 0;

    const clearBackgroundImage = useCallback((solidColor?: string) => {
      if (!layer) return;
      const cleanedBg = { ...(layer.design?.backgrounds || {}) };
      for (const prop of BG_IMAGE_PROPS) delete cleanedBg[prop as keyof typeof cleanedBg];
      const varName = buildBgImgVarName(activeBreakpoint, activeUIState);
      cleanedBg.bgImageVars = removeVarEntry(cleanedBg.bgImageVars, varName);

      let classes = getClassesArray(layer);
      for (const prop of BG_IMAGE_PROPS) {
        if (prop === 'backgroundImage' && cleanedBg.bgGradientVars?.[varName]) continue;
        classes = setBreakpointClass(classes, prop, null, activeBreakpoint, activeUIState);
      }
      delete cleanedBg.backgroundClip;
      classes = setBreakpointClass(classes, 'backgroundClip', null, activeBreakpoint, activeUIState);

      if (solidColor) {
        const colorCls = propertyToClass('typography', 'color', solidColor);
        classes = setBreakpointClass(classes, 'color', colorCls, activeBreakpoint, activeUIState);
      } else {
        classes = setBreakpointClass(classes, 'color', null, activeBreakpoint, activeUIState);
      }

      onLayerUpdate(layer.id, buildStyledUpdate(layer, {
        design: { ...layer.design, backgrounds: cleanedBg },
        classes: classes.join(' '),
        variables: { ...layer.variables, backgroundImage: undefined },
      }));
    }, [layer, onLayerUpdate, activeBreakpoint, activeUIState]);

    const handleSourceTypeChange = useCallback((type: BackgroundImageSourceType) => {
      if (type === 'none') { clearBackgroundImage(); return; }
      if (!layer) return;

      let newSrc: typeof bgImageVariable;
      if (type === 'file_manager') newSrc = createAssetVariable('');
      else if (type === 'custom_url') newSrc = createDynamicTextVariable('');
      else newSrc = { type: 'field', data: { field_id: null, relationships: [], field_type: null } } as FieldVariable;

      const varName = buildBgImgVarName(activeBreakpoint, activeUIState);
      const bgDesign = { ...(layer.design?.backgrounds || {}), isActive: true };
      if (!bgDesign.backgroundSize) bgDesign.backgroundSize = 'cover';
      if (!bgDesign.backgroundPosition) bgDesign.backgroundPosition = 'center';
      if (!bgDesign.backgroundRepeat) bgDesign.backgroundRepeat = 'no-repeat';
      bgDesign.backgroundImage = varName;

      let classes = getClassesArray(layer);
      for (const prop of ['backgroundSize', 'backgroundPosition', 'backgroundRepeat'] as const) {
        const cls = propertyToClass('backgrounds', prop, bgDesign[prop]!);
        classes = setBreakpointClass(classes, prop, cls, activeBreakpoint, activeUIState);
      }
      classes = setBreakpointClass(classes, 'backgroundImage', buildBgImgClass(varName), activeBreakpoint, activeUIState);

      bgDesign.backgroundClip = 'text';
      const clipCls = propertyToClass('backgrounds', 'backgroundClip', 'text');
      if (clipCls) classes = setBreakpointClass(classes, 'backgroundClip', clipCls, activeBreakpoint, activeUIState);
      classes = setBreakpointClass(classes, 'color', 'text-transparent', activeBreakpoint, activeUIState);

      onLayerUpdate(layer.id, buildStyledUpdate(layer, {
        design: { ...layer.design, backgrounds: bgDesign },
        classes: classes.join(' '),
        variables: { ...layer.variables, backgroundImage: { src: newSrc } },
      }));
    }, [layer, onLayerUpdate, clearBackgroundImage, activeBreakpoint, activeUIState]);

    useImperativeHandle(ref, () => ({
      activate: () => {
        if (sourceType === 'none') handleSourceTypeChange('file_manager');
      },
      deactivate: (solidColor?: string) => clearBackgroundImage(solidColor),
    }), [sourceType, handleSourceTypeChange, clearBackgroundImage]);

    const handleBackgroundPropChange = useCallback(
      (property: string, value: string) => updateDesignProperty('backgrounds', property, value),
      [updateDesignProperty],
    );

    const handleOpenFileManager = useCallback(() => {
      openFileManager(
        (asset) => {
          if (!asset.mime_type || !isAssetOfType(asset.mime_type, ASSET_CATEGORIES.IMAGES)) {
            toast.error('Invalid asset type', { description: 'Please select an image file.' });
            return false;
          }
          if (!asset.public_url) { toast.error('Asset has no URL'); return false; }
          if (!layer) return false;

          const varName = buildBgImgVarName(activeBreakpoint, activeUIState);
          const cssUrl = `url(${asset.public_url})`;
          const currentBg = layer.design?.backgrounds || {};
          const updatedBg = {
            ...currentBg,
            backgroundImage: varName,
            bgImageVars: { ...currentBg.bgImageVars, [varName]: cssUrl },
            isActive: true,
          };
          let classes = getClassesArray(layer);
          classes = setBreakpointClass(classes, 'backgroundImage', buildBgImgClass(varName), activeBreakpoint, activeUIState);

          onLayerUpdate(layer.id, buildStyledUpdate(layer, {
            design: { ...layer.design, backgrounds: updatedBg },
            classes: classes.join(' '),
            variables: { ...layer.variables, backgroundImage: { src: createAssetVariable(asset.id) } },
          }));
        },
        null,
        [ASSET_CATEGORIES.IMAGES],
      );
    }, [openFileManager, layer, onLayerUpdate, activeBreakpoint, activeUIState]);

    const handleFieldSelect = useCallback((
      fieldId: string,
      relationshipPath: string[],
      source?: FieldSourceType,
      layerId?: string,
    ) => {
      if (!layer) return;
      const field = imageFields.find(f => f.id === fieldId);
      const fieldVar: FieldVariable = {
        type: 'field',
        data: { field_id: fieldId, relationships: relationshipPath, field_type: field?.type || null, source, collection_layer_id: layerId },
      };

      const varName = buildBgImgVarName(activeBreakpoint, activeUIState);
      const currentBg = layer.design?.backgrounds || {};
      const updatedBg = { ...currentBg, backgroundImage: varName, isActive: true };
      let classes = getClassesArray(layer);
      classes = setBreakpointClass(classes, 'backgroundImage', buildBgImgClass(varName), activeBreakpoint, activeUIState);

      onLayerUpdate(layer.id, buildStyledUpdate(layer, {
        design: { ...layer.design, backgrounds: updatedBg },
        classes: classes.join(' '),
        variables: { ...layer.variables, backgroundImage: { src: fieldVar } },
      }));
    }, [layer, onLayerUpdate, imageFields, activeBreakpoint, activeUIState]);

    if (!isActive) return null;

    return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-3 items-center">
        <Label variant="muted">Source</Label>
        <div className="col-span-2 *:w-full">
          <Select
            value={sourceType}
            onValueChange={(v) => handleSourceTypeChange(v as BackgroundImageSourceType)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="file_manager"><Icon name="folder" className="size-3" /> File manager</SelectItem>
              <SelectItem value="custom_url"><Icon name="link" className="size-3" /> Custom URL</SelectItem>
              <SelectItem value="cms" disabled={!hasCmsFields}><Icon name="database" className="size-3" /> CMS field</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {sourceType === 'file_manager' && (
        <div
          className="relative group bg-secondary/30 hover:bg-secondary/60 rounded-md w-full aspect-3/2 overflow-hidden cursor-pointer"
          onClick={handleOpenFileManager}
        >
          <div className="absolute inset-0 opacity-5 bg-checkerboard" />
          {displayUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={displayUrl} className="relative w-full h-full object-contain z-10"
              alt="Background image preview"
            />
          )}
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center px-2 py-1 opacity-0 group-hover:opacity-100 z-20">
            <Button variant="overlay" size="sm">{bgImageUrl ? 'Change file' : 'Choose file'}</Button>
          </div>
        </div>
      )}

      {sourceType === 'custom_url' && (
        <Input
          type="text"
          value={bgImageUrl}
          onChange={(e) => {
            const url = e.target.value.trim();
            if (!layer) return;
            const processedValue = wrapCssUrl(removeSpaces(url));
            const varName = buildBgImgVarName(activeBreakpoint, activeUIState);
            const currentBg = layer.design?.backgrounds || {};
            const newVars = { ...currentBg.bgImageVars };
            if (processedValue) newVars[varName] = processedValue;
            else delete newVars[varName];
            const updatedBg = { ...currentBg, backgroundImage: varName, bgImageVars: Object.keys(newVars).length > 0 ? newVars : undefined, isActive: true };
            let classes = getClassesArray(layer);
            classes = setBreakpointClass(classes, 'backgroundImage', processedValue ? buildBgImgClass(varName) : null, activeBreakpoint, activeUIState);
            const variableUpdates = bgImageVariable?.type === 'dynamic_text'
              ? { ...layer.variables, backgroundImage: { src: createDynamicTextVariable(url) } }
              : undefined;
            onLayerUpdate(layer.id, buildStyledUpdate(layer, {
              design: { ...layer.design, backgrounds: updatedBg },
              classes: classes.join(' '),
              ...(variableUpdates ? { variables: variableUpdates } : {}),
            }));
          }}
          placeholder="https://example.com/image.jpg"
        />
      )}

      {sourceType === 'cms' && (
        <FieldSelectDropdown
          fieldGroups={imageFieldGroups}
          allFields={allFields || {}}
          collections={collections || []}
          value={bgImageVariable?.type === 'field' ? (bgImageVariable as FieldVariable).data.field_id : null}
          onSelect={handleFieldSelect}
          placeholder="Select..."
          allowedFieldTypes={IMAGE_FIELD_TYPES}
        />
      )}

      <div className="grid grid-cols-3">
        <Label variant="muted">Size</Label>
        <div className="col-span-2 *:w-full">
          <Select value={backgroundSize || 'cover'} onValueChange={(v) => handleBackgroundPropChange('backgroundSize', v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="cover">Cover</SelectItem>
                <SelectItem value="contain">Contain</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-3">
        <Label variant="muted">Position</Label>
        <div className="col-span-2 *:w-full">
          <Select value={backgroundPosition || 'center'} onValueChange={(v) => handleBackgroundPropChange('backgroundPosition', v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="left-top">Top / Left</SelectItem>
                <SelectItem value="top">Top / Center</SelectItem>
                <SelectItem value="right-top">Top / Right</SelectItem>
                <SelectItem value="left">Center / Left</SelectItem>
                <SelectItem value="center">Center / Center</SelectItem>
                <SelectItem value="right">Center / Right</SelectItem>
                <SelectItem value="left-bottom">Bottom / Left</SelectItem>
                <SelectItem value="bottom">Bottom / Center</SelectItem>
                <SelectItem value="right-bottom">Bottom / Right</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-3">
        <Label variant="muted">Repeat</Label>
        <div className="col-span-2 *:w-full">
          <Select value={backgroundRepeat || 'no-repeat'} onValueChange={(v) => handleBackgroundPropChange('backgroundRepeat', v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="no-repeat">No repeat</SelectItem>
                <SelectItem value="repeat">Repeat</SelectItem>
                <SelectItem value="repeat-x">Repeat X</SelectItem>
                <SelectItem value="repeat-y">Repeat Y</SelectItem>
                <SelectItem value="repeat-round">Repeat round</SelectItem>
                <SelectItem value="repeat-space">Repeat space</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
    );
  });

export default TextBackgroundImageTab;

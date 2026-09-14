'use client';

/**
 * Webwow-only: client half of the /dev/css-controls sandbox (see ../page.tsx).
 * Posts the resulting CSS declarations to the parent frame so the panels can be
 * driven from an embedding page.
 */

import { useEffect, useMemo, useState } from 'react';
import EffectControls from '@/app/(builder)/ycode/components/EffectControls';
import SettingsPanel from '@/app/(builder)/ycode/components/SettingsPanel';
import SpacingControls from '@/app/(builder)/ycode/components/SpacingControls';
import TypographyControls from '@/app/(builder)/ycode/components/TypographyControls';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { DesignProperties, Layer } from '@/types';

const INITIAL_LAYER: Layer = {
  id: 'dev-css-layer',
  name: 'div',
  classes: '',
  design: {
    spacing: {
      marginTop: '0px',
      marginRight: '0px',
      marginBottom: '0px',
      marginLeft: '0px',
      paddingTop: '0px',
      paddingRight: '0px',
      paddingBottom: '0px',
      paddingLeft: '0px',
    },
    typography: {
      fontWeight: '500',
      fontSize: '56px',
      color: '#111827',
      textAlign: 'left',
      letterSpacing: '0em',
      lineHeight: '1.2',
    },
    effects: {
      opacity: '100',
    },
  },
};

export default function DevCssControlsClient() {
  const [layer, setLayer] = useState<Layer>(INITIAL_LAYER);
  const [activeTab, setActiveTab] = useState<'design' | 'settings' | 'interactions'>('design');
  const [spacingOpen, setSpacingOpen] = useState(true);
  const [typographyOpen, setTypographyOpen] = useState(true);
  const [effectsOpen, setEffectsOpen] = useState(true);

  const handleLayerUpdate = (layerId: string, updates: Partial<Layer>) => {
    if (layerId !== layer.id) {
      return;
    }

    setLayer((prev) => {
      const nextDesign = mergeDesign(prev.design, updates.design);
      return {
        ...prev,
        ...updates,
        design: nextDesign,
      };
    });
  };

  const cssDeclarations = useMemo(() => designToCssDeclarations(layer.design), [layer.design]);

  useEffect(() => {
    window.parent.postMessage(
      {
        source: 'webwow-css-controls',
        type: 'design-change',
        declarations: cssDeclarations,
      },
      '*',
    );
  }, [cssDeclarations]);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-3">
      <div className="max-w-sm mx-auto">
        <header className="mb-3">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
            <TabsList className="grid grid-cols-3">
              <TabsTrigger value="design">Design</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
              <TabsTrigger value="interactions">Interactions</TabsTrigger>
            </TabsList>
          </Tabs>
        </header>

        {activeTab === 'design' ? (
          <>
            <SettingsPanel
              title="Spacing"
              isOpen={spacingOpen}
              onToggle={() => setSpacingOpen((prev) => !prev)}
              collapsible
            >
              <SpacingControls
                layer={layer}
                onLayerUpdate={handleLayerUpdate}
              />
            </SettingsPanel>

            <SettingsPanel
              title="Typography"
              isOpen={typographyOpen}
              onToggle={() => setTypographyOpen((prev) => !prev)}
              collapsible
            >
              <TypographyControls
                layer={layer}
                onLayerUpdate={handleLayerUpdate}
              />
            </SettingsPanel>

            <SettingsPanel
              title="Effects"
              isOpen={effectsOpen}
              onToggle={() => setEffectsOpen((prev) => !prev)}
              collapsible
            >
              <EffectControls
                layer={layer}
                onLayerUpdate={handleLayerUpdate}
              />
            </SettingsPanel>
          </>
        ) : (
          <div className="rounded-md border border-zinc-800 p-4 text-sm text-zinc-400">
            Dieser Embed-Modus zeigt Design Controls.
          </div>
        )}
      </div>
    </main>
  );
}

function mergeDesign(existing: DesignProperties | undefined, updates: DesignProperties | undefined): DesignProperties {
  return {
    ...(existing || {}),
    ...(updates || {}),
    layout: { ...(existing?.layout || {}), ...(updates?.layout || {}) },
    spacing: { ...(existing?.spacing || {}), ...(updates?.spacing || {}) },
    sizing: { ...(existing?.sizing || {}), ...(updates?.sizing || {}) },
    typography: { ...(existing?.typography || {}), ...(updates?.typography || {}) },
    backgrounds: { ...(existing?.backgrounds || {}), ...(updates?.backgrounds || {}) },
    borders: { ...(existing?.borders || {}), ...(updates?.borders || {}) },
    effects: { ...(existing?.effects || {}), ...(updates?.effects || {}) },
    positioning: { ...(existing?.positioning || {}), ...(updates?.positioning || {}) },
  };
}

function designToCssDeclarations(design: DesignProperties | undefined): Record<string, string> {
  const declarations: Record<string, string> = {};
  if (!design) {
    return declarations;
  }

  const spacing = design.spacing || {};
  setDeclaration(declarations, 'margin-top', spacing.marginTop);
  setDeclaration(declarations, 'margin-right', spacing.marginRight);
  setDeclaration(declarations, 'margin-bottom', spacing.marginBottom);
  setDeclaration(declarations, 'margin-left', spacing.marginLeft);
  setDeclaration(declarations, 'padding-top', spacing.paddingTop);
  setDeclaration(declarations, 'padding-right', spacing.paddingRight);
  setDeclaration(declarations, 'padding-bottom', spacing.paddingBottom);
  setDeclaration(declarations, 'padding-left', spacing.paddingLeft);

  const typography = design.typography || {};
  setDeclaration(declarations, 'font-size', normalizeCssValue('font-size', typography.fontSize));
  setDeclaration(declarations, 'font-weight', typography.fontWeight);
  setDeclaration(declarations, 'line-height', typography.lineHeight);
  setDeclaration(declarations, 'letter-spacing', normalizeCssValue('letter-spacing', typography.letterSpacing));
  setDeclaration(declarations, 'color', typography.color);
  setDeclaration(declarations, 'text-align', typography.textAlign);

  const effects = design.effects || {};
  setDeclaration(declarations, 'opacity', normalizeOpacity(effects.opacity));

  const borders = design.borders || {};
  setDeclaration(declarations, 'border-radius', normalizeCssValue('border-radius', borders.borderRadius));

  const sizing = design.sizing || {};
  setDeclaration(declarations, 'width', normalizeCssValue('width', sizing.width));
  setDeclaration(declarations, 'height', normalizeCssValue('height', sizing.height));

  const backgrounds = design.backgrounds || {};
  setDeclaration(declarations, 'background-color', backgrounds.backgroundColor);

  return declarations;
}

function setDeclaration(
  target: Record<string, string>,
  property: string,
  value: string | null | undefined,
) {
  const nextValue = (value || '').trim();
  if (!nextValue) {
    return;
  }
  target[property] = nextValue;
}

function normalizeOpacity(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return value;
  }
  const normalized = Math.max(0, Math.min(100, numeric)) / 100;
  return String(normalized);
}

function normalizeCssValue(property: string, value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const needsUnit = ['font-size', 'letter-spacing', 'border-radius', 'width', 'height'].includes(property);
  if (!needsUnit) {
    return trimmed;
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return `${trimmed}px`;
  }

  return trimmed;
}

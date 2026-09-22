/**
 * Body-layer classes for the real `<body>` element.
 *
 * The editor stores background / type / font classes on a synthetic `body`
 * layer. Those must be present on `<body>` in the first HTML byte — applying
 * them from a script after paint flashes the default background (FOUC).
 */

import { getClassesString } from '@/lib/layer-utils';

import type { Layer } from '@/types';

/** Always present on public documents so `font-sans` falls back to the system stack. */
export const DOCUMENT_BODY_FONT_CLASS = 'font-sans';

/** Used when the body layer has no classes, matching the canvas / previous script. */
export const DOCUMENT_BODY_FALLBACK_CLASS = 'bg-white';

/**
 * Extract the class string from the synthetic `body` layer.
 * The editor canvas and static export apply the same classes to the real body.
 */
export function getBodyClasses(layers: Layer[] | null | undefined): string {
  if (!layers || layers.length === 0) {
    return '';
  }

  const bodyLayer = layers.find((layer) => layer.id === 'body' || layer.name === 'body');
  return bodyLayer ? getClassesString(bodyLayer) : '';
}

/**
 * Classes for the SSR `<body>`: system-font fallback plus the page's body layer
 * (or `bg-white` when the layer has none).
 */
export function composeDocumentBodyClassName(layerClasses: string): string {
  const design = (layerClasses || DOCUMENT_BODY_FALLBACK_CLASS).trim();
  return `${DOCUMENT_BODY_FONT_CLASS} ${design}`.trim();
}

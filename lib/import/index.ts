/**
 * Shared import pipeline entry point.
 *
 * Source adapters (Webflow, Figma) produce an `ImportDocument`; this runs the
 * common steps — install fonts, convert IR → layers, recover components — and
 * returns the resulting layers plus a summary for the UI. Insertion is left to
 * the caller so both importers share the host's single insertion path.
 */

import { ImportMaterializer } from '@/lib/import/materializer';
import { ImportConverter } from '@/lib/import/convert';
import { componentizeLayers } from '@/lib/import/componentize';
import { useFontsStore } from '@/stores/useFontsStore';
import type { Layer } from '@/types';
import type { ImportDocument, ImportNode, ImportSummary } from '@/lib/import/types';

function countLayers(layers: { children?: unknown[] }[]): number {
  let total = 0;
  const walk = (list: { children?: unknown[] }[]) => {
    for (const layer of list) {
      total += 1;
      if (Array.isArray(layer.children)) walk(layer.children as { children?: unknown[] }[]);
    }
  };
  walk(layers);
  return total;
}

function countCollections(layers: Array<{ variables?: { collection?: unknown }; children?: unknown[] }>): number {
  let total = 0;
  const walk = (list: Array<{ variables?: { collection?: unknown }; children?: unknown[] }>) => {
    for (const layer of list) {
      if (layer.variables?.collection) total += 1;
      if (Array.isArray(layer.children)) walk(layer.children as typeof list);
    }
  };
  walk(layers);
  return total;
}

export interface ImportResult {
  layers: Layer[];
  summary: ImportSummary;
}

/** Total nodes in the source tree — the denominator for the layers phase. */
function countNodes(nodes: { children?: unknown[] }[]): number {
  let total = 0;
  const walk = (list: { children?: unknown[] }[]) => {
    for (const node of list) {
      total += 1;
      if (Array.isArray(node.children)) walk(node.children as { children?: unknown[] }[]);
    }
  };
  walk(nodes);
  return total;
}

/** Unique remote image URLs that need re-hosting (skips pre-uploaded assets). */
function collectImageUrls(nodes: ImportNode[]): string[] {
  const urls = new Set<string>();
  const walk = (list: ImportNode[]) => {
    for (const node of list) {
      if (node.kind === 'image' && node.image?.src && !node.image.assetId) {
        urls.add(node.image.src);
      }
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return [...urls];
}

/** The work phase a paste is currently in, in execution order. */
export type ImportPhase = 'styles' | 'images' | 'layers';

/** Progress for the active phase (`done` of `total`). */
export interface ImportProgress {
  phase: ImportPhase;
  done: number;
  total: number;
}

export interface BuildImportOptions {
  /** Reports phase-based progress (styles → images → layers) for a UI indicator. */
  onProgress?: (progress: ImportProgress) => void;
}

/**
 * Run the shared pipeline and return the built layers + summary. The caller is
 * responsible for inserting `layers` onto the canvas (so Webflow and Figma both
 * flow through the host's one robust insertion path).
 */
export async function buildImport(
  document: ImportDocument,
  options: BuildImportOptions = {},
): Promise<ImportResult> {
  const mat = new ImportMaterializer(document.source);
  const report = options.onProgress;

  // Install referenced fonts up front (best-effort; needs the catalog loaded).
  if (document.fonts && document.fonts.length > 0) {
    await useFontsStore.getState().loadGoogleFontsCatalog();
    await Promise.all(document.fonts.map((f) => mat.installFont(f.family)));
  }

  const totalNodes = countNodes(document.roots);
  let nodeDone = 0;
  const converter = new ImportConverter(mat, () => {
    nodeDone += 1;
    report?.({ phase: 'layers', done: nodeDone, total: totalNodes });
  });

  // Phase 1 — styles: bulk-create every style in one round-trip (the slow step
  // on serverless), priming the cache so conversion needs no per-style request.
  const styleRefs = converter.collectStyleRefs(document.roots);
  report?.({ phase: 'styles', done: 0, total: 1 });
  await mat.prepareStyles(styleRefs);
  report?.({ phase: 'styles', done: 1, total: 1 });

  // Phase 2 — images: re-host every referenced image in parallel.
  const imageUrls = collectImageUrls(document.roots);
  if (imageUrls.length > 0) {
    let imageDone = 0;
    report?.({ phase: 'images', done: 0, total: imageUrls.length });
    await mat.prepareAssets(imageUrls, () => {
      imageDone += 1;
      report?.({ phase: 'images', done: imageDone, total: imageUrls.length });
    });
  }

  // Phase 3 — layers: build the tree. Styles/assets are cached, so this is now
  // CPU-bound and fast; the converter ticks per node for the indicator.
  report?.({ phase: 'layers', done: 0, total: totalNodes });
  let layers = await converter.convertNodes(document.roots);
  layers = await componentizeLayers(layers, mat);

  return {
    layers,
    summary: {
      layers: countLayers(layers),
      styles: mat.counts.styles,
      components: mat.counts.components,
      assets: mat.counts.assets,
      fonts: mat.counts.fonts,
      collections: countCollections(layers),
    },
  };
}

export type { ImportDocument, ImportSummary } from '@/lib/import/types';
export type { Layer } from '@/types';

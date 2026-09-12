/**
 * Import materializer.
 *
 * Owns the side-effecting, deduplicated creation of the persistent entities an
 * import needs: layer styles, components, assets and fonts. A single instance
 * lives for the duration of one paste so that a class/url/font referenced by
 * hundreds of nodes is only created once (promise-cached).
 *
 * Generalised from the Figma materializer so both importers can share it.
 */

import type { Asset, Component, ComponentVariable, Font, Layer, LayerStyle } from '@/types';
import { useLayerStylesStore } from '@/stores/useLayerStylesStore';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { useAssetsStore } from '@/stores/useAssetsStore';
import { useFontsStore } from '@/stores/useFontsStore';
import { buildDesign } from '@/lib/import/design';
import type { ImportStyleRef } from '@/lib/import/types';

/**
 * Stable identity for "same style": name plus its declarations, order-agnostic
 * (the class set, not its written order, defines equality). Lets re-pasted
 * combos reuse a previously created style instead of duplicating it.
 */
function contentKey(name: string, classes: string): string {
  const sorted = classes.split(/\s+/).filter(Boolean).sort().join(' ');
  return `${name}\u0000${sorted}`;
}

/** Mutable counters surfaced in the post-import summary toast. */
export interface MaterializerCounts {
  styles: number;
  components: number;
  assets: number;
  fonts: number;
}

export class ImportMaterializer {
  readonly counts: MaterializerCounts = { styles: 0, components: 0, assets: 0, fonts: 0 };

  /** Source label (e.g. "Webflow") used to tag re-hosted assets. */
  private readonly group: string;

  /** Dedupe caches keyed by a stable identity. */
  private readonly styleCache = new Map<string, Promise<LayerStyle | null>>();
  private readonly assetCache = new Map<string, Promise<string | null>>();
  private readonly fontCache = new Map<string, Promise<Font | null>>();

  /** Names already taken (existing styles + ones created this run). */
  private readonly usedStyleNames: Set<string>;

  /** Existing styles keyed by `name\u0000<sorted classes>` for cross-paste reuse. */
  private readonly stylesByContent = new Map<string, LayerStyle>();

  constructor(group: string) {
    this.group = group;
    const existing = useLayerStylesStore.getState().styles ?? [];
    this.usedStyleNames = new Set(existing.map((s) => s.name));
    for (const style of existing) {
      this.stylesByContent.set(contentKey(style.name, style.classes), style);
    }
  }

  /**
   * Create (or reuse) a `LayerStyle` for a reusable class reference.
   *
   * Reuse is two-tiered: by the ref's stable key within one paste, and by
   * name + content across pastes/existing styles — so re-pasting a `Button`
   * combo links to the same style instead of spawning `Button 2`, `Button 3`.
   */
  getOrCreateStyle(ref: ImportStyleRef): Promise<LayerStyle | null> {
    const cached = this.styleCache.get(ref.key);
    if (cached) return cached;

    const promise = (async () => {
      const classes = ref.classes.join(' ').trim();
      if (!classes) return null;

      const name = ref.name || 'Imported';

      // Reuse an existing style with the same name and identical declarations.
      const key = contentKey(name, classes);
      const existing = this.stylesByContent.get(key);
      if (existing) return existing;

      const design = buildDesign(classes);
      // Leave imported styles ungrouped so they always surface in the layer
      // style picker (grouped styles only show when that group is selected).
      const style = await useLayerStylesStore.getState().createStyle(this.uniqueStyleName(name), classes, design);
      if (style) {
        this.counts.styles += 1;
        // Register under both the requested name and the (possibly suffixed)
        // created name so later refs in this run can still reuse it.
        this.stylesByContent.set(key, style);
        this.stylesByContent.set(contentKey(style.name, style.classes), style);
      }
      return style;
    })();

    this.styleCache.set(ref.key, promise);
    return promise;
  }

  /**
   * Pre-create every new style a paste needs in ONE bulk request, priming the
   * per-key cache so the subsequent conversion resolves styles from memory with
   * no further network calls. This collapses the dominant paste cost on
   * serverless — one POST per style — into a single round-trip.
   *
   * Dedup mirrors {@link getOrCreateStyle} exactly: by the ref's stable key,
   * then by name + content (reusing existing styles and collapsing duplicate
   * content within the batch), so the bulk path produces an identical style set
   * to the per-node path.
   */
  async prepareStyles(refs: ImportStyleRef[]): Promise<void> {
    // Styles to actually create, deduped by content; `contentToIndex` maps a
    // content key to its slot in `toCreate`, `keyToContent` maps every ref key
    // that should resolve to that new style.
    const toCreate: { name: string; classes: string; design: Layer['design'] }[] = [];
    const contentToIndex = new Map<string, number>();
    const keyToContent = new Map<string, string>();
    const keyToExisting = new Map<string, LayerStyle>();

    for (const ref of refs) {
      if (this.styleCache.has(ref.key)) continue;

      const classes = ref.classes.join(' ').trim();
      if (!classes) continue; // declaration-less: handled inline by the converter

      const name = ref.name || 'Imported';
      const cKey = contentKey(name, classes);

      // Reuse a style that already exists (from a prior paste or this app).
      const existing = this.stylesByContent.get(cKey);
      if (existing) {
        keyToExisting.set(ref.key, existing);
        continue;
      }

      // Collapse duplicate content within this batch onto one creation.
      if (contentToIndex.has(cKey)) {
        keyToContent.set(ref.key, cKey);
        continue;
      }

      const index = toCreate.length;
      toCreate.push({ name: this.uniqueStyleName(name), classes, design: buildDesign(classes) });
      contentToIndex.set(cKey, index);
      keyToContent.set(ref.key, cKey);
    }

    // Prime the cache for reused existing styles (no network needed).
    for (const [key, style] of keyToExisting) {
      this.styleCache.set(key, Promise.resolve(style));
    }

    if (toCreate.length === 0) return;

    const created = await useLayerStylesStore.getState().createStyles(toCreate);

    // Register each created style under its created identity for cross-paste
    // reuse, and bump the styles counter.
    created.forEach((style) => {
      if (!style) return;
      this.counts.styles += 1;
      this.stylesByContent.set(contentKey(style.name, style.classes), style);
    });

    // Wire every ref key to its created style, and register the requested-name
    // content key so a later ref with the same name+content reuses it too.
    for (const [key, cKey] of keyToContent) {
      const index = contentToIndex.get(cKey);
      if (index === undefined) continue;
      const style = created[index];
      if (!style) continue;
      this.styleCache.set(key, Promise.resolve(style));
      this.stylesByContent.set(cKey, style);
    }
  }

  /**
   * Re-host every referenced image in parallel, priming the asset cache so the
   * conversion's `uploadAsset` calls resolve instantly. `onUploaded` fires once
   * per finished image to drive a "k of N" progress indicator.
   */
  async prepareAssets(urls: string[], onUploaded?: () => void): Promise<void> {
    await Promise.all(
      urls.map(async (url) => {
        await this.uploadAsset(url);
        onUploaded?.();
      }),
    );
  }

  /** Re-host a remote image and return its Ycode asset id (null on failure). */
  uploadAsset(url: string): Promise<string | null> {
    const cached = this.assetCache.get(url);
    if (cached) return cached;

    const promise = (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const blob = await response.blob();
        const filename = decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'image');
        const file = new File([blob], filename, { type: blob.type || 'image/png' });

        const formData = new FormData();
        formData.append('file', file);
        formData.append('source', `${this.group.toLowerCase()}-import`);

        const uploadResponse = await fetch('/ycode/api/files/upload', {
          method: 'POST',
          body: formData,
        });
        if (!uploadResponse.ok) return null;

        const data = await uploadResponse.json();
        const asset: Asset | undefined = data?.data;
        if (!asset?.id) return null;

        useAssetsStore.getState().addAsset(asset);
        this.counts.assets += 1;
        return asset.id;
      } catch {
        // CORS or network failure — caller falls back to the remote URL.
        return null;
      }
    })();

    this.assetCache.set(url, promise);
    return promise;
  }

  /** Install a Google Font matching `family` (no-op if unavailable/installed). */
  installFont(family: string): Promise<Font | null> {
    const key = family.toLowerCase();
    const cached = this.fontCache.get(key);
    if (cached) return cached;

    const promise = (async () => {
      const fonts = useFontsStore.getState();
      const existing = fonts.getFontByFamily(family);
      if (existing) return existing;

      const match = fonts.googleFontsCatalog.find((f) => f.family.toLowerCase() === key);
      if (!match) return null;

      const installed = await fonts.addGoogleFont(match);
      if (installed) this.counts.fonts += 1;
      return installed;
    })();

    this.fontCache.set(key, promise);
    return promise;
  }

  /**
   * Create a reusable component (optionally with variables) and register it in
   * the components store so it resolves immediately on the canvas.
   */
  async createComponent(
    name: string,
    layers: Layer[],
    variables?: ComponentVariable[],
  ): Promise<Component | null> {
    try {
      const response = await fetch('/ycode/api/components', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, layers, variables }),
      });
      const result = await response.json();
      if (result.error || !result.data) return null;

      const component: Component = result.data;
      useComponentsStore.setState((state) => ({ components: [component, ...state.components] }));
      this.counts.components += 1;
      return component;
    } catch {
      return null;
    }
  }

  private uniqueStyleName(base: string): string {
    let name = base.trim() || 'Imported';
    if (!this.usedStyleNames.has(name)) {
      this.usedStyleNames.add(name);
      return name;
    }
    let i = 2;
    while (this.usedStyleNames.has(`${base} ${i}`)) i += 1;
    name = `${base} ${i}`;
    this.usedStyleNames.add(name);
    return name;
  }
}

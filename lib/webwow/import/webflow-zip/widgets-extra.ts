/**
 * Webflow widgets WITHOUT a one-to-one counterpart in `widgets-native.ts`
 * (SPEC part C): embedded video, Lottie, code blocks, file uploads, maps, the
 * site search form, the locale list, list pagination, conditional visibility,
 * the background-video play/pause button, the `webflow-icons` glyph font, the
 * Users / Ecommerce widgets and the "Made in Webflow" badge.
 *
 * Same split as widgets-native.ts: this module holds the Webflow-side
 * KNOWLEDGE (which attribute means what, how an embedly URL wraps a YouTube
 * id, which glyph a `w-icon-*` class draws) and the ycode-side TARGETS (the
 * exact layer shapes the element library / the public renderer expect).
 * `html.ts` calls the planners while building the IR; `convert-bridge.ts`
 * calls the builders after upstream's converter has run; `binding.ts` calls
 * {@link planConditionalVisibility} once the collection of an item is known.
 *
 * Two constant, importer-owned runtime lines live here and nowhere else:
 * {@link LOTTIE_PLAYER_SCRIPT} and {@link BG_VIDEO_TOGGLE_SCRIPT}. Neither is
 * taken from the export — the export's own scripts are never shipped (v2 rule).
 */

import { DEFAULT_MAP_SETTINGS } from '@/lib/map-utils';
import { paginationVariableNode } from '@/lib/pagination-text-utils';
import { generateId } from '@/lib/utils';

import type { WfCollectionInfo } from './cms';
import type { WfNode, WfVisibilityPlan } from './types';
import type { Warnings } from './warnings';

import type { Layer, MapSettings } from '@/types';

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Webflow writes `1` / `0` (older exports `true` / `false`). */
function boolAttr(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false' || v === '') return false;
  return fallback;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** `padding-top: 56.25%` / `width=940 height=528` -> Tailwind `aspect-[w/h]` token. */
export function aspectClass(input: { style?: string; width?: string; height?: string }): string {
  const pct = /padding-(?:top|bottom)\s*:\s*([\d.]+)%/i.exec(input.style ?? '');
  if (pct) {
    const value = Number.parseFloat(pct[1]);
    if (Number.isFinite(value) && value > 0) {
      if (Math.abs(value - 56.25) < 0.5) return 'aspect-[16/9]';
      if (Math.abs(value - 75) < 0.5) return 'aspect-[4/3]';
      return `aspect-[100/${Number(value.toFixed(2))}]`;
    }
  }
  const w = Number.parseInt(input.width ?? '', 10);
  const h = Number.parseInt(input.height ?? '', 10);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    if (Math.abs(w / h - 16 / 9) < 0.01) return 'aspect-[16/9]';
    const g = gcd(w, h);
    return `aspect-[${w / g}/${h / g}]`;
  }
  return 'aspect-[16/9]';
}

// ─── Video (YouTube / Vimeo) ──────────────────────────────────────────────────

export interface EmbedVideoPlan {
  provider: 'youtube' | 'vimeo' | 'other';
  videoId?: string;
  /** Normalised embed URL (used by the `iframe` target). */
  url: string;
  autoplay: boolean;
  muted: boolean;
  loop: boolean;
  controls: boolean;
  /** Start offset in seconds (YouTube `start=`, Vimeo `#t=`). */
  start?: number;
  /** `aspect-[w/h]` token for the layer. */
  aspect: string;
  title?: string;
  /**
   * `video` when ycode's `VideoVariable` can express it (a YouTube id without a
   * start offset), `iframe` for everything else (Vimeo, `start=`, other players).
   */
  target: 'video' | 'iframe';
}

const EMBEDLY_RE = /cdn\.embedly\.com\/widgets\/media\.html/i;
const YOUTUBE_HOST_RE = /(^|\.)youtube(-nocookie)?\.com$/i;
const VIMEO_HOST_RE = /(^|\.)vimeo\.com$/i;
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{6,}$/;

/** Query parameters that only make sense for the oEmbed wrapper Webflow used. */
const DROPPED_PARAMS = new Set(['feature', 'app_id', 'dntp', 'display_name', 'schema', 'image', 'type', 'url', 'src']);

function toUrl(raw: string): URL | null {
  const src = raw.trim();
  if (!src) return null;
  const abs = src.startsWith('//') ? `https:${src}` : /^https?:\/\//i.test(src) ? src : `https://${src}`;
  try {
    return new URL(abs);
  } catch {
    return null;
  }
}

/**
 * Plan a `.w-video` / `.w-embed-youtubevideo` widget from its `<iframe src>`.
 *
 * Webflow's "Video" element wraps the player in embedly
 * (`//cdn.embedly.com/widgets/media.html?src=<encoded player url>&…`); the
 * "YouTube" element embeds `https://www.youtube.com/embed/<id>?…` directly.
 * Returns null when the src is not a URL at all.
 */
export function planEmbedVideo(input: { src: string; style?: string; width?: string; height?: string; title?: string }): EmbedVideoPlan | null {
  let url = toUrl(input.src);
  if (!url) return null;
  if (EMBEDLY_RE.test(url.href)) {
    const inner = url.searchParams.get('src');
    const innerUrl = inner ? toUrl(inner) : null;
    if (innerUrl) url = innerUrl;
  }

  const params = url.searchParams;
  const flag = (name: string, fallback: boolean) => (params.has(name) ? boolAttr(params.get(name) ?? '', fallback) : fallback);
  const plan: EmbedVideoPlan = {
    provider: 'other',
    url: url.href,
    autoplay: flag('autoplay', false),
    muted: flag('mute', false) || flag('muted', false),
    loop: flag('loop', false),
    controls: flag('controls', true),
    aspect: aspectClass(input),
    target: 'iframe',
  };
  if (input.title?.trim()) plan.title = input.title.trim();

  const startRaw = params.get('start') ?? params.get('t');
  const start = startRaw ? Number.parseInt(startRaw, 10) : NaN;
  if (Number.isFinite(start) && start > 0) plan.start = start;

  if (YOUTUBE_HOST_RE.test(url.hostname) || /^youtu\.be$/i.test(url.hostname)) {
    const id = /^youtu\.be$/i.test(url.hostname)
      ? url.pathname.replace(/^\/+/, '').split('/')[0]
      : /\/embed\/([^/?#]+)/.exec(url.pathname)?.[1] ?? params.get('v') ?? '';
    if (YOUTUBE_ID_RE.test(id)) {
      plan.provider = 'youtube';
      plan.videoId = id;
      const kept = new URLSearchParams();
      for (const [key, value] of params) {
        if (DROPPED_PARAMS.has(key) || key === 'v') continue;
        kept.set(key, value);
      }
      if (plan.loop && !kept.has('playlist')) kept.set('playlist', id);
      const query = kept.toString();
      plan.url = `https://www.youtube.com/embed/${id}${query ? `?${query}` : ''}`;
      plan.target = plan.start ? 'iframe' : 'video';
    }
  } else if (VIMEO_HOST_RE.test(url.hostname)) {
    const id = /\/(?:video\/)?(\d+)/.exec(url.pathname)?.[1];
    if (id) {
      plan.provider = 'vimeo';
      plan.videoId = id;
      const kept = new URLSearchParams();
      for (const [key, value] of params) {
        if (DROPPED_PARAMS.has(key)) continue;
        kept.set(key, value);
      }
      const query = kept.toString();
      plan.url = `https://player.vimeo.com/video/${id}${query ? `?${query}` : ''}${plan.start ? `#t=${plan.start}s` : ''}`;
    }
  }
  return plan;
}

/** Layer fields for an embed-video plan (applied on top of the converted wrapper layer). */
export function applyEmbedVideo(layer: Layer, plan: EmbedVideoPlan): void {
  if (plan.target === 'video' && plan.provider === 'youtube' && plan.videoId) {
    layer.name = 'video';
    layer.attributes = {
      ...layer.attributes,
      controls: plan.controls,
      autoplay: plan.autoplay,
      muted: plan.muted,
      loop: plan.loop,
      youtubePrivacyMode: false,
    };
    layer.variables = {
      ...layer.variables,
      video: { src: { type: 'video', data: { provider: 'youtube', video_id: plan.videoId } } },
    };
    delete layer.children;
    return;
  }
  layer.name = 'iframe';
  layer.attributes = {
    ...layer.attributes,
    title: plan.title ?? (plan.provider === 'vimeo' ? 'Vimeo video' : plan.provider === 'youtube' ? 'YouTube video' : 'Embedded video'),
    loading: 'lazy',
    frameBorder: '0',
    allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen',
    allowFullScreen: true,
  };
  layer.variables = { ...layer.variables, iframe: { src: { type: 'dynamic_text', data: { content: plan.url } } } };
  delete layer.children;
}

/** One-off classes an embed-video layer needs (its Webflow wrapper used the padding-bottom trick). */
export function embedVideoClasses(plan: EmbedVideoPlan): string[] {
  return ['relative', 'block', 'w-full', 'h-auto', plan.aspect, 'overflow-hidden'];
}

// ─── Lottie ───────────────────────────────────────────────────────────────────

/**
 * The player element. Constant and importer-owned: ycode renders an
 * `htmlEmbed` inside an isolated iframe (`LayerRendererPublic`), so the
 * `<script>` has to travel WITH the markup — a page-level head script would
 * never reach the embed's document. The browser fetches the file once.
 */
export const LOTTIE_PLAYER_SCRIPT = '<script src="https://unpkg.com/@lottiefiles/lottie-player@latest/dist/lottie-player.js"></script>';

export interface LottiePlan {
  /** Asset key (ZIP path) or remote URL of the animation JSON. */
  src: string;
  loop: boolean;
  autoplay: boolean;
  /** `data-direction="-1"` plays backwards. */
  reverse: boolean;
  /** `data-is-ix2-target="1"`: an interaction drives the playhead (not reproducible). */
  ix2: boolean;
  /** CSS size of the `<lottie-player>` (from the element's own class), e.g. `200px`. */
  width?: string;
  height?: string;
}

const SIZE_CLASS_RE = /^(w|h)-\[(\d+(?:\.\d+)?(?:px|rem|em|vw|vh))\]$/;

/** Read `w-[200px]` / `h-[200px]` from a class list (the element's translated site class). */
export function sizeFromClasses(classes: string[]): { width?: string; height?: string } {
  const out: { width?: string; height?: string } = {};
  for (const cls of classes) {
    const m = SIZE_CLASS_RE.exec(cls);
    if (!m) continue;
    if (m[1] === 'w') out.width = m[2];
    else out.height = m[2];
  }
  return out;
}

export function planLottie(attrs: Record<string, string>, src: string, size: { width?: string; height?: string }): LottiePlan {
  const plan: LottiePlan = {
    src,
    loop: boolAttr(attrs['data-loop'], false),
    autoplay: boolAttr(attrs['data-autoplay'], false),
    reverse: (attrs['data-direction'] ?? '1').trim() === '-1',
    ix2: boolAttr(attrs['data-is-ix2-target'], false),
  };
  if (size.width) plan.width = size.width;
  if (size.height) plan.height = size.height;
  return plan;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The embed code: player script + `<lottie-player>`. `url` is the public URL of the JSON. */
export function lottieEmbedCode(plan: LottiePlan, url: string): string {
  // The embed iframe grows to its body's height, so the player needs an explicit
  // height or it collapses to 0px.
  const height = plan.height ?? plan.width ?? '300px';
  const style = `width:${plan.width ?? '100%'};height:${height}`;
  const flags = [plan.loop ? ' loop' : '', plan.autoplay ? ' autoplay' : '', plan.reverse ? ' direction="-1"' : ''].join('');
  return `${LOTTIE_PLAYER_SCRIPT}\n<lottie-player src="${escapeAttr(url)}" background="transparent" speed="1" style="${style}"${flags}></lottie-player>`;
}

// ─── Code block ───────────────────────────────────────────────────────────────

export interface CodeBlockPlan {
  /** Verbatim code (entities decoded, highlight spans removed, whitespace intact). */
  code: string;
  language?: string;
}

/** `language-javascript` -> `javascript`. */
export function languageFromClasses(classes: string[]): string | undefined {
  for (const cls of classes) {
    const m = /^(?:language|lang)-([\w#+-]+)$/i.exec(cls);
    if (m) return m[1].toLowerCase();
  }
  return undefined;
}

const SPACING_SIDES = ['t', 'r', 'b', 'l'] as const;

function spacingClasses(prefix: 'm' | 'p', value: string): string[] {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 4) return [];
  const [top, right = top, bottom = top, left = right] = parts;
  const values = [top, right, bottom, left];
  const token = (v: string) => (v === '0' || v === '0px' ? '0' : `[${v}]`);
  if (values.every((v) => v === values[0])) return [`${prefix}-${token(values[0])}`];
  return SPACING_SIDES.map((side, i) => `${prefix}${side}-${token(values[i])}`);
}

/**
 * Translate the handful of inline-style properties Webflow writes on a code
 * block wrapper (`margin`, `padding`, `background-color`, `border-radius`, …)
 * into Tailwind utilities. Anything else is ignored — the wrapper's site
 * classes still arrive through the style model like on any other element.
 */
export function inlineStyleClasses(style: string | undefined): string[] {
  if (!style) return [];
  const out: string[] = [];
  for (const decl of style.split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim().replace(/\s+/g, ' ');
    if (!value || value === 'none' || value === 'unset' || value === 'inherit') continue;
    const token = value.replace(/ /g, '_');
    switch (prop) {
      case 'margin':
        out.push(...spacingClasses('m', value));
        break;
      case 'padding':
        out.push(...spacingClasses('p', value));
        break;
      case 'background-color':
      case 'background':
        if (/^(#|rgb|hsl|[a-z]+$)/i.test(value)) out.push(`bg-[${token}]`);
        break;
      case 'border-radius':
        out.push(`rounded-[${token}]`);
        break;
      case 'color':
        out.push(`text-[${token}]`);
        break;
      case 'font-size':
        out.push(`text-[${token}]`);
        break;
      case 'font-family':
        out.push(/mono|courier|consolas|menlo/i.test(value) ? 'font-mono' : `font-[${token}]`);
        break;
      case 'white-space':
        if (value === 'pre-wrap') out.push('whitespace-pre-wrap');
        else if (value === 'pre') out.push('whitespace-pre');
        else if (value === 'nowrap') out.push('whitespace-nowrap');
        break;
      case 'width':
        out.push(`w-[${token}]`);
        break;
      case 'max-width':
        out.push(`max-w-[${token}]`);
        break;
      case 'height':
        out.push(`h-[${token}]`);
        break;
      default:
        break;
    }
  }
  return out;
}

/** The `<code>` child layer of a code block (`<pre>` is the converted wrapper itself). */
export function codeChildLayer(plan: CodeBlockPlan): Layer {
  const layer: Layer = {
    id: generateId('lyr'),
    name: 'text',
    customName: 'Code',
    classes: 'font-mono',
    settings: { tag: 'code', ...(plan.language ? { customAttributes: { 'data-language': plan.language } } : {}) },
    restrictions: { editText: true },
    variables: { text: { type: 'dynamic_text', data: { content: plan.code } } },
  } as Layer;
  return layer;
}

/** Classes the `<pre>` wrapper needs so the browser keeps the whitespace exactly. */
export const CODE_BLOCK_CLASSES = ['block', 'whitespace-pre-wrap', 'font-mono', 'overflow-x-auto'];

// ─── File upload ──────────────────────────────────────────────────────────────

/** Plain-language reason every imported file input is reported as partial. */
export const FILE_UPLOAD_NOTE = 'Datei-Uploads werden nicht gespeichert: ycode sendet Formulare als JSON an /ycode/api/form-submissions, eine Datei kommt dort als leeres Objekt an. Das Feld bleibt im Formular, die Datei erreicht den Server nicht.';

/** Webflow's upload state boxes that need `webflow.js` and are dropped. */
export const FILE_UPLOAD_STATE_CLASSES = new Set(['w-file-upload-uploading', 'w-file-upload-success', 'w-file-upload-error']);

// ─── Map ──────────────────────────────────────────────────────────────────────

export interface MapPlan {
  settings: MapSettings;
  /** Webflow settings that had to be approximated (reported as `widget_partial`). */
  notes: string[];
}

/**
 * `.w-widget-map`'s `data-widget-*` -> `MapSettings` (Google Maps embed, the
 * provider Webflow itself uses). The embed needs a Google Maps Embed API key in
 * the site settings; without it ycode renders the wrapper with a hint.
 */
export function planMap(attrs: Record<string, string>): MapPlan {
  const notes: string[] = [];
  const [latRaw, lngRaw] = (attrs['data-widget-latlng'] ?? '').split(',');
  const lat = Number.parseFloat(latRaw ?? '');
  const lng = Number.parseFloat(lngRaw ?? '');
  const zoom = Number.parseInt(attrs['data-widget-zoom'] ?? '', 10);
  const style = (attrs['data-widget-style'] ?? 'roadmap').trim().toLowerCase();
  let googleStyle: 'roadmap' | 'satellite' = 'roadmap';
  if (style === 'satellite' || style === 'hybrid') googleStyle = 'satellite';
  if (style === 'hybrid' || style === 'terrain') notes.push(`data-widget-style="${style}" has no ycode equivalent; using ${googleStyle}`);
  const tooltip = (attrs['data-widget-tooltip'] ?? '').trim();
  if (tooltip) notes.push('marker tooltip kept as the map\'s search text; ycode\'s Google embed shows a plain pin');

  const settings: MapSettings = {
    ...DEFAULT_MAP_SETTINGS,
    provider: 'google',
    latitude: Number.isFinite(lat) ? lat : DEFAULT_MAP_SETTINGS.latitude,
    longitude: Number.isFinite(lng) ? lng : DEFAULT_MAP_SETTINGS.longitude,
    zoom: Number.isFinite(zoom) ? zoom : DEFAULT_MAP_SETTINGS.zoom,
    search: tooltip || (Number.isFinite(lat) && Number.isFinite(lng) ? `${lat},${lng}` : DEFAULT_MAP_SETTINGS.search),
    mapbox: { ...DEFAULT_MAP_SETTINGS.mapbox },
    google: {
      ...DEFAULT_MAP_SETTINGS.google,
      style: googleStyle,
      scrollZoom: boolAttr(attrs['data-enable-scroll'], true),
      interactive: boolAttr(attrs['data-enable-touch'], true),
    },
  };
  return { settings, notes };
}

export const MAP_KEY_NOTE = 'Karte braucht einen Google-Maps-Embed-API-Key (Einstellungen -> Apps); bis dahin zeigt die veröffentlichte Seite nur den Rahmen';

// ─── Search form ──────────────────────────────────────────────────────────────

export function isSearchForm(attrs: Record<string, string>): boolean {
  return /^\/?search\/?$/i.test((attrs.action ?? '').trim());
}

export const SEARCH_NOTE = 'Seitensuche gibt es in ycode nicht: das Suchformular bleibt ein normales Formular und sendet an die Formular-Eingänge';

// ─── Locales ──────────────────────────────────────────────────────────────────

/** Chevron of ycode's own `localeSelector` template (lib/templates/utilities.ts). */
export const LOCALE_CHEVRON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.168l3.71-3.938a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" clip-rule="evenodd"></path></svg>';

export interface LocalesPlan {
  /** Label of the current locale (`w--current` link), e.g. `Deutsch`. */
  current: string;
  /** `hreflang` codes in document order. */
  codes: string[];
}

export const LOCALES_NOTE = 'Sprachliste wird zu ycodes Sprachauswahl; die Auswahl ist erst aktiv, wenn unter Einstellungen -> Sprachen die Sprachen angelegt sind';

/** The two children ycode's `localeSelector` template carries: the label and the chevron. */
export function localeSelectorChildren(label: string): Layer[] {
  return [
    {
      id: generateId('lyr'),
      name: 'text',
      key: 'localeSelectorLabel',
      customName: 'Locale',
      classes: '',
      settings: { tag: 'span' },
      restrictions: { copy: false, delete: false, editText: false, ancestor: 'localeSelector' },
      variables: { text: { type: 'dynamic_text', data: { content: label || 'English' } } },
    } as Layer,
    {
      id: generateId('lyr'),
      name: 'icon',
      customName: 'Icon',
      classes: 'w-[18px] h-[18px]',
      design: { sizing: { isActive: true, width: '18px', height: '18px' } } as Layer['design'],
      variables: { icon: { src: { type: 'static_text', data: { content: LOCALE_CHEVRON_SVG } } } },
    } as Layer,
  ];
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginationInfoParts {
  before: string;
  between: string;
  after: string;
}

/** `Seite 2 von 3` -> `{ before: 'Seite ', between: ' von ', after: '' }` (null when there are not two numbers). */
export function parsePaginationInfo(text: string): PaginationInfoParts | null {
  const m = /^([\s\S]*?)\d+([\s\S]*?)\d+([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  return { before: m[1], between: m[2], after: m[3] };
}

/** TipTap doc with `pagination` chips, keeping the export's own wording around the numbers. */
export function paginationInfoDoc(text: string): object {
  const parts = parsePaginationInfo(text) ?? { before: 'Page ', between: ' of ', after: '' };
  const content: unknown[] = [];
  if (parts.before) content.push({ type: 'text', text: parts.before });
  content.push(paginationVariableNode('current'));
  if (parts.between) content.push({ type: 'text', text: parts.between });
  content.push(paginationVariableNode('pages'));
  if (parts.after) content.push({ type: 'text', text: parts.after });
  return { type: 'doc', content: [{ type: 'paragraph', content }] };
}

/** The ids ycode's SSR pass keys on (`page-fetcher.ts` `updatePaginationLayerWithMeta`). */
export function paginationIds(collectionLayerId: string): { wrapper: string; prev: string; next: string; info: string } {
  return {
    wrapper: `${collectionLayerId}-pagination-wrapper`,
    prev: `${collectionLayerId}-pagination-prev`,
    next: `${collectionLayerId}-pagination-next`,
    info: `${collectionLayerId}-pagination-info`,
  };
}

// ─── Conditional visibility ───────────────────────────────────────────────────

function nodeText(node: WfNode): string {
  const parts: string[] = [];
  const walk = (n: WfNode) => {
    if (n.text) parts.push(n.text);
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);
  return parts.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function firstBinding(node: WfNode): WfNode['wf']['binding'] | undefined {
  const queue: WfNode[] = [node];
  while (queue.length > 0) {
    const n = queue.shift()!;
    const b = n.wf.binding;
    if (b && b.kind !== 'link' && b.fieldId && !b.fieldId.startsWith('__')) return b;
    queue.push(...(n.children ?? []));
  }
  return undefined;
}

function normaliseName(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Reconstruct the Designer's visibility rule for a `.w-condition-invisible`
 * element inside a bound item (or on a collection page). The export carries
 * only the class, never the rule, so two cases are recoverable:
 *
 *  1. the element (or a descendant) is bound to a field -> "field is present";
 *  2. a static element whose text or class names a switch field -> "field is
 *     true" (the classic "Featured" badge).
 *
 * On success the rule replaces the `hidden` fallback class; otherwise the
 * element stays hidden and the reason is reported.
 */
export function planConditionalVisibility(
  node: WfNode,
  collection: WfCollectionInfo,
  source: 'collection' | 'page',
  warn: Warnings,
  ctx: { page: string; label: string },
): WfVisibilityPlan | null {
  node.wf.visibilityChecked = true;
  let plan: WfVisibilityPlan | null = null;

  const bound = firstBinding(node);
  if (bound) {
    plan = { fieldId: bound.fieldId, fieldType: bound.fieldType, operator: 'is_present', source, reason: `bound to ${collection.name}.${bound.fieldName}: shown when the field is present` };
  } else {
    const text = nodeText(node);
    const names = [text, ...node.wf.siteClasses.map(normaliseName)].filter(Boolean);
    const switches = collection.fields.filter((f) => f.type === 'boolean');
    const hit = switches.find((f) => names.includes(normaliseName(f.name)));
    if (hit) {
      plan = { fieldId: hit.id, fieldType: 'boolean', operator: 'is', value: 'true', source, reason: `"${hit.name}" names the switch field ${collection.name}.${hit.name}: shown when it is on` };
    }
  }

  if (!plan) {
    warn.add('widget_partial', `${ctx.label}: condition-invisible element kept hidden (the Designer's rule is not in the export)`, { page: ctx.page, node: node.wf.id });
    return null;
  }
  node.wf.visibility = plan;
  if (node.classes) {
    const rest = node.classes.filter((c) => c !== 'hidden');
    if (rest.length > 0) node.classes = rest;
    else delete node.classes;
  }
  return plan;
}

// ─── Background-video control ─────────────────────────────────────────────────

/**
 * Constant, importer-owned runtime for the play/pause button (goes into the
 * page's `custom_code.body`, executed by `CustomCodeInjector` after hydration).
 * ASCII only, idempotent, no dependency on layer ids: the button finds the
 * nearest `<video>` by walking up the DOM, so it survives component and
 * collection cloning. Mirrors Webflow's own behaviour: toggles `w--paused`,
 * `data-paused`, the aria-label and shows the first child while playing, the
 * second while paused.
 */
export const BG_VIDEO_TOGGLE_SCRIPT =
  '<script data-webwow-import="video-toggle">(function(){if(window.__webwowVideoToggle)return;window.__webwowVideoToggle=true;'
  + 'function sync(b,v){var p=v.paused;b.setAttribute("data-paused",p?"true":"false");b.classList.toggle("w--paused",p);'
  + 'var l=b.getAttribute(p?"data-label-play":"data-label-pause");if(l)b.setAttribute("aria-label",l);'
  // Inline `display` as well as the class: an `inline-block` utility from the element's own
  // style would otherwise outrank a later `hidden` (both are display utilities in one layer).
  + 'var k=b.children;if(k.length>1){k[0].classList.toggle("hidden",p);k[0].style.display=p?"none":"";k[1].classList.toggle("hidden",!p);k[1].style.display=p?"":"none";}}'
  + 'function find(b){var e=b.parentElement;while(e){var v=e.querySelector("video");if(v)return v;e=e.parentElement;}return null;}'
  + 'document.addEventListener("click",function(ev){var t=ev.target;var b=t&&t.closest?t.closest("[data-webwow-video-toggle]"):null;if(!b)return;'
  + 'var v=find(b);if(!v)return;ev.preventDefault();if(v.paused){var r=v.play();if(r&&r.then){r.then(function(){sync(b,v)},function(){sync(b,v)});}}else{v.pause();}sync(b,v);});'
  + 'function init(){var bs=document.querySelectorAll("[data-webwow-video-toggle]");for(var i=0;i<bs.length;i++){(function(b){var v=find(b);if(!v||b.__webwowBound)return;b.__webwowBound=true;'
  + 'sync(b,v);v.addEventListener("play",function(){sync(b,v)});v.addEventListener("pause",function(){sync(b,v)});})(bs[i]);}}'
  + 'init();setTimeout(init,500);})();</script>';

export interface BgVideoControlPlan {
  /** Accessible names Webflow ships in the two hidden `<span>`s. */
  labelPause: string;
  labelPlay: string;
}

/** Custom attributes the button layer carries so the runtime line can find and label it. */
export function bgVideoControlAttributes(plan: BgVideoControlPlan): Record<string, string> {
  return {
    'data-webwow-video-toggle': '',
    'aria-label': plan.labelPause || 'Pause video',
    'data-label-pause': plan.labelPause || 'Pause video',
    'data-label-play': plan.labelPlay || 'Play video',
  };
}

// ─── Dropdown runtime (close on outside click / Escape, aria-expanded, touch) ─

/**
 * Constant, importer-owned runtime for dropdowns (`custom_code.body`, like
 * `BG_VIDEO_TOGGLE_SCRIPT`). ycode's interactions know `click` and `hover`
 * triggers only — nothing closes a click-opened dropdown when the visitor
 * clicks elsewhere or presses Escape, nothing maintains `aria-expanded`, and a
 * hover interaction is dead on a touch screen. webflow.js does all three, so
 * this line restores it on top of the generated interaction: the `.w-dropdown`
 * wrapper carries `data-webwow-dropdown="click"` or `"hover"` (widgets.ts), the
 * toggle inside it `aria-expanded`. A click on the toggle flips the attribute;
 * a click outside an open click-dropdown, or Escape, closes it by clicking its
 * toggle again, so the interaction's own toggle state (the runtime's yoyo
 * timeline) stays in step; a hover dropdown mirrors mouse enter / leave into
 * `aria-expanded`.
 *
 * Touch (webflow.js: `hover: data-hover && !touch`, with `touch =
 * 'ontouchstart' in window || DocumentTouch`, here also `(hover: none)`): a
 * hover dropdown behaves like a click dropdown. The tap opens it by sending
 * the wrapper the `mouseenter` its hover interaction listens for, a second
 * tap, a tap outside or Escape sends `mouseleave`; the browser's own
 * compatibility `mouseenter` / `mouseleave` pair after a tap (which opened
 * and closed the list within a frame) is stopped in the capture phase before
 * it reaches the wrapper. ASCII only, idempotent, no layer ids: it survives
 * component and collection cloning.
 */
export const DROPDOWN_RUNTIME_SCRIPT =
  '<script data-webwow-import="dropdown">(function(){if(window.__webwowDropdown)return;window.__webwowDropdown=true;'
  + 'var W="[data-webwow-dropdown]",H="[data-webwow-dropdown=\\"hover\\"]";'
  + 'var T="ontouchstart" in window||!!(window.DocumentTouch&&document instanceof window.DocumentTouch)||!!(window.matchMedia&&window.matchMedia("(hover: none)").matches);'
  + 'function tg(w){return w.querySelector("[aria-expanded]");}'
  + 'function hover(w){return w.getAttribute("data-webwow-dropdown")==="hover";}'
  + 'function tap(w){return !hover(w)||T;}'
  + 'function set(w,o){var t=tg(w);if(t)t.setAttribute("aria-expanded",o?"true":"false");}'
  + 'function isOpen(w){var t=tg(w);return !!t&&t.getAttribute("aria-expanded")==="true";}'
  + 'function mouse(w,n){w.dispatchEvent(new MouseEvent(n,{bubbles:false,cancelable:false}));}'
  + 'function open(w){if(hover(w))mouse(w,"mouseenter");set(w,true);}'
  + 'function close(w){if(hover(w)){mouse(w,"mouseleave");set(w,false);return;}var t=tg(w);if(!t)return;w.__webwowClosing=true;t.click();}'
  + 'function tappable(){var out=[],ws=document.querySelectorAll(W);for(var i=0;i<ws.length;i++)if(tap(ws[i]))out.push(ws[i]);return out;}'
  + 'document.addEventListener("click",function(ev){var x=ev.target;var w=x&&x.closest?x.closest(W):null;var t=w?tg(w):null;'
  + 'if(w&&t&&t.contains(x)&&tap(w)){var c=w.__webwowClosing;w.__webwowClosing=false;if(c){set(w,false);return;}if(hover(w)){if(isOpen(w))close(w);else open(w);}else set(w,!isOpen(w));}'
  + 'var all=tappable();for(var i=0;i<all.length;i++){var o=all[i];if(o!==w&&isOpen(o)&&!o.contains(x))close(o);}});'
  + 'document.addEventListener("keydown",function(ev){if(ev.key!=="Escape")return;var all=tappable();for(var i=0;i<all.length;i++)if(isOpen(all[i]))close(all[i]);});'
  + 'function hov(ev,o){if(T)return;var x=ev.target;var w=x&&x.closest?x.closest(W+H):null;if(!w)return;var r=ev.relatedTarget;if(r&&w.contains(r))return;set(w,o);}'
  + 'document.addEventListener("mouseover",function(ev){hov(ev,true)});document.addEventListener("mouseout",function(ev){hov(ev,false)});'
  + 'function block(ev){if(!T||!ev.isTrusted)return;var x=ev.target;if(x&&x.matches&&x.matches(W+H))ev.stopPropagation();}'
  + 'document.addEventListener("mouseenter",block,true);document.addEventListener("mouseleave",block,true);'
  + '})();</script>';

/** Attributes for the `.w-dropdown` wrapper and its toggle so the runtime line can find them. */
export function dropdownAttributes(hover: boolean): { wrapper: Record<string, string>; toggle: Record<string, string> } {
  return {
    wrapper: { 'data-webwow-dropdown': hover ? 'hover' : 'click' },
    toggle: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
  };
}

// ─── Icon font (`webflow-icons`) ──────────────────────────────────────────────

const STROKE = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}>${body}</svg>`;

/**
 * Glyph -> inline SVG. Codepoints from Webflow's `components.css`
 * (`\e600` slider-right, `\e601` slider-left, `\e602` nav-menu, `\e603`
 * arrow-down / dropdown-toggle, `\e900` file-upload-remove, `\e903`
 * file-upload-icon). The font itself is never shipped.
 */
export const ICON_FONT_SVGS: Record<string, string> = {
  'w-icon-slider-right': svg('<polyline points="9 6 15 12 9 18"/>'),
  'w-icon-slider-left': svg('<polyline points="15 6 9 12 15 18"/>'),
  'w-icon-nav-menu': svg('<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/>'),
  'w-icon-arrow-down': svg('<polyline points="6 9 12 15 18 9"/>'),
  'w-icon-dropdown-toggle': svg('<polyline points="6 9 12 15 18 9"/>'),
  'w-icon-file-upload-remove': svg('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>'),
  'w-icon-file-upload-icon': svg('<path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/><polyline points="7 9 12 4 17 9"/><line x1="12" y1="4" x2="12" y2="16"/>'),
};

/** The inline SVG for a `w-icon-*` glyph class, or null. */
export function iconFontSvg(classNames: string[]): { className: string; svg: string } | null {
  for (const cls of classNames) {
    const found = ICON_FONT_SVGS[cls];
    if (found) return { className: cls, svg: found };
  }
  return null;
}

// ─── Users / Ecommerce ────────────────────────────────────────────────────────

export type UnsupportedWidgetFamily = 'users' | 'commerce';

export function unsupportedWidgetFamily(classNames: string[]): UnsupportedWidgetFamily | null {
  for (const cls of classNames) {
    if (cls.startsWith('w-users-')) return 'users';
    if (cls.startsWith('w-commerce-')) return 'commerce';
  }
  return null;
}

export const UNSUPPORTED_WIDGET_NOTES: Record<UnsupportedWidgetFamily, string> = {
  users: 'Webflow Memberships (Login, Registrierung, Konto) gibt es in ycode nicht: die Formulare werden normale Formulare ohne Anmeldung',
  commerce: 'Webflow Ecommerce (Warenkorb, Kasse, Produkt-Optionen) gibt es in ycode nicht: die Formulare werden normale Formulare ohne Shop-Funktion',
};

/** True for a `w-users-*` / `w-commerce-*` class (known family, reported once per page instead of per class). */
export function isUnsupportedWidgetClass(name: string): boolean {
  return name.startsWith('w-users-') || name.startsWith('w-commerce-');
}

// ─── Navbar variants (components.ts) ──────────────────────────────────────────

/**
 * Human-readable variant name from the classes a variant root carries on top
 * of the default one (`navbar black` vs `navbar` -> `Black`).
 */
export function variantNameFromClasses(defaultClasses: string[] | undefined, variantClasses: string[] | undefined, fallbackIndex: number): string {
  const base = new Set(defaultClasses ?? []);
  const extra = (variantClasses ?? []).filter((c) => !base.has(c));
  if (extra.length === 0) return `Variant ${fallbackIndex}`;
  return extra.map((c) => c.replace(/[-_]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())).join(' ');
}

/** `layer.id` -> the Webflow site classes of its node (variant naming input for components.ts). */
export function siteClassIndex(pages: { nodeIndex: Map<string, WfNode> }[], layerByNode: Map<string, Layer>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const page of pages) {
    for (const node of page.nodeIndex.values()) {
      const layer = layerByNode.get(node.wf.id);
      if (layer && node.wf.siteClasses.length > 0) out.set(layer.id, node.wf.siteClasses);
    }
  }
  return out;
}

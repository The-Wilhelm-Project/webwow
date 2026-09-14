/**
 * Webflow widgets -> ycode NATIVE layers (SPEC D3, extension).
 *
 * `html.ts` already routes `.w-richtext`, `.w-dyn-*`, `.w-nav*`, `.w-dropdown*`,
 * `.w-layout-*`, `.w-embed` and `.w-background-video`. Everything else Webflow
 * ships as a widget — slider, tabs, lightbox, form, and the legacy
 * `.w-row`/`.w-col-N` grid — used to fall through to a generic box, which keeps
 * the pixels but loses the native integration: no carousel UI, no lightbox
 * gallery, no form submissions, no editable column widths.
 *
 * This module holds the Webflow-side KNOWLEDGE (which `data-*` attribute means
 * what, how the lightbox JSON payload is shaped, which control tags exist) and
 * the ycode-side TARGETS (the exact sub-layer trees ycode's element library
 * inserts). `html.ts` calls the detectors while building the IR;
 * `convert-bridge.ts` calls the builders after upstream's converter has run.
 *
 * Every widget sits behind a flag ({@link WfWidgetFlags}) so one builder can be
 * turned off without touching the others, and every widget that is recognised
 * but cannot be mapped in full raises a `widget_partial` warning instead of
 * degrading silently.
 *
 * The slider chrome below mirrors `lib/templates/utilities.ts` (the element
 * library's own `slider` template) layer for layer — `widgets-native.test.ts`
 * diffs the two so the copy cannot drift.
 */

import { generateId } from '@/lib/utils';
import { DEFAULT_LIGHTBOX_SETTINGS, DEFAULT_SLIDER_SETTINGS } from '@/lib/slider-constants';
import type { Layer, LightboxSettings, SliderSettings, SwiperAnimationEffect } from '@/types';

// ─── Flags ────────────────────────────────────────────────────────────────────

/**
 * Per-widget kill switches. A builder that regresses on someone's export can be
 * turned off without reverting the module: the widget then takes the pre-existing
 * generic-box path and reports `html_unmapped` exactly as before.
 */
export interface WfWidgetFlags {
  /** `.w-slider` -> `slider` / `slides` / `slide` + native navigation and pagination. */
  slider: boolean;
  /** `.w-tabs` -> DOM kept, tab switching rebuilt as generated click interactions. */
  tabs: boolean;
  /** `.w-lightbox` -> `lightbox` layer with `settings.lightbox`. */
  lightbox: boolean;
  /** `.w-form` + form control tags -> `form` / `input` / `textarea` / `select` / `option` / `button`. */
  form: boolean;
  /** `.w-row` / `.w-col-N` -> flex row with per-column width shims. */
  columns: boolean;
  /** Rich-text inline marks (bold / italic / underline / strike / code) via `richtext.ts`. */
  richText: boolean;
}

export const DEFAULT_WIDGET_FLAGS: WfWidgetFlags = {
  slider: true,
  tabs: true,
  lightbox: true,
  form: true,
  columns: true,
  richText: true,
};

export function resolveWidgetFlags(overrides?: Partial<WfWidgetFlags>): WfWidgetFlags {
  return { ...DEFAULT_WIDGET_FLAGS, ...overrides };
}

// ─── Slider ───────────────────────────────────────────────────────────────────

/** Webflow writes `1` / `0` (older exports write `true` / `false`). */
function boolAttr(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false' || v === '') return false;
  return fallback;
}

/** `data-duration="500"` (ms) -> `"0.5"` (seconds, ycode's unit). */
function msToSeconds(value: string | undefined, fallbackSeconds: string): string {
  const ms = Number.parseFloat(value ?? '');
  if (!Number.isFinite(ms) || ms < 0) return fallbackSeconds;
  return String(Math.round((ms / 1000) * 1000) / 1000);
}

/**
 * Webflow's `data-animation` values (`slide`, `cross`, `fade`, `over`, `outin`,
 * `random`) against ycode's `SwiperAnimationEffect`. Only `slide` and `fade`
 * exist on both sides; the rest are cross-fades of one kind or another and map
 * to `fade`, which is the closest thing Swiper offers.
 */
const ANIMATION_BY_WEBFLOW: Record<string, SwiperAnimationEffect> = {
  slide: 'slide',
  cross: 'fade',
  fade: 'fade',
  over: 'fade',
  outin: 'fade',
  random: 'fade',
};

/** Webflow eases that ycode's easing select also offers; anything else keeps ycode's default. */
const SLIDER_EASINGS = new Set(['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out']);

export interface SliderDetection {
  settings: SliderSettings;
  /** Webflow attributes that have no ycode equivalent (reported as `widget_partial`). */
  unmapped: string[];
}

/**
 * `.w-slider`'s `data-*` attributes -> `SliderSettings`.
 *
 * `data-infinite` must become `loop: 'loop'` — `SliderLoopMode` is
 * `'none' | 'loop' | 'rewind'` and `lib/slider-utils.ts` reacts to nothing else,
 * so any other spelling silently produces a slider that does not loop.
 *
 * @param hasNav Whether the widget ships a `.w-slider-nav` (its bullet strip).
 */
export function sliderSettingsFromAttrs(attrs: Record<string, string>, hasNav: boolean): SliderDetection {
  const unmapped: string[] = [];
  const animation = (attrs['data-animation'] ?? '').trim().toLowerCase();
  if (animation && !ANIMATION_BY_WEBFLOW[animation]) unmapped.push(`data-animation="${animation}"`);
  const easing = (attrs['data-easing'] ?? '').trim().toLowerCase();
  if (easing && !SLIDER_EASINGS.has(easing)) unmapped.push(`data-easing="${easing}"`);
  if (attrs['data-autoplay-limit'] && attrs['data-autoplay-limit'] !== '0') unmapped.push(`data-autoplay-limit="${attrs['data-autoplay-limit']}"`);
  if (attrs['data-nav-spacing']) unmapped.push(`data-nav-spacing="${attrs['data-nav-spacing']}"`);

  const settings: SliderSettings = {
    ...DEFAULT_SLIDER_SETTINGS,
    navigation: !boolAttr(attrs['data-hide-arrows']),
    loop: boolAttr(attrs['data-infinite']) ? 'loop' : 'none',
    touchEvents: !boolAttr(attrs['data-disable-swipe']),
    pagination: hasNav,
    autoplay: boolAttr(attrs['data-autoplay']),
    delay: msToSeconds(attrs['data-delay'], DEFAULT_SLIDER_SETTINGS.delay),
    duration: msToSeconds(attrs['data-duration'], DEFAULT_SLIDER_SETTINGS.duration),
    animationEffect: ANIMATION_BY_WEBFLOW[animation] ?? DEFAULT_SLIDER_SETTINGS.animationEffect,
    easing: SLIDER_EASINGS.has(easing) ? easing : DEFAULT_SLIDER_SETTINGS.easing,
  };
  return { settings, unmapped };
}

/** Webflow slider chrome that ycode regenerates natively and html.ts therefore drops. */
export const SLIDER_CHROME_CLASSES = new Set([
  'w-slider-arrow-left', 'w-slider-arrow-right', 'w-slider-nav', 'w-slider-aria-label',
]);

const CHEVRON_LEFT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z" clip-rule="evenodd"></path></svg>';
const CHEVRON_RIGHT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd"></path></svg>';

/** `restrictions` every slider sub-layer carries (`lib/templates/utilities.ts`). */
const CHROME_RESTRICTIONS = { copy: false, delete: false, ancestor: 'slider' } as const;

function layer(name: string, customName: string, classes: string[], design: Layer['design'], extra?: Partial<Layer>): Layer {
  return {
    id: generateId('lyr'),
    name,
    customName,
    classes: classes.join(' '),
    design,
    ...extra,
  } as Layer;
}

/**
 * The navigation (prev / next) and pagination (bullets / fraction) sub-trees
 * ycode's slider needs.
 *
 * In ycode the arrows and bullets ARE layers: `filterDisabledSliderLayers`
 * (`lib/layer-utils.ts`) only *removes* them when `settings.slider.navigation` /
 * `.pagination` are off, and the public renderer tags them through
 * `SWIPER_DATA_ATTR_MAP` so Swiper can find them. A slider imported without
 * these children therefore has no controls at all, whatever its settings say.
 */
export function sliderChromeLayers(): Layer[] {
  const iconLayer = (svg: string): Layer => layer('icon', 'Icon', ['w-[24px]', 'h-[24px]', 'text-white'], {
    sizing: { isActive: true, width: '24px', height: '24px' },
  } as Layer['design'], {
    settings: { tag: 'div' },
    variables: { icon: { src: { type: 'static_text', data: { content: svg } } } },
  } as Partial<Layer>);

  const arrow = (side: 'Prev' | 'Next'): Layer => {
    const isPrev = side === 'Prev';
    return layer(
      isPrev ? 'slideButtonPrev' : 'slideButtonNext',
      isPrev ? 'Previous' : 'Next',
      ['absolute', 'top-0', 'bottom-0', isPrev ? 'left-0' : 'right-0', 'z-[100]', 'flex', 'items-center', 'justify-center', 'disabled:opacity-50', 'disabled:pointer-events-none'],
      {
        layout: { isActive: true, display: 'Flex', alignItems: 'center', justifyContent: 'center' },
        positioning: { isActive: true, position: 'absolute', top: '0px', bottom: '0px', ...(isPrev ? { left: '0px' } : { right: '0px' }), zIndex: '100' },
      } as Layer['design'],
      {
        restrictions: { ...CHROME_RESTRICTIONS },
        children: [
          layer('div', 'Button', ['flex', 'items-center', 'justify-center', 'cursor-pointer', isPrev ? 'ml-[32px]' : 'mr-[32px]', 'rounded-full', 'bg-black', 'w-[36px]', 'h-[36px]'], {
            layout: { isActive: true, display: 'Flex', alignItems: 'center', justifyContent: 'center' },
            sizing: { isActive: true, width: '36px', height: '36px' },
            borders: { isActive: true, borderRadius: '9999px' },
            backgrounds: { isActive: true, backgroundColor: '#000000' },
            spacing: { isActive: true, ...(isPrev ? { marginLeft: '32px' } : { marginRight: '32px' }) },
          } as Layer['design'], { children: [iconLayer(isPrev ? CHEVRON_LEFT_SVG : CHEVRON_RIGHT_SVG)] }),
        ],
      },
    );
  };

  const navigation = layer('slideNavigationWrapper', 'Navigation', ['contents'], {
    layout: { isActive: true, display: 'Contents' },
  } as Layer['design'], { restrictions: { ...CHROME_RESTRICTIONS }, children: [arrow('Prev'), arrow('Next')] });

  const bullet = layer('slideBullet', 'Bullet', ['w-[6px]', 'h-[6px]', 'rounded-[8px]', 'bg-white', 'opacity-50', 'cursor-pointer', 'current:opacity-100'], {
    sizing: { isActive: true, width: '6px', height: '6px' },
    borders: { isActive: true, borderRadius: '8px' },
  } as Layer['design'], { restrictions: { ...CHROME_RESTRICTIONS }, children: [] });

  const bullets = layer('slideBullets', 'Bullets', ['flex', 'items-center', 'justify-center', 'bg-black/50', 'rounded-[9999px]', 'gap-[4px]', 'p-[8px]', 'z-[100]', 'relative'], {
    layout: { isActive: true, display: 'Flex', alignItems: 'center', justifyContent: 'center', gap: '4px' },
    borders: { isActive: true, borderRadius: '9999px' },
    spacing: { isActive: true, paddingTop: '8px', paddingRight: '8px', paddingBottom: '8px', paddingLeft: '8px' },
    backgrounds: { isActive: true, backgroundColor: 'rgba(0,0,0,0.5)' },
    positioning: { isActive: true, position: 'relative', zIndex: '100' },
  } as Layer['design'], { restrictions: { ...CHROME_RESTRICTIONS }, children: [bullet] });

  const fraction = layer('slideFraction', 'Fraction', ['text-white', 'text-[14px]'], {
    typography: { isActive: true, fontSize: '14px', color: '#ffffff' },
  } as Layer['design'], { restrictions: { ...CHROME_RESTRICTIONS }, children: [] });

  const pagination = layer('slidePaginationWrapper', 'Pagination', ['absolute', 'bottom-[16px]', 'left-0', 'right-0', 'z-[100]', 'flex', 'items-center', 'justify-center', 'gap-[8px]'], {
    layout: { isActive: true, display: 'Flex', alignItems: 'center', justifyContent: 'center', gap: '8px' },
    positioning: { isActive: true, position: 'absolute', bottom: '16px', left: '0px', right: '0px', zIndex: '100' },
  } as Layer['design'], { restrictions: { ...CHROME_RESTRICTIONS }, children: [bullets, fraction] });

  return [navigation, pagination];
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────

export interface LightboxPayload {
  /** `items[].url` in document order (Webflow CDN URLs, or ZIP-relative paths in older exports). */
  urls: string[];
  /** `group` — Webflow's own gallery key, empty when the lightbox is standalone. */
  group: string;
  /** Item types that are not plain images (video embeds); reported as `widget_partial`. */
  nonImage: number;
}

/**
 * Parse the `<script type="application/json" class="w-json">` payload Webflow
 * writes inside every `.w-lightbox` link. Shape:
 *
 *   {"items":[{"url":"https://…/a.jpg","type":"image","fileName":"a.jpg"}],"group":"Gallery"}
 *
 * Malformed payloads return no urls rather than throwing — the lightbox still
 * works off its visible thumbnail.
 */
export function parseLightboxPayload(raw: string): LightboxPayload {
  const empty: LightboxPayload = { urls: [], group: '', nonImage: 0 };
  if (!raw.trim()) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  const payload = parsed as { items?: unknown; group?: unknown };
  const group = typeof payload.group === 'string' ? payload.group : '';
  const items = Array.isArray(payload.items) ? payload.items : [];
  const urls: string[] = [];
  let nonImage = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { url?: unknown; type?: unknown; originalSrc?: unknown };
    if (entry.type !== undefined && entry.type !== 'image') {
      nonImage += 1;
      continue;
    }
    const url = typeof entry.url === 'string' ? entry.url : typeof entry.originalSrc === 'string' ? entry.originalSrc : '';
    if (url) urls.push(url);
  }
  return { urls, group, nonImage };
}

/**
 * Namespace Webflow's gallery key so an imported gallery can never join a group
 * the user created by hand (`groupId` is a free-text field in ycode's panel).
 */
export function lightboxGroupId(group: string): string {
  const slug = group.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `wf-${slug}` : '';
}

export function lightboxSettings(files: string[], group: string): LightboxSettings {
  return { ...DEFAULT_LIGHTBOX_SETTINGS, files, groupId: lightboxGroupId(group) };
}

// ─── Form controls ────────────────────────────────────────────────────────────

/** Tags that must become one of ycode's native form layers instead of a `div`. */
export const FORM_CONTROL_TAGS = new Set(['input', 'textarea', 'select', 'option', 'button']);

/**
 * Attributes a control needs to actually work.
 *
 * ycode's submit handler builds its payload with `new FormData(form)`, which
 * keys on `name`; a control imported without `name` therefore submits nothing.
 */
const CONTROL_ATTRS = [
  'type', 'name', 'placeholder', 'required', 'value', 'checked', 'disabled', 'readonly',
  'maxlength', 'minlength', 'min', 'max', 'step', 'pattern', 'rows', 'cols', 'multiple',
  'accept', 'autocomplete', 'inputmode', 'selected',
];

/**
 * The layer renderer spreads `layer.attributes` straight onto a React element
 * and only rewrites the handful of names in `HTML_TO_REACT_ATTRS`
 * (`lib/parse-head-html.ts`), which does not cover the form ones — React then
 * logs `Invalid DOM property maxlength` and drops the attribute. Storing the
 * JSX spelling is safe on the SSR path too: HTML attribute names are
 * case-insensitive.
 */
const JSX_ATTR_NAME: Record<string, string> = {
  maxlength: 'maxLength',
  minlength: 'minLength',
  readonly: 'readOnly',
  autocomplete: 'autoComplete',
  inputmode: 'inputMode',
};

/** Attributes that are present-or-absent in HTML and boolean in ycode's layer model. */
const BOOLEAN_ATTRS = new Set(['required', 'checked', 'disabled', 'readonly', 'multiple', 'selected']);

const NUMERIC_ATTRS = new Set(['rows', 'cols', 'maxlength', 'minlength']);

/**
 * `<input type="submit">` is Webflow's submit button. ycode has a real `button`
 * layer whose text is editable in the canvas, and the public renderer already
 * forces `type="submit"` on a button inside a form — so the input becomes a
 * button carrying its `value` as text, not an opaque `<input>`.
 */
const BUTTON_INPUT_TYPES = new Set(['submit', 'button', 'reset']);

export interface FormControlPlan {
  /** ycode layer name, or `'button'` when the control should become a button layer. */
  name: 'input' | 'textarea' | 'select' | 'option' | 'button';
  attributes: Record<string, string | number | boolean>;
  /** Button / option text (submit inputs carry it in `value`). */
  text?: string;
  /** `<option value="">Select one…</option>` — ycode's select renderer needs `settings.isPlaceholder`. */
  isPlaceholder?: boolean;
}

/**
 * Map one form-control element to its ycode layer. Returns null for a tag this
 * module does not own, so the caller keeps its existing behaviour.
 */
export function planFormControl(tag: string, attrs: Record<string, string>, text: string): FormControlPlan | null {
  const lower = tag.toLowerCase();
  if (!FORM_CONTROL_TAGS.has(lower)) return null;

  const attributes: Record<string, string | number | boolean> = {};
  for (const key of CONTROL_ATTRS) {
    const raw = attrs[key];
    if (raw === undefined) continue;
    const name = JSX_ATTR_NAME[key] ?? key;
    if (BOOLEAN_ATTRS.has(key)) {
      // `required`, `required=""` and `required="required"` all mean true;
      // only an explicit "false" turns it off.
      attributes[name] = raw.trim().toLowerCase() !== 'false';
      continue;
    }
    if (NUMERIC_ATTRS.has(key)) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n)) attributes[name] = n;
      continue;
    }
    if (raw !== '') attributes[name] = raw;
  }

  const type = (attrs.type ?? '').trim().toLowerCase();
  if (lower === 'input' && BUTTON_INPUT_TYPES.has(type)) {
    const label = (attrs.value ?? '').trim() || (type === 'submit' ? 'Submit' : 'Button');
    delete attributes.value;
    return { name: 'button', attributes, text: label };
  }
  if (lower === 'button') {
    return { name: 'button', attributes, text: text.trim() };
  }
  if (lower === 'option') {
    // Webflow's first option is the prompt: `<option value="">Select one…</option>`.
    // Its empty `value` is meaningful, so it is kept even though every other
    // empty attribute is dropped, and the option is flagged as the placeholder.
    const value = attrs.value ?? '';
    attributes.value = value;
    return { name: 'option', attributes, text: text.trim(), ...(value === '' ? { isPlaceholder: true } : {}) };
  }
  return { name: lower as 'input' | 'textarea' | 'select', attributes };
}

// ─── Columns (`.w-row` / `.w-col-N`) ──────────────────────────────────────────

/** `.w-col-6` -> `50%`, rounded the way Webflow's own `components.css` rounds it. */
export function columnWidth(span: number): string {
  if (span >= 12) return '100%';
  const pct = (span / 12) * 100;
  return `${Number(pct.toFixed(6))}%`;
}

/**
 * Framework shims for Webflow's 12-column grid.
 *
 * Webflow's base rules give `.w-col-N` its width at every width; at <= 767 px
 * `.w-col { width: 100% }` re-stacks the row and `.w-col-small-N` re-splits it;
 * at <= 991 px `.w-col-medium-N` overrides the desktop split. `w-col-tiny-N`
 * (<= 479 px) has no ycode tier (SPEC D11) and is reported as `widget_partial`.
 *
 * Shims are applied in the element's own class order, so `class="w-col w-col-6
 * w-col-small-12"` yields `w-[50%] max-md:w-full` then `max-md:w-full` — later
 * wins, which is the cascade Webflow itself produces.
 */
export function columnFrameworkClasses(): Record<string, string[]> {
  const out: Record<string, string[]> = {
    // `.w-row` is float+clearfix in Webflow; flex-wrap reproduces the same
    // layout and is what ycode's own Columns element uses.
    'w-row': ['flex', 'flex-wrap'],
    'w-col': ['relative', 'w-full', 'min-h-[1px]', 'px-[10px]'],
    'w-col-stack': ['max-lg:w-full'],
    'w-container': ['mx-auto', 'max-w-[940px]', 'max-lg:max-w-[728px]'],
  };
  for (let n = 1; n <= 12; n++) {
    // `w-full` rather than `w-[100%]` for a full-width column: it is the same
    // declaration and the class ycode's own templates use.
    const width = n >= 12 ? 'w-full' : `w-[${columnWidth(n)}]`;
    // Desktop split, plus Webflow's <= 767 px stack reset.
    out[`w-col-${n}`] = n >= 12 ? ['w-full'] : [width, 'max-md:w-full'];
    out[`w-col-medium-${n}`] = [`max-lg:${width}`];
    out[`w-col-small-${n}`] = [`max-md:${width}`];
    // tiny (<= 479 px) has no tier — deliberately empty, warned by html.ts.
    out[`w-col-tiny-${n}`] = [];
  }
  return out;
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

/**
 * ycode has no native tabs layer (verified against the element library: the only
 * `tabs` in the repo is `components/ui/tabs.tsx`, builder chrome). Webflow's
 * tabs are driven entirely by `webflow.js`, which v2 deliberately does not ship.
 *
 * So the DOM is kept and the behaviour is REBUILT the same way `widgets.ts`
 * rebuilds navbars and dropdowns: one generated click interaction per
 * `.w-tab-link` that shows its own `.w-tab-pane` and hides the others. The pane
 * that starts active (`w--tab-active`) is the only one that is not hidden
 * on load.
 */
export const TAB_ACTIVE_CLASS = 'w--tab-active';
export const TAB_CURRENT_CLASS = 'w--current';

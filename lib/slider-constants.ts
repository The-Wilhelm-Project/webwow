/**
 * Slider / Lightbox constants and pure type guards.
 *
 * Lives in its own module (with zero dependencies on `lib/templates/*`) so
 * that the public renderer and other lightweight consumers can import these
 * symbols without dragging the entire ~1.5 MB template tree
 * (`lib/templates/layouts.ts` + friends) into their bundle.
 */

import type { SliderSettings, LightboxSettings } from '@/types';

/** Default slider settings applied when creating a new slider */
export const DEFAULT_SLIDER_SETTINGS: SliderSettings = {
  navigation: true,
  groupSlide: 1,
  slidesPerGroup: 1,
  loop: 'none',
  centered: false,
  touchEvents: false,
  slideToClicked: false,
  mousewheel: false,

  pagination: true,
  paginationType: 'bullets',
  paginationClickable: true,
  autoplay: false,
  pauseOnHover: true,
  delay: '3',
  animationEffect: 'slide',
  easing: 'ease-in-out',
  duration: '0.5',
};

/** Default lightbox settings applied when creating a new lightbox */
export const DEFAULT_LIGHTBOX_SETTINGS: LightboxSettings = {
  files: [],
  filesSource: 'files',
  filesField: null,
  thumbnails: true,
  navigation: true,
  pagination: true,
  zoom: false,
  doubleTapZoom: false,
  mousewheel: false,
  overlay: 'light',
  groupId: '',
  animationEffect: 'slide',
  easing: 'ease-in-out',
  duration: '0.5',
};

/** All layer names that are part of the slider element */
export const SLIDER_LAYER_NAMES = [
  'slider', 'slides', 'slide',
  'slideNavigationWrapper', 'slideButtonPrev', 'slideButtonNext',
  'slidePaginationWrapper', 'slideBullets', 'slideFraction', 'slideBullet',
] as const;

export type SliderLayerName = typeof SLIDER_LAYER_NAMES[number];

/** Check if a layer name belongs to the slider element family */
export function isSliderLayerName(name: string): name is SliderLayerName {
  return (SLIDER_LAYER_NAMES as readonly string[]).includes(name);
}

/** Swiper CSS classes needed for core layout (used on canvas + production) */
export const SWIPER_CLASS_MAP: Record<string, string> = {
  slider: 'swiper',
  slides: 'swiper-wrapper',
  slide: 'swiper-slide',
};

/** Data attributes added to slider nav/pagination elements on production for Swiper targeting */
export const SWIPER_DATA_ATTR_MAP: Record<string, string> = {
  slideButtonPrev: 'data-slider-prev',
  slideButtonNext: 'data-slider-next',
  slideBullets: 'data-slider-pagination',
  slideFraction: 'data-slider-fraction',
  slideBullet: 'data-slider-bullet',
};

/** Accessible names for slider chrome that renders as a native button. */
export const SLIDER_BUTTON_ARIA_LABELS: Record<string, string> = {
  slideButtonPrev: 'Previous slide',
  slideButtonNext: 'Next slide',
  slideBullet: 'Go to slide',
};

/** Prev / next wrappers and bullets — not form submit buttons. */
export function isSliderChromeButton(name: string): boolean {
  return name === 'slideButtonPrev' || name === 'slideButtonNext' || name === 'slideBullet';
}

/**
 * Strip UA button chrome so slider controls keep their Tailwind look.
 * Attribute selectors only — must not reset designer `button` layers.
 * Prev/next are invisible hit areas (the circle is a child), so they
 * need `background:transparent`. Bullets ARE the visible dots (`bg-white`)
 * — a transparent reset would hide them (attribute+element beats a class).
 */
export const SLIDER_BUTTON_RESET_CSS =
  'button[data-slider-prev],button[data-slider-next]{appearance:none;-webkit-appearance:none;background:transparent;border:0;padding:0;margin:0;font:inherit;color:inherit}'
  + 'button[data-slider-bullet]{appearance:none;-webkit-appearance:none;border:0;padding:0;margin:0;font:inherit;color:inherit}';

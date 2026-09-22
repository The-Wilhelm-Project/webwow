/**
 * Webflow framework classes (`components.css`) -> Tailwind layout shims.
 *
 * The exported `components.css` is never parsed. Instead, the handful of `w-*`
 * classes whose framework CSS matters for layout are reproduced here as
 * `frameworkClasses` (the lowest layer of a node's cascade, folded into its base
 * style by upstream's converter). Reference: findings-ix2-css §9.4 and upstream
 * `lib/import/adapters/webflow/parse.ts` WEBFLOW_WIDGET_CLASSES.
 *
 * `text-[#fff]` (not `text-white`): upstream's `getAffectedProperties` reports
 * both `fontSize` and `color` for the named colour, which would let a later
 * `text-[24px]` evict it (or vice versa) inside `mergeClassStack`.
 *
 * Classes mapped to an empty list are known framework classes that need no CSS
 * of their own (their behaviour is structural and handled by html.ts). Any
 * other `w-*` class is unknown to the importer and should be reported as
 * `html_unmapped`.
 */

import type { WfNavCollapse } from './types';
import { isUnsupportedWidgetClass } from './widgets-extra';
import { columnFrameworkClasses } from './widgets-native';

export const FRAMEWORK_CLASSES: Record<string, string[]> = {
  'w-inline-block': ['inline-block', 'max-w-full'],
  // Webflow's button defaults (`components.css`): the site class stacks on top, so a
  // designed button keeps its own padding and colours; an undesigned `.w-button`
  // (search form, login submit) renders like Webflow's blue default instead of a
  // 0px-padding box with the body text colour.
  'w-button': ['inline-block', 'py-[9px]', 'px-[15px]', 'bg-[#3898ec]', 'text-[#fff]', 'border-0', 'leading-[inherit]', 'no-underline', 'cursor-pointer', 'rounded-none'],
  'w-nav': ['relative', 'z-[1000]'],
  'w-nav-brand': ['relative', 'float-left', 'no-underline'],
  'w-nav-menu': ['relative', 'float-right'],
  'w-dropdown': ['inline-block', 'relative', 'text-left', 'mx-auto', 'z-[900]'],
  // Webflow's dropdown defaults (`components.css`): the toggle is a 20px-padded
  // dark-grey label (40px on the right for the chevron), every link in the list
  // a 10px/20px-padded dark-grey block. Without the colour both inherit the
  // navbar's text colour — white links on the white list of a dark navbar.
  'w-dropdown-toggle': ['relative', 'inline-block', 'cursor-pointer', 'select-none', 'py-[20px]', 'pl-[20px]', 'pr-[40px]', 'text-[#222]', 'whitespace-nowrap', 'text-left'],
  'w-dropdown-list': ['absolute', 'hidden', 'min-w-full', 'bg-[#ddd]'],
  'w-icon-dropdown-toggle': ['absolute', 'top-0', 'right-0', 'bottom-0', 'm-auto', 'mr-[20px]', 'w-[1em]', 'h-[1em]'],
  'w-background-video': ['relative', 'overflow-hidden', 'h-[500px]', 'text-[#fff]'],
  'wf-layout-layout': ['grid'],
  'w-richtext': [],
  'w-embed': [],
  'w-script': [],
  'w-dyn-list': [],
  'w-dyn-items': [],
  'w-dyn-item': [],
  'w-dyn-empty': [],
  'w-layout-cell': [],
  'w-layout-layout': [],
  'w-webflow-badge': [],
  'w-background-video-atom': [],
  // Navbar parts whose visibility depends on `data-collapse` (see navFrameworkClasses).
  // The hamburger button keeps Webflow's tap size and glyph size (`padding: 18px`,
  // `font-size: 24px`) when the site class sets neither.
  'w-nav-button': ['relative', 'float-right', 'p-[18px]', 'text-[24px]', 'cursor-pointer', 'select-none'],
  'w-nav-link': ['inline-block', 'no-underline'],
  'w-nav-overlay': [],
  'w-dropdown-link': ['relative', 'block', 'no-underline', 'text-[#222]', 'py-[10px]', 'px-[20px]', 'text-left', 'whitespace-nowrap'],
  // Background-video play/pause button (kept as a button layer by html.ts; the
  // constant runtime line toggles it). `components.css` pins it to the bottom
  // right of the video wrapper — without that the button sits at the top left.
  'w-backgroundvideo-backgroundvideoplaypausebutton': [],
  'w-background-video--control': ['absolute', 'bottom-[1em]', 'right-[1em]', 'bg-[transparent]', 'p-[0]'],

  // ── Native widgets (widgets-native.ts). Values reproduce Webflow's own
  //    `components.css` defaults; the designer's site classes stack on top.
  // Slider: the root is Swiper's container, `.w-slider-mask` is its wrapper and
  // `.w-slide` a flex child, so the mask's `overflow:hidden` moves to the root.
  'w-slider': ['relative', 'overflow-hidden', 'w-full', 'h-[300px]', 'text-center'],
  'w-slider-mask': ['relative', 'flex', 'w-full', 'h-full', 'overflow-visible'],
  'w-slide': ['relative', 'shrink-0', 'w-full', 'h-full', 'text-left'],
  // Slider chrome ycode regenerates natively (html.ts drops these elements).
  'w-slider-nav': [],
  'w-slider-nav-invert': [],
  'w-slider-dot': [],
  'w-slider-arrow-left': [],
  'w-slider-arrow-right': [],
  'w-slider-aria-label': [],
  'w-slider-force-show': [],
  // Standalone the glyphs become inline SVG icons (widgets-extra.ts); inside the
  // slider chrome the whole arrow element is dropped.
  'w-icon-slider-left': ['inline-block', 'w-[1em]', 'h-[1em]'],
  'w-icon-slider-right': ['inline-block', 'w-[1em]', 'h-[1em]'],
  'w-round': [],

  // Tabs: the DOM is kept, the switching is a generated interaction (widgets.ts),
  // so `.w-tab-pane` must NOT carry a `hidden` shim — the interaction owns it.
  'w-tabs': ['relative'],
  'w-tab-menu': ['relative'],
  'w-tab-link': ['relative', 'inline-block', 'align-top', 'no-underline', 'py-[9px]', 'px-[30px]', 'text-left', 'cursor-pointer', 'text-[#222]', 'bg-[#ddd]'],
  'w-tab-content': ['relative', 'block', 'overflow-hidden'],
  'w-tab-pane': ['relative'],

  // Lightbox: `.w-lightbox` becomes a native lightbox layer; the rest is the
  // runtime overlay Webflow injects, which never appears in an export's markup.
  'w-lightbox': [],

  // Forms. `.w-form-done` / `.w-form-fail` keep their look but their visibility
  // is owned by `hiddenGenerated` + the submit handler, not by a `hidden` shim.
  'w-form': ['mb-[15px]'],
  'w-form-done': ['p-[20px]', 'text-center', 'bg-[#ddd]'],
  'w-form-fail': ['mt-[10px]', 'p-[10px]', 'bg-[#ffdede]'],
  'w-form-label': ['inline-block', 'cursor-pointer', 'font-normal', 'mb-0'],
  'w-input': ['block', 'w-full', 'h-[38px]', 'py-[8px]', 'px-[12px]', 'mb-[10px]', 'text-[14px]', 'leading-[1.43]', 'text-[#333]', 'align-middle', 'bg-[#fff]', 'border', 'border-solid', 'border-[#ccc]'],
  'w-select': ['block', 'w-full', 'h-[38px]', 'py-[8px]', 'px-[12px]', 'mb-[10px]', 'text-[14px]', 'leading-[1.43]', 'text-[#333]', 'align-middle', 'bg-[#f3f3f3]', 'border', 'border-solid', 'border-[#ccc]'],
  'w-checkbox': ['block', 'mb-[5px]', 'pl-[20px]'],
  'w-checkbox-input': ['float-left', '-ml-[20px]', 'mt-[4px]'],
  'w-radio': ['block', 'mb-[5px]', 'pl-[20px]'],
  'w-radio-input': ['float-left', '-ml-[20px]', 'mt-[3px]'],
  'w-list-unstyled': ['pl-0', 'list-none'],

  // Webflow's responsive visibility helpers (`display:none !important` reset per
  // breakpoint). `tiny` has no ycode tier (SPEC D11), so `w-hidden-tiny` is a no-op.
  'w-hidden-main': ['hidden', 'max-lg:block'],
  'w-hidden-medium': ['max-lg:hidden', 'max-md:block'],
  'w-hidden-small': ['max-md:hidden'],
  'w-hidden-tiny': [],
  // Webflow's screen-reader-only helper (`.w-hidden { display: none }`).
  'w-hidden': ['hidden'],

  // ── widgets-extra.ts. Values reproduce Webflow's `components.css` defaults. ──
  // Embedded video: the layer itself becomes the player box (aspect from the
  // wrapper's padding trick, see widgets-extra.ts `embedVideoClasses`).
  'w-video': [],
  'w-embed-youtubevideo': [],
  // Lottie / code block / map widget wrappers.
  'w-lottie': ['block'],
  'w-code-block': [],
  'w-widget': [],
  'w-widget-map': ['w-full', 'h-[400px]'],
  // File upload: the `<input type="file">` is visually hidden behind its label.
  'w-file-upload': ['block', 'mb-[10px]'],
  'w-file-upload-default': ['inline-block', 'text-[#333]'],
  'w-file-upload-input': ['w-[0.1px]', 'h-[0.1px]', 'opacity-0', 'overflow-hidden', 'absolute', '-z-[100]'],
  'w-file-upload-label': ['inline-block', 'text-[14px]', 'font-normal', 'cursor-pointer', 'm-0', 'py-[8px]', 'px-[12px]', 'border', 'border-solid', 'border-[#ccc]', 'bg-[#fafafa]'],
  'w-file-upload-info': ['inline-block', 'leading-[38px]', 'px-[12px]'],
  // Upload state boxes need webflow.js and are dropped by html.ts.
  'w-file-upload-uploading': [],
  'w-file-upload-success': [],
  'w-file-upload-error': [],
  'w-file-upload-uploading-btn': [],
  'w-file-upload-file': [],
  'w-file-upload-file-name': [],
  'w-file-remove-link': [],
  'w-file-upload-error-msg': [],
  // Locales: the list becomes ycode's `localeSelector` (needs `relative` for its overlay select).
  'w-locales-list': ['relative', 'inline-flex', 'items-center', 'gap-[6px]'],
  'w-locales-items': [],
  'w-locales-item': [],
  // Pagination: ycode regenerates the controls from these layers.
  'w-pagination-wrapper': ['flex', 'flex-wrap', 'justify-center'],
  'w-pagination-previous': ['inline-block', 'mx-[8px]', 'py-[9px]', 'px-[20px]', 'text-[14px]', 'leading-[20px]', 'text-center', 'cursor-pointer', 'no-underline', 'text-[#333]', 'bg-[#fafafa]', 'border', 'border-solid', 'border-[#ccc]', 'rounded-[2px]'],
  'w-pagination-next': ['inline-block', 'mx-[8px]', 'py-[9px]', 'px-[20px]', 'text-[14px]', 'leading-[20px]', 'text-center', 'cursor-pointer', 'no-underline', 'text-[#333]', 'bg-[#fafafa]', 'border', 'border-solid', 'border-[#ccc]', 'rounded-[2px]'],
  'w-pagination-previous-icon': ['mx-[8px]'],
  'w-pagination-next-icon': ['mx-[8px]'],
  'w-page-count': ['w-full', 'mt-[20px]', 'text-center'],
  // Icon font glyphs (inline SVG, 1em like the font glyph; see widgets-extra.ts ICON_FONT_SVGS).
  'w-icon-nav-menu': ['inline-block', 'w-[1em]', 'h-[1em]'],
  'w-icon-arrow-down': ['inline-block', 'w-[1em]', 'h-[1em]'],
  'w-icon-file-upload-icon': ['inline-block', 'mr-[8px]', 'w-[20px]', 'h-[20px]'],
  'w-icon-file-upload-uploading': ['inline-block', 'mr-[8px]', 'w-[20px]', 'h-[20px]'],
  'w-icon-file-upload-remove': ['m-auto', 'w-[10px]', 'h-[10px]'],

  // Legacy 12-column grid (`.w-row` / `.w-col-N` and the responsive variants).
  ...columnFrameworkClasses(),
};

/**
 * Webflow's layout of an opened collapsed menu (`.w-nav-menu[data-nav-menu-open]`
 * in `components.css`): a panel below the bar, full width, grey, centred.
 * `display:block` is the generated interaction's business (widgets.ts).
 */
const NAV_MENU_OPEN = ['absolute', 'top-full', 'left-0', 'right-0', 'min-w-[200px]', 'bg-[#c8c8c8]', 'text-center'];

/**
 * Framework classes for the navbar menu / hamburger button by `data-collapse`.
 *
 *   all:        menu [] (visibility owned by the generated interaction), button []
 *   medium:     menu ['max-lg:hidden'], button ['hidden', 'max-lg:block']
 *   small|tiny: menu ['max-md:hidden'], button ['hidden', 'max-md:block']
 *   none:       menu [], button ['hidden']
 *
 * `menu-open` is the opened panel's layout for the collapsed breakpoints
 * (`NAV_MENU_OPEN` under `max-lg:` / `max-md:` / no prefix for `all`); html.ts
 * adds it when the site class sets no position or inset of its own.
 */
export function navFrameworkClasses(collapse: WfNavCollapse | undefined, part: 'menu' | 'button' | 'menu-open'): string[] {
  switch (collapse) {
    case 'all':
      return part === 'menu-open' ? [...NAV_MENU_OPEN] : [];
    case 'medium':
      if (part === 'menu-open') return NAV_MENU_OPEN.map((c) => `max-lg:${c}`);
      return part === 'menu' ? ['max-lg:hidden'] : ['hidden', 'max-lg:block'];
    case 'small':
    case 'tiny':
      if (part === 'menu-open') return NAV_MENU_OPEN.map((c) => `max-md:${c}`);
      return part === 'menu' ? ['max-md:hidden'] : ['hidden', 'max-md:block'];
    case 'none':
      return part === 'menu' || part === 'menu-open' ? [] : ['hidden'];
    default:
      // Webflow's default collapse point is `medium`.
      return navFrameworkClasses('medium', part);
  }
}

/** True when a site style positions the element itself (position or inset utility, any breakpoint / state). */
export function setsPosition(classes: string[]): boolean {
  return classes.some((cls) => {
    const base = cls.slice(cls.lastIndexOf(':') + 1);
    return /^(static|fixed|absolute|relative|sticky)$/.test(base) || /^-?(inset|top|left|right|bottom)-/.test(base) || /^\[(inset|top|left|right|bottom)(-[a-z]+)?:/.test(base);
  });
}

/** 24x24 stroke chevron (currentColor), same style as lib/import/adapters/webflow/icons.ts. */
export const DROPDOWN_CHEVRON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

/**
 * Webflow state / runtime classes: never a style chip of their own. The
 * `.x.w--open` / `.x.w--current` combo rules are resolved by css.ts + html.ts
 * (states.ts) into the base chip, a `current:` variant or a toggle tween.
 */
export const IGNORED_CLASSES = new Set([
  'w--current', 'w--open', 'w--tab-active', 'w--nav-menu-open', 'w-dyn-bind-empty', 'w-condition-invisible', 'w-dyn-hide', 'w-mod-js', 'w-mod-touch', 'w-clearfix',
]);

/** True for every class that belongs to Webflow's framework (`w-*`, `wf-layout-layout`) or its state classes. */
export function isFrameworkClass(name: string): boolean {
  return name.startsWith('w-') || name === 'wf-layout-layout' || IGNORED_CLASSES.has(name);
}

/** True when a framework class is known to the importer (mapped or deliberately empty). */
export function isKnownFrameworkClass(name: string): boolean {
  // `w-users-*` / `w-commerce-*` are whole widget families with dozens of
  // classes each; html.ts reports the family once (`widget_unsupported`).
  return Object.prototype.hasOwnProperty.call(FRAMEWORK_CLASSES, name) || IGNORED_CLASSES.has(name) || isUnsupportedWidgetClass(name);
}

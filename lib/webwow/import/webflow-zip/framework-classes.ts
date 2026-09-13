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

export const FRAMEWORK_CLASSES: Record<string, string[]> = {
  'w-inline-block': ['inline-block', 'max-w-full'],
  'w-button': ['inline-block', 'cursor-pointer', 'no-underline'],
  'w-nav': ['relative', 'z-[1000]'],
  'w-nav-brand': ['relative', 'float-left', 'no-underline'],
  'w-nav-menu': ['relative', 'float-right'],
  'w-dropdown': ['inline-block', 'relative', 'text-left', 'mx-auto', 'z-[900]'],
  'w-dropdown-toggle': ['relative', 'inline-block', 'cursor-pointer', 'select-none', 'pr-[40px]', 'whitespace-nowrap', 'text-left'],
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
  'w-nav-button': [],
  'w-nav-link': ['inline-block', 'no-underline'],
  'w-nav-overlay': [],
  'w-dropdown-link': ['block', 'no-underline'],
  // Video / background-video runtime chrome that html.ts drops.
  'w-backgroundvideo-backgroundvideoplaypausebutton': [],
  'w-background-video--control': [],
};

/**
 * Framework classes for the navbar menu / hamburger button by `data-collapse`.
 *
 *   all:        menu [] (visibility owned by the generated interaction), button []
 *   medium:     menu ['max-lg:hidden'], button ['hidden', 'max-lg:block']
 *   small|tiny: menu ['max-md:hidden'], button ['hidden', 'max-md:block']
 *   none:       menu [], button ['hidden']
 */
export function navFrameworkClasses(collapse: WfNavCollapse | undefined, part: 'menu' | 'button'): string[] {
  switch (collapse) {
    case 'all':
      return [];
    case 'medium':
      return part === 'menu' ? ['max-lg:hidden'] : ['hidden', 'max-lg:block'];
    case 'small':
    case 'tiny':
      return part === 'menu' ? ['max-md:hidden'] : ['hidden', 'max-md:block'];
    case 'none':
      return part === 'menu' ? [] : ['hidden'];
    default:
      // Webflow's default collapse point is `medium`.
      return navFrameworkClasses('medium', part);
  }
}

/** 24x24 stroke chevron (currentColor), same style as lib/import/adapters/webflow/icons.ts. */
export const DROPDOWN_CHEVRON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

/** Webflow state / runtime classes that never influence styling in ycode. */
export const IGNORED_CLASSES = new Set([
  'w--current', 'w--open', 'w-dyn-bind-empty', 'w-condition-invisible', 'w-dyn-hide', 'w-mod-js', 'w-mod-touch', 'w-clearfix',
]);

/** True for every class that belongs to Webflow's framework (`w-*`, `wf-layout-layout`) or its state classes. */
export function isFrameworkClass(name: string): boolean {
  return name.startsWith('w-') || name === 'wf-layout-layout' || IGNORED_CLASSES.has(name);
}

/** True when a framework class is known to the importer (mapped or deliberately empty). */
export function isKnownFrameworkClass(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(FRAMEWORK_CLASSES, name) || IGNORED_CLASSES.has(name);
}

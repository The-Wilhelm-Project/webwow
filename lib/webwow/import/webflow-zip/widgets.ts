/**
 * Generated interactions for Webflow widgets that rely on runtime JS (D3).
 *
 * - Navbar: Webflow's `data-collapse` hides `.w-nav-menu` and shows the
 *   hamburger `.w-nav-button` at the chosen widths; the export has no script
 *   for it. We generate a `click` / `yoyo` interaction on the button that
 *   toggles the menu's `display` (pattern from lib/mcp/tools/animations.ts:
 *   `from { display: hidden } -> to { display: visible }`, `apply_styles
 *   display: on-load` so the menu starts collapsed on the affected breakpoints).
 * - Dropdown: the toggle gets a `click` (or `hover` for `data-hover="true"`)
 *   interaction that reveals the sibling `.w-dropdown-list`.
 * - Tabs: ycode has no native tabs layer (checked against the element library),
 *   and Webflow's tab switching lives entirely in `webflow.js`, which v2 does
 *   not ship. Each `.w-tab-link` therefore gets a `click` interaction that shows
 *   its own `.w-tab-pane` and hides every sibling pane — the panes that do not
 *   start active carry `apply_styles: display on-load`, so exactly one pane is
 *   visible before the first click.
 *
 * The runtime shows a toggled element by removing its `data-gsap-hidden`
 * attribute, so any Tailwind `hidden` shim on the target would keep it
 * invisible; html.ts already omits those shims and this module strips any
 * leftover `hidden` / `max-lg:hidden` / `max-md:hidden` from the target layer.
 */

import { generateId } from '@/lib/utils';
import type { Breakpoint, Layer, LayerInteraction } from '@/types';
import type { WfNavCollapse, WfNode, WfNodeRole, WfPage } from './types';
import type { Warnings } from './warnings';

const DISPLAY_SHIMS = new Set(['hidden', 'max-lg:hidden', 'max-md:hidden']);
const ALL_BREAKPOINTS: Breakpoint[] = ['desktop', 'tablet', 'mobile'];
const DEFAULT_NAV_DURATION_MS = 400;
const DROPDOWN_DURATION_S = 0.2;

function collapseBreakpoints(collapse: WfNavCollapse | undefined): Breakpoint[] {
  switch (collapse) {
    case 'all':
      return ['desktop', 'tablet', 'mobile'];
    case 'small':
    case 'tiny':
      return ['mobile'];
    case 'medium':
    default:
      return ['tablet', 'mobile'];
  }
}

/** Every descendant with `role`, document order, without descending into a nested widget of the same family. */
function collectDescendants(node: WfNode, role: WfNodeRole, stopAt: WfNodeRole[]): WfNode[] {
  const out: WfNode[] = [];
  const visit = (current: WfNode) => {
    for (const child of current.children ?? []) {
      if (child.wf.role === role) {
        out.push(child);
        continue;
      }
      if (child.wf.role && stopAt.includes(child.wf.role)) continue;
      visit(child);
    }
  };
  visit(node);
  return out;
}

function findDescendant(node: WfNode, role: WfNodeRole): WfNode | undefined {
  for (const child of node.children ?? []) {
    if (child.wf.role === role) return child;
    // Nested widgets own their own parts: do not descend into another nav / dropdown.
    if (child.wf.role === 'nav' || child.wf.role === 'dropdown') continue;
    const found = findDescendant(child, role);
    if (found) return found;
  }
  return undefined;
}

/** Remove display shims from a layer's flat classes and per-chip overrides (the interaction owns visibility). */
export function stripDisplayShims(layer: Layer): void {
  const strip = (classes: string | string[]): string | string[] => {
    if (Array.isArray(classes)) return classes.filter((c) => !DISPLAY_SHIMS.has(c));
    return classes.split(/\s+/).filter((c) => c && !DISPLAY_SHIMS.has(c)).join(' ');
  };
  layer.classes = strip(layer.classes ?? '');
  if (layer.styleOverrides?.classes) layer.styleOverrides = { ...layer.styleOverrides, classes: strip(layer.styleOverrides.classes) as string };
  if (layer.styleOverridesByStyle) {
    for (const [id, override] of Object.entries(layer.styleOverridesByStyle)) {
      if (override?.classes) layer.styleOverridesByStyle[id] = { ...override, classes: strip(override.classes) as string };
    }
  }
}

function toggleInteraction(trigger: 'click' | 'hover', breakpoints: Breakpoint[], targetLayerId: string, durationSeconds: number): LayerInteraction {
  return {
    id: generateId('int'),
    trigger,
    timeline: { breakpoints, repeat: 0, yoyo: true },
    tweens: [
      {
        id: generateId('twn'),
        layer_id: targetLayerId,
        position: 0,
        duration: durationSeconds,
        ease: 'none',
        from: { display: 'hidden' },
        to: { display: 'visible' },
        apply_styles: { display: 'on-load' },
      },
    ],
  };
}

/**
 * One click interaction per tab link: show its own pane, hide the others.
 *
 * `yoyo` must stay false — a tab is not a toggle, and a second click on the
 * active tab should leave it open.
 */
function generateTabInteractions(page: WfPage, tabs: WfNode, layerByNode: Map<string, Layer>, warn: Warnings): number {
  const links = collectDescendants(tabs, 'tab-link', ['tabs']);
  const panes = collectDescendants(tabs, 'tab-pane', ['tabs']);
  if (links.length === 0 || panes.length === 0) {
    warn.add('widget_partial', `tabs without ${links.length === 0 ? 'tab links' : 'tab panes'}: no switching interaction generated`, { page: page.name, node: tabs.wf.id });
    return 0;
  }

  const paneByTab = new Map<string, WfNode>();
  panes.forEach((pane, i) => paneByTab.set(pane.wf.tab?.id || `#${i}`, pane));
  const paneLayers = panes.map((pane) => layerByNode.get(pane.wf.id)).filter((l): l is Layer => Boolean(l));

  let generated = 0;
  links.forEach((link, i) => {
    const linkLayer = layerByNode.get(link.wf.id);
    const pane = paneByTab.get(link.wf.tab?.id || `#${i}`) ?? panes[i];
    const paneLayer = pane ? layerByNode.get(pane.wf.id) : undefined;
    if (!linkLayer || !paneLayer) {
      warn.add('widget_partial', `tab link without a matching pane (data-w-tab="${link.wf.tab?.id ?? ''}")`, { page: page.name, node: link.wf.id });
      return;
    }
    const tweens = paneLayers.map((target) => ({
      id: generateId('twn'),
      layer_id: target.id,
      position: 0,
      duration: 0,
      ease: 'none',
      from: { display: target.id === paneLayer.id ? 'hidden' : 'visible' },
      to: { display: target.id === paneLayer.id ? 'visible' : 'hidden' },
      // Only the panes that do NOT start active are hidden before the first
      // click; `collectHiddenLayerInfo` keys off exactly this combination.
      apply_styles: target.id === paneLayer.id && !pane?.wf.tab?.active ? { display: 'on-load' as const } : {},
    }));
    linkLayer.interactions = [
      ...(linkLayer.interactions ?? []),
      { id: generateId('int'), trigger: 'click' as const, timeline: { breakpoints: ALL_BREAKPOINTS, repeat: 0, yoyo: false }, tweens },
    ];
    stripDisplayShims(paneLayer);
    generated += 1;
  });
  return generated;
}

/**
 * Generate navbar / dropdown interactions for one page. Runs on the converted
 * layers BEFORE component extraction so every page copy carries the
 * interaction; `generated` counts the objects created by this call.
 */
export function generateWidgetInteractions(page: WfPage, layerByNode: Map<string, Layer>, warn: Warnings): { generated: number } {
  let generated = 0;
  const layerOf = (node: WfNode | undefined): Layer | undefined => (node ? layerByNode.get(node.wf.id) : undefined);

  const visit = (node: WfNode) => {
    if (node.wf.role === 'nav') {
      const collapse = node.wf.navCollapse ?? 'medium';
      if (collapse !== 'none') {
        const button = findDescendant(node, 'nav-button');
        const menu = findDescendant(node, 'nav-menu');
        const buttonLayer = layerOf(button);
        const menuLayer = layerOf(menu);
        if (buttonLayer && menuLayer) {
          const ms = Number.parseInt(node.wf.attrs['data-duration'] ?? '', 10);
          const duration = (Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_NAV_DURATION_MS) / 1000;
          const interaction = toggleInteraction('click', collapseBreakpoints(collapse), menuLayer.id, duration);
          buttonLayer.interactions = [...(buttonLayer.interactions ?? []), interaction];
          stripDisplayShims(menuLayer);
          generated++;
        } else {
          warn.add('html_unmapped', `navbar without ${button ? 'menu' : 'hamburger button'}: no toggle interaction generated`, { page: page.name, node: node.wf.id });
        }
      }
    } else if (node.wf.role === 'dropdown') {
      const toggle = findDescendant(node, 'dropdown-toggle');
      const list = findDescendant(node, 'dropdown-list');
      const toggleLayer = layerOf(toggle);
      const listLayer = layerOf(list);
      if (toggleLayer && listLayer) {
        const interaction = toggleInteraction(node.wf.dropdownHover ? 'hover' : 'click', ['desktop', 'tablet', 'mobile'], listLayer.id, DROPDOWN_DURATION_S);
        toggleLayer.interactions = [...(toggleLayer.interactions ?? []), interaction];
        stripDisplayShims(listLayer);
        generated++;
      } else {
        warn.add('html_unmapped', `dropdown without ${toggle ? 'list' : 'toggle'}: no interaction generated`, { page: page.name, node: node.wf.id });
      }
    } else if (node.wf.role === 'tabs') {
      generated += generateTabInteractions(page, node, layerByNode, warn);
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const root of page.roots) visit(root);
  return { generated };
}

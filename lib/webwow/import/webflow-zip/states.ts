/**
 * Webflow runtime state classes (`w--open`, `w--current`, `w--tab-active`,
 * `w--nav-menu-open`) and how their combo rules (`.dropdown-list.w--open`)
 * translate into ycode's model.
 *
 * `webflow.js` sets these classes at runtime; the export never carries them on
 * an element, and ycode has no class-based state. A rule `.x.<state>` therefore
 * cannot stay a combo chip (it would never match anything). css.ts records it
 * as a {@link WfStateRule} keyed by the chain without the state class, and
 * html.ts decides per element role what it becomes:
 *
 * - **merge** (`w--open` on a dropdown list or nav menu, `w--nav-menu-open` /
 *   `[data-nav-menu-open]` on a nav menu, `w--tab-active` on a tab pane): the
 *   closed state is `display: none`, so the open styles are the only ones that
 *   are ever visible — they join the element's base style (the chip of `x`).
 * - **tween** (`w--open` on a dropdown toggle or the nav button): the element
 *   is visible in both states, so the open styles become a tween on the same
 *   click / hover interaction that opens the list — as far as ycode's tween
 *   keys carry them ({@link stateTweenFromDeclarations}); the rest is reported
 *   as `css_state_dropped`.
 * - **drop**: any other element (Webflow never sets the class there, or ycode
 *   has no counterpart) — reported as `css_state_dropped`.
 * - **variant** (`w--current` anywhere but a tab link): css.ts has already
 *   turned the rule into ycode's `current:` variant (`aria-current="page"`,
 *   `@custom-variant current`) on the base style; nothing to do per element.
 *   On a **tab link** Webflow's `w--current` marks the active tab, which ycode
 *   never flags with `aria-current`, so there the rule takes the tween path on
 *   the generated tab interaction (widgets.ts) instead.
 *
 * A merged rule on a **nav menu** is scoped to the navbar's collapsed
 * breakpoints by html.ts (the menu is always visible above them, and Webflow
 * never applies the open styles there).
 *
 * A state class inside a **complex selector** (a descendant / child chain such
 * as `.dropdown-list.w--open .link`, `.nav .link.w--current`,
 * `.w-locales-item a.w--current`) never becomes a chip: css.ts translates it
 * into residual CSS or reports it, never keeps it verbatim (a `.wf-w--open`
 * hook would match nothing):
 *
 * - `w--current` becomes ycode's own marker: `.w--current` -> `[aria-current]`
 *   (ycode sets `aria-current="page"` on links to the current page; the
 *   `current:` variant is `&[aria-current]`).
 * - `w--open` / `w--tab-active` whose element (the compound carrying the state
 *   class) is, on every element of the export that matches it, a dropdown list
 *   or a tab pane: the state is implied (those elements are only visible when
 *   open / active), so the rule is kept without the state class.
 *   {@link collectClassLists} gives css.ts the export's class lists up front.
 * - everything else (a toggle's or the nav button's descendants, the nav menu,
 *   no matching element, two state classes) is reported as `css_state_dropped`.
 */

import type { TweenProperties, TweenPropertyKey } from '@/types';
import type { CssDeclaration } from './css-tokenizer';
import { RESTING } from './ix2';
import type { WfNodeRole } from './types';

export type WfStateClass = 'w--open' | 'w--current' | 'w--tab-active' | 'w--nav-menu-open';

/** Every state class becomes a `WfStateRule` (kept as an alias of {@link WfStateClass}). */
export type WfRuleState = WfStateClass;

export const STATE_CLASSES: ReadonlySet<string> = new Set<WfStateClass>(['w--open', 'w--current', 'w--tab-active', 'w--nav-menu-open']);

export function isStateClass(name: string): name is WfStateClass {
  return STATE_CLASSES.has(name);
}

export interface WfStateRule {
  state: WfRuleState;
  /** Original selector, for warnings (`.dropdown-list.w--open`). */
  selector: string;
  /** Translated utility classes, breakpoint-prefixed (`max-md:p-[10px]`): the merge path. */
  classes: string[];
  /** Normalised declarations of a main-breakpoint rule (empty for a breakpoint rule): the tween path. */
  declarations: CssDeclaration[];
  breakpoint: 'main' | 'medium' | 'small';
}

export type WfStateHandling = 'merge' | 'tween' | 'drop' | 'variant';

/** What a state rule becomes on an element with this role (see the module comment). */
export function stateHandling(role: WfNodeRole | undefined, state: WfRuleState): WfStateHandling {
  switch (state) {
    case 'w--open':
      if (role === 'dropdown-list' || role === 'nav-menu') return 'merge';
      if (role === 'dropdown-toggle' || role === 'nav-button') return 'tween';
      return 'drop';
    case 'w--nav-menu-open':
      return role === 'nav-menu' ? 'merge' : 'drop';
    case 'w--tab-active':
      return role === 'tab-pane' ? 'merge' : 'drop';
    case 'w--current':
      return role === 'tab-link' ? 'tween' : 'variant';
    default:
      return 'drop';
  }
}

/** Which Webflow element carries the state class at runtime (for the `css_state_dropped` text). */
export function stateCarrier(state: WfRuleState): string {
  switch (state) {
    case 'w--open':
      return 'dropdown toggles, dropdown lists and the nav button';
    case 'w--nav-menu-open':
      return 'the nav menu';
    case 'w--tab-active':
      return 'tab panes';
    case 'w--current':
      return 'links to the current page and the active tab link';
    default:
      return 'elements';
  }
}

/** The state in plain words, for warnings (`the open state`, `the active-tab state`). */
export function stateLabel(state: WfRuleState): string {
  switch (state) {
    case 'w--current':
      return 'active-tab';
    case 'w--tab-active':
      return 'active-pane';
    case 'w--nav-menu-open':
      return 'open-menu';
    default:
      return 'open';
  }
}

/** Framework class -> the role html.ts gives the element (html.ts `convertElement`). */
export const STATE_ROLE_BY_CLASS: Readonly<Record<string, WfNodeRole>> = {
  'w-dropdown-list': 'dropdown-list',
  'w-dropdown-toggle': 'dropdown-toggle',
  'w-nav-menu': 'nav-menu',
  'w-nav-button': 'nav-button',
  'w-tab-pane': 'tab-pane',
  'w-tab-link': 'tab-link',
};

/** The state role of an element with this class list (`undefined` for a plain element). */
export function stateRoleOf(classNames: readonly string[]): WfNodeRole | undefined {
  for (const c of classNames) {
    const role = STATE_ROLE_BY_CLASS[c];
    if (role) return role;
  }
  return undefined;
}

/**
 * The roles of the export's elements whose class list contains every class of
 * `carrier` (`['dropdown-list']`, `['w-dropdown-list']`); `null` for a plain
 * element. Empty when no element matches.
 */
export function carrierRoles(carrier: readonly string[], classLists: Iterable<readonly string[]>): (WfNodeRole | null)[] {
  const out: (WfNodeRole | null)[] = [];
  for (const list of classLists) {
    if (carrier.every((c) => list.includes(c))) out.push(stateRoleOf(list) ?? null);
  }
  return out;
}

/**
 * The state is implied by the element itself: it is only ever visible in that
 * state (a closed dropdown list and an inactive tab pane are `display: none`).
 * The nav menu is excluded: above its collapse point it is visible and closed.
 */
export function stateImpliedBy(role: WfNodeRole | null, state: WfRuleState): boolean {
  return (state === 'w--open' && role === 'dropdown-list') || (state === 'w--tab-active' && role === 'tab-pane');
}

const CLASS_ATTR_RE = /\bclass\s*=\s*"([^"]*)"|\bclass\s*=\s*'([^']*)'/gi;

/**
 * Every distinct class list of a page's elements (`"dropdown-list w-dropdown-list"`),
 * so css.ts can tell which elements a state rule inside a complex selector
 * targets before any page is parsed.
 */
export function collectClassLists(html: string, out: Set<string>): void {
  for (const m of html.matchAll(CLASS_ATTR_RE)) {
    const list = (m[1] ?? m[2] ?? '').split(/\s+/).filter(Boolean);
    if (list.length > 0) out.add(list.join(' '));
  }
}

// ─── Declarations -> tween ────────────────────────────────────────────────────

export interface StateTweenPlan {
  /** The open state, as ycode tween values. */
  to: TweenProperties;
  /** The resting state for the same keys (from the element's own rules, else ycode's resting defaults). */
  from: TweenProperties;
  /** Declarations that have no tween key, as `prop: value` (for the warning). */
  dropped: string[];
}

const NAMED_COLORS: Record<string, string> = { white: '#ffffff', black: '#000000', transparent: '#000000/0' };
const LENGTH_RE = /^-?\d*\.?\d+(px|%|vw|vh|em|rem)$/;

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

function withAlpha(hex: string, alpha: number): string {
  return alpha >= 1 ? hex : `${hex}/${Math.round(Math.max(0, alpha) * 100)}`;
}

/** CSS colour -> ycode colour (`#rrggbb` or `#rrggbb/<opacity 0-100>`); null when not a plain colour. */
export function tweenColor(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  const hex = v.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const rgb = `#${h.slice(0, 6)}`;
    return h.length === 8 ? withAlpha(rgb, Number.parseInt(h.slice(6), 16) / 255) : rgb;
  }
  const fn = v.match(/^rgba?\(([^)]*)\)$/);
  if (fn) {
    const parts = fn[1].replace(/\s*\/\s*/, ',').split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const nums = parts.map((p) => (p.endsWith('%') ? Number.parseFloat(p) / 100 : Number.parseFloat(p)));
    if (nums.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
    const [r, g, b] = parts.slice(0, 3).map((p, i) => (p.endsWith('%') ? nums[i] * 255 : nums[i]));
    const a = parts.length > 3 && Number.isFinite(nums[3]) ? nums[3] : 1;
    return withAlpha(`#${hex2(r)}${hex2(g)}${hex2(b)}`, a);
  }
  return null;
}

/** `rotate(90deg) translateX(10px) scale(1.2)` -> tween keys; unsupported functions are named in `dropped`. */
function transformValues(value: string): { values: TweenProperties; dropped: string[] } {
  const values: TweenProperties = {};
  const dropped: string[] = [];
  const fns = [...value.matchAll(/([a-zA-Z0-9]+)\(([^)]*)\)/g)];
  if (fns.length === 0) {
    if (value.trim() !== 'none') dropped.push(value.trim());
    return { values, dropped };
  }
  const unitOr = (raw: string, unit: string) => (/^-?\d*\.?\d+$/.test(raw.trim()) ? `${raw.trim()}${unit}` : raw.trim());
  for (const [, fn, argList] of fns) {
    const args = argList.split(',').map((a) => a.trim());
    switch (fn.toLowerCase()) {
      case 'rotate':
      case 'rotatez':
        values.rotation = unitOr(args[0] ?? '0', 'deg');
        break;
      case 'translate':
        values.x = unitOr(args[0] ?? '0', 'px');
        if (args[1]) values.y = unitOr(args[1], 'px');
        break;
      case 'translatex':
        values.x = unitOr(args[0] ?? '0', 'px');
        break;
      case 'translatey':
        values.y = unitOr(args[0] ?? '0', 'px');
        break;
      case 'scale':
        values.scale = args[0] ?? '1';
        break;
      case 'skew':
        values.skewX = unitOr(args[0] ?? '0', 'deg');
        if (args[1]) values.skewY = unitOr(args[1], 'deg');
        break;
      case 'skewx':
        values.skewX = unitOr(args[0] ?? '0', 'deg');
        break;
      case 'skewy':
        values.skewY = unitOr(args[0] ?? '0', 'deg');
        break;
      default:
        dropped.push(`${fn}(${argList})`);
    }
  }
  return { values, dropped };
}

/** Declarations -> the tween values ycode can carry; everything else is listed in `dropped`. */
export function tweenValuesOf(decls: CssDeclaration[]): { values: TweenProperties; dropped: string[] } {
  const values: TweenProperties = {};
  const dropped: string[] = [];
  for (const d of decls) {
    const value = d.value.trim();
    switch (d.prop) {
      case 'background-color':
      case 'background': {
        const color = tweenColor(value);
        if (color) values.backgroundColor = color;
        else dropped.push(`${d.prop}: ${value}`);
        break;
      }
      case 'opacity': {
        const n = Number.parseFloat(value);
        if (Number.isFinite(n)) values.autoAlpha = String(Math.round(Math.max(0, Math.min(1, n)) * 100));
        else dropped.push(`${d.prop}: ${value}`);
        break;
      }
      case 'transform': {
        const t = transformValues(value);
        Object.assign(values, t.values);
        for (const fn of t.dropped) dropped.push(`transform: ${fn}`);
        break;
      }
      case 'width':
      case 'height':
        if (LENGTH_RE.test(value)) values[d.prop] = value;
        else dropped.push(`${d.prop}: ${value}`);
        break;
      case 'display':
        values.display = value === 'none' ? 'hidden' : 'visible';
        break;
      default:
        dropped.push(`${d.prop}: ${value}`);
    }
  }
  return { values, dropped };
}

/**
 * The open state of a toggle as a tween: `to` from the state rule, `from` for
 * the same keys from the element's resting declarations (its own class rules),
 * else ycode's resting defaults (`rotation: 0deg`, `scale: 1`, …). A key with
 * no known resting value (a background colour the class never sets) is left
 * out of `from`; GSAP then starts from the rendered value.
 *
 * `options.fallback` supplies resting values for exactly those keys (the tab
 * interaction needs an explicit value to return a tab to when another one is
 * clicked); a key still without one is then dropped and named.
 */
export function stateTweenFromDeclarations(decls: CssDeclaration[], resting: CssDeclaration[], options: { fallback?: TweenProperties } = {}): StateTweenPlan {
  const open = tweenValuesOf(decls);
  const rest = tweenValuesOf(resting).values;
  const from: TweenProperties = {};
  const to: TweenProperties = {};
  const dropped = [...open.dropped];
  for (const key of Object.keys(open.values) as TweenPropertyKey[]) {
    const r = rest[key] ?? RESTING[key] ?? options.fallback?.[key];
    if (r !== undefined) from[key] = r;
    else if (options.fallback) {
      dropped.push(`${key}: no resting value to return to (the element's own classes never set it)`);
      continue;
    }
    to[key] = open.values[key];
  }
  return { to, from, dropped };
}

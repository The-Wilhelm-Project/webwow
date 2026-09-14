/**
 * Webflow IX2 interactions -> ycode `LayerInteraction`s.
 *
 * Events become triggers (hover / click / scroll-into-view / load /
 * while-scrolling), action lists become tweens on the layers the IX2 targets
 * resolve to (`findings-ix2-css §4`). A MOUSE_OVER / MOUSE_OUT pair (linked by
 * `autoStopEventId`) is ONE hover interaction with `yoyo: true` built from the
 * OVER list — ycode reverses the timeline on mouse-leave; the OUT list's own
 * easing is lost. SCROLL_INTO_VIEW / SCROLL_OUT_OF_VIEW pairs likewise become
 * one scroll-into-view interaction with `toggleActions: 'play reverse play reverse'`.
 *
 * Timing: IX2 groups play sequentially, items within a group in parallel.
 * `useFirstGroupAsInitialState` (and instant, 0 ms items) provide `from`
 * values for the later tweens on the same key/target; leftovers become 0.001 s
 * set-tweens. Tweens on the same layer with identical position, duration and
 * ease are merged so `growBigIn` yields one `{ autoAlpha, scale }` tween.
 *
 * Unsupported events / action types / eases are reported through `Warnings`
 * (`ix2_unsupported_event`, `ix2_unsupported_action`, `ix2_no_targets`,
 * `ix2_ease_approximated`) — never thrown.
 */

import { generateId } from '@/lib/utils';
import type { ApplyStyles, Breakpoint, InteractionTween, Layer, LayerInteraction, TweenPropertyKey, TweenProperties } from '@/types';
import type { Ix2ActionItem, Ix2ActionList, Ix2Data, Ix2Event, Ix2Target } from './ix2-parse';
import type { WfNode, WfPage } from './types';
import type { Warnings } from './warnings';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface Ix2MapDeps {
  data: Ix2Data;
  pages: WfPage[];
  /** `wf.id` -> converted layer (the layer objects are mutated: interactions are pushed onto trigger layers). */
  layerByNode: Map<string, Layer>;
  warn: Warnings;
}

export interface MappedInteraction {
  page: string;
  triggerLayerId: string;
  interaction: LayerInteraction;
}

export type Trigger = LayerInteraction['trigger'];
export type TweenValues = Partial<Record<TweenPropertyKey, string>>;

// ─── Easing ───────────────────────────────────────────────────────────────────

const EASE_TABLE: Record<string, string> = {
  '': 'none',
  linear: 'none',
  none: 'none',
  ease: 'power1.inOut',
  easein: 'power1.in',
  easeout: 'power1.out',
  easeinout: 'power1.inOut',
  swingfrom: 'back.in',
  swingto: 'back.out',
  swingfromto: 'back.inOut',
  bounce: 'bounce.out',
  outbounce: 'bounce.out',
  bouncepast: 'bounce.out',
  inbounce: 'bounce.in',
  inoutbounce: 'bounce.inOut',
};

const EASE_FAMILIES: Record<string, string> = {
  quad: 'power1',
  cubic: 'power2',
  quart: 'power3',
  quint: 'power4',
  sine: 'sine',
  expo: 'expo',
  circ: 'circ',
  back: 'back',
  elastic: 'elastic',
};

/** Named ease curves used to approximate custom cubic-bezier arrays (`t` in [0, 1]). */
const EASE_FUNCTIONS: Record<string, (t: number) => number> = (() => {
  const out: Record<string, (t: number) => number> = { none: (t) => t };
  const power = (p: number) => ({
    in: (t: number) => t ** p,
    out: (t: number) => 1 - (1 - t) ** p,
    inOut: (t: number) => (t < 0.5 ? 2 ** (p - 1) * t ** p : 1 - (-2 * t + 2) ** p / 2),
  });
  const families: Record<string, { in: (t: number) => number; out: (t: number) => number; inOut: (t: number) => number }> = {
    power1: power(2),
    power2: power(3),
    power3: power(4),
    power4: power(5),
    sine: {
      in: (t) => 1 - Math.cos((t * Math.PI) / 2),
      out: (t) => Math.sin((t * Math.PI) / 2),
      inOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
    },
    expo: {
      in: (t) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
      out: (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
      inOut: (t) => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2),
    },
    circ: {
      in: (t) => 1 - Math.sqrt(1 - t ** 2),
      out: (t) => Math.sqrt(1 - (t - 1) ** 2),
      inOut: (t) => (t < 0.5 ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2 : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2),
    },
    back: {
      in: (t) => 2.70158 * t ** 3 - 1.70158 * t ** 2,
      out: (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
      inOut: (t) => {
        const c2 = 1.70158 * 1.525;
        return t < 0.5 ? ((2 * t) ** 2 * ((c2 + 1) * 2 * t - c2)) / 2 : ((2 * t - 2) ** 2 * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
      },
    },
  };
  for (const [name, fns] of Object.entries(families)) {
    out[`${name}.in`] = fns.in;
    out[`${name}.out`] = fns.out;
    out[`${name}.inOut`] = fns.inOut;
  }
  return out;
})();

function bezierY(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const bx = (s: number) => 3 * (1 - s) ** 2 * s * x1 + 3 * (1 - s) * s ** 2 * x2 + s ** 3;
  const by = (s: number) => 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s ** 2 * y2 + s ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < x) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

/**
 * Webflow easing name (or `[x1, y1, x2, y2]` bezier) -> GSAP ease. Custom
 * curves are approximated by the nearest named ease sampled at t = .25/.5/.75.
 */
export function mapEase(webflowEase: string | number[] | undefined): { ease: string; approximated: boolean } {
  if (Array.isArray(webflowEase)) {
    if (webflowEase.length !== 4 || webflowEase.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return { ease: 'power2.out', approximated: true };
    const [x1, y1, x2, y2] = webflowEase;
    const samples = [0.25, 0.5, 0.75].map((x) => bezierY(x1, y1, x2, y2, x));
    let best = 'none';
    let bestError = Number.POSITIVE_INFINITY;
    for (const [name, fn] of Object.entries(EASE_FUNCTIONS)) {
      const error = [0.25, 0.5, 0.75].reduce((sum, x, i) => sum + (fn(x) - samples[i]) ** 2, 0);
      if (error < bestError) {
        bestError = error;
        best = name;
      }
    }
    return { ease: best, approximated: true };
  }
  const key = (webflowEase ?? '').trim().toLowerCase();
  if (key in EASE_TABLE) return { ease: EASE_TABLE[key], approximated: false };
  const m = key.match(/^(in|out|inout)?(quad|cubic|quart|quint|sine|expo|circ|back|elastic)$/);
  if (m) {
    const dir = m[1] === 'inout' ? 'inOut' : (m[1] ?? 'out');
    return { ease: `${EASE_FAMILIES[m[2]]}.${dir}`, approximated: false };
  }
  return { ease: 'none', approximated: true };
}

// ─── Action items ─────────────────────────────────────────────────────────────

const UNSUPPORTED_ACTIONS = new Set([
  'STYLE_TEXT_COLOR', 'STYLE_BORDER', 'STYLE_FONT_VARIATION', 'OBJECT_VALUE', 'GENERAL_COMBO_CLASS', 'GENERAL_LOOP',
]);

function unit(u: string | undefined, fallback: string): string {
  const v = (u ?? '').trim().toLowerCase();
  return v === '' ? fallback : v;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

function targetLabel(item: Ix2ActionItem): string {
  const t = item.config?.target;
  if (!t) return 'trigger';
  if (t.selector) return t.selector;
  if (t.useEventTarget === true) return 'trigger element';
  if (t.id && t.id !== 'N/A') return `#${t.id}`;
  return 'trigger';
}

/**
 * IX2 action item -> tween key/value pairs (findings-ix2-css §4.2); null when
 * the action type has no ycode tween key (reported as `ix2_unsupported_action`)
 * or no key survived (e.g. `STYLE_SIZE` with `AUTO` units).
 */
export function actionItemToTween(item: Ix2ActionItem, warn?: Warnings): TweenValues | null {
  const cfg = item.config ?? {};
  const type = item.actionTypeId;
  const out: TweenValues = {};
  const note = (message: string) => warn?.add('ix2_unsupported_action', message);
  switch (type) {
    case 'TRANSFORM_MOVE': {
      const x = num(cfg.xValue);
      const y = num(cfg.yValue);
      if (x !== null) out.x = `${x}${unit(cfg.xUnit, 'px')}`;
      if (y !== null) out.y = `${y}${unit(cfg.yUnit, 'px')}`;
      const z = num(cfg.zValue);
      if (z !== null && z !== 0) note(`TRANSFORM_MOVE z axis (${z}) ignored on ${targetLabel(item)}`);
      break;
    }
    case 'TRANSFORM_SCALE': {
      const x = num(cfg.xValue) ?? num(cfg.yValue);
      const y = num(cfg.yValue);
      if (x !== null) out.scale = String(x);
      if (x !== null && y !== null && x !== y) note(`TRANSFORM_SCALE uses x=${x} (y=${y}) on ${targetLabel(item)} — ycode has one scale value`);
      break;
    }
    case 'TRANSFORM_ROTATE': {
      const z = num(cfg.zValue) ?? 0;
      out.rotation = `${z}deg`;
      if ((num(cfg.xValue) ?? 0) !== 0 || (num(cfg.yValue) ?? 0) !== 0) note(`TRANSFORM_ROTATE x/y rotation ignored on ${targetLabel(item)}`);
      break;
    }
    case 'TRANSFORM_SKEW': {
      const x = num(cfg.xValue);
      const y = num(cfg.yValue);
      if (x !== null) out.skewX = `${x}deg`;
      if (y !== null) out.skewY = `${y}deg`;
      break;
    }
    case 'STYLE_OPACITY': {
      const v = num(cfg.value);
      if (v !== null) out.autoAlpha = String(Math.round(v * 100));
      break;
    }
    case 'STYLE_SIZE': {
      const w = num(cfg.widthValue);
      const h = num(cfg.heightValue);
      const wu = unit(cfg.widthUnit, 'px');
      const hu = unit(cfg.heightUnit, 'px');
      if (w !== null) {
        if (wu === 'auto') note(`STYLE_SIZE width AUTO cannot be tweened on ${targetLabel(item)}`);
        else out.width = `${w}${wu}`;
      }
      if (h !== null) {
        if (hu === 'auto') note(`STYLE_SIZE height AUTO cannot be tweened on ${targetLabel(item)}`);
        else out.height = `${h}${hu}`;
      }
      break;
    }
    case 'STYLE_BACKGROUND_COLOR': {
      const r = num(cfg.rValue);
      const g = num(cfg.gValue);
      const b = num(cfg.bValue);
      if (r === null || g === null || b === null) break;
      const a = num(cfg.aValue) ?? 1;
      const hex = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
      out.backgroundColor = a >= 1 ? hex : `${hex}/${Math.round(a * 100)}`;
      break;
    }
    case 'STYLE_FILTER': {
      const filters = Array.isArray(cfg.filters) ? (cfg.filters as { type?: string; value?: number; unit?: string }[]) : [];
      for (const f of filters) {
        const v = num(f.value);
        if (v === null) continue;
        if (f.type === 'blur') out.filterBlur = String(v);
        else if (f.type === 'brightness') out.filterBrightness = String(v / 100);
        else if (f.type === 'grayscale') out.filterGrayscale = String(v);
        else note(`STYLE_FILTER ${f.type ?? 'unknown'} is not supported on ${targetLabel(item)}`);
      }
      break;
    }
    case 'GENERAL_DISPLAY': {
      out.display = cfg.value === 'none' ? 'hidden' : 'visible';
      break;
    }
    default:
      if (UNSUPPORTED_ACTIONS.has(type) || type.startsWith('PLUGIN_') || type.startsWith('STYLE_') || type.startsWith('GENERAL_')) {
        note(`unsupported action ${type} on ${targetLabel(item)}`);
      } else {
        note(`unknown action ${type} on ${targetLabel(item)}`);
      }
      return null;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ─── Selector / target resolution ─────────────────────────────────────────────

function selectorClasses(selector: string): string[] {
  const compound = selector.trim().split(/\s*[>\s+~]\s*/).filter(Boolean).pop() ?? '';
  return compound.split('.').map((c) => c.trim()).filter(Boolean);
}

/** Nodes whose `classNames` contain every class of the compound selector (`.a.b`). */
export function matchSelector(selector: string, nodes: Iterable<WfNode>): WfNode[] {
  const classes = selectorClasses(selector);
  if (classes.length === 0) return [];
  const out: WfNode[] = [];
  for (const node of nodes) {
    if (classes.every((c) => node.wf.classNames.includes(c))) out.push(node);
  }
  return out;
}

interface PageIndex {
  page: WfPage;
  nodes: WfNode[];
  parent: Map<string, WfNode>;
  rootLayerNode?: WfNode;
}

function indexPage(page: WfPage): PageIndex {
  const nodes: WfNode[] = [];
  const parent = new Map<string, WfNode>();
  const walk = (list: WfNode[], p?: WfNode) => {
    for (const n of list) {
      nodes.push(n);
      if (p) parent.set(n.wf.id, p);
      if (n.children) walk(n.children, n);
    }
  };
  walk(page.roots);
  return { page, nodes, parent, rootLayerNode: page.roots[0] };
}

function descendants(node: WfNode): WfNode[] {
  const out: WfNode[] = [];
  const walk = (list: WfNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.children) walk(n.children);
    }
  };
  walk(node.children ?? []);
  return out;
}

function ancestors(node: WfNode, index: PageIndex): WfNode[] {
  const out: WfNode[] = [];
  let cur = index.parent.get(node.wf.id);
  while (cur) {
    out.push(cur);
    cur = index.parent.get(cur.wf.id);
  }
  return out;
}

function matchesId(node: WfNode, id: string): boolean {
  const wId = node.wf.wId;
  return !!wId && (wId === id || wId.startsWith(`${id}_instance`));
}

function itemTargets(target: Ix2Target | undefined, trigger: WfNode, index: PageIndex): WfNode[] {
  if (!target || target.useEventTarget === true || target.appliesTo === 'TRIGGER_ELEMENT') return [trigger];
  const selector = target.selector ?? '';
  const byClass = (pool: WfNode[]) => (selector ? matchSelector(selector, pool) : target.id && target.id !== 'N/A' ? pool.filter((n) => matchesId(n, target.id!)) : []);
  let out: WfNode[];
  switch (target.useEventTarget) {
    case 'CHILDREN':
      out = byClass(descendants(trigger));
      break;
    case 'IMMEDIATE_CHILDREN':
      out = byClass(trigger.children ?? []);
      break;
    case 'SIBLINGS': {
      const parent = index.parent.get(trigger.wf.id);
      const siblings = (parent ? parent.children ?? [] : index.page.roots).filter((n) => n !== trigger);
      out = byClass(siblings);
      break;
    }
    case 'PARENT':
      out = byClass(ancestors(trigger, index));
      break;
    default:
      out = byClass(index.nodes);
  }
  if (target.boundaryMode) {
    const boundary = ancestors(trigger, index).find((n) => n.wf.role === 'dyn-item') ?? (trigger.wf.role === 'dyn-item' ? trigger : undefined);
    if (boundary) {
      const inside = new Set(descendants(boundary).map((n) => n.wf.id));
      inside.add(boundary.wf.id);
      out = out.filter((n) => inside.has(n.wf.id));
    }
  }
  return out;
}

// ─── Events ───────────────────────────────────────────────────────────────────

const LOAD_EVENTS = new Set(['PAGE_START', 'PAGE_FINISH', 'PAGE_SCROLL_UP', 'PAGE_SCROLL_DOWN']);
const CONTINUOUS_EVENTS = new Set(['SCROLLING_IN_VIEW', 'MOUSE_MOVE_IN_VIEWPORT', 'MOUSE_MOVE_OVER_ELEMENT', 'PAGE_SCROLL']);

function breakpointsOf(event: Ix2Event): Breakpoint[] {
  const queries = event.mediaQueries ?? [];
  if (queries.length === 0) return ['desktop', 'tablet', 'mobile'];
  const out: Breakpoint[] = [];
  const add = (b: Breakpoint) => {
    if (!out.includes(b)) out.push(b);
  };
  for (const q of queries) {
    if (q === 'main') add('desktop');
    else if (q === 'medium') add('tablet');
    else if (q === 'small' || q === 'tiny') add('mobile');
  }
  return out.length > 0 ? out : ['desktop', 'tablet', 'mobile'];
}

function actionListIdOf(event: Ix2Event): string | undefined {
  const id = event.action?.config?.actionListId;
  return typeof id === 'string' && id ? id : undefined;
}

function playsInReverse(event: Ix2Event): boolean {
  return event.action?.config?.playInReverse === true || event.config?.playInReverse === true;
}

function scrollStartOf(event: Ix2Event): string {
  const v = num(event.config?.scrollOffsetValue) ?? 0;
  const u = (event.config?.scrollOffsetUnit ?? '%').toString().toLowerCase();
  if (u === '%') return v === 0 ? 'top bottom' : `top ${100 - v}%`;
  return v === 0 ? 'top bottom' : `top bottom-=${v}px`;
}

const RESTING: Partial<Record<TweenPropertyKey, string>> = {
  scale: '1',
  x: '0px',
  y: '0px',
  rotation: '0deg',
  skewX: '0deg',
  skewY: '0deg',
  autoAlpha: '100',
  display: 'visible',
  filterBlur: '0',
  filterBrightness: '1',
  filterGrayscale: '0',
};

interface PendingTween {
  layerId: string;
  nodeId: string;
  position: number;
  duration: number;
  ease: string;
  from: TweenValues;
  to: TweenValues;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

class Ix2Mapper {
  private readonly indexes: PageIndex[];
  private readonly pageByWfId = new Map<string, PageIndex>();
  private readonly itemCache = new Map<Ix2ActionItem, TweenValues | null>();
  private readonly easeWarned = new Set<string>();
  readonly items: MappedInteraction[] = [];
  readonly definitions = new Set<string>();

  constructor(private readonly deps: Ix2MapDeps) {
    this.indexes = deps.pages.map(indexPage);
    for (const idx of this.indexes) if (idx.page.wfPageId) this.pageByWfId.set(idx.page.wfPageId, idx);
  }

  private warn(code: 'ix2_unsupported_event' | 'ix2_unsupported_action' | 'ix2_no_targets' | 'ix2_ease_approximated', message: string, page?: string): void {
    this.deps.warn.add(code, message, page ? { page } : undefined);
  }

  private ease(raw: unknown): string {
    const value = Array.isArray(raw) ? (raw as number[]) : typeof raw === 'string' ? raw : undefined;
    const { ease, approximated } = mapEase(value);
    if (approximated) {
      const key = JSON.stringify(value ?? '');
      if (!this.easeWarned.has(key)) {
        this.easeWarned.add(key);
        this.warn('ix2_ease_approximated', `easing ${key} approximated by ${ease}`);
      }
    }
    return ease;
  }

  private values(item: Ix2ActionItem): TweenValues | null {
    if (this.itemCache.has(item)) return this.itemCache.get(item) ?? null;
    const v = actionItemToTween(item, this.deps.warn);
    this.itemCache.set(item, v);
    return v;
  }

  run(): void {
    const events = Object.values(this.deps.data.events ?? {});
    const byId = new Map(events.map((e) => [e.id, e]));
    const secondary = new Set<string>();
    const partnerOf = new Map<string, Ix2Event>();
    for (const e of events) {
      const stopId = e.action?.config?.autoStopEventId;
      const partner = typeof stopId === 'string' ? byId.get(stopId) : undefined;
      if (!partner) continue;
      if (e.eventTypeId === 'MOUSE_OVER' && partner.eventTypeId === 'MOUSE_OUT') {
        partnerOf.set(e.id, partner);
        secondary.add(partner.id);
      } else if (e.eventTypeId === 'SCROLL_INTO_VIEW' && partner.eventTypeId === 'SCROLL_OUT_OF_VIEW') {
        partnerOf.set(e.id, partner);
        secondary.add(partner.id);
      } else if (e.eventTypeId === 'MOUSE_CLICK' && partner.eventTypeId === 'MOUSE_CLICK' && !playsInReverse(e) && playsInReverse(partner)) {
        partnerOf.set(e.id, partner);
        secondary.add(partner.id);
      }
    }
    for (const event of events) {
      if (secondary.has(event.id)) continue;
      this.mapEvent(event, partnerOf.get(event.id));
    }
  }

  private mapEvent(event: Ix2Event, partner: Ix2Event | undefined): void {
    const type = event.eventTypeId;
    let trigger: Trigger;
    let yoyo = false;
    const timelineExtra: Partial<LayerInteraction['timeline']> = {};
    if (type === 'MOUSE_OVER') {
      trigger = 'hover';
      yoyo = true;
    } else if (type === 'MOUSE_CLICK') {
      trigger = 'click';
      yoyo = partner !== undefined;
    } else if (type === 'SCROLL_INTO_VIEW') {
      trigger = 'scroll-into-view';
      timelineExtra.scrollStart = scrollStartOf(event);
      timelineExtra.toggleActions = partner ? 'play reverse play reverse' : 'play none none none';
    } else if (LOAD_EVENTS.has(type)) {
      trigger = 'load';
    } else if (CONTINUOUS_EVENTS.has(type) || event.action?.actionTypeId === 'GENERAL_CONTINUOUS_ACTION') {
      if (type !== 'SCROLLING_IN_VIEW' && type !== 'PAGE_SCROLL') {
        this.warn('ix2_unsupported_event', `unsupported event ${type} (${event.target?.selector ?? event.target?.id ?? event.id})`);
        return;
      }
      trigger = 'while-scrolling';
      timelineExtra.scrub = true;
      timelineExtra.scrollStart = 'top bottom';
      timelineExtra.scrollEnd = 'bottom top';
    } else {
      this.warn('ix2_unsupported_event', `unsupported event ${type} (${event.target?.selector ?? event.target?.id ?? event.id})`);
      return;
    }

    const listId = actionListIdOf(event);
    const list = listId ? this.deps.data.actionLists?.[listId] : undefined;
    if (!list) {
      this.warn('ix2_unsupported_event', `event ${event.id} references a missing action list ${listId ?? '(none)'}`);
      return;
    }

    const triggers = this.triggerNodes(event);
    if (triggers.length === 0) {
      const label = event.target?.selector ?? event.target?.id ?? event.id;
      this.warn('ix2_no_targets', `trigger ${label} matched no element`);
      return;
    }

    const breakpoints = breakpointsOf(event);
    const repeat = event.config?.loop ? -1 : 0;
    const applyMode: ApplyStyles = trigger === 'hover' || trigger === 'click' ? 'on-trigger' : 'on-load';

    for (const { node, index } of triggers) {
      const triggerLayer = this.deps.layerByNode.get(node.wf.id);
      if (!triggerLayer) continue;
      const pending = trigger === 'while-scrolling' ? this.continuousTweens(list, node, index) : this.sequentialTweens(list, node, index);
      if (pending.length === 0) continue;
      const tweens: InteractionTween[] = mergeTweens(pending).map((t) => {
        const apply: InteractionTween['apply_styles'] = {};
        for (const key of Object.keys(t.to) as TweenPropertyKey[]) apply[key] = applyMode;
        return {
          id: generateId('twn'),
          layer_id: t.layerId,
          position: t.position,
          duration: t.duration,
          ease: t.ease,
          from: t.from as TweenProperties,
          to: t.to as TweenProperties,
          apply_styles: apply,
        };
      });
      const interaction: LayerInteraction = {
        id: generateId('int'),
        trigger,
        timeline: { breakpoints, repeat, yoyo, ...timelineExtra },
        tweens,
      };
      triggerLayer.interactions = [...(triggerLayer.interactions ?? []), interaction];
      this.items.push({ page: index.page.name, triggerLayerId: triggerLayer.id, interaction });
      this.definitions.add(event.id);
    }
  }

  private triggerNodes(event: Ix2Event): { node: WfNode; index: PageIndex }[] {
    const target = event.target ?? event.targets?.[0];
    const out: { node: WfNode; index: PageIndex }[] = [];
    if (!target) {
      for (const index of this.indexes) if (index.rootLayerNode) out.push({ node: index.rootLayerNode, index });
      return out;
    }
    if (target.appliesTo === 'PAGE' || (!target.selector && !target.id)) {
      for (const index of this.indexes) if (index.rootLayerNode) out.push({ node: index.rootLayerNode, index });
      return out;
    }
    if (target.selector) {
      for (const index of this.indexes) for (const node of matchSelector(target.selector, index.nodes)) out.push({ node, index });
      return out;
    }
    if (target.id) {
      let id = target.id;
      let scope: PageIndex[] = this.indexes;
      const bar = id.indexOf('|');
      if (bar !== -1) {
        const pageId = id.slice(0, bar);
        id = id.slice(bar + 1);
        const page = this.pageByWfId.get(pageId);
        scope = page ? [page] : [];
      }
      for (const index of scope) for (const node of index.nodes) if (matchesId(node, id)) out.push({ node, index });
    }
    return out;
  }

  private resolveTargets(item: Ix2ActionItem, trigger: WfNode, index: PageIndex): { node: WfNode; layerId: string }[] {
    const out: { node: WfNode; layerId: string }[] = [];
    for (const node of itemTargets(item.config?.target, trigger, index)) {
      const layer = this.deps.layerByNode.get(node.wf.id);
      if (layer) out.push({ node, layerId: layer.id });
    }
    if (out.length === 0) this.warn('ix2_no_targets', `action ${item.actionTypeId} target ${targetLabel(item)} matched no element`, index.page.name);
    return out;
  }

  /** Groups play sequentially, items in parallel; group 0 with `useFirstGroupAsInitialState` and 0 ms items are `from` values. */
  private sequentialTweens(list: Ix2ActionList, trigger: WfNode, index: PageIndex): PendingTween[] {
    const groups = list.actionItemGroups ?? [];
    const initial = new Map<string, { position: number; values: TweenValues }>();
    const pendingSets = new Map<string, Map<TweenPropertyKey, { value: string; position: number }>>();
    const lastTo = new Map<string, TweenValues>();
    const out: PendingTween[] = [];
    let groupStart = 0;

    const setPending = (nodeId: string, key: TweenPropertyKey, value: string, position: number) => {
      let m = pendingSets.get(nodeId);
      if (!m) {
        m = new Map();
        pendingSets.set(nodeId, m);
      }
      m.set(key, { value, position });
    };

    groups.forEach((group, gi) => {
      const isInitial = gi === 0 && list.useFirstGroupAsInitialState === true;
      let groupEnd = 0;
      for (const item of group.actionItems ?? []) {
        const to = this.values(item);
        if (!to) continue;
        const targets = this.resolveTargets(item, trigger, index);
        if (targets.length === 0) continue;
        const delayMs = num(item.config?.delay) ?? 0;
        const durationMs = num(item.config?.duration) ?? 0;
        if (!isInitial) groupEnd = Math.max(groupEnd, (delayMs + durationMs) / 1000);
        const position = round3(isInitial ? 0 : groupStart + delayMs / 1000);
        for (const { node, layerId } of targets) {
          if (isInitial || durationMs <= 0) {
            for (const [key, value] of Object.entries(to) as [TweenPropertyKey, string][]) setPending(node.wf.id, key, value, position);
            if (isInitial) initial.set(node.wf.id, { position, values: { ...(initial.get(node.wf.id)?.values ?? {}), ...to } });
            continue;
          }
          const from: TweenValues = {};
          const toCopy: TweenValues = { ...to };
          for (const key of Object.keys(toCopy) as TweenPropertyKey[]) {
            const pending = pendingSets.get(node.wf.id)?.get(key);
            if (pending) {
              from[key] = pending.value;
              pendingSets.get(node.wf.id)!.delete(key);
              continue;
            }
            const previous = lastTo.get(node.wf.id)?.[key];
            if (previous !== undefined) {
              from[key] = previous;
              continue;
            }
            const resting = RESTING[key];
            if (resting !== undefined) {
              from[key] = resting;
              continue;
            }
            this.warn('ix2_unsupported_action', `${item.actionTypeId} on ${targetLabel(item)} has no initial ${key} value; key skipped`, index.page.name);
            delete toCopy[key];
          }
          if (Object.keys(toCopy).length === 0) continue;
          out.push({ layerId, nodeId: node.wf.id, position, duration: Math.max(durationMs / 1000, 0.001), ease: this.ease(item.config?.easing), from, to: toCopy });
          lastTo.set(node.wf.id, { ...(lastTo.get(node.wf.id) ?? {}), ...toCopy });
        }
      }
      if (!isInitial) groupStart = round3(groupStart + groupEnd);
    });

    // Leftover set-values (never animated afterwards) become instant tweens.
    for (const [nodeId, sets] of pendingSets) {
      const layerId = this.deps.layerByNode.get(nodeId)?.id;
      if (!layerId) continue;
      for (const [key, { value, position }] of sets) {
        const previous = lastTo.get(nodeId)?.[key] ?? RESTING[key] ?? value;
        out.push({ layerId, nodeId, position, duration: 0.001, ease: 'none', from: { [key]: previous }, to: { [key]: value } });
      }
    }
    return out;
  }

  /** Keyframe lists (`continuousParameterGroups`): keyframe % -> position on a 1 s scrubbed timeline. */
  private continuousTweens(list: Ix2ActionList, trigger: WfNode, index: PageIndex): PendingTween[] {
    const out: PendingTween[] = [];
    const group = list.continuousParameterGroups?.[0];
    const frames = [...(group?.continuousActionGroups ?? [])].sort((a, b) => a.keyframe - b.keyframe);
    const lastTo = new Map<string, TweenValues>();
    frames.forEach((frame, fi) => {
      const position = round3(frame.keyframe / 100);
      const next = frames[fi + 1];
      const duration = next ? Math.max((next.keyframe - frame.keyframe) / 100, 0.001) : 0.001;
      for (const item of frame.actionItems ?? []) {
        const to = this.values(item);
        if (!to) continue;
        const targets = this.resolveTargets(item, trigger, index);
        for (const { node, layerId } of targets) {
          const from: TweenValues = {};
          for (const key of Object.keys(to) as TweenPropertyKey[]) {
            from[key] = lastTo.get(node.wf.id)?.[key] ?? RESTING[key] ?? to[key]!;
          }
          out.push({ layerId, nodeId: node.wf.id, position, duration, ease: 'none', from, to: { ...to } });
          lastTo.set(node.wf.id, { ...(lastTo.get(node.wf.id) ?? {}), ...to });
        }
      }
    });
    return out;
  }
}

/** Merge tweens on the same layer with identical position / duration / ease into one multi-key tween. */
function mergeTweens(pending: PendingTween[]): PendingTween[] {
  const out: PendingTween[] = [];
  for (const t of pending) {
    const existing = out.find((o) => o.layerId === t.layerId && o.position === t.position && o.duration === t.duration && o.ease === t.ease);
    if (existing && !Object.keys(t.to).some((k) => k in existing.to)) {
      Object.assign(existing.from, t.from);
      Object.assign(existing.to, t.to);
      continue;
    }
    out.push({ ...t, from: { ...t.from }, to: { ...t.to } });
  }
  return out.sort((a, b) => a.position - b.position);
}

/**
 * Map every IX2 event onto the converted layers. `definitions` counts events
 * that produced at least one interaction, `instances` the interaction objects
 * (one per trigger layer — before component extraction every page copy counts).
 */
export function mapInteractions(deps: Ix2MapDeps): { items: MappedInteraction[]; definitions: number; instances: number } {
  const mapper = new Ix2Mapper(deps);
  mapper.run();
  return { items: mapper.items, definitions: mapper.definitions.size, instances: mapper.items.length };
}

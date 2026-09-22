/**
 * Tailwind v3 → v4 class normalizer and named color resolver.
 *
 * Handles renaming deprecated utilities, merging standalone opacity
 * classes into color modifiers, rescaling rounded/shadow/blur sizes,
 * and converting named Tailwind colors to hex arbitrary values.
 */

import { TAILWIND_COLORS, SINGLE_COLORS } from '@/lib/tailwind-colors';

// ─── Tailwind v3 → v4 Normalizer ───

const V3_TO_V4_RENAMES: Record<string, string> = {
  'flex-grow': 'grow',
  'flex-grow-0': 'grow-0',
  'flex-shrink': 'shrink',
  'flex-shrink-0': 'shrink-0',
  'overflow-ellipsis': 'text-ellipsis',
  'decoration-clone': 'box-decoration-clone',
  'decoration-slice': 'box-decoration-slice',
  'outline-none': 'outline-hidden',
  'ring': 'ring-3',
  'shadow-inner': 'inset-shadow-sm',
  'break-words': 'wrap-break-word',
  'transform': '',
  'filter': '',
  'backdrop-filter': '',
};

const OPACITY_RE = /^(bg|text|border|ring|divide|placeholder)-opacity-(?:(\d+)|\[(\d+)%?\])$/;
const NAMED_COLOR_RE = /^[a-z]+-\d{2,3}$/;
const SIZE_VALUE_RE = /^\d|(?:px|em|rem|%|vh|vw|ch|ex|svh|dvh|lvh)$/;

const VARIANT_PREFIX_RE = /^((?:[a-z0-9-]+:)+)/;

function splitVariantPrefix(cls: string): [string, string] {
  const m = cls.match(VARIANT_PREFIX_RE);
  return m ? [m[1], cls.slice(m[1].length)] : ['', cls];
}

function isArbitraryColorClass(_prefix: string, rest: string): boolean {
  if (!rest.startsWith('[')) return false;
  const inner = rest.slice(1, rest.indexOf(']'));
  if (SIZE_VALUE_RE.test(inner)) return false;
  return true;
}

const V3_TO_V4_SCALE: Record<string, string> = {
  '': 'sm', 'sm': 'xs',
};

const ROUNDED_RE = /^rounded(-(?:t|r|b|l|tl|tr|bl|br|s|e|ss|se|es|ee))?(?:-(sm|md|lg|xl|2xl|3xl))?$/;

function renameScaledUtility(cls: string): string | null {
  const roundedMatch = cls.match(ROUNDED_RE);
  if (roundedMatch) {
    const dir = roundedMatch[1] || '';
    const size = roundedMatch[2] || '';
    if (!(size in V3_TO_V4_SCALE)) return null;
    const v4 = V3_TO_V4_SCALE[size];
    return `rounded${dir}${v4 ? `-${v4}` : ''}`;
  }

  for (const pfx of ['drop-shadow', 'shadow', 'backdrop-blur', 'blur'] as const) {
    if (cls === pfx || cls.startsWith(`${pfx}-`)) {
      const rest = cls.slice(pfx.length);
      const m = rest.match(/^(?:-(sm|md|lg|xl|2xl|3xl))?$/);
      if (!m) return null;
      const size = m[1] || '';
      if (!(size in V3_TO_V4_SCALE)) return null;
      const v4 = V3_TO_V4_SCALE[size];
      return `${pfx}${v4 ? `-${v4}` : ''}`;
    }
  }

  return null;
}

export function normalizeV3ToV4(classes: string[]): string[] {
  const result: string[] = [];
  const opacityEntries: { prefix: string; value: string }[] = [];

  for (const cls of classes) {
    const [variantPrefix, base] = splitVariantPrefix(cls);

    const renamed = V3_TO_V4_RENAMES[base];
    if (renamed !== undefined) {
      if (renamed) result.push(variantPrefix + renamed);
      continue;
    }

    const opMatch = base.match(OPACITY_RE);
    if (opMatch) {
      const opValue = opMatch[2] || opMatch[3];
      if (opValue && opValue !== '100') {
        opacityEntries.push({ prefix: opMatch[1], value: opValue });
      }
      continue;
    }

    if (base.startsWith('bg-gradient-to-')) {
      result.push(variantPrefix + 'bg-linear-to-' + base.slice(15));
      continue;
    }

    const scaled = renameScaledUtility(base);
    if (scaled) {
      result.push(variantPrefix + scaled);
      continue;
    }

    result.push(cls);
  }

  for (const { prefix, value } of opacityEntries) {
    const colorIdx = result.findIndex(cls => {
      if (cls.includes('/')) return false;
      if (!cls.startsWith(`${prefix}-`)) return false;
      const rest = cls.slice(prefix.length + 1);
      if (rest.startsWith('[')) return isArbitraryColorClass(prefix, rest);
      return NAMED_COLOR_RE.test(rest);
    });

    if (colorIdx !== -1) {
      result[colorIdx] = `${result[colorIdx]}/${value}`;
    }
  }

  for (let i = 0; i < result.length; i++) {
    const [vp, base] = splitVariantPrefix(result[i]);
    if (base.startsWith('placeholder-') && !base.includes(':')) {
      result[i] = `${vp}placeholder:text-${base.slice(12)}`;
    }
  }

  return result;
}

// ─── Named Tailwind Color → Hex Resolver ───

const COLOR_UTILITY_PREFIXES = [
  'bg', 'text', 'border', 'ring', 'outline', 'shadow', 'divide',
  'from', 'via', 'to', 'caret', 'accent', 'fill', 'stroke', 'decoration',
];

const NAMED_COLOR_PATTERN = new RegExp(
  `^(${COLOR_UTILITY_PREFIXES.join('|')})-(${Object.keys(TAILWIND_COLORS).join('|')})-(50|100|200|300|400|500|600|700|800|900|950)(?:/(\\d+|\\[.+?\\]))?$`
);

const SINGLE_COLOR_PATTERN = new RegExp(
  `^(${COLOR_UTILITY_PREFIXES.join('|')})-(${Object.keys(SINGLE_COLORS).join('|')})(?:/(\\d+|\\[.+?\\]))?$`
);

export function resolveNamedColors(classes: string[]): string[] {
  return classes.map(cls => {
    const [variantPrefix, base] = splitVariantPrefix(cls);

    const namedMatch = base.match(NAMED_COLOR_PATTERN);
    if (namedMatch) {
      const [, prefix, color, shade, opacity] = namedMatch;
      const hex = TAILWIND_COLORS[color]?.[shade];
      if (hex) {
        return `${variantPrefix}${prefix}-[${hex}]${opacity ? `/${opacity}` : ''}`;
      }
    }

    const singleMatch = base.match(SINGLE_COLOR_PATTERN);
    if (singleMatch) {
      const [, prefix, color, opacity] = singleMatch;
      const value = SINGLE_COLORS[color];
      if (value) {
        if (value === 'transparent' || value === 'currentColor') {
          return cls;
        }
        return `${variantPrefix}${prefix}-[${value}]${opacity ? `/${opacity}` : ''}`;
      }
    }

    return cls;
  });
}

/**
 * Fonts (D10): one custom font row per family, extra weights as residual CSS.
 *
 * ycode's `buildCustomFontsCss` emits one `@font-face` per font row WITHOUT a
 * weight/style descriptor, so two rows of one family would collapse. The
 * weight-400 face (or the closest to it) is uploaded through upstream's
 * `uploadFontFile` and becomes the font row; every other face is stored as a
 * plain asset (`mat.uploadRaw`) and declared via a residual `@font-face` with
 * proper `font-weight` / `font-style` descriptors, which `saveSiteSettings`
 * appends to the site's custom head code together with the residual CSS.
 *
 * Google Fonts requested by a page (`fonts.googleapis.com` links,
 * `WebFont.load`) are installed through `mat.installFont`.
 */

import { getAllFonts } from '@/lib/repositories/fontRepository';
import { uploadFontFile } from '@/lib/font-upload';
import { guessMimeType } from '@/lib/webwow/storage';
import type { CssFontFace } from './css-tokenizer';
import type { WfStyleModel } from './css';
import type { WfMaterializerLike, WfPage } from './types';
import type { WfZipBundle } from './zip';
import type { Warnings } from './warnings';

const FORMAT_BY_EXT: Record<string, string> = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype', eot: 'embedded-opentype' };
const SUPPORTED_EXT = new Set(['ttf', 'otf', 'woff', 'woff2']);

/** `'400'`, `'normal'`, `'bold'`, `'300 700'` -> numeric weight (first value of a range). */
export function fontWeightNumber(weight: string | undefined): number {
  const w = (weight ?? '').trim().toLowerCase();
  if (!w || w === 'normal') return 400;
  if (w === 'bold') return 700;
  const n = Number.parseInt(w.split(/\s+/)[0], 10);
  return Number.isFinite(n) ? n : 400;
}

/** `../fonts/x.woff2` -> the bundle path (`fonts/x.woff2`), or null when the file is not in the export. */
export function resolveFontPath(src: string, zip: WfZipBundle): string | null {
  const clean = src.trim().replace(/[?#].*$/, '').replace(/^(\.\.\/|\.\/|\/)+/, '');
  if (!clean) return null;
  if (zip.files.has(clean)) return clean;
  const base = clean.split('/').pop() ?? clean;
  const alt = `fonts/${base}`;
  if (zip.files.has(alt)) return alt;
  return null;
}

function extensionOf(p: string): string {
  return (p.split('.').pop() ?? '').toLowerCase();
}

function cssString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** `@font-face` declaration for an extra weight hosted at `url`. */
export function residualFontFace(family: string, weight: string, style: string, url: string, format: string): string {
  const src = `url(${cssString(url)})${format ? ` format(${cssString(format)})` : ''}`;
  return `@font-face{font-family:${cssString(family)};font-weight:${weight};font-style:${style};font-display:swap;src:${src}}`;
}

/** Pick the family's primary face: weight 400 first, then the closest weight, normal style preferred. */
export function primaryFace(faces: CssFontFace[]): CssFontFace {
  return [...faces].sort((a, b) => {
    const da = Math.abs(fontWeightNumber(a.weight) - 400);
    const db = Math.abs(fontWeightNumber(b.weight) - 400);
    if (da !== db) return da - db;
    const sa = (a.style || 'normal').toLowerCase() === 'normal' ? 0 : 1;
    const sb = (b.style || 'normal').toLowerCase() === 'normal' ? 0 : 1;
    return sa - sb;
  })[0];
}

export interface InstallFontsResult {
  /** Font rows created (custom uploads + Google installs). */
  fonts: number;
  /** Residual `@font-face` declarations for the extra weights (empty string when none). */
  residualFaces: string;
}

export async function installFonts(model: WfStyleModel, pages: WfPage[], zip: WfZipBundle, mat: WfMaterializerLike, warn: Warnings): Promise<InstallFontsResult> {
  let fonts = 0;
  const residual: string[] = [];

  const existing = new Set<string>();
  try {
    for (const font of await getAllFonts()) {
      existing.add(font.family.trim().toLowerCase());
      existing.add(font.name.trim().toLowerCase());
    }
  } catch (error) {
    warn.add('asset_missing', `could not list existing fonts: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Group faces by family (case-insensitive), keeping the first spelling.
  const families = new Map<string, { family: string; faces: CssFontFace[] }>();
  for (const face of model.fontFaces) {
    const key = face.family.trim().toLowerCase();
    if (!key) continue;
    const entry = families.get(key) ?? { family: face.family.trim(), faces: [] };
    entry.faces.push(face);
    families.set(key, entry);
  }

  for (const [key, { family, faces }] of families) {
    const primary = primaryFace(faces);
    const primaryPath = resolveFontPath(primary.src, zip);
    if (!primaryPath) {
      warn.add('asset_missing', `font file for ${family} (${primary.weight}) is not in the export: ${primary.src}`);
    } else if (existing.has(key)) {
      warn.add('font_extra_weight', `font ${family} already exists; the export's file was not uploaded again`);
    } else if (!SUPPORTED_EXT.has(extensionOf(primaryPath))) {
      warn.add('asset_missing', `font ${family}: unsupported format ${extensionOf(primaryPath)} (${primaryPath})`);
    } else {
      const basename = primaryPath.split('/').pop() ?? primaryPath;
      const buffer = await zip.files.get(primaryPath)!.data();
      const font = await uploadFontFile(new File([new Uint8Array(buffer)], basename, { type: guessMimeType(basename) }), family);
      if (font) {
        fonts++;
        existing.add(key);
      } else {
        warn.add('asset_missing', `font ${family} could not be uploaded (${primaryPath})`);
      }
    }

    for (const face of faces) {
      if (face === primary) continue;
      const facePath = resolveFontPath(face.src, zip);
      if (!facePath) {
        warn.add('asset_missing', `font file for ${family} ${face.weight} ${face.style} is not in the export: ${face.src}`);
        continue;
      }
      const basename = facePath.split('/').pop() ?? facePath;
      const mime = guessMimeType(basename);
      const buffer = await zip.files.get(facePath)!.data();
      const uploaded = await mat.uploadRaw(`fonts/${basename}`, buffer, mime);
      if (!uploaded) {
        warn.add('asset_missing', `extra font weight ${family} ${face.weight} could not be stored (${facePath})`);
        continue;
      }
      const format = face.format ?? FORMAT_BY_EXT[extensionOf(facePath)] ?? '';
      residual.push(residualFontFace(family, String(fontWeightNumber(face.weight)), face.style || 'normal', uploaded.publicUrl, format));
      warn.add('font_extra_weight', `font ${family} ${face.weight} ${face.style || 'normal'} kept as a residual @font-face (ycode stores one file per family)`);
    }
  }

  // Google Fonts requested by the pages.
  const google = new Set<string>();
  for (const page of pages) for (const family of page.googleFontFamilies ?? []) google.add(family.trim());
  for (const family of google) {
    if (!family || existing.has(family.toLowerCase()) || families.has(family.toLowerCase())) continue;
    const font = await mat.installFont(family);
    if (font) {
      fonts++;
      existing.add(family.toLowerCase());
    } else {
      warn.add('asset_missing', `Google font ${family} could not be installed`);
    }
  }

  return { fonts, residualFaces: residual.join('\n') };
}

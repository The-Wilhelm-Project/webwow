/**
 * Site identifiers, slugs and database names (multi-site).
 *
 * Kept free of `server-only` and `@/` imports: this module is loaded by
 * `knexfile.ts` under the knex CLI (ts-node) as well as by the Next bundles.
 * See docs/MULTISITE.md.
 */

import { randomBytes } from 'crypto';

export const DEFAULT_SITE_ID = 'default';

/** `default` or `s_` + 10 chars of [a-z0-9]. */
export const SITE_ID_RE = /^(default|s_[a-z0-9]{10})$/;

/** Lower-case, 1-50 chars, no leading/trailing hyphen. */
export const SITE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

/** Slugs that would collide with the default site, host routing or app paths. */
export const RESERVED_SLUGS = new Set(['default', 'www', 'api', 'mail', 'localhost', 'ycode', 'webwow', 'admin', 'static', 'storage', 'a']);

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** New random site id: `s_` + 10 chars from [a-z0-9] (~51 bits). */
export function newSiteId(): string {
  const bytes = randomBytes(10);
  let out = 's_';
  for (let i = 0; i < 10; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

export function isSiteId(value: unknown): value is string {
  return typeof value === 'string' && SITE_ID_RE.test(value);
}

/** Postgres database name for a site slug (`webwow_site_<slug with - as _>`, at most 62 bytes). */
export function slugToDatabaseName(slug: string): string {
  return `webwow_site_${slug.replace(/-/g, '_')}`;
}

/** Lower-case ASCII slug from a free-form name: `[^a-z0-9]+` -> `-`, trimmed, max 50 chars; empty -> `site`. */
export function slugify(name: string): string {
  const folded = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining diacritics left over from NFKD
    .replace(/ß/g, 'ss')
    .replace(/æ/gi, 'ae')
    .replace(/ø/gi, 'o')
    .replace(/œ/gi, 'oe')
    .toLowerCase();
  const slug = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/g, '');
  return slug || 'site';
}

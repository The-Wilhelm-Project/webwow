/**
 * Signed `x-webwow-site` request header (multi-site).
 *
 * The proxy resolves the site for a request and forwards it as
 * `x-webwow-site: <siteId>.<hmac-sha256-hex(secret, siteId)>`; every consumer
 * verifies the MAC, so a client-supplied header is worthless on every code
 * path (docs/MULTISITE.md, "Security"). Secret = `getSessionSecret()`
 * (`PAGE_AUTH_SECRET`, mandatory in multi-site mode).
 *
 * No `server-only`, no `@/` imports (loaded through knexfile.ts by the knex CLI).
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { getSessionSecret } from '../secret';
import { SITE_ID_RE } from './ids';

function hmacHex(secret: string, siteId: string): string {
  return createHmac('sha256', secret).update(siteId).digest('hex');
}

/** `${siteId}.${hmacSha256Hex(secret, siteId)}` (synchronous, node crypto). */
export function signSiteHeader(siteId: string, secret: string): string {
  if (!SITE_ID_RE.test(siteId)) throw new Error(`[webwow/sites] invalid site id "${siteId}"`);
  return `${siteId}.${hmacHex(secret, siteId)}`;
}

/** Site id from a signed header value, or null when unsigned, tampered or malformed. */
export function verifySiteHeader(value: string, secret: string = getSessionSecret()): string | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const siteId = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!SITE_ID_RE.test(siteId)) return null;
  const expected = hmacHex(secret, siteId);
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac, 'utf8'), Buffer.from(expected, 'utf8'))) return null;
  return siteId;
}

// Per-secret cache of signed values (the proxy signs every request).
const webCryptoCache = new Map<string, Map<string, string>>();
const webCryptoKeys = new Map<string, Promise<CryptoKey>>();

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error('[webwow/sites] Web Crypto is not available');
  return c.subtle;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Same output as `signSiteHeader`, computed with `crypto.subtle` (proxy runtime); cached per secret and site id. */
export async function signSiteHeaderWebCrypto(siteId: string, secret: string): Promise<string> {
  if (!SITE_ID_RE.test(siteId)) throw new Error(`[webwow/sites] invalid site id "${siteId}"`);
  let perSecret = webCryptoCache.get(secret);
  if (!perSecret) {
    perSecret = new Map();
    webCryptoCache.clear(); // a rotated secret invalidates every older entry
    webCryptoKeys.clear();
    webCryptoCache.set(secret, perSecret);
  }
  const cached = perSecret.get(siteId);
  if (cached) return cached;

  let keyPromise = webCryptoKeys.get(secret);
  if (!keyPromise) {
    keyPromise = subtle().importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    webCryptoKeys.set(secret, keyPromise);
  }
  const key = await keyPromise;
  const mac = toHex(await subtle().sign('HMAC', key, new TextEncoder().encode(siteId)));
  const value = `${siteId}.${mac}`;
  if (perSecret.size > 1000) perSecret.clear();
  perSecret.set(siteId, value);
  return value;
}

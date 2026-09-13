/**
 * SSRF-safe, bounded download of remote CMS assets (Webflow CDN only).
 *
 * Rules: https only; host must match the allowlist (defaults + the
 * `WEBWOW_IMPORT_ALLOWED_HOSTS` env var, comma-separated literal hostnames);
 * every resolved address must be public; redirects are followed manually (max
 * 3) and re-validated; the body is streamed with a running byte counter and
 * aborted above `maxBytes`; an optional `ByteBudget` caps the whole import.
 * Never throws — every failure is `{ ok: false, error }`. Because only https
 * URLs on allowlisted hosts pass, the storage fetch-intercept (`/storage/...`)
 * can never be reached from here.
 */

import { promises as dns } from 'dns';
import { isIP } from 'net';
import { guessMimeType } from '@/lib/webwow/storage';

export class ByteBudget {
  used = 0;

  constructor(readonly limit: number) {}

  /** Reserve `n` bytes; false (and nothing reserved) when the budget would be exceeded. */
  take(n: number): boolean {
    if (n < 0) return false;
    if (this.used + n > this.limit) return false;
    this.used += n;
    return true;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }
}

export const DEFAULT_ALLOWED_HOSTS: RegExp[] = [
  /(^|\.)website-files\.com$/i,
  /(^|\.)webflow\.com$/i,
  /(^|\.)webflow\.io$/i,
  /^d3e54v103j8qbb\.cloudfront\.net$/i,
];

export interface SafeFetchOptions {
  /** Default 20 000 ms. */
  timeoutMs?: number;
  /** Default 20 MiB. */
  maxBytes?: number;
  budget?: ByteBudget;
  allowHosts?: RegExp[];
  /** Default 3. */
  maxRedirects?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  lookupImpl?: (host: string) => Promise<{ address: string }[]>;
}

export type SafeFetchResult =
  | { ok: true; buffer: Buffer; contentType: string; filename: string }
  | { ok: false; error: string };

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_BYTES = 20 * 2 ** 20;
const DEFAULT_MAX_REDIRECTS = 3;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extra literal hostnames from `WEBWOW_IMPORT_ALLOWED_HOSTS` (comma-separated); pass the raw value to test. */
export function envAllowedHosts(raw: string | undefined = process.env.WEBWOW_IMPORT_ALLOWED_HOSTS): RegExp[] {
  return (raw ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9.-]+$/.test(h))
    .map((h) => new RegExp(`^${escapeRegExp(h)}$`, 'i'));
}

export function isAllowedHost(host: string, allow: RegExp[]): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  return allow.some((re) => re.test(h));
}

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 10) return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 0) return true; // 0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** Expand an IPv6 address into 8 hextets (handles `::` and an embedded IPv4 tail). Null when invalid. */
function parseIPv6(ip: string): number[] | null {
  let s = ip.trim().toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  // Embedded IPv4 tail (::ffff:192.168.0.1).
  const v4Match = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Match) {
    const oct = parseIPv4(v4Match[2]);
    if (!oct) return null;
    s = `${v4Match[1]}${((oct[0] << 8) | oct[1]).toString(16)}:${((oct[2] << 8) | oct[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...(halves.length === 2 ? new Array(missing).fill('0') : []), ...tail];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/**
 * True for loopback, link-local, unique-local, unspecified, multicast and
 * private-range addresses (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16,
 * 0/8, 100.64/10, ::1, ::, fc00::/7, fe80::/10, ::ffff:<v4> of any of those).
 * Unparseable input counts as private (fail closed).
 */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.trim();
  const kind = isIP(v);
  if (kind === 4) {
    const oct = parseIPv4(v);
    return oct ? isPrivateIPv4(oct) : true;
  }
  if (kind === 6 || v.includes(':')) {
    const h = parseIPv6(v);
    if (!h) return true;
    const allZero = h.every((x) => x === 0);
    if (allZero) return true; // ::
    if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
    if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((h[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
    if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
      // ::ffff:a.b.c.d
      return isPrivateIPv4([h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff]);
    }
    if (h[0] === 0x2002) {
      // 6to4: embedded IPv4 in the next 32 bits.
      return isPrivateIPv4([h[1] >> 8, h[1] & 0xff, h[2] >> 8, h[2] & 0xff]);
    }
    return false;
  }
  return true;
}

/** Last path segment of the original URL (decoded, query stripped) without Webflow's `<24 hex>_` prefix. */
export function filenameFromUrl(url: string): string {
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split(/[?#]/)[0];
  }
  const last = pathname.split('/').filter(Boolean).pop() ?? '';
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    decoded = last;
  }
  decoded = decoded.replace(/^[0-9a-f]{24}_/i, '').trim();
  return decoded || 'download';
}

async function readBody(res: Response, maxBytes: number, abort: AbortController): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        abort.abort();
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        return null;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), total);
}

function combineSignals(abort: AbortController, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([abort.signal, timeout]);
  timeout.addEventListener('abort', () => abort.abort(), { once: true });
  return abort.signal;
}

async function validateUrl(
  url: URL,
  allow: RegExp[],
  lookup: NonNullable<SafeFetchOptions['lookupImpl']>,
): Promise<string | null> {
  if (url.protocol !== 'https:') return `only https URLs are allowed (${url.protocol})`;
  if (url.username || url.password) return 'URLs with credentials are not allowed';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!isAllowedHost(host, allow)) return `host ${host} is not in the allowlist`;
  if (isIP(host)) {
    if (isPrivateAddress(host)) return `address ${host} is not public`;
    return null;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host);
  } catch (error) {
    return `DNS lookup failed for ${host}: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!addresses || addresses.length === 0) return `DNS lookup returned no address for ${host}`;
  for (const a of addresses) {
    if (isPrivateAddress(a.address)) return `host ${host} resolves to a non-public address`;
  }
  return null;
}

/**
 * Download a remote asset under the safety rules above. Never throws.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allow = opts.allowHosts ?? [...DEFAULT_ALLOWED_HOSTS, ...envAllowedHosts()];
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lookup = opts.lookupImpl ?? (async (host: string) => dns.lookup(host, { all: true }));
  const filename = filenameFromUrl(url);

  try {
    let current: URL;
    try {
      current = new URL(url);
    } catch {
      return { ok: false, error: `invalid URL: ${url}` };
    }

    let response: Response | null = null;
    const abort = new AbortController();
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const problem = await validateUrl(current, allow, lookup);
      if (problem) return { ok: false, error: problem };
      const res = await fetchImpl(current.toString(), {
        redirect: 'manual',
        signal: combineSignals(abort, timeoutMs),
        headers: { accept: '*/*' },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        try {
          await res.body?.cancel();
        } catch {
          // ignore
        }
        if (!location) return { ok: false, error: `redirect without Location (HTTP ${res.status})` };
        if (hop === maxRedirects) return { ok: false, error: `too many redirects (> ${maxRedirects})` };
        current = new URL(location, current);
        continue;
      }
      response = res;
      break;
    }
    if (!response) return { ok: false, error: 'too many redirects' };
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
      return { ok: false, error: `file larger than ${Math.round(maxBytes / 2 ** 20)} MB` };
    }
    if (opts.budget && Number.isFinite(declared) && declared > 0 && declared > opts.budget.remaining) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
      return { ok: false, error: 'import download budget exhausted' };
    }

    const buffer = await readBody(response, maxBytes, abort);
    if (!buffer) return { ok: false, error: `file larger than ${Math.round(maxBytes / 2 ** 20)} MB` };
    if (opts.budget && !opts.budget.take(buffer.length)) {
      return { ok: false, error: 'import download budget exhausted' };
    }
    const headerType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const contentType = headerType && headerType !== 'application/octet-stream' ? headerType : guessMimeType(filename);
    return { ok: true, buffer, contentType, filename };
  } catch (error) {
    const message = error instanceof Error ? (error.name === 'TimeoutError' || error.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : error.message) : String(error);
    return { ok: false, error: message };
  }
}

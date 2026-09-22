/**
 * SSRF-safe, bounded download of remote CMS assets (Webflow CDN only).
 *
 * Rules: https only; host must match the allowlist (defaults + the
 * `WEBWOW_IMPORT_ALLOWED_HOSTS` env var, comma-separated literal hostnames);
 * every resolved address must be public; redirects are followed manually (max
 * 3) and re-validated; the body is streamed with a running byte counter and
 * aborted above `maxBytes`; an optional `ByteBudget` caps the whole import and
 * is charged chunk by chunk while the body streams, so a response without a
 * `content-length` header can never transfer more than the budget has left.
 * The address that passed validation is the address the socket connects to:
 * the request goes through Node's http(s) client with a `lookup` that returns
 * the validated addresses (Host header and TLS servername stay the hostname),
 * so a name whose DNS answers differently a second time (rebinding) cannot
 * steer the connection to an internal service. Every redirect hop is resolved
 * and pinned the same way.
 * Two explicit relaxations exist for the live-site source: `allowHttp` (a
 * public site without TLS) and `relaxedHosts` (operator-listed hosts, outside
 * production only, may be plain http on a private address — the fixture site
 * of the verification setup). Neither is ever derived from user input, and
 * neither is on unless the caller passes it (`site-crawl.ts` and the CMS image
 * download of `server-materializer.ts` pass `envRelaxedHosts()` explicitly).
 * Never throws — every failure is `{ ok: false, error }`. Because only https
 * URLs on allowlisted hosts pass, the storage fetch-intercept (`/storage/...`)
 * can never be reached from here.
 */

import { promises as dns } from 'dns';
import http from 'http';
import https from 'https';
import { isIP, type LookupFunction } from 'net';
import { Readable } from 'stream';
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

  /** Give back `n` bytes reserved earlier (a download that failed after streaming part of its body). */
  release(n: number): void {
    if (n > 0) this.used = Math.max(0, this.used - n);
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }
}

/** The error text of a download refused or cut off by the {@link ByteBudget}; callers compare against it. */
export const BUDGET_EXHAUSTED_ERROR = 'import download budget exhausted';

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
  /**
   * Accept plain `http:` URLs (public hosts only — the private-address check
   * still applies). Off by default; the live-site crawler (`site-crawl.ts`)
   * turns it on because a published site may not have TLS.
   */
  allowHttp?: boolean;
  /**
   * Hosts for which `http:` and non-public addresses are tolerated. Off by
   * default — nothing is relaxed unless the caller passes it. The intended
   * value is {@link envRelaxedHosts}: the operator's `WEBWOW_IMPORT_ALLOWED_HOSTS`
   * entries, and only outside production. Never widened from user input.
   */
  relaxedHosts?: RegExp[];
}

/** The rules {@link checkUrlSafety} relaxes for a request; both default to off. */
export interface UrlSafetyPolicy {
  allowHttp?: boolean;
  relaxedHosts?: RegExp[];
}

export type SafeFetchResult =
  | { ok: true; buffer: Buffer; contentType: string; filename: string }
  | {
      ok: false;
      error: string;
      /**
       * Set when a redirect target was refused by the safety rules: the absolute
       * URL the server pointed at. Lets a caller with a wider policy (the site
       * crawler re-basing `example.com` -> `www.example.com`) decide for itself
       * instead of treating the hop as an unreachable page.
       */
      redirect?: string;
    };

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

/**
 * Hosts that may be reached over plain http and on non-public addresses: the
 * literal `WEBWOW_IMPORT_ALLOWED_HOSTS` entries, but only outside production
 * (the same rule `data-api.ts` applies to its stub base URL). In production
 * this is always empty, whatever the env var says.
 */
export function envRelaxedHosts(raw: string | undefined = process.env.WEBWOW_IMPORT_ALLOWED_HOSTS, nodeEnv: string | undefined = process.env.NODE_ENV): RegExp[] {
  if (nodeEnv === 'production') return [];
  return envAllowedHosts(raw);
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
 * 0/8, 100.64/10, ::1, ::, fc00::/7, fe80::/10, and ::ffff:<v4>, 2002:<v4>
 * (6to4) or 64:ff9b::<v4> (NAT64) embedding any of those).
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
    if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
      // NAT64 well-known prefix 64:ff9b::/96: embedded IPv4 in the last 32 bits.
      return isPrivateIPv4([h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff]);
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

type BodyOutcome = { kind: 'ok'; buffer: Buffer } | { kind: 'too_large' } | { kind: 'budget' };

/**
 * Stream the body with a running counter. Every chunk is reserved against the
 * budget before it is kept, so the transfer stops the moment the budget is
 * gone — with or without a `content-length` header. A body that is cut off
 * gives its reservation back.
 */
async function readBody(res: Response, maxBytes: number, abort: AbortController, budget?: ByteBudget): Promise<BodyOutcome> {
  if (!res.body) return { kind: 'ok', buffer: Buffer.alloc(0) };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let reserved = 0;
  const stop = async (kind: 'too_large' | 'budget'): Promise<BodyOutcome> => {
    abort.abort();
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    budget?.release(reserved);
    return { kind };
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (budget && !budget.take(value.byteLength)) return stop('budget');
    reserved += value.byteLength;
    total += value.byteLength;
    if (total > maxBytes) return stop('too_large');
    chunks.push(value);
  }
  return { kind: 'ok', buffer: Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), total) };
}

function combineSignals(abort: AbortController, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([abort.signal, timeout]);
  timeout.addEventListener('abort', () => abort.abort(), { once: true });
  return abort.signal;
}

const defaultLookup: NonNullable<SafeFetchOptions['lookupImpl']> = async (host: string) => dns.lookup(host, { all: true });

/** What a URL resolved to under the safety rules: the reason it was refused, or the addresses a request may connect to. */
export type SafeUrlResolution = { problem: string; addresses?: undefined } | { problem: null; addresses: string[] };

/**
 * The URL half of `safeFetch`'s safety rules, without the download: https only,
 * no credentials in the URL, host on the allowlist, and every address the host
 * resolves to public. Returns the validated addresses so the request can be
 * pinned to exactly them (a second DNS answer inside the http client is never
 * consulted), or the reason the URL is refused.
 */
export async function resolveSafeUrl(
  url: URL,
  allow: RegExp[],
  lookup: NonNullable<SafeFetchOptions['lookupImpl']> = defaultLookup,
  policy: UrlSafetyPolicy = {},
): Promise<SafeUrlResolution> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const relaxed = policy.relaxedHosts ? isAllowedHost(host, policy.relaxedHosts) : false;
  const httpOk = url.protocol === 'http:' && (policy.allowHttp === true || relaxed);
  if (url.protocol !== 'https:' && !httpOk) return { problem: `only https URLs are allowed (${url.protocol})` };
  if (url.username || url.password) return { problem: 'URLs with credentials are not allowed' };
  if (!isAllowedHost(host, allow)) return { problem: `host ${host} is not in the allowlist` };
  if (isIP(host)) {
    // An operator-listed host (development only) may live on a private address.
    if (!relaxed && isPrivateAddress(host)) return { problem: `address ${host} is not public` };
    return { problem: null, addresses: [host] };
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host);
  } catch (error) {
    return { problem: `DNS lookup failed for ${host}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!addresses || addresses.length === 0) return { problem: `DNS lookup returned no address for ${host}` };
  const list = addresses.map((a) => a.address.trim()).filter((a) => isIP(a) !== 0);
  if (list.length === 0) return { problem: `DNS lookup returned no usable address for ${host}` };
  if (!relaxed) {
    for (const a of list) {
      if (isPrivateAddress(a)) return { problem: `host ${host} resolves to a non-public address` };
    }
  }
  return { problem: null, addresses: list };
}

/**
 * {@link resolveSafeUrl} without the addresses: the reason a URL is refused, or
 * null when it passes. Exported so callers that speak a protocol of their own —
 * the Webflow Data API client (`data-api.ts`) sends an `Authorization` header
 * and reads JSON, which `safeFetch` deliberately cannot do — run through the
 * same guard instead of reaching for a bare `fetch`.
 */
export async function checkUrlSafety(
  url: URL,
  allow: RegExp[],
  lookup: NonNullable<SafeFetchOptions['lookupImpl']> = defaultLookup,
  policy: UrlSafetyPolicy = {},
): Promise<string | null> {
  return (await resolveSafeUrl(url, allow, lookup, policy)).problem;
}

/**
 * One GET through Node's http(s) client whose socket connects to exactly the
 * validated `addresses` (the `lookup` option answers from that list — with all
 * of them when the client asks for `all`, so its own family selection keeps
 * working) while `Host` and the TLS servername remain the URL's hostname.
 * Redirects are not followed here; `safeFetch` re-validates every hop. The
 * result is a WHATWG `Response` so the rest of the pipeline is shared with the
 * injectable `fetchImpl` of the tests.
 */
function pinnedRequest(url: URL, addresses: string[], signal: AbortSignal): Promise<Response> {
  const client = url.protocol === 'https:' ? https : http;
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));
  const lookup: LookupFunction = (_hostname, options, callback) => {
    const wanted = options.family === 4 || options.family === 6 ? entries.filter((e) => e.family === options.family) : entries;
    const list = wanted.length > 0 ? wanted : entries;
    if (options.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  };
  return new Promise<Response>((resolve, reject) => {
    const req = client.request(url, { method: 'GET', headers: { accept: '*/*' }, signal, lookup }, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status > 599) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value === undefined) continue;
        try {
          headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        } catch {
          // a header the WHATWG model refuses is not one this module reads
        }
      }
      const bodyless = status === 204 || status === 205 || status === 304;
      if (bodyless) res.resume();
      const body = bodyless ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
      resolve(new Response(body, { status, headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Download a remote asset under the safety rules above. Never throws.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allow = opts.allowHosts ?? [...DEFAULT_ALLOWED_HOSTS, ...envAllowedHosts()];
  const fetchImpl = opts.fetchImpl;
  const lookup = opts.lookupImpl ?? defaultLookup;
  const policy: UrlSafetyPolicy = { allowHttp: opts.allowHttp === true, relaxedHosts: opts.relaxedHosts ?? [] };
  const filename = filenameFromUrl(url);
  if (opts.budget && opts.budget.remaining <= 0) return { ok: false, error: BUDGET_EXHAUSTED_ERROR };

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
      const resolved = await resolveSafeUrl(current, allow, lookup, policy);
      if (resolved.problem !== null) {
        return hop === 0 ? { ok: false, error: resolved.problem } : { ok: false, error: resolved.problem, redirect: current.toString() };
      }
      const signal = combineSignals(abort, timeoutMs);
      // The injected `fetchImpl` exists for tests only; the real path pins the socket
      // to the addresses that were just validated.
      const res = fetchImpl
        ? await fetchImpl(current.toString(), { redirect: 'manual', signal, headers: { accept: '*/*' } })
        : await pinnedRequest(current, resolved.addresses, signal);
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
      return { ok: false, error: BUDGET_EXHAUSTED_ERROR };
    }

    const body = await readBody(response, maxBytes, abort, opts.budget);
    if (body.kind === 'too_large') return { ok: false, error: `file larger than ${Math.round(maxBytes / 2 ** 20)} MB` };
    if (body.kind === 'budget') return { ok: false, error: BUDGET_EXHAUSTED_ERROR };
    const { buffer } = body;
    const headerType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const contentType = headerType && headerType !== 'application/octet-stream' ? headerType : guessMimeType(filename);
    return { ok: true, buffer, contentType, filename };
  } catch (error) {
    const message = error instanceof Error ? (error.name === 'TimeoutError' || error.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : error.message) : String(error);
    return { ok: false, error: message };
  }
}

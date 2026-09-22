/**
 * In-process login throttle for the `?edit` site password.
 *
 * The editor password is shared by everyone who may edit a site, so the login
 * endpoint is the one place a guessing attack is cheap. Counters are kept per
 * site (always) and per IP (only behind a trusted proxy, because a client can
 * otherwise pick its own `x-forwarded-for`), plus a process-wide cap that bounds
 * the scrypt CPU an attacker can buy.
 */

export interface ThrottleDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
}

interface Bucket {
  count: number;
  resetAt: number;
  lockedUntil?: number;
  lockouts: number;
}

export interface ThrottleOptions {
  siteLimit?: number;
  siteWindowMs?: number;
  ipLimit?: number;
  ipWindowMs?: number;
  globalLimit?: number;
  globalWindowMs?: number;
  now?: () => number;
}

export class LoginThrottle {
  private readonly siteBuckets = new Map<string, Bucket>();
  private readonly ipBuckets = new Map<string, Bucket>();
  private globalBucket: Bucket = { count: 0, resetAt: 0, lockouts: 0 };

  private readonly siteLimit: number;
  private readonly siteWindowMs: number;
  private readonly ipLimit: number;
  private readonly ipWindowMs: number;
  private readonly globalLimit: number;
  private readonly globalWindowMs: number;
  private readonly now: () => number;

  constructor(opts: ThrottleOptions = {}) {
    this.siteLimit = opts.siteLimit ?? 20;
    this.siteWindowMs = opts.siteWindowMs ?? 5 * 60_000;
    this.ipLimit = opts.ipLimit ?? 5;
    this.ipWindowMs = opts.ipWindowMs ?? 60_000;
    this.globalLimit = opts.globalLimit ?? 60;
    this.globalWindowMs = opts.globalWindowMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  private bucket(map: Map<string, Bucket>, key: string, windowMs: number): Bucket {
    const now = this.now();
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { count: 0, resetAt: now + windowMs, lockouts: 0 };
      map.set(key, bucket);
    }
    if (now >= bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }
    return bucket;
  }

  check(keys: { site: string; ip?: string }): ThrottleDecision {
    this.prune();
    const now = this.now();

    const site = this.bucket(this.siteBuckets, keys.site, this.siteWindowMs);
    if (site.lockedUntil && now < site.lockedUntil) {
      return { allowed: false, retryAfterSeconds: Math.ceil((site.lockedUntil - now) / 1000) };
    }
    if (site.count >= this.siteLimit) {
      return { allowed: false, retryAfterSeconds: Math.ceil((site.resetAt - now) / 1000) };
    }

    if (keys.ip) {
      const ip = this.bucket(this.ipBuckets, keys.ip, this.ipWindowMs);
      if (ip.count >= this.ipLimit) {
        return { allowed: false, retryAfterSeconds: Math.ceil((ip.resetAt - now) / 1000) };
      }
    }

    if (now >= this.globalBucket.resetAt) {
      this.globalBucket = { count: 0, resetAt: now + this.globalWindowMs, lockouts: 0 };
    }
    if (this.globalBucket.count >= this.globalLimit) {
      return { allowed: false, retryAfterSeconds: Math.ceil((this.globalBucket.resetAt - now) / 1000) };
    }

    return { allowed: true };
  }

  fail(keys: { site: string; ip?: string }): void {
    const now = this.now();
    const site = this.bucket(this.siteBuckets, keys.site, this.siteWindowMs);
    site.count += 1;
    if (site.count >= this.siteLimit) {
      site.lockouts += 1;
      const minutes = Math.min(5 * 2 ** (site.lockouts - 1), 60);
      site.lockedUntil = now + minutes * 60_000;
    }
    if (keys.ip) this.bucket(this.ipBuckets, keys.ip, this.ipWindowMs).count += 1;
    if (now >= this.globalBucket.resetAt) {
      this.globalBucket = { count: 0, resetAt: now + this.globalWindowMs, lockouts: 0 };
    }
    this.globalBucket.count += 1;
  }

  succeed(keys: { site: string; ip?: string }): void {
    const site = this.siteBuckets.get(keys.site);
    if (site) site.count = 0;
    if (keys.ip) this.ipBuckets.delete(keys.ip);
  }

  prune(): void {
    const now = this.now();
    for (const [key, bucket] of this.siteBuckets) {
      if (now >= bucket.resetAt && (!bucket.lockedUntil || now >= bucket.lockedUntil)) this.siteBuckets.delete(key);
    }
    for (const [key, bucket] of this.ipBuckets) {
      if (now >= bucket.resetAt) this.ipBuckets.delete(key);
    }
  }
}

const THROTTLE_KEY = Symbol.for('webwow.loginThrottle');
const globalForThrottle = globalThis as unknown as Record<symbol, LoginThrottle | undefined>;
export const loginThrottle: LoginThrottle =
  globalForThrottle[THROTTLE_KEY] ?? (globalForThrottle[THROTTLE_KEY] = new LoginThrottle());

/** The client IP to key on — only when the deployment says a proxy is in front. */
export function clientIpKey(headers: Headers): string | undefined {
  if (process.env.WEBWOW_TRUSTED_PROXY !== '1' && process.env.WEBWOW_TRUSTED_PROXY !== 'true') return undefined;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip')?.trim() || undefined;
}

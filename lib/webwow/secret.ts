/**
 * Shared secret for signing Webwow sessions and upload tokens.
 *
 * Uses `PAGE_AUTH_SECRET` (already required by upstream for password-protected
 * pages) or `AUTH_SECRET`. Without either, a random per-process secret is used
 * and a warning is logged — sessions then do not survive a restart.
 */

import { randomBytes } from 'crypto';

const globalForSecret = globalThis as unknown as { __webwowFallbackSecret?: string; __webwowSecretWarned?: boolean };

export function getSessionSecret(): string {
  const configured = process.env.PAGE_AUTH_SECRET || process.env.AUTH_SECRET;
  if (configured && configured.trim().length > 0) return configured.trim();

  if (!globalForSecret.__webwowFallbackSecret) {
    globalForSecret.__webwowFallbackSecret = randomBytes(32).toString('hex');
  }
  if (!globalForSecret.__webwowSecretWarned) {
    globalForSecret.__webwowSecretWarned = true;
    console.warn('[webwow] PAGE_AUTH_SECRET is not set — using a random secret; sessions will not survive a restart. Generate one with `openssl rand -hex 32`.');
  }
  return globalForSecret.__webwowFallbackSecret;
}

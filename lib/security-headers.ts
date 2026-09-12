/**
 * Security headers configuration for published/public pages.
 *
 * Opt-in: headers are applied to public page responses only after a site saves
 * a configuration via Settings → Security. Sites with no saved configuration
 * are left untouched, so existing sites and their custom code/features are never
 * affected without the owner's action.
 */

export interface SecurityHeadersSettings {
  /** Master toggle. When false, no security headers are sent. */
  enabled: boolean;
  /** X-Frame-Options value; 'OFF' omits the header. */
  frameOptions: 'SAMEORIGIN' | 'DENY' | 'OFF';
  /** Send `X-Content-Type-Options: nosniff` when true. */
  contentTypeOptions: boolean;
  /** Referrer-Policy value; empty string omits the header. */
  referrerPolicy: string;
  /** Permissions-Policy value; empty string omits the header. */
  permissionsPolicy: string;
  /** Content-Security-Policy value; empty string omits the header. */
  contentSecurityPolicy: string;
  /** Strict-Transport-Security value; empty string omits the header. */
  strictTransportSecurity: string;
}

/** The settings key under which the configuration is stored. */
export const SECURITY_HEADERS_SETTING_KEY = 'security_headers';

/** Allowed Referrer-Policy values for the settings UI. */
export const REFERRER_POLICY_OPTIONS = [
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
] as const;

/** Recommended values pre-filled in the settings UI (not auto-applied). */
export function getDefaultSecurityHeadersSettings(): SecurityHeadersSettings {
  return {
    enabled: true,
    // Only `nosniff` is on by default — it has essentially no breakage risk.
    // Everything else is left off so enabling the feature never changes a
    // site's behavior (framing, referrer, device APIs, CSP, HTTPS) unless the
    // owner explicitly opts in:
    //   - X-Frame-Options can break sites intentionally embedded cross-origin.
    //   - A restrictive Permissions-Policy can disable geolocation/camera/mic.
    //   - CSP can block custom code; HSTS is often set by the host (e.g. Vercel).
    frameOptions: 'OFF',
    contentTypeOptions: true,
    referrerPolicy: '',
    permissionsPolicy: '',
    contentSecurityPolicy: '',
    strictTransportSecurity: '',
  };
}

/**
 * Build the HTTP header map from a site's saved configuration.
 * Returns an empty object when nothing is saved (opt-in) or the feature is off.
 */
export function resolveSecurityHeaders(
  stored: Partial<SecurityHeadersSettings> | null,
): Record<string, string> {
  // Opt-in: never send headers for a site that hasn't saved a configuration,
  // so existing sites are never changed without the owner's action.
  if (!stored || Object.keys(stored).length === 0) return {};

  const settings = { ...getDefaultSecurityHeadersSettings(), ...stored };

  if (!settings.enabled) return {};

  const headers: Record<string, string> = {};

  if (settings.frameOptions && settings.frameOptions !== 'OFF') {
    headers['X-Frame-Options'] = settings.frameOptions;
  }
  if (settings.contentTypeOptions) {
    headers['X-Content-Type-Options'] = 'nosniff';
  }
  if (settings.referrerPolicy) {
    headers['Referrer-Policy'] = settings.referrerPolicy;
  }
  if (settings.permissionsPolicy) {
    headers['Permissions-Policy'] = settings.permissionsPolicy;
  }
  if (settings.contentSecurityPolicy) {
    headers['Content-Security-Policy'] = settings.contentSecurityPolicy;
  }
  if (settings.strictTransportSecurity) {
    headers['Strict-Transport-Security'] = settings.strictTransportSecurity;
  }

  return headers;
}

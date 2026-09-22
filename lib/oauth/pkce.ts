/**
 * PKCE (RFC 7636) helpers for the MCP OAuth flow.
 *
 * We only support the S256 transformation — `plain` is rejected up front
 * because the MCP authorization spec (2025-06-18) mandates S256.
 */

function base64UrlEncode(bytes: ArrayBuffer): string {
  const b64 = Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function deriveS256Challenge(codeVerifier: string): Promise<string> {
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(digest);
}

/**
 * Verify that the supplied `code_verifier` matches the stored `code_challenge`
 * under the given method. Returns false for any unsupported method.
 */
export async function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
  method: string,
): Promise<boolean> {
  if (method !== 'S256') {
    return false;
  }

  if (!codeVerifier || codeVerifier.length < 43 || codeVerifier.length > 128) {
    return false;
  }

  const derived = await deriveS256Challenge(codeVerifier);
  return derived === codeChallenge;
}

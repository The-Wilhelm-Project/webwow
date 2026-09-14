/**
 * Return-path handling for the `?edit` content editor.
 *
 * The public page a visitor pressed "edit" on is carried through the login page
 * and the editor session token so "Sign out" lands back on that page. Because the
 * value reaches us from a query string it is validated as a same-origin path
 * (open-redirect and header-injection guard).
 */

export const MAX_RETURN_LENGTH = 512;

/** Remove the `edit` query parameter, keeping every other parameter. */
export function stripEditParam(pathWithQuery: string): string {
  const hashIndex = pathWithQuery.indexOf('#');
  const hash = hashIndex === -1 ? '' : pathWithQuery.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? pathWithQuery : pathWithQuery.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf('?');
  if (queryIndex === -1) return withoutHash + hash;

  const path = withoutHash.slice(0, queryIndex);
  const params = new URLSearchParams(withoutHash.slice(queryIndex + 1));
  params.delete('edit');
  const query = params.toString();
  return `${path}${query ? `?${query}` : ''}${hash}`;
}

/** True when the string contains an ASCII control character (CR/LF injection guard). */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate a return path: a same-origin absolute path, no protocol-relative
 * form, no control characters, bounded length. Returns null when invalid.
 */
export function validateReturnPath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value || value.length > MAX_RETURN_LENGTH) return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  if (hasControlCharacter(value)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  return stripEditParam(value);
}

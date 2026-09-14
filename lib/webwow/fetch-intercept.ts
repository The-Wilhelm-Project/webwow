/**
 * Server-side fetch interception for local storage URLs.
 *
 * Upstream code fetches asset bytes through the public storage URL returned by
 * `storage.getPublicUrl()` (e.g. the `/a/[hash]` asset proxy route and the
 * static export bundler). In Webwow those URLs are relative
 * (`/storage/v1/object/public/<bucket>/<path>`), so a plain `fetch()` would
 * fail. This module wraps `globalThis.fetch` once per process and serves such
 * URLs straight from disk (with HTTP Range support) — everything else is passed
 * through untouched.
 */

import 'server-only';

import { createObjectResponse, parsePublicUrl, PUBLIC_STORAGE_PREFIX } from '@/lib/webwow/storage';
import { LOCAL_SUPABASE_URL } from '@/lib/credentials';

const globalForFetch = globalThis as unknown as { __webwowPatchedFetch?: typeof fetch; __webwowInnerFetch?: typeof fetch };

function extractUrl(input: RequestInfo | URL): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof (input as Request).url === 'string') return (input as Request).url;
  return null;
}

function isLocalStorageUrl(url: string): boolean {
  if (url.startsWith(`${PUBLIC_STORAGE_PREFIX}/`)) return true;
  if (url.startsWith(`${LOCAL_SUPABASE_URL}${PUBLIC_STORAGE_PREFIX}/`)) return true;
  return false;
}

/**
 * Install (or re-assert) the interceptor as the outermost `fetch` wrapper.
 *
 * Next.js wraps `globalThis.fetch` for its data cache and parses the URL first;
 * a relative storage URL would throw there before reaching us. Calling this
 * again right before use (see `getSupabaseAdmin()`) guarantees our wrapper is
 * on top even if Next re-patched fetch in the meantime.
 */
export function installFetchIntercept(): void {
  const current = globalThis.fetch;
  if (globalForFetch.__webwowPatchedFetch && current === globalForFetch.__webwowPatchedFetch) return;

  // The inner fetch is captured exactly ONCE (the fetch that was active when the
  // layer loaded — normally Next.js' own patched fetch). It is never replaced on
  // re-assertion: if Next.js had wrapped *our* function in the meantime, taking that
  // wrapper as the new inner fetch would create a call cycle (stack overflow).
  if (!globalForFetch.__webwowInnerFetch) {
    globalForFetch.__webwowInnerFetch = current;
  }

  if (!globalForFetch.__webwowPatchedFetch) {
    const patchedFetch: typeof fetch = async (input, init) => {
      const url = extractUrl(input);
      if (url && isLocalStorageUrl(url)) {
        const parsed = parsePublicUrl(url);
        if (!parsed) return new Response('Not found', { status: 404 });
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        return createObjectResponse(parsed.bucket, parsed.objectPath, headers.get('range'));
      }
      return globalForFetch.__webwowInnerFetch!(input as RequestInfo, init);
    };

    // Mark the wrapper the way Next.js marks its own patched fetch so Next does not
    // wrap it again (its check is `fetch.__nextPatched === true`).
    const inner = globalForFetch.__webwowInnerFetch as typeof fetch & { __nextPatched?: boolean; _nextOriginalFetch?: typeof fetch };
    const marked = patchedFetch as typeof fetch & { __nextPatched?: boolean; _nextOriginalFetch?: typeof fetch };
    if (inner.__nextPatched) {
      marked.__nextPatched = true;
      marked._nextOriginalFetch = inner._nextOriginalFetch ?? inner;
    }

    globalForFetch.__webwowPatchedFetch = patchedFetch;
  }

  globalThis.fetch = globalForFetch.__webwowPatchedFetch;
}

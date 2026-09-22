/**
 * Shared helpers for the Webwow auth routes.
 */

import { noCache } from '@/lib/api-response';
import type { AuthError } from '@/lib/webwow/auth-server';

export const dynamic = 'force-dynamic';

export function authErrorResponse(error: AuthError) {
  return noCache({ error: error.message, code: error.code ?? null }, error.status >= 400 && error.status < 600 ? error.status : 400);
}

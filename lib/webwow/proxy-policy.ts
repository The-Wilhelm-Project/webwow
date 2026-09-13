/**
 * Proxy policy for editor sessions (`?edit` CMS-only editor).
 *
 * Data + pure functions, evaluated by `proxy.ts` for every request whose
 * session cookie has `kind === 'editor'` — BEFORE the public-prefix check, so
 * routes under public prefixes (`/ycode/api/webwow/auth/update-user`,
 * `/ycode/api/auth/users`, ...) cannot be reached by a site-password holder.
 *
 * Upstream enforces roles client-side only (findings-editor-flow §1.4), so this
 * table is the server-side allow/deny/rewrite list for editor sessions:
 *  - `allow`   -> the request continues through the normal session auth
 *  - `rewrite` -> the request is rewritten to a validating Webwow route
 *  - `deny`    -> 403 JSON for API paths, 302 `/ycode/collections` for pages
 * Anything under `/ycode/api` or `/api` that no rule matches is denied.
 *
 * `proxy-policy.test.ts` enumerates every `route.ts` under
 * `app/(builder)/ycode/api` and `app/(site)/api` and requires `classifyRoute()`
 * to classify each (method, path): a new upstream route family fails the test
 * until it is added here (docs/UPSTREAM-SYNC.md §5). SPEC-edit §4 documents
 * this table for the edit stream; this file is the source of truth.
 *
 * No `server-only`, no imports (usable from the proxy, route handlers and tests).
 */

export type Decision =
  | { kind: 'allow' }
  | { kind: 'deny'; redirect?: string }
  | { kind: 'rewrite'; to: string };

export interface PolicyRule {
  /** Upper-case HTTP methods, or `'*'` for any method. */
  methods: string[] | '*';
  re: RegExp;
  decision: Decision['kind'];
  /** Rewrite target (pathname) for `rewrite` rules; the query string is preserved by the proxy. */
  to?: string;
  note: string;
}

/** Where denied editor page requests are sent. */
export const EDITOR_HOME = '/ycode/collections';

/**
 * Visitor-facing routes with their own auth (API keys, MCP/OAuth tokens,
 * secrets, page passwords) or none at all. They are never gated by the editor
 * policy: an editor browsing the published site must still be able to submit a
 * form or page through a collection list.
 */
export const PUBLIC_ROUTE_RULES: PolicyRule[] = [
  { methods: ['POST'], re: /^\/ycode\/api\/form-submissions$/, decision: 'allow', note: 'visitor form submissions' },
  { methods: ['POST'], re: /^\/ycode\/api\/collections\/[^/]+\/items\/(filter|load-more)$/, decision: 'allow', note: 'published collection lists' },
  { methods: '*', re: /^\/ycode\/api\/v1(\/.*)?$/, decision: 'allow', note: 'public API (API-key auth)' },
  { methods: '*', re: /^\/ycode\/mcp(\/.*)?$/, decision: 'allow', note: 'MCP (token auth)' },
  { methods: ['POST'], re: /^\/ycode\/api\/oauth\/(register|token)$/, decision: 'allow', note: 'OAuth DCR / token exchange (anonymous)' },
  { methods: ['POST'], re: /^\/ycode\/api\/revalidate$/, decision: 'allow', note: 'cache revalidation (REVALIDATE_SECRET)' },
  { methods: '*', re: /^\/api\/cron(\/.*)?$/, decision: 'allow', note: 'cron (CRON_SECRET)' },
  { methods: ['POST'], re: /^\/api\/airtable-webhook$/, decision: 'allow', note: 'Airtable webhook (signed)' },
  { methods: ['POST'], re: /^\/api\/page-auth\/(verify|logout)$/, decision: 'allow', note: 'password-protected pages' },
];

/**
 * Editor rules for `/ycode/api/**` and `/api/**` (first match wins).
 * Allow/rewrite rules come first, then the family-level deny rules that make
 * every known route classifiable. SPEC-multisite §5 / SPEC-edit §4.
 */
export const EDITOR_API_RULES: PolicyRule[] = [
  // bootstrap / session
  { methods: ['GET'], re: /^\/ycode\/api\/setup\/status$/, decision: 'allow', note: 'builder boot' },
  { methods: ['POST'], re: /^\/ycode\/api\/setup\/migrate$/, decision: 'allow', note: 'MigrationChecker on builder boot (site DB)' },
  { methods: ['GET'], re: /^\/ycode\/api\/webwow\/auth\/session$/, decision: 'allow', note: 'session probe' },
  { methods: ['POST'], re: /^\/ycode\/api\/webwow\/auth\/logout$/, decision: 'allow', note: 'sign out (returns to the page)' },
  { methods: ['POST'], re: /^\/ycode\/api\/webwow\/auth\/edit-login$/, decision: 'allow', note: 'editor login (edit stream)' },
  { methods: ['GET'], re: /^\/ycode\/api\/editor\/init$/, decision: 'allow', note: 'builder init payload' },
  // pages / layers (reads + draft layer save through the validating route)
  { methods: ['GET'], re: /^\/ycode\/api\/pages(\/drafts|\/unpublished|\/slug\/[^/]+|\/[^/]+(\/collection-item)?)?$/, decision: 'allow', note: 'page reads' },
  { methods: ['GET'], re: /^\/ycode\/api\/folders(\/[^/]+)?$/, decision: 'allow', note: 'folder reads' },
  { methods: ['GET'], re: /^\/ycode\/api\/layers$/, decision: 'allow', note: 'layer reads' },
  { methods: ['PUT'], re: /^\/ycode\/api\/layers$/, decision: 'rewrite', to: '/ycode/api/webwow/editor/layers', note: 'content-only layer save (edit stream validates)' },
  { methods: ['POST'], re: /^\/ycode\/api\/css\/generate-pages$/, decision: 'allow', note: 'CSS after a layer save (idempotent)' },
  // CMS content
  { methods: ['GET'], re: /^\/ycode\/api\/collections(\/fields|\/[^/]+(\/fields(\/[^/]+(\/usage)?)?|\/usage)?)?$/, decision: 'allow', note: 'collection/field reads' },
  { methods: ['GET', 'POST', 'PUT', 'DELETE'], re: /^\/ycode\/api\/collections\/[^/]+\/items(\/.*)?$/, decision: 'allow', note: 'item CRUD' },
  { methods: ['POST'], re: /^\/ycode\/api\/collections\/items\/(batch|slugs|delete)$/, decision: 'allow', note: 'item batch helpers' },
  { methods: ['POST'], re: /^\/ycode\/api\/collections\/[^/]+\/import$/, decision: 'allow', note: 'CSV import' },
  { methods: ['POST'], re: /^\/ycode\/api\/collections\/import\/process$/, decision: 'allow', note: 'CSV import' },
  { methods: ['GET'], re: /^\/ycode\/api\/collections\/import\/[^/]+\/status$/, decision: 'allow', note: 'CSV import' },
  { methods: ['GET'], re: /^\/ycode\/api\/globals$/, decision: 'allow', note: 'global variable reads' },
  // assets / uploads
  { methods: ['POST'], re: /^\/ycode\/api\/assets\/upload$/, decision: 'deny', note: 'legacy multipart upload (unused by the builder; bypasses the editor upload policy)' },
  { methods: ['GET', 'POST', 'PUT', 'DELETE'], re: /^\/ycode\/api\/assets(\/.*)?$/, decision: 'allow', note: 'asset records' },
  { methods: ['GET', 'POST', 'PUT', 'DELETE'], re: /^\/ycode\/api\/asset-folders(\/.*)?$/, decision: 'allow', note: 'asset folders' },
  { methods: ['POST'], re: /^\/ycode\/api\/files\/upload$/, decision: 'rewrite', to: '/ycode/api/webwow/editor/upload', note: 'upload without SVG/HTML (edit stream)' },
  { methods: ['POST'], re: /^\/ycode\/api\/files\/presign$/, decision: 'rewrite', to: '/ycode/api/webwow/editor/presign', note: 'presign without SVG/HTML (edit stream)' },
  { methods: ['POST'], re: /^\/ycode\/api\/files\/register$/, decision: 'allow', note: 'register a presigned upload' },
  { methods: ['DELETE'], re: /^\/ycode\/api\/files\/delete$/, decision: 'allow', note: 'delete own uploads' },
  { methods: ['PUT', 'POST'], re: /^\/ycode\/api\/webwow\/storage\/upload$/, decision: 'allow', note: 'signed upload target (token protected)' },
  { methods: ['PUT'], re: /^\/ycode\/api\/webwow\/editor\/(layers|upload|presign)$/, decision: 'allow', note: 'direct calls to the editor routes' },
  { methods: ['POST'], re: /^\/ycode\/api\/webwow\/editor\/(upload|presign)$/, decision: 'allow', note: 'direct calls to the editor routes' },
  // translations (locale management denied below)
  { methods: ['GET'], re: /^\/ycode\/api\/locales(\/[^/]+)?$/, decision: 'allow', note: 'locale reads' },
  { methods: ['GET', 'POST', 'PUT', 'DELETE'], re: /^\/ycode\/api\/translations(\/.*)?$/, decision: 'allow', note: 'translations CRUD' },
  // read-only design data the canvas / CMS need
  { methods: ['GET'], re: /^\/ycode\/api\/components(\/unpublished|\/[^/]+)?$/, decision: 'allow', note: 'component reads' },
  { methods: ['GET'], re: /^\/ycode\/api\/layer-styles(\/unpublished|\/[^/]+)?$/, decision: 'allow', note: 'layer style reads' },
  { methods: ['GET'], re: /^\/ycode\/api\/color-variables$/, decision: 'allow', note: 'color variable reads' },
  { methods: ['GET'], re: /^\/ycode\/api\/fonts(\/[^/]+)?$/, decision: 'allow', note: 'font reads' },
  { methods: ['GET'], re: /^\/ycode\/api\/error-page$/, decision: 'allow', note: 'error page read' },
  // publishing (Revert and Clear cache stay denied)
  { methods: ['GET'], re: /^\/ycode\/api\/publish\/preview$/, decision: 'allow', note: 'publish preview' },
  { methods: ['POST'], re: /^\/ycode\/api\/publish$/, decision: 'allow', note: 'publish (matches upstream: editors may publish)' },

  // --- denied families (everything not allowed above) ---
  { methods: '*', re: /^\/ycode\/api\/webwow\/auth\/(update-user|signup|login)$/, decision: 'deny', note: 'would re-purpose the synthetic editor account' },
  { methods: '*', re: /^\/ycode\/api\/webwow\/sites(\/.*)?$/, decision: 'deny', note: 'sites dashboard API' },
  { methods: '*', re: /^\/ycode\/api\/webwow\/webflow(\/.*)?$/, decision: 'deny', note: 'Webflow importer v2' },
  { methods: '*', re: /^\/ycode\/api\/webwow(\/.*)?$/, decision: 'deny', note: 'other Webwow routes' },
  { methods: '*', re: /^\/ycode\/api\/profile(\/.*)?$/, decision: 'deny', note: 'profile (would alter/delete the synthetic user)' },
  { methods: '*', re: /^\/ycode\/api\/auth(\/.*)?$/, decision: 'deny', note: 'user management (users, invite, set-role, callback, session)' },
  { methods: '*', re: /^\/ycode\/api\/revert$/, decision: 'deny', note: 'discards every draft' },
  { methods: '*', re: /^\/ycode\/api\/cache(\/.*)?$/, decision: 'deny', note: 'cache management' },
  { methods: '*', re: /^\/ycode\/api\/css(\/.*)?$/, decision: 'deny', note: 'full CSS regeneration' },
  { methods: '*', re: /^\/ycode\/api\/pages(\/.*)?$/, decision: 'deny', note: 'page writes (create/rename/delete/duplicate/status)' },
  { methods: '*', re: /^\/ycode\/api\/folders(\/.*)?$/, decision: 'deny', note: 'folder writes' },
  { methods: '*', re: /^\/ycode\/api\/layers(\/.*)?$/, decision: 'deny', note: 'other layer endpoints' },
  { methods: '*', re: /^\/ycode\/api\/collections(\/.*)?$/, decision: 'deny', note: 'collection schema writes, publish, reorder, sample' },
  { methods: '*', re: /^\/ycode\/api\/globals(\/.*)?$/, decision: 'deny', note: 'global variable writes' },
  { methods: '*', re: /^\/ycode\/api\/locales(\/.*)?$/, decision: 'deny', note: 'locale management' },
  { methods: '*', re: /^\/ycode\/api\/translations(\/.*)?$/, decision: 'deny', note: 'other translation endpoints' },
  { methods: '*', re: /^\/ycode\/api\/components(\/.*)?$/, decision: 'deny', note: 'component writes (+ thumbnails)' },
  { methods: '*', re: /^\/ycode\/api\/layer-styles(\/.*)?$/, decision: 'deny', note: 'layer style writes (+ bulk)' },
  { methods: '*', re: /^\/ycode\/api\/color-variables(\/.*)?$/, decision: 'deny', note: 'color variable writes' },
  { methods: '*', re: /^\/ycode\/api\/fonts(\/.*)?$/, decision: 'deny', note: 'font writes' },
  { methods: '*', re: /^\/ycode\/api\/layouts(\/.*)?$/, decision: 'deny', note: 'layouts' },
  { methods: '*', re: /^\/ycode\/api\/settings(\/.*)?$/, decision: 'deny', note: 'settings (batch, agent, email)' },
  { methods: '*', re: /^\/ycode\/api\/api-keys(\/.*)?$/, decision: 'deny', note: 'API keys' },
  { methods: '*', re: /^\/ycode\/api\/mcp-tokens(\/.*)?$/, decision: 'deny', note: 'MCP tokens' },
  { methods: '*', re: /^\/ycode\/api\/oauth(\/.*)?$/, decision: 'deny', note: 'OAuth consent (register/token are public above)' },
  { methods: '*', re: /^\/ycode\/api\/ai(\/.*)?$/, decision: 'deny', note: 'AI agent' },
  { methods: '*', re: /^\/ycode\/api\/devtools(\/.*)?$/, decision: 'deny', note: 'reset-db / run-migrations' },
  { methods: '*', re: /^\/ycode\/api\/project(\/.*)?$/, decision: 'deny', note: 'project export/import' },
  { methods: '*', re: /^\/ycode\/api\/webflow(\/.*)?$/, decision: 'deny', note: 'Webflow importer v1' },
  { methods: '*', re: /^\/ycode\/api\/apps(\/.*)?$/, decision: 'deny', note: 'integrations (credentials, syncs)' },
  { methods: '*', re: /^\/ycode\/api\/webhooks(\/.*)?$/, decision: 'deny', note: 'webhooks' },
  { methods: '*', re: /^\/ycode\/api\/form-submissions(\/.*)?$/, decision: 'deny', note: 'form submissions (visitor POST is public above)' },
  { methods: '*', re: /^\/ycode\/api\/versions(\/.*)?$/, decision: 'deny', note: 'versions' },
  { methods: '*', re: /^\/ycode\/api\/updates(\/.*)?$/, decision: 'deny', note: 'update checks' },
  { methods: '*', re: /^\/ycode\/api\/maps(\/.*)?$/, decision: 'deny', note: 'geocoding' },
  { methods: '*', re: /^\/ycode\/api\/supabase(\/.*)?$/, decision: 'deny', note: 'supabase config' },
  { methods: '*', re: /^\/ycode\/api\/setup(\/.*)?$/, decision: 'deny', note: 'setup wizard (status/migrate allowed above)' },
  { methods: '*', re: /^\/ycode\/api\/editor(\/.*)?$/, decision: 'deny', note: 'other editor endpoints' },
  { methods: '*', re: /^\/ycode\/api\/files(\/.*)?$/, decision: 'deny', note: 'other file endpoints' },
  { methods: '*', re: /^\/ycode\/api\/assets(\/.*)?$/, decision: 'deny', note: 'other asset endpoints' },
  { methods: '*', re: /^\/ycode\/api\/publish(\/.*)?$/, decision: 'deny', note: 'other publish endpoints' },
  { methods: '*', re: /^\/api\/templates(\/.*)?$/, decision: 'deny', note: 'templates (apply/export are destructive)' },
];

/** Builder pages an editor session is redirected away from (302 `/ycode/collections`). */
export const EDITOR_PAGE_REDIRECTS: RegExp[] = [
  /^\/ycode\/(settings|integrations|components|localization|forms|profile|devtools|welcome|accept-invite|oauth)(\/|$)/,
];

/**
 * Routes under the public `/ycode/api/auth/` prefix that must still require a
 * session (inherited upstream hole: `GET /ycode/api/auth/users` listed every
 * e-mail unauthenticated — findings-editor-flow §1.4, SPEC-multisite M12).
 */
export const SESSION_REQUIRED_PUBLIC_PATHS = ['/ycode/api/auth/users', '/ycode/api/auth/invite', '/ycode/api/auth/set-role'];

function normalizeMethod(method: string): string {
  const m = (method || 'GET').toUpperCase();
  return m === 'HEAD' ? 'GET' : m;
}

function matchRule(rules: PolicyRule[], method: string, pathname: string): PolicyRule | undefined {
  return rules.find((rule) => (rule.methods === '*' || rule.methods.includes(method)) && rule.re.test(pathname));
}

/** `/ycode/api/**` or `/api/**` (JSON 403 on deny; everything else is a page). */
export function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/ycode/api/') || pathname === '/ycode/api' || pathname.startsWith('/api/') || pathname === '/api';
}

/**
 * Decision for an editor session: first matching rule; no rule -> deny for API
 * paths, allow for builder pages except `EDITOR_PAGE_REDIRECTS`.
 */
export function evaluateEditorPolicy(method: string, pathname: string): Decision {
  const m = normalizeMethod(method);
  if (matchRule(PUBLIC_ROUTE_RULES, m, pathname)) return { kind: 'allow' };

  const api = isApiPath(pathname);
  const rule = matchRule(EDITOR_API_RULES, m, pathname);
  if (rule) {
    if (rule.decision === 'rewrite') return { kind: 'rewrite', to: rule.to! };
    if (rule.decision === 'deny') return api ? { kind: 'deny' } : { kind: 'deny', redirect: EDITOR_HOME };
    return { kind: 'allow' };
  }
  if (api) return { kind: 'deny' };
  if (EDITOR_PAGE_REDIRECTS.some((re) => re.test(pathname))) return { kind: 'deny', redirect: EDITOR_HOME };
  return { kind: 'allow' }; // builder pages (client-gated), /ycode/preview, /webwow, /webwow/edit, /storage, /_next
}

/**
 * Classification for the enumeration test: `public` for visitor-facing routes
 * with their own auth, otherwise the matching editor rule's decision, or
 * `undefined` when no rule knows the route (the test fails on that).
 */
export function classifyRoute(method: string, pathname: string): 'allow' | 'deny' | 'rewrite' | 'public' | undefined {
  const m = normalizeMethod(method);
  if (matchRule(PUBLIC_ROUTE_RULES, m, pathname)) return 'public';
  return matchRule(EDITOR_API_RULES, m, pathname)?.decision;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  EDITOR_API_RULES,
  EDITOR_PAGE_REDIRECTS,
  PUBLIC_ROUTE_RULES,
  SESSION_REQUIRED_PUBLIC_PATHS,
  classifyRoute,
  evaluateEditorPolicy,
} from './proxy-policy';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Every (method, url pattern) exported by the route files under `dir` (mounted at `mount`). */
function enumerateRoutes(dir: string, mount: string): Array<{ method: string; url: string; file: string }> {
  const out: Array<{ method: string; url: string; file: string }> = [];
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  const entries = fs.readdirSync(abs, { recursive: true, encoding: 'utf8' }) as string[];
  for (const rel of entries) {
    if (path.basename(rel) !== 'route.ts') continue;
    const file = path.join(abs, rel);
    const source = fs.readFileSync(file, 'utf8');
    const methods = new Set<string>();
    for (const m of source.matchAll(/export (?:const|async function|function) (GET|POST|PUT|PATCH|DELETE)\b/g)) methods.add(m[1]);
    const segments = path.dirname(rel).split(path.sep).filter((s) => s && s !== '.');
    const url = `${mount}${segments.map((s) => (s.startsWith('[...') || s.startsWith('[[...') ? '/x/y' : s.startsWith('[') ? '/x' : `/${s}`)).join('')}`;
    for (const method of methods) out.push({ method, url, file: path.join(dir, rel) });
  }
  return out;
}

test('every API route under app/(builder)/ycode/api and app/(site)/api is classified', () => {
  const routes = [
    ...enumerateRoutes('app/(builder)/ycode/api', '/ycode/api'),
    ...enumerateRoutes('app/(site)/api', '/api'),
  ];
  assert.ok(routes.length > 150, `expected the upstream route inventory, found ${routes.length}`);
  const unknown = routes.filter((r) => classifyRoute(r.method, r.url) === undefined);
  assert.deepEqual(
    unknown.map((r) => `${r.method} ${r.url} (${r.file})`),
    [],
    'unclassified routes — add a rule to lib/webwow/proxy-policy.ts (see docs/UPSTREAM-SYNC.md §5)',
  );
});

test('rule tables are well-formed', () => {
  for (const rule of [...PUBLIC_ROUTE_RULES, ...EDITOR_API_RULES]) {
    assert.ok(rule.re.source.startsWith('^') && rule.re.source.endsWith('$'), `anchored: ${rule.re}`);
    assert.ok(rule.note.length > 0);
    if (rule.decision === 'rewrite') assert.ok(rule.to?.startsWith('/ycode/api/webwow/editor/'), `rewrite target: ${rule.re}`);
    else assert.equal(rule.to, undefined);
    if (rule.methods !== '*') for (const m of rule.methods) assert.match(m, /^(GET|POST|PUT|PATCH|DELETE)$/);
  }
  assert.deepEqual(SESSION_REQUIRED_PUBLIC_PATHS, ['/ycode/api/auth/users', '/ycode/api/auth/invite', '/ycode/api/auth/set-role']);
  assert.equal(EDITOR_PAGE_REDIRECTS.length, 1);
});

test('explicit decisions (SPEC-multisite §5, SPEC-edit §4/§6.5)', () => {
  const d = (method: string, pathname: string) => evaluateEditorPolicy(method, pathname);

  // denied even though the prefix is public
  assert.deepEqual(d('POST', '/ycode/api/webwow/auth/update-user'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/ycode/api/webwow/auth/signup'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/ycode/api/webwow/auth/login'), { kind: 'deny' });
  assert.deepEqual(d('GET', '/ycode/api/auth/users'), { kind: 'deny' });
  assert.deepEqual(d('PATCH', '/ycode/api/auth/users'), { kind: 'deny' });
  assert.deepEqual(d('GET', '/ycode/api/webwow/sites'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/ycode/api/webwow/sites/x/duplicate'), { kind: 'deny' });
  assert.deepEqual(d('DELETE', '/ycode/api/profile'), { kind: 'deny' });
  // rewrites
  assert.deepEqual(d('PUT', '/ycode/api/layers'), { kind: 'rewrite', to: '/ycode/api/webwow/editor/layers' });
  assert.deepEqual(d('POST', '/ycode/api/files/upload'), { kind: 'rewrite', to: '/ycode/api/webwow/editor/upload' });
  assert.deepEqual(d('POST', '/ycode/api/files/presign'), { kind: 'rewrite', to: '/ycode/api/webwow/editor/presign' });
  // allowed
  assert.deepEqual(d('GET', '/ycode/api/layers'), { kind: 'allow' });
  assert.deepEqual(d('HEAD', '/ycode/api/layers'), { kind: 'allow' });
  assert.deepEqual(d('GET', '/ycode/api/editor/init'), { kind: 'allow' });
  assert.deepEqual(d('POST', '/ycode/api/publish'), { kind: 'allow' });
  assert.deepEqual(d('GET', '/ycode/api/publish/preview'), { kind: 'allow' });
  assert.deepEqual(d('PUT', '/ycode/api/collections/c1/items/i1'), { kind: 'allow' });
  assert.deepEqual(d('POST', '/ycode/api/collections/c1/items/i1/duplicate'), { kind: 'allow' });
  assert.deepEqual(d('POST', '/ycode/api/collections/items/batch'), { kind: 'allow' });
  assert.deepEqual(d('GET', '/ycode/api/pages/p1/collection-item'), { kind: 'allow' });
  assert.deepEqual(d('GET', '/ycode/api/pages/slug/home'), { kind: 'allow' });
  assert.deepEqual(d('POST', '/ycode/api/setup/migrate'), { kind: 'allow' });
  assert.deepEqual(d('POST', '/ycode/api/webwow/auth/edit-login'), { kind: 'allow' });
  assert.deepEqual(d('POST', '/ycode/api/webwow/auth/logout'), { kind: 'allow' });
  assert.deepEqual(d('PUT', '/ycode/api/webwow/storage/upload'), { kind: 'allow' });
  assert.deepEqual(d('PUT', '/ycode/api/webwow/editor/layers'), { kind: 'allow' });
  assert.deepEqual(d('POST', '/ycode/api/webwow/editor/upload'), { kind: 'allow' });
  assert.deepEqual(d('GET', '/ycode/api/translations?locale_id=x'.split('?')[0]), { kind: 'allow' });
  // denied writes / destructive
  assert.deepEqual(d('POST', '/ycode/api/revert'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/ycode/api/cache/clear-all'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/ycode/api/css/generate'), { kind: 'deny' });
  assert.deepEqual(d('DELETE', '/ycode/api/pages/p1'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/ycode/api/pages'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/ycode/api/collections'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/ycode/api/collections/c1/publish'), { kind: 'deny' });
  assert.deepEqual(d('PUT', '/ycode/api/collections/c1/fields/reorder'), { kind: 'deny' });
  assert.deepEqual(d('PUT', '/ycode/api/settings/batch'), { kind: 'deny' });
  assert.deepEqual(d('GET', '/ycode/api/api-keys'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/ycode/api/mcp-tokens'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/ycode/api/devtools/reset-db'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/ycode/api/project/export'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/ycode/api/oauth/authorize'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/ycode/api/locales'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/ycode/api/locales/l1/default'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/ycode/api/layer-styles/bulk'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/ycode/api/components/c1/thumbnail'), { kind: 'deny' });
  assert.deepEqual(d('GET', '/ycode/api/form-submissions'), { kind: 'deny' });
  assert.deepEqual(d('DELETE', '/ycode/api/form-submissions/f1'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/ycode/api/assets/upload'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/ycode/api/webwow/webflow/import'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/api/templates/t1/apply'), { kind: 'deny' });
  assert.deepEqual(d('GET', '/api/templates'), { kind: 'deny' });
  // unknown API paths are denied
  assert.deepEqual(d('GET', '/ycode/api/does-not-exist'), { kind: 'deny' });
  assert.deepEqual(d('POST', '/api/nope'), { kind: 'deny' });
  // visitor-facing routes are never gated by the editor policy
  assert.deepEqual(d('POST', '/ycode/api/form-submissions'), { kind: 'allow' });
  assert.deepEqual(d('POST', '/ycode/api/collections/c1/items/load-more'), { kind: 'allow' });
  assert.deepEqual(d('GET', '/ycode/api/v1/collections'), { kind: 'allow' });
  assert.deepEqual(d('POST', '/ycode/api/oauth/token'), { kind: 'allow' });
  assert.deepEqual(d('POST', '/ycode/mcp'), { kind: 'allow' });
  // pages
  assert.deepEqual(d('GET', '/ycode/settings/general'), { kind: 'deny', redirect: '/ycode/collections' });
  assert.deepEqual(d('GET', '/ycode/integrations'), { kind: 'deny', redirect: '/ycode/collections' });
  assert.deepEqual(d('GET', '/ycode/components/c1'), { kind: 'deny', redirect: '/ycode/collections' });
  assert.deepEqual(d('GET', '/ycode/profile'), { kind: 'deny', redirect: '/ycode/collections' });
  assert.deepEqual(d('GET', '/ycode/forms'), { kind: 'deny', redirect: '/ycode/collections' });
  assert.deepEqual(d('GET', '/ycode/devtools/reset-db'), { kind: 'deny', redirect: '/ycode/collections' });
  assert.deepEqual(d('GET', '/ycode'), { kind: 'allow' });
  assert.deepEqual(d('GET', '/ycode/collections'), { kind: 'allow' });
  assert.deepEqual(d('GET', '/ycode/collections/c1'), { kind: 'allow' });
  assert.deepEqual(d('GET', '/ycode/layers/p1'), { kind: 'allow' });
  assert.deepEqual(d('GET', '/ycode/pages/p1'), { kind: 'allow' });
  assert.deepEqual(d('GET', '/ycode/preview/work'), { kind: 'allow' });
  assert.deepEqual(d('GET', '/webwow'), { kind: 'allow' });
  assert.deepEqual(d('GET', '/webwow/edit'), { kind: 'allow' });
  assert.deepEqual(d('GET', '/storage/v1/object/public/assets/x.png'), { kind: 'allow' });
  assert.deepEqual(d('GET', '/_next/static/x.js'), { kind: 'allow' });
});

test('classifyRoute distinguishes public routes from editor decisions', () => {
  assert.equal(classifyRoute('POST', '/ycode/api/form-submissions'), 'public');
  assert.equal(classifyRoute('GET', '/api/cron/airtable-webhooks'), 'public');
  assert.equal(classifyRoute('POST', '/api/page-auth/verify'), 'public');
  assert.equal(classifyRoute('GET', '/ycode/api/v1/forms'), 'public');
  assert.equal(classifyRoute('GET', '/ycode/api/pages'), 'allow');
  assert.equal(classifyRoute('PUT', '/ycode/api/layers'), 'rewrite');
  assert.equal(classifyRoute('POST', '/ycode/api/revert'), 'deny');
  assert.equal(classifyRoute('GET', '/ycode/api/brand-new-family'), undefined);
  assert.equal(classifyRoute('GET', '/api/brand-new'), undefined);
});

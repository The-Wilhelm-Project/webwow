import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCRUB_TABLES,
  SiteServiceError,
  buildUrlRewriteStatements,
  isScrubbedSettingKey,
  isSiteServiceError,
  looksLikeAgentSecretKey,
  normalizeDomains,
  validateEditorPassword,
  validateSiteName,
  validateSlug,
} from './service';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(isSiteServiceError(error), `expected a SiteServiceError, got ${String(error)}`);
    return (error as SiteServiceError).code;
  }
  assert.fail('expected an error');
}

test('validateSiteName: 1-80 chars, trimmed', () => {
  assert.equal(validateSiteName('  Valeska  '), 'Valeska');
  assert.equal(code(() => validateSiteName('')), 'invalid_name');
  assert.equal(code(() => validateSiteName('   ')), 'invalid_name');
  assert.equal(code(() => validateSiteName(undefined)), 'invalid_name');
  assert.equal(code(() => validateSiteName('x'.repeat(81))), 'invalid_name');
  assert.equal(validateSiteName('x'.repeat(80)).length, 80);
});

test('validateSlug: SITE_SLUG_RE + reserved slugs', () => {
  assert.equal(validateSlug('valeska'), 'valeska');
  assert.equal(validateSlug(' My-Site '), 'my-site');
  assert.equal(code(() => validateSlug('')), 'invalid_slug');
  assert.equal(code(() => validateSlug('-bad')), 'invalid_slug');
  assert.equal(code(() => validateSlug('bad-')), 'invalid_slug');
  assert.equal(code(() => validateSlug('has space')), 'invalid_slug');
  assert.equal(code(() => validateSlug('ünïcode')), 'invalid_slug');
  assert.equal(code(() => validateSlug('a'.repeat(51))), 'invalid_slug');
  for (const reserved of ['default', 'www', 'api', 'mail', 'localhost', 'ycode', 'webwow', 'admin', 'static', 'storage', 'a']) {
    assert.equal(code(() => validateSlug(reserved)), 'reserved_slug', reserved);
  }
});

test('normalizeDomains: lower-case, trimmed, port stripped, validated, unique', () => {
  assert.deepEqual(normalizeDomains([' Valeska.Example.com:443 ', 'https://www.example.com/path', 'valeska.example.com', '']), ['valeska.example.com', 'www.example.com']);
  assert.deepEqual(normalizeDomains([]), []);
  assert.equal(code(() => normalizeDomains('example.com')), 'invalid_domain');
  assert.equal(code(() => normalizeDomains([42])), 'invalid_domain');
  assert.equal(code(() => normalizeDomains(['exa mple.com'])), 'invalid_domain');
  assert.equal(code(() => normalizeDomains(['.example.com'])), 'invalid_domain');
  assert.equal(code(() => normalizeDomains(['example..com'])), 'invalid_domain');
  assert.equal(code(() => normalizeDomains(['exam_ple.com'])), 'invalid_domain');
});

test('validateEditorPassword: 10-128 chars', () => {
  assert.equal(validateEditorPassword('valeska-edit-2026'), 'valeska-edit-2026');
  assert.equal(code(() => validateEditorPassword('short')), 'password_too_short');
  assert.equal(code(() => validateEditorPassword(null)), 'password_too_short');
  assert.equal(code(() => validateEditorPassword('x'.repeat(129))), 'password_too_long');
});

test('SCRUB_TABLES covers every table of critique-security 1.4', () => {
  for (const table of ['auth.users', 'api_keys', 'app_settings', 'mcp_tokens', 'mcp_oauth_codes', 'mcp_oauth_clients', 'webhooks', 'webhook_deliveries', 'form_submissions', 'webflow_imports', 'versions', 'ai_chats', 'collection_imports', 'webwow_sites']) {
    assert.ok(SCRUB_TABLES.includes(table), table);
  }
  assert.equal(new Set(SCRUB_TABLES).size, SCRUB_TABLES.length, 'no duplicates');
  assert.ok(!SCRUB_TABLES.includes('settings'), 'settings are scrubbed per key, not truncated');
});

test('scrubbed setting keys: agent secrets, email/smtp, published_at', () => {
  const isAgent = looksLikeAgentSecretKey;
  assert.equal(isAgent('ai_anthropic_api_key'), true);
  assert.equal(isAgent('ai_openai_api_key:user-1'), true);
  assert.equal(isAgent('ai_model'), false);
  assert.equal(isScrubbedSettingKey('ai_anthropic_api_key', isAgent), true);
  assert.equal(isScrubbedSettingKey('email_from', isAgent), true);
  assert.equal(isScrubbedSettingKey('smtp_password', isAgent), true);
  assert.equal(isScrubbedSettingKey('published_at', isAgent), true);
  assert.equal(isScrubbedSettingKey('site_name', isAgent), false);
  assert.equal(isScrubbedSettingKey('custom_code_head', isAgent), false);
});

test('buildUrlRewriteStatements: whitelisted casts only, plain replace for a site source', () => {
  const columns = [
    { table: 'assets', column: 'public_url', dataType: 'text' },
    { table: 'pages', column: 'settings', dataType: 'jsonb' },
    { table: 'layers', column: 'data', dataType: 'json' },
    { table: 'fonts', column: 'name', dataType: 'character varying' },
    { table: 'assets', column: 'size', dataType: 'integer' },
    { table: 'evil', column: 'x', dataType: 'text; DROP TABLE settings' },
  ];
  const statements = buildUrlRewriteStatements(columns, '/public/assets/sites/s_abcdefghij/', '/public/assets/sites/s_klmnopqrst/');
  assert.equal(statements.length, 4, 'integer and unknown types skipped');
  const casts = statements.map((s) => /\)::(\w+) WHERE/.exec(s.sql)?.[1]);
  assert.deepEqual(casts, ['text', 'jsonb', 'json', 'text']);
  for (const s of statements) {
    assert.match(s.sql, /^UPDATE \?\? SET \?\? = replace\(\?\?::text, \?, \?\)::(text|json|jsonb) WHERE \?\?::text LIKE \?$/);
    assert.ok(!s.sql.includes('DROP'));
    assert.equal(s.bindings.length, 7);
    assert.equal(s.bindings[3], '/public/assets/sites/s_abcdefghij/');
    assert.equal(s.bindings[4], '/public/assets/sites/s_klmnopqrst/');
    assert.equal(s.bindings[6], '%/public/assets/sites/s\\_abcdefghij/%', 'LIKE wildcards escaped');
  }
  assert.deepEqual(statements[0].bindings.slice(0, 3), ['assets', 'public_url', 'public_url']);
});

test('buildUrlRewriteStatements: default source uses regexp_replace with a negative lookahead', () => {
  const columns = [{ table: 'assets', column: 'public_url', dataType: 'text' }, { table: 'pages', column: 'settings', dataType: 'jsonb' }];
  const statements = buildUrlRewriteStatements(columns, '/public/assets/', '/public/assets/sites/s_klmnopqrst/');
  assert.equal(statements.length, 2);
  for (const s of statements) {
    assert.match(s.sql, /^UPDATE \?\? SET \?\? = regexp_replace\(\?\?::text, \?, \?, 'g'\)::(text|jsonb) WHERE \?\?::text LIKE \?$/);
    assert.equal(s.bindings[3], '/public/assets/(?!sites/)');
    assert.equal(s.bindings[4], '/public/assets/sites/s_klmnopqrst/');
    assert.equal(s.bindings[6], '%/public/assets/%');
  }
  // explicit flag wins over the heuristic
  const forced = buildUrlRewriteStatements(columns, '/public/assets/sites/s_abcdefghij/', '/public/assets/sites/s_klmnopqrst/', { defaultSource: true });
  assert.match(forced[0].sql, /regexp_replace/);
  assert.equal(forced[0].bindings[3], '/public/assets/sites/s_abcdefghij/(?!sites/)');
  // regex metacharacters in the source prefix are escaped
  const dotted = buildUrlRewriteStatements(columns, '/public/my.bucket/', '/public/my.bucket/sites/s_klmnopqrst/');
  assert.equal(dotted[0].bindings[3], '/public/my\\.bucket/(?!sites/)');
});

test('SiteServiceError carries status and code', () => {
  const error = new SiteServiceError('nope', 409, 'slug_taken');
  assert.equal(error.status, 409);
  assert.equal(error.code, 'slug_taken');
  assert.equal(error.name, 'SiteServiceError');
  assert.ok(isSiteServiceError(error));
  assert.ok(!isSiteServiceError(new Error('x')));
});

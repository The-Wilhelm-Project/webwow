import type { Knex } from 'knex';

/**
 * Migration: Add OAuth 2.1 + Dynamic Client Registration support to the MCP server.
 *
 * Adds two new tables and extends `mcp_tokens` with OAuth-related columns so that
 * Claude.ai web and ChatGPT custom connectors (which require OAuth + PKCE per the
 * MCP authorization spec 2025-06-18) can authenticate against the YCode MCP server.
 *
 * The existing URL-token flow (`/ycode/mcp/[token]`) remains unchanged for
 * backward compatibility with Cursor, Windsurf, Claude Desktop, and Claude Code.
 */

export async function up(knex: Knex): Promise<void> {
  // --- mcp_oauth_clients (DCR registrations) ---
  const hasClientsTable = await knex.schema.hasTable('mcp_oauth_clients');
  if (!hasClientsTable) {
    await knex.schema.createTable('mcp_oauth_clients', (table) => {
      table.uuid('id').defaultTo(knex.raw('gen_random_uuid()')).primary();
      table.string('client_id', 128).notNullable().unique();
      table.string('client_name', 255).notNullable();
      table.specificType('redirect_uris', 'text[]').notNullable();
      table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    });

    await knex.schema.raw(
      'CREATE INDEX IF NOT EXISTS idx_mcp_oauth_clients_client_id ON mcp_oauth_clients(client_id)',
    );

    await knex.schema.raw('ALTER TABLE mcp_oauth_clients ENABLE ROW LEVEL SECURITY');

    await knex.schema.raw(`
      CREATE POLICY "OAuth clients are viewable by authenticated users"
        ON mcp_oauth_clients FOR SELECT
        USING ((SELECT auth.uid()) IS NOT NULL)
    `);
  }

  // --- mcp_oauth_codes (short-lived authorization codes) ---
  const hasCodesTable = await knex.schema.hasTable('mcp_oauth_codes');
  if (!hasCodesTable) {
    await knex.schema.createTable('mcp_oauth_codes', (table) => {
      table.string('code', 128).primary();
      table.string('client_id', 128).notNullable();
      table.string('redirect_uri', 1024).notNullable();
      table.string('code_challenge', 256).notNullable();
      table.string('code_challenge_method', 16).notNullable();
      table.string('scope', 256).nullable();
      table.uuid('user_id').notNullable();
      table.timestamp('expires_at', { useTz: true })
        .notNullable()
        .defaultTo(knex.raw("(NOW() + INTERVAL '10 minutes')"));
      table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    });

    await knex.schema.raw(
      'CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_expires_at ON mcp_oauth_codes(expires_at)',
    );

    await knex.schema.raw('ALTER TABLE mcp_oauth_codes ENABLE ROW LEVEL SECURITY');
  }

  // --- Extend mcp_tokens with OAuth-related columns ---
  const hasOauthClientId = await knex.schema.hasColumn('mcp_tokens', 'oauth_client_id');
  if (!hasOauthClientId) {
    await knex.schema.alterTable('mcp_tokens', (table) => {
      table.string('oauth_client_id', 128).nullable();
    });
  }

  const hasExpiresAt = await knex.schema.hasColumn('mcp_tokens', 'expires_at');
  if (!hasExpiresAt) {
    await knex.schema.alterTable('mcp_tokens', (table) => {
      table.timestamp('expires_at', { useTz: true }).nullable();
    });
  }

  const hasRefreshToken = await knex.schema.hasColumn('mcp_tokens', 'refresh_token');
  if (!hasRefreshToken) {
    await knex.schema.alterTable('mcp_tokens', (table) => {
      table.string('refresh_token', 128).nullable().unique();
    });
  }

  const hasRefreshExpiresAt = await knex.schema.hasColumn('mcp_tokens', 'refresh_expires_at');
  if (!hasRefreshExpiresAt) {
    await knex.schema.alterTable('mcp_tokens', (table) => {
      table.timestamp('refresh_expires_at', { useTz: true }).nullable();
    });
  }

  const hasUserId = await knex.schema.hasColumn('mcp_tokens', 'user_id');
  if (!hasUserId) {
    await knex.schema.alterTable('mcp_tokens', (table) => {
      table.uuid('user_id').nullable();
    });
  }

  // Partial index to quickly find active, non-expired tokens (covers both flows)
  await knex.schema.raw(`
    CREATE INDEX IF NOT EXISTS idx_mcp_tokens_oauth_client_id
    ON mcp_tokens(oauth_client_id) WHERE oauth_client_id IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  const hasUserId = await knex.schema.hasColumn('mcp_tokens', 'user_id');
  if (hasUserId) {
    await knex.schema.alterTable('mcp_tokens', (table) => {
      table.dropColumn('user_id');
    });
  }

  const hasRefreshExpiresAt = await knex.schema.hasColumn('mcp_tokens', 'refresh_expires_at');
  if (hasRefreshExpiresAt) {
    await knex.schema.alterTable('mcp_tokens', (table) => {
      table.dropColumn('refresh_expires_at');
    });
  }

  const hasRefreshToken = await knex.schema.hasColumn('mcp_tokens', 'refresh_token');
  if (hasRefreshToken) {
    await knex.schema.alterTable('mcp_tokens', (table) => {
      table.dropColumn('refresh_token');
    });
  }

  const hasExpiresAt = await knex.schema.hasColumn('mcp_tokens', 'expires_at');
  if (hasExpiresAt) {
    await knex.schema.alterTable('mcp_tokens', (table) => {
      table.dropColumn('expires_at');
    });
  }

  const hasOauthClientId = await knex.schema.hasColumn('mcp_tokens', 'oauth_client_id');
  if (hasOauthClientId) {
    await knex.schema.alterTable('mcp_tokens', (table) => {
      table.dropColumn('oauth_client_id');
    });
  }

  await knex.schema.dropTableIfExists('mcp_oauth_codes');
  await knex.schema.dropTableIfExists('mcp_oauth_clients');
}

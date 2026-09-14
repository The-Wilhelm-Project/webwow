import type { Knex } from 'knex';

/**
 * Migration: Hash MCP refresh tokens at rest.
 *
 * Refresh tokens were initially stored as plaintext in `mcp_tokens.refresh_token`.
 * That's unsafe — a database leak would let an attacker rotate every active
 * session. This migration mirrors the `api_keys` pattern: store only a SHA-256
 * hash of the refresh token and look it up by hash at rotation time. The
 * plaintext value is only ever returned to the OAuth client once at issue time.
 *
 * Steps (all guarded so the migration is idempotent and safe on template data):
 *   1. Add `refresh_token_hash TEXT UNIQUE NULL`.
 *   2. Backfill the hash from any existing plaintext rows.
 *   3. Drop the plaintext `refresh_token` column.
 */

export async function up(knex: Knex): Promise<void> {
  const hasHash = await knex.schema.hasColumn('mcp_tokens', 'refresh_token_hash');
  if (!hasHash) {
    await knex.schema.alterTable('mcp_tokens', (table) => {
      table.string('refresh_token_hash', 128).nullable().unique();
    });
  }

  const hasPlaintext = await knex.schema.hasColumn('mcp_tokens', 'refresh_token');
  if (hasPlaintext) {
    // Backfill hashes for any rows that still have a plaintext refresh token
    // and haven't been migrated yet. Uses pgcrypto's `digest` to compute the
    // SHA-256 hash in-place.
    await knex.raw(`
      UPDATE mcp_tokens
      SET refresh_token_hash = encode(digest(refresh_token, 'sha256'), 'hex')
      WHERE refresh_token IS NOT NULL
        AND refresh_token_hash IS NULL;
    `);

    await knex.schema.alterTable('mcp_tokens', (table) => {
      table.dropColumn('refresh_token');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasPlaintext = await knex.schema.hasColumn('mcp_tokens', 'refresh_token');
  if (!hasPlaintext) {
    await knex.schema.alterTable('mcp_tokens', (table) => {
      table.string('refresh_token', 128).nullable().unique();
    });
  }

  const hasHash = await knex.schema.hasColumn('mcp_tokens', 'refresh_token_hash');
  if (hasHash) {
    await knex.schema.alterTable('mcp_tokens', (table) => {
      table.dropColumn('refresh_token_hash');
    });
  }
}

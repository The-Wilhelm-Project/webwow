import { getSupabaseAdmin } from '@/lib/supabase-server';
import { randomBytes } from 'crypto';

/**
 * MCP OAuth Code Repository
 *
 * Stores short-lived (10 minute) authorization codes issued at the consent
 * step. Codes are single-use: `consumeCode` deletes the row atomically so a
 * replayed code is rejected even on concurrent requests.
 */

export interface McpOAuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string | null;
  user_id: string;
  expires_at: string;
  created_at: string;
}

export interface CreateCodeData {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope?: string | null;
  user_id: string;
}

function generateCode(): string {
  return 'mcp_code_' + randomBytes(32).toString('hex');
}

export async function createCode(data: CreateCodeData): Promise<string> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { error } = await client
    .from('mcp_oauth_codes')
    .insert({
      code,
      client_id: data.client_id,
      redirect_uri: data.redirect_uri,
      code_challenge: data.code_challenge,
      code_challenge_method: data.code_challenge_method,
      scope: data.scope ?? null,
      user_id: data.user_id,
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
    });

  if (error) {
    throw new Error(`Failed to create OAuth code: ${error.message}`);
  }

  return code;
}

/**
 * Atomically consume an authorization code: fetch it and delete it in the
 * same operation. Returns null if the code was already consumed, expired,
 * or never existed.
 */
export async function consumeCode(code: string): Promise<McpOAuthCode | null> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await client
    .from('mcp_oauth_codes')
    .delete()
    .eq('code', code)
    .select('code, client_id, redirect_uri, code_challenge, code_challenge_method, scope, user_id, expires_at, created_at')
    .single();

  if (error || !data) {
    return null;
  }

  if (new Date(data.expires_at).getTime() < Date.now()) {
    return null;
  }

  return data;
}

/**
 * Best-effort cleanup of expired codes. Safe to call from any request path;
 * we only schedule it occasionally to avoid load.
 */
export async function cleanupExpired(): Promise<void> {
  const client = await getSupabaseAdmin();

  if (!client) {
    return;
  }

  await client
    .from('mcp_oauth_codes')
    .delete()
    .lt('expires_at', new Date().toISOString());
}

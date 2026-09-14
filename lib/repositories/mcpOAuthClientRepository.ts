import { getSupabaseAdmin } from '@/lib/supabase-server';
import { randomBytes } from 'crypto';

/**
 * MCP OAuth Client Repository
 *
 * Stores RFC 7591 Dynamic Client Registration entries. The `client_id` itself
 * is not a secret (PKCE is the actual security mechanism) but we persist the
 * client name so the consent screen can display "Allow [Client Name]…" and
 * the registered redirect URIs so we can validate them at /authorize time.
 */

export interface McpOAuthClient {
  id: string;
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: string;
}

export interface RegisterClientData {
  client_name: string;
  redirect_uris: string[];
}

function generateClientId(): string {
  return 'mcp_client_' + randomBytes(24).toString('hex');
}

export async function registerClient(data: RegisterClientData): Promise<McpOAuthClient> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const clientId = generateClientId();

  const { data: row, error } = await client
    .from('mcp_oauth_clients')
    .insert({
      client_id: clientId,
      client_name: data.client_name,
      redirect_uris: data.redirect_uris,
      created_at: new Date().toISOString(),
    })
    .select('id, client_id, client_name, redirect_uris, created_at')
    .single();

  if (error) {
    throw new Error(`Failed to register OAuth client: ${error.message}`);
  }

  return row;
}

export async function getClient(clientId: string): Promise<McpOAuthClient | null> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await client
    .from('mcp_oauth_clients')
    .select('id, client_id, client_name, redirect_uris, created_at')
    .eq('client_id', clientId)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Failed to fetch OAuth client: ${error.message}`);
  }

  return data;
}

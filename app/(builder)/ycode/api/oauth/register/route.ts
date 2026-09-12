import { NextRequest } from 'next/server';
import { registerClient } from '@/lib/repositories/mcpOAuthClientRepository';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/oauth/register
 *
 * RFC 7591 — OAuth 2.0 Dynamic Client Registration.
 *
 * Public endpoint (no auth required). PKCE is the actual security mechanism
 * for the issued tokens; the returned `client_id` is opaque and not a secret.
 * We persist the `client_name` so the consent screen can show it to the user,
 * and the `redirect_uris` so /authorize can validate them on every request.
 */

interface RegisterBody {
  client_name?: unknown;
  redirect_uris?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  token_endpoint_auth_method?: unknown;
}

function jsonError(status: number, error: string, description?: string): Response {
  return new Response(
    JSON.stringify(description ? { error, error_description: description } : { error }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}

export async function POST(request: NextRequest) {
  let body: RegisterBody;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'invalid_client_metadata', 'Request body must be valid JSON');
  }

  const clientName = typeof body.client_name === 'string' && body.client_name.trim() !== ''
    ? body.client_name.trim()
    : 'MCP Client';

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === 'string' && u.length > 0)
    : [];

  if (redirectUris.length === 0) {
    return jsonError(
      400,
      'invalid_redirect_uri',
      'At least one redirect_uri is required',
    );
  }

  for (const uri of redirectUris) {
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== 'https:'
        && parsed.hostname !== 'localhost'
        && parsed.hostname !== '127.0.0.1') {
        return jsonError(
          400,
          'invalid_redirect_uri',
          `redirect_uri must use HTTPS (or be localhost): ${uri}`,
        );
      }
    } catch {
      return jsonError(400, 'invalid_redirect_uri', `Malformed redirect_uri: ${uri}`);
    }
  }

  try {
    const client = await registerClient({
      client_name: clientName,
      redirect_uris: redirectUris,
    });

    const issuedAt = Math.floor(new Date(client.created_at).getTime() / 1000);

    return new Response(
      JSON.stringify({
        client_id: client.client_id,
        client_id_issued_at: issuedAt,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
      {
        status: 201,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      },
    );
  } catch (error) {
    console.error('[oauth/register] Failed:', error);
    return jsonError(
      500,
      'server_error',
      error instanceof Error ? error.message : 'Failed to register client',
    );
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

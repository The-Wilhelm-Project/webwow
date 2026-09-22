import type { NextRequest } from 'next/server';
import { getBaseUrl, jsonMetadataResponse, optionsResponse } from '@/lib/oauth/metadata';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * RFC 8414 — OAuth 2.0 Authorization Server Metadata.
 *
 * Advertises the authorize, token, and registration endpoints, plus the
 * supported response types, grant types, and PKCE methods. MCP clients
 * (Claude.ai web, ChatGPT) fetch this to discover the OAuth flow.
 *
 * We deliberately do NOT advertise `client_id_metadata_document_supported`:
 * only DCR via /register is implemented. Advertising CIMD makes clients like
 * Claude send a URL as the client_id instead of registering, which then fails
 * the /authorize lookup with "Unknown client".
 */
export async function GET(request: NextRequest) {
  const baseUrl = getBaseUrl(request);

  return jsonMetadataResponse({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/ycode/oauth/authorize`,
    token_endpoint: `${baseUrl}/ycode/api/oauth/token`,
    registration_endpoint: `${baseUrl}/ycode/api/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  });
}

export async function OPTIONS() {
  return optionsResponse();
}

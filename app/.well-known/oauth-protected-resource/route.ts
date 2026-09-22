import type { NextRequest } from 'next/server';
import { getBaseUrl, jsonMetadataResponse, optionsResponse } from '@/lib/oauth/metadata';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * RFC 9728 — Protected Resource Metadata.
 *
 * Tells OAuth-aware MCP clients which authorization server protects this
 * deployment. Returned URL is absolute so it works behind reverse proxies
 * and on any host (Vercel preview, custom domain, localhost).
 */
export async function GET(request: NextRequest) {
  const baseUrl = getBaseUrl(request);

  return jsonMetadataResponse({
    resource: `${baseUrl}/ycode/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://github.com/ycode/ycode',
  });
}

export async function OPTIONS() {
  return optionsResponse();
}

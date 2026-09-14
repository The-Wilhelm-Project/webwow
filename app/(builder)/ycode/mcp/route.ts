import { NextRequest } from 'next/server';
import {
  authenticateToken,
  handleMcpPost,
  handleMcpGet,
  handleMcpDelete,
  addCorsHeaders,
  buildWwwAuthenticateHeader,
} from '@/lib/mcp/handler';
import { getBaseUrl } from '@/lib/oauth/metadata';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * OAuth Bearer-token MCP endpoint.
 *
 * Used by clients that authenticate per the MCP authorization spec
 * (Claude.ai web, ChatGPT). Returns 401 with a `WWW-Authenticate` header
 * pointing to the protected-resource metadata so unauthenticated clients
 * can discover the OAuth flow.
 *
 * The shared session/transport logic lives in `lib/mcp/handler.ts` and is
 * also used by the legacy URL-token endpoint at `/ycode/mcp/[token]`.
 */

function extractBearerToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization') || request.headers.get('Authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function unauthorizedWithChallenge(request: NextRequest, message: string): Response {
  const baseUrl = getBaseUrl(request);
  const response = new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': buildWwwAuthenticateHeader(baseUrl),
    },
  });
  return addCorsHeaders(response);
}

async function authorize(request: NextRequest): Promise<Response | null> {
  const token = extractBearerToken(request);
  if (!token) {
    return unauthorizedWithChallenge(request, 'Authorization required');
  }

  const valid = await authenticateToken(token);
  if (!valid) {
    return unauthorizedWithChallenge(request, 'Invalid or expired access token');
  }

  return null;
}

export async function POST(request: NextRequest) {
  const denied = await authorize(request);
  if (denied) return denied;
  return handleMcpPost(request);
}

export async function GET(request: NextRequest) {
  const denied = await authorize(request);
  if (denied) return denied;
  return handleMcpGet(request);
}

export async function DELETE(request: NextRequest) {
  const denied = await authorize(request);
  if (denied) return denied;
  return handleMcpDelete(request);
}

export async function OPTIONS() {
  return addCorsHeaders(new Response(null, { status: 204 }));
}

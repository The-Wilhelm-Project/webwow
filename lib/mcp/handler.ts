import { randomUUID } from 'crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { validateToken } from '@/lib/repositories/mcpTokenRepository';
import { createMcpServer } from '@/lib/mcp/server';
import { getCachedToken, setCachedToken } from '@/lib/mcp/token-cache';

/**
 * Shared MCP HTTP handler used by both the URL-token endpoint
 * (`/ycode/mcp/[token]`) and the OAuth Bearer-token endpoint
 * (`/ycode/mcp`).
 *
 * Authentication is the only thing that differs between the two — once a
 * token is validated, the request body, session lifecycle, transport, and
 * CORS handling are identical.
 */

interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
}

const sessions = new Map<string, McpSession>();

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

function cleanupStaleSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      session.transport.close().catch(() => {});
      sessions.delete(id);
    }
  }
}

export async function authenticateToken(token: string): Promise<boolean> {
  const cached = getCachedToken(token);
  if (cached) {
    return cached.valid;
  }

  let valid = false;
  try {
    const result = await validateToken(token);
    valid = result !== null;
  } catch {
    valid = false;
  }

  setCachedToken(token, valid);
  return valid;
}

export function addCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, mcp-protocol-version, Authorization');
  headers.set('Access-Control-Expose-Headers', 'mcp-session-id');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function createSessionTransport() {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (newSessionId) => {
      sessions.set(newSessionId, { transport, server, lastActivity: Date.now() });
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
  };

  return { server, transport };
}

/**
 * Auto-initialize a fresh server+transport so it can handle non-init requests.
 * Needed on serverless (Vercel) where in-memory sessions are lost between
 * requests that hit different instances.
 */
async function autoInitialize(
  transport: WebStandardStreamableHTTPServerTransport,
  url: string,
): Promise<void> {
  const initReq = new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
  });

  await transport.handleRequest(initReq, {
    parsedBody: {
      jsonrpc: '2.0',
      id: '_auto_init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'ycode-auto', version: '1.0.0' },
      },
    },
  });

  const notifReq = new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': transport.sessionId!,
    },
  });

  await transport.handleRequest(notifReq, {
    parsedBody: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
}

/**
 * Some MCP clients (e.g., Claude Code) don't send text/event-stream,
 * but the SDK enforces it even when enableJsonResponse is true.
 */
function ensureAcceptHeader(request: Request): Request {
  const accept = request.headers.get('accept') || '';
  if (accept.includes('application/json') && accept.includes('text/event-stream')) {
    return request;
  }

  const headers = new Headers(request.headers);
  headers.set('Accept', 'application/json, text/event-stream');
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error duplex is needed for streaming body but not in all TS defs
    duplex: 'half',
  });
}

async function handlePost(request: Request): Promise<Response> {
  const normalized = ensureAcceptHeader(request);
  const sessionId = normalized.headers.get('mcp-session-id');

  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.lastActivity = Date.now();
    return session.transport.handleRequest(normalized);
  }

  const body = await normalized.json();
  const isInit = !Array.isArray(body) && body.method === 'initialize';

  const { server, transport } = createSessionTransport();
  await server.connect(transport);

  if (isInit) {
    const req = new Request(normalized.url, {
      method: 'POST',
      headers: normalized.headers,
    });
    return transport.handleRequest(req, { parsedBody: body });
  }

  await autoInitialize(transport, normalized.url);

  const actualReq = new Request(normalized.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': transport.sessionId!,
    },
  });

  return transport.handleRequest(actualReq, { parsedBody: body });
}

export async function handleMcpPost(request: Request): Promise<Response> {
  cleanupStaleSessions();
  try {
    const response = await handlePost(request);
    return addCorsHeaders(response);
  } catch (error) {
    console.error('[MCP POST] Error:', error);
    return addCorsHeaders(new Response(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32603, message: error instanceof Error ? error.message : 'Internal server error' },
      id: null,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }));
  }
}

export async function handleMcpGet(request: Request): Promise<Response> {
  try {
    const sessionId = request.headers.get('mcp-session-id');
    if (!sessionId || !sessions.has(sessionId)) {
      return addCorsHeaders(new Response(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session not found. Send a POST initialize first.' },
        id: null,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    const session = sessions.get(sessionId)!;
    session.lastActivity = Date.now();
    const response = await session.transport.handleRequest(request);
    return addCorsHeaders(response);
  } catch (error) {
    console.error('[MCP GET] Error:', error);
    return addCorsHeaders(new Response(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32603, message: error instanceof Error ? error.message : 'Internal server error' },
      id: null,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }));
  }
}

export async function handleMcpDelete(request: Request): Promise<Response> {
  try {
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      await session.transport.close();
      sessions.delete(sessionId);
    }
    return addCorsHeaders(new Response(null, { status: 204 }));
  } catch (error) {
    console.error('[MCP DELETE] Error:', error);
    return addCorsHeaders(new Response(null, { status: 204 }));
  }
}

export function unauthorizedJson(message: string): Response {
  return addCorsHeaders(new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  }));
}

/**
 * Build the `WWW-Authenticate` header value used by the bearer-token MCP
 * endpoint. Includes the absolute URL of the protected-resource metadata
 * document so OAuth-aware clients can discover the auth server.
 */
export function buildWwwAuthenticateHeader(baseUrl: string): string {
  const resourceMetadata = `${baseUrl}/.well-known/oauth-protected-resource/ycode/mcp`;
  return `Bearer realm="ycode", resource_metadata="${resourceMetadata}"`;
}

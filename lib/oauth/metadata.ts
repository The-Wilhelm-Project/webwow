import type { NextRequest } from 'next/server';

/**
 * Shared helpers for building absolute URLs in OAuth metadata documents.
 *
 * We derive the public base URL from the request headers so that the
 * advertised endpoints work regardless of deployment host (Vercel preview,
 * custom domain, localhost).
 */

export function getBaseUrl(request: NextRequest | Request): string {
  const host = request.headers.get('host') || 'localhost:3000';
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const protocol = forwardedProto || (host.startsWith('localhost') ? 'http' : 'https');
  return `${protocol}://${host}`;
}

export function jsonMetadataResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

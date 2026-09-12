import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { z } from 'zod';

import { resolveAgentConfig } from '@/lib/agent/config';
import { getAuthUser } from '@/lib/supabase-auth';

import type { AgentProviderId } from '@/lib/agent/models';

const bodySchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'google', 'xai']).default('anthropic'),
  // Key to test; falls back to the provider's currently configured key when
  // omitted so the user can verify an already-saved configuration.
  apiKey: z.string().optional(),
});

/**
 * POST /ycode/api/settings/agent/test
 *
 * Verify a provider API key by making a cheap authenticated request
 * (models list — no tokens billed).
 */
export async function POST(request: NextRequest) {
  let provider: AgentProviderId = 'anthropic';
  try {
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    provider = body.provider;

    let apiKey = body.apiKey?.trim();
    if (!apiKey) {
      // Resolve as the current user so their personal key is the one tested.
      const auth = await getAuthUser();
      const config = await resolveAgentConfig(auth?.user.id);
      apiKey = config.providers[provider].apiKey ?? undefined;
    }

    if (!apiKey) {
      return NextResponse.json({ error: 'No API key to test' }, { status: 400 });
    }

    await testKey(provider, apiKey);

    return NextResponse.json({
      data: { success: true },
      message: 'API key is valid',
    });
  } catch (error) {
    const friendly = toFriendlyError(provider, error);
    if (friendly) {
      return NextResponse.json({ error: friendly }, { status: 400 });
    }
    console.error('[API] Error testing agent API key:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to test API key' },
      { status: 500 }
    );
  }
}

async function testKey(provider: AgentProviderId, apiKey: string): Promise<void> {
  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey, maxRetries: 0 });
    await client.models.list({ limit: 1 });
    return;
  }
  if (provider === 'openai') {
    const client = new OpenAI({ apiKey, maxRetries: 0 });
    await client.models.list();
    return;
  }
  if (provider === 'xai') {
    await testXaiKey(apiKey);
    return;
  }
  const client = new GoogleGenAI({ apiKey });
  await client.models.list({ config: { pageSize: 1 } });
}

/** A key problem xAI reported that should surface to the user as-is. */
class XaiKeyError extends Error {}

/**
 * xAI API keys carry per-endpoint ACLs, so listing models (how the other
 * providers are tested) 403s for keys that were never granted that endpoint —
 * even when the key is fine for chat. GET /v1/api-key validates any key
 * without requiring ACLs and reports its status and permissions.
 */
async function testXaiKey(apiKey: string): Promise<void> {
  const response = await fetch('https://api.x.ai/v1/api-key', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (response.status === 401 || response.status === 403) {
    throw new XaiKeyError('Invalid API key');
  }
  if (!response.ok) {
    throw new XaiKeyError(`xAI API error: ${response.status} ${response.statusText}`);
  }

  const info = (await response.json()) as {
    api_key_blocked?: boolean;
    api_key_disabled?: boolean;
    team_blocked?: boolean;
    acls?: string[];
  };

  if (info.api_key_disabled || info.api_key_blocked) {
    throw new XaiKeyError('API key is valid but disabled or blocked — re-enable it in the xAI Console');
  }
  // xAI blocks the whole team until it has credits, so this is usually a
  // billing problem rather than a key problem.
  if (info.team_blocked) {
    throw new XaiKeyError('API key is valid but your xAI team is blocked — this usually means it has no credits yet. Add credits in the xAI Console.');
  }

  // The agent talks to the chat endpoint, so a key without that ACL will fail
  // at build time even though it authenticates fine.
  const acls = info.acls ?? [];
  const hasChatAccess = acls.some(
    (acl) => acl === 'api-key:endpoint:*' || acl === 'api-key:endpoint:chat',
  );
  if (!hasChatAccess) {
    throw new XaiKeyError(
      'API key is valid but has no chat endpoint permission — edit the key in the xAI Console and grant it the "chat" endpoint (or all endpoints)',
    );
  }
}

/** Map SDK auth/permission errors to a user-facing message, or null for
 * unexpected failures (which surface as a 500). */
function toFriendlyError(provider: AgentProviderId, error: unknown): string | null {
  if (error instanceof XaiKeyError) {
    return error.message;
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof OpenAI.AuthenticationError) {
    return 'Invalid API key';
  }
  if (error instanceof Anthropic.PermissionDeniedError || error instanceof OpenAI.PermissionDeniedError) {
    return 'API key is valid but has no access to this API';
  }
  if (error instanceof Anthropic.APIError) {
    return `Anthropic API error: ${error.message}`;
  }
  if (error instanceof OpenAI.APIError) {
    return `OpenAI API error: ${error.message}`;
  }
  // The Google SDK throws plain errors; auth failures carry a 400 with
  // "API key not valid" or a 403.
  if (provider === 'google' && error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('api key not valid') || message.includes('api_key_invalid') || message.includes('permission')) {
      return 'Invalid API key';
    }
    return `Google API error: ${error.message}`;
  }
  return null;
}

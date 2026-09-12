import OpenAI from 'openai';

import { createChatCompletionsProvider } from './openai';

import type { AgentProvider } from './types';

/**
 * BYOK xAI (Grok) provider.
 *
 * xAI's API is OpenAI Chat Completions-compatible, so this reuses the shared
 * Chat Completions provider with the x.ai base URL. Grok models manage
 * reasoning internally and don't take a reasoning_effort parameter, so none
 * is sent (the shared factory's default).
 */
export function createXaiProvider(apiKey: string): AgentProvider {
  const client = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1', maxRetries: 2 });
  return createChatCompletionsProvider('xai-byok', client);
}

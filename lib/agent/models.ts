/**
 * Models and providers the in-app AI builder can use.
 *
 * This module has no server-only imports so it can be shared between the client
 * (model picker UI) and the server (request validation). The actual default is
 * still resolved server-side from settings/env in `lib/agent/config.ts`.
 */

export type AgentProviderId = 'anthropic' | 'openai' | 'google' | 'xai';

export interface AgentProviderOption {
  id: AgentProviderId;
  label: string;
  /** Env var that supplies the key when no setting is stored. */
  envVar: string;
  /** Input placeholder hint for the key field. */
  keyPlaceholder: string;
  /** Where the user creates an API key. */
  consoleUrl: string;
  consoleLabel: string;
}

export const AGENT_PROVIDERS: AgentProviderOption[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    envVar: 'ANTHROPIC_API_KEY',
    keyPlaceholder: 'sk-ant-...',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    consoleLabel: 'Anthropic Console',
  },
  {
    id: 'openai',
    label: 'OpenAI (ChatGPT)',
    envVar: 'OPENAI_API_KEY',
    keyPlaceholder: 'sk-...',
    consoleUrl: 'https://platform.openai.com/api-keys',
    consoleLabel: 'OpenAI Platform',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    envVar: 'GEMINI_API_KEY',
    keyPlaceholder: 'AIza...',
    consoleUrl: 'https://aistudio.google.com/apikey',
    consoleLabel: 'Google AI Studio',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    envVar: 'XAI_API_KEY',
    keyPlaceholder: 'xai-...',
    consoleUrl: 'https://console.x.ai',
    consoleLabel: 'xAI Console',
  },
];

export interface AgentModelOption {
  id: string;
  label: string;
  provider: AgentProviderId;
  /** Superseded model kept for projects that already have it enabled. Legacy
   * models are excluded from the default enabled set and hidden in settings
   * unless present in the stored allowlist, so no new project can adopt them. */
  legacy?: boolean;
}

export const AGENT_MODELS: AgentModelOption[] = [
  { id: 'claude-opus-5', label: 'Opus 5', provider: 'anthropic' },
  { id: 'claude-fable-5', label: 'Fable 5', provider: 'anthropic' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', provider: 'anthropic' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', provider: 'anthropic', legacy: true },
  { id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai' },
  { id: 'gpt-5-mini', label: 'GPT-5 Mini', provider: 'openai' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', provider: 'google' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'google' },
  { id: 'grok-4.5', label: 'Grok 4.5', provider: 'xai' },
  { id: 'grok-4.3', label: 'Grok 4.3', provider: 'xai' },
];

/**
 * Model selected by default in the picker. Opus 5 is Anthropic's recommended
 * production tier and prices the same as the Opus 4.8 it replaces; users who
 * want a cheaper (Sonnet 5) or stronger (Fable 5) model — or a different
 * provider — can switch from the dropdown.
 */
export const DEFAULT_AGENT_MODEL = 'claude-opus-5';

/**
 * Models the removed automatic self-review pass ran on, per provider. Kept so
 * providerOfModel still resolves these ids — they appear on assistant turns in
 * older persisted chats (and in stored usage records).
 */
const LEGACY_REVIEW_MODEL_BY_PROVIDER: Record<AgentProviderId, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5-mini',
  google: 'gemini-3.5-flash',
  xai: 'grok-4.3',
};

/** Which provider serves a model id, or null for unknown/custom models.
 * Resolves picker models (AGENT_MODELS) and the legacy review-only ids found
 * in older chats, so key/provider checks work for both. */
export function providerOfModel(id: string): AgentProviderId | null {
  const pickerProvider = AGENT_MODELS.find((model) => model.id === id)?.provider;
  if (pickerProvider) return pickerProvider;
  const reviewEntry = (Object.entries(LEGACY_REVIEW_MODEL_BY_PROVIDER) as Array<[AgentProviderId, string]>)
    .find(([, modelId]) => modelId === id);
  return reviewEntry ? reviewEntry[0] : null;
}

/** Whether a requested model id is one the agent is allowed to use. */
export function isAllowedModel(id: string): boolean {
  return AGENT_MODELS.some((model) => model.id === id);
}

/** USD per million tokens, split by how Anthropic bills each token class. */
interface ModelPricing {
  input: number;
  output: number;
  /** Ephemeral (5-minute) cache writes are billed at 1.25x input. */
  cacheWrite: number;
  /** Cache reads are billed at 0.1x input. */
  cacheRead: number;
}

/**
 * Provider list prices (USD / MTok), used for the approximate session cost in
 * the usage badge. Estimates only — not billing data.
 *
 * claude-sonnet-5 uses the introductory rate in effect through Aug 31, 2026
 * ($2/$10); it moves to $3/$15 on Sep 1, 2026.
 *
 * OpenAI and Google cache automatically and don't bill cache writes, so their
 * cacheWrite matches the plain input rate (a cache-writing input token costs
 * the same as an uncached one).
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  // Review-only fast tier (not in the picker). Estimate for the cost badge.
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'gpt-5.5': { input: 5, output: 30, cacheWrite: 5, cacheRead: 0.5 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheWrite: 0.25, cacheRead: 0.025 },
  'gemini-3.1-pro-preview': { input: 2, output: 12, cacheWrite: 2, cacheRead: 0.2 },
  'gemini-3.5-flash': { input: 1.5, output: 9, cacheWrite: 1.5, cacheRead: 0.15 },
  // xAI standard-context rates (< 200k prompt tokens); like OpenAI, xAI caches
  // automatically and doesn't bill cache writes separately.
  'grok-4.5': { input: 2, output: 6, cacheWrite: 2, cacheRead: 0.3 },
  'grok-4.3': { input: 1.25, output: 2.5, cacheWrite: 1.25, cacheRead: 0.2 },
};

export interface TokenUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

/**
 * Approximate USD cost of a usage report for a given model, or null when the
 * model isn't in the pricing table (e.g. a custom ANTHROPIC_MODEL override) —
 * callers should hide the estimate rather than show a wrong number.
 */
export function estimateCostUsd(model: string, usage: TokenUsageBreakdown): number | null {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return null;

  return (
    (usage.inputTokens * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cacheWriteTokens * pricing.cacheWrite +
      usage.cacheReadTokens * pricing.cacheRead) / 1_000_000
  );
}

/**
 * Provider SDK errors often carry a raw API response body as their message.
 * The Google SDK is the worst offender: its message is a JSON envelope
 * ({"error":{"message":"...","code":429,...}}) whose inner message is itself
 * another JSON blob, followed by per-quota bullet lines. Unwrap all of that to
 * the human-readable sentence so the chat panel never shows raw JSON.
 */
export function humanizeProviderError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  let message = raw.trim();

  // Unwrap nested {"error":{"message":...}} envelopes (Google nests two deep).
  for (let depth = 0; depth < 3; depth += 1) {
    if (!message.startsWith('{')) break;
    const inner = parseErrorEnvelope(message);
    if (!inner) break;
    message = inner;
  }

  // Keep only the leading prose: Gemini appends "* Quota exceeded for
  // metric ..." bullet lines and retry hints on separate lines.
  const firstLine = message.split('\n')[0]?.trim() ?? '';
  return firstLine || 'Agent run failed';
}

function parseErrorEnvelope(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as { error?: { message?: unknown }; message?: unknown };
    const inner = parsed.error?.message ?? parsed.message;
    return typeof inner === 'string' && inner.trim() ? inner.trim() : null;
  } catch {
    return null;
  }
}

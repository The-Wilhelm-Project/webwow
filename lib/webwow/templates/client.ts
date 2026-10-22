/**
 * Browser call for the universal ontology template (used by the builder's CMS rail panel).
 * Kept here instead of lib/api.ts so the upstream API client stays byte-identical.
 */

import type { UniversalTemplateOptions, UniversalTemplateResult } from './universal-template';

export async function requestUniversalTemplate(options: UniversalTemplateOptions = {}): Promise<UniversalTemplateResult> {
  const response = await fetch('/ycode/api/webwow/templates/universal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  const json = await response.json().catch(() => null) as { data?: UniversalTemplateResult; error?: string } | null;
  if (!response.ok || !json?.data) {
    throw new Error(json?.error || `HTTP ${response.status}: ${response.statusText}`);
  }
  return json.data;
}

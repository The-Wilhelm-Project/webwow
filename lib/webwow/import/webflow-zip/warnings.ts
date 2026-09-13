/**
 * Warning collector for the Webflow ZIP importer.
 *
 * Identical warnings (same code, message and page) merge into one entry whose
 * `count` grows, so a loop over 97 CSV rows reporting the same problem yields a
 * single line "… (x97)" instead of 97 lines.
 */

import type { WfWarning, WfWarningCode } from './types';

export interface WarningContext {
  page?: string;
  node?: string;
  /** Number of occurrences to record at once (default 1). */
  count?: number;
}

export class Warnings {
  readonly list: WfWarning[] = [];
  private readonly index = new Map<string, WfWarning>();

  add(code: WfWarningCode, message: string, ctx?: WarningContext): void {
    const n = Math.max(1, Math.floor(ctx?.count ?? 1));
    const key = JSON.stringify([code, message, ctx?.page ?? '']);
    const existing = this.index.get(key);
    if (existing) {
      existing.count = (existing.count ?? 1) + n;
      return;
    }
    const warning: WfWarning = { code, message, count: n };
    if (ctx?.page) warning.page = ctx.page;
    if (ctx?.node) warning.node = ctx.node;
    this.list.push(warning);
    this.index.set(key, warning);
  }

  /** Total occurrences (sum of counts) recorded for a code. */
  count(code: WfWarningCode): number {
    let total = 0;
    for (const w of this.list) if (w.code === code) total += w.count ?? 1;
    return total;
  }

  /** Occurrences per code (only codes that occurred). */
  summary(): Partial<Record<WfWarningCode, number>> {
    const out: Partial<Record<WfWarningCode, number>> = {};
    for (const w of this.list) out[w.code] = (out[w.code] ?? 0) + (w.count ?? 1);
    return out;
  }
}

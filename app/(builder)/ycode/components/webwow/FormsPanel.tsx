'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDate } from '@/lib/utils';
import type { FormSummary } from '@/types';
import PanelLinkList, { PanelSectionTitle } from './PanelLinkList';

export interface RoutePanelProps {
  goTo: (path: string) => void;
}

const CACHE_TTL_MS = 30_000;
let cache: { at: number; data: FormSummary[] } | null = null;

async function fetchFormSummaries(force = false): Promise<FormSummary[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const response = await fetch('/ycode/api/form-submissions?summary=true');
  const json = await response.json();
  if (json.error) throw new Error(json.error);
  const data: FormSummary[] = json.data || [];
  cache = { at: Date.now(), data };
  return data;
}

/** Forms with their submission counts; opens `/ycode/forms`. */
function FormsPanel({ goTo }: RoutePanelProps) {
  const currentPath = usePathname();
  const [summaries, setSummaries] = useState<FormSummary[] | null>(cache?.data ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      setSummaries(await fetchFormSummaries(force));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load forms');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totalNew = (summaries ?? []).reduce((sum, s) => sum + (s.new_count || 0), 0);
  const onFormsRoute = currentPath?.startsWith('/ycode/forms') ?? false;

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-webwow-forms-panel>
      <div className="px-3 pt-3 pb-2 border-b flex items-center gap-1.5">
        <Button
          size="sm" variant="secondary"
          className="flex-1" onClick={() => goTo('/ycode/forms')}
          aria-current={onFormsRoute ? 'page' : undefined}
        >
          <Icon name="form" />
          Open forms
          {totalNew > 0 && <Badge variant="default" className="ml-1 px-1.5 py-0 text-[10px]">{totalNew} new</Badge>}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm" variant="secondary"
              aria-label="Refresh" disabled={loading}
              onClick={() => { void load(true); }}
            >
              {loading ? <Spinner /> : <Icon name="refresh" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Refresh</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
        <PanelSectionTitle>Forms</PanelSectionTitle>
        {error && <p className="px-4 py-2 text-xs text-destructive">{error}</p>}
        {summaries === null && loading && <div className="flex justify-center py-6"><Spinner /></div>}
        {summaries !== null && (
          <PanelLinkList
            emptyText="No submissions yet. Submissions from published forms show up here."
            links={summaries.map((s) => ({
              id: s.form_id,
              label: s.form_id,
              icon: 'form',
              description: s.latest_submission ? `Last ${formatDate(s.latest_submission)}` : undefined,
              hint: s.new_count > 0 ? `${s.new_count} new · ${s.submission_count}` : String(s.submission_count),
              onSelect: () => goTo('/ycode/forms'),
            }))}
          />
        )}
      </div>
    </div>
  );
}

export default React.memo(FormsPanel);

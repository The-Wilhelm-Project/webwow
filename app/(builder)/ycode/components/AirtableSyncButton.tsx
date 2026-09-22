'use client';

import { useState, useEffect, useCallback, memo } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { toast } from 'sonner';

import airtableLogo from '@/lib/apps/airtable/logo.svg';
import { airtableApi, fetchCachedConnections, getCachedConnection } from '@/lib/apps/airtable/client';
import type { AirtableConnection } from '@/lib/apps/airtable/types';

interface AirtableSyncButtonProps {
  collectionId: string;
  onSyncComplete?: () => void;
}

/** Renders an Airtable dropdown in the CMS toolbar when the collection has an active connection */
function AirtableSyncButton({ collectionId, onSyncComplete }: AirtableSyncButtonProps) {
  const router = useRouter();
  const [connection, setConnection] = useState<AirtableConnection | null>(
    () => getCachedConnection(collectionId)
  );
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;

    setConnection(getCachedConnection(collectionId));

    fetchCachedConnections().then((conns) => {
      if (cancelled) return;
      setConnection(conns.find((c) => c.collectionId === collectionId) ?? null);
    });

    return () => { cancelled = true; };
  }, [collectionId]);

  const handleSync = useCallback(async () => {
    if (!connection) return;

    try {
      setIsSyncing(true);
      await airtableApi.sync(connection.id);
      onSyncComplete?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Sync failed');
    } finally {
      setIsSyncing(false);
    }
  }, [connection, onSyncComplete]);

  if (!connection) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="gap-2"
        >
          {isSyncing && <Spinner className="size-3" />}
          <Image
            src={airtableLogo}
            alt="Airtable"
            width={14}
            height={14}
            className="shrink-0"
          />
          Airtable
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={handleSync}
          disabled={isSyncing}
        >
          {isSyncing ? 'Syncing data...' : 'Sync data now'}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push('/ycode/integrations/apps?app=airtable')}>
          Go to settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default memo(AirtableSyncButton);

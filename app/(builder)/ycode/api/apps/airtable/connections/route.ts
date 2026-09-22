import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import {
  getConnections,
  saveConnections,
  ensureRecordIdField,
  requireAirtableToken,
} from '@/lib/apps/airtable/sync-service';
import { noCache } from '@/lib/api-response';
import type { AirtableConnection } from '@/lib/apps/airtable/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/apps/airtable/connections
 * List all configured Airtable sync connections
 */
export async function GET() {
  try {
    const connections = await getConnections();
    return noCache({ data: connections });
  } catch (error) {
    console.error('Error fetching Airtable connections:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch connections' },
      500
    );
  }
}

/**
 * POST /ycode/api/apps/airtable/connections
 * Create a new Airtable sync connection
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { baseId, baseName, tableId, tableName, collectionId, collectionName, fieldMapping } = body;

    if (!baseId || !tableId || !collectionId || !fieldMapping) {
      return noCache({ error: 'baseId, tableId, collectionId, and fieldMapping are required' }, 400);
    }

    await requireAirtableToken();
    const recordIdFieldId = await ensureRecordIdField(collectionId);

    const newConnection: AirtableConnection = {
      id: randomUUID(),
      baseId,
      baseName: baseName || baseId,
      tableId,
      tableName: tableName || tableId,
      collectionId,
      collectionName: collectionName || '',
      fieldMapping: fieldMapping || [],
      recordIdFieldId,
      webhookId: null,
      webhookCursor: 0,
      webhookSecret: null,
      webhookExpiresAt: null,
      webhookExpiredAt: null,
      lastSyncedAt: null,
      syncStatus: 'idle',
      syncError: null,
    };

    const connections = await getConnections();
    connections.push(newConnection);
    await saveConnections(connections);

    return noCache({ data: newConnection }, 201);
  } catch (error) {
    console.error('Error creating Airtable connection:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to create connection' },
      500
    );
  }
}

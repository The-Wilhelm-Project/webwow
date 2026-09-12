import { NextRequest } from 'next/server';
import {
  getConnections,
  saveConnections,
  updateConnection,
  requireAirtableToken,
} from '@/lib/apps/airtable/sync-service';
import { deleteWebhook } from '@/lib/apps/airtable';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * PUT /ycode/api/apps/airtable/connections/[connectionId]
 * Update field mapping for a connection
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  try {
    const { connectionId } = await params;
    const body = await request.json();

    const updated = await updateConnection(connectionId, {
      fieldMapping: body.fieldMapping,
    });

    if (!updated) {
      return noCache({ error: 'Connection not found' }, 404);
    }

    return noCache({ data: updated });
  } catch (error) {
    console.error('Error updating Airtable connection:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to update connection' },
      500
    );
  }
}

/**
 * DELETE /ycode/api/apps/airtable/connections/[connectionId]
 * Remove a connection and its webhook
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  try {
    const { connectionId } = await params;
    const connections = await getConnections();
    const connection = connections.find((c) => c.id === connectionId);

    if (!connection) {
      return noCache({ error: 'Connection not found' }, 404);
    }

    if (connection.webhookId) {
      const token = await requireAirtableToken().catch(() => null);
      if (token) {
        await deleteWebhook(token, connection.baseId, connection.webhookId).catch(() => {});
      }
    }

    const remaining = connections.filter((c) => c.id !== connectionId);
    await saveConnections(remaining);

    return noCache({ data: { success: true } });
  } catch (error) {
    console.error('Error deleting Airtable connection:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to delete connection' },
      500
    );
  }
}

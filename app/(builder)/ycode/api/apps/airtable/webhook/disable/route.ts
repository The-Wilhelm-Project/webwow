import { NextRequest } from 'next/server';
import {
  requireConnectionFromBody,
  updateConnection,
  requireAirtableToken,
} from '@/lib/apps/airtable/sync-service';
import { deleteWebhook } from '@/lib/apps/airtable';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/apps/airtable/webhook/disable
 * Deregister an Airtable webhook for a connection
 */
export async function POST(request: NextRequest) {
  try {
    const connection = await requireConnectionFromBody(request);

    if (!connection.webhookId) {
      return noCache({ error: 'No webhook registered for this connection' }, 400);
    }

    const token = await requireAirtableToken();

    try {
      await deleteWebhook(token, connection.baseId, connection.webhookId);
    } catch {
      // Webhook may already be expired or deleted — safe to ignore
    }

    await updateConnection(connection.id, {
      webhookId: null,
      webhookSecret: null,
      webhookExpiresAt: null,
      webhookExpiredAt: null,
      webhookCursor: 0,
    });

    return noCache({ data: { success: true } });
  } catch (error) {
    console.error('Error disabling Airtable webhook:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to disable webhook' },
      500
    );
  }
}

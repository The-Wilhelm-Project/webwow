import { NextRequest } from 'next/server';
import {
  requireConnectionFromBody,
  updateConnection,
  requireAirtableToken,
} from '@/lib/apps/airtable/sync-service';
import { refreshWebhook } from '@/lib/apps/airtable';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/apps/airtable/webhook/refresh
 * Refresh an Airtable webhook to extend its expiry
 */
export async function POST(request: NextRequest) {
  try {
    const connection = await requireConnectionFromBody(request);

    if (!connection.webhookId) {
      return noCache({ error: 'No webhook registered for this connection' }, 400);
    }

    const token = await requireAirtableToken();
    const result = await refreshWebhook(token, connection.baseId, connection.webhookId);

    await updateConnection(connection.id, {
      webhookExpiresAt: result.expirationTime,
    });

    return noCache({
      data: { expiresAt: result.expirationTime },
    });
  } catch (error) {
    console.error('Error refreshing Airtable webhook:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to refresh webhook' },
      500
    );
  }
}

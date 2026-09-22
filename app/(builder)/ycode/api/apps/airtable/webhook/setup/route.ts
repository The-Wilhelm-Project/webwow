import { NextRequest } from 'next/server';
import {
  requireConnectionFromBody,
  updateConnection,
  requireAirtableToken,
} from '@/lib/apps/airtable/sync-service';
import { createWebhook } from '@/lib/apps/airtable';
import { noCache } from '@/lib/api-response';
import { getSiteBaseUrl } from '@/lib/url-utils';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/apps/airtable/webhook/setup
 * Register an Airtable webhook for a connection's base
 */
export async function POST(request: NextRequest) {
  try {
    const connection = await requireConnectionFromBody(request);

    if (connection.webhookId) {
      return noCache({ error: 'Auto-sync already enabled', detail: 'Disable the existing webhook first.' }, 400);
    }

    const token = await requireAirtableToken();

    const baseUrl = getSiteBaseUrl() || request.nextUrl.origin;
    const notificationUrl = `${baseUrl}/api/airtable-webhook`;

    if (!notificationUrl.startsWith('https://')) {
      return noCache(
        {
          error: 'HTTPS URL required',
          detail: 'Webhooks require a public HTTPS URL. On Vercel, enable "Automatically expose System Environment Variables" in project settings. Otherwise, set NEXT_PUBLIC_SITE_URL.',
        },
        400
      );
    }

    // Verify the webhook endpoint is reachable before registering with Airtable
    try {
      const ping = await fetch(notificationUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (ping.status === 401 || ping.status === 403) {
        return noCache(
          {
            error: 'Webhook URL is not publicly accessible',
            detail: 'Webhooks require a public HTTPS URL. On Vercel, enable "Automatically expose System Environment Variables" in project settings. Otherwise, set NEXT_PUBLIC_SITE_URL.',
          },
          400
        );
      }
    } catch {
      return noCache(
        { error: 'Webhook URL is unreachable', detail: 'Ensure the app is deployed and publicly accessible.' },
        400
      );
    }

    const webhook = await createWebhook(token, connection.baseId, connection.tableId, notificationUrl);

    await updateConnection(connection.id, {
      webhookId: webhook.id,
      webhookSecret: webhook.macSecretBase64,
      webhookExpiresAt: webhook.expirationTime,
      webhookExpiredAt: null,
      webhookCursor: 0,
    });

    return noCache({
      data: {
        webhookId: webhook.id,
        expiresAt: webhook.expirationTime,
      },
    });
  } catch (error) {
    console.error('Error setting up Airtable webhook:', error);
    return noCache(
      { error: 'Failed to enable auto-sync', detail: error instanceof Error ? error.message : 'Unknown error' },
      500
    );
  }
}
